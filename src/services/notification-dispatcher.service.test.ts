import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Types } from 'mongoose';

import { ROLES } from '../constants/roles.js';

/**
 * Unit tests for the notification dispatcher (Step 11).
 *
 * The dispatcher is the only piece of Step-11 plumbing that has business
 * logic worth covering at the unit level — recipient resolution, fan-out
 * cardinality, and the never-throw error contract. Everything else (CRUD
 * service, controller, routes) is exercised end-to-end by
 * `scripts/smoke-notifications.sh`.
 *
 * We mock:
 *   - `User.findById`/`User.find`  — recipient resolution.
 *   - `Notification.create`        — in-app channel.
 *   - `sendEmail`                  — email channel.
 *
 * Each test asserts the cardinality + payload shape of the mocked calls.
 */

// ─── Mocks ────────────────────────────────────────────────────────────────
//
// `vi.mock` factories are hoisted to the top of the file BEFORE module-level
// const declarations. To share mock fn references with the test body we
// declare them inside `vi.hoisted` so vitest hoists the bindings together
// with the factory.

const { notificationCreateMock, sendEmailMock, userFindByIdMock, userFindMock, loggerWarnMock } = vi.hoisted(() => {
    return {
        notificationCreateMock: vi.fn(),
        sendEmailMock: vi.fn(),
        userFindByIdMock: vi.fn(),
        userFindMock: vi.fn(),
        loggerWarnMock: vi.fn(),
    };
});

/**
 * Build a Mongoose-Query-shaped mock so the dispatcher can chain
 * `.select(...).lean<T>()` against the mocked model methods. `mockReturnThis`
 * on a `vi.fn()` returns the mock function itself (not the parent object), so
 * we wire `select` to return the same chain object explicitly.
 */
const queryReturning = <T>(value: T) => {
    const chain: { select: ReturnType<typeof vi.fn>; lean: ReturnType<typeof vi.fn> } = {
        select: vi.fn(),
        lean: vi.fn().mockResolvedValue(value),
    };
    chain.select.mockReturnValue(chain);
    return chain;
};

vi.mock('../models/notification.model.js', () => ({
    Notification: {
        create: notificationCreateMock,
    },
}));

vi.mock('../models/user.model.js', () => ({
    User: {
        findById: userFindByIdMock,
        find: userFindMock,
    },
}));

// `email-templates.ts` also imports `escapeHtml` from `mailer.js`, so we must
// keep the rest of the module intact and only override `sendEmail`.
vi.mock('../utils/mailer.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../utils/mailer.js')>();
    return {
        ...actual,
        sendEmail: sendEmailMock,
    };
});

// Suppress the dispatcher's `logger.warn` so a deliberately-thrown mock error
// doesn't show up as a real warning in the test output.
vi.mock('../utils/logger.js', () => ({
    default: { warn: loggerWarnMock, info: vi.fn() },
}));

// Pull dispatcher AFTER the mocks are wired so the SUT picks them up.
const dispatcher = await import('./notification-dispatcher.service.js');

// ─── Fixtures ─────────────────────────────────────────────────────────────

const requesterId = new Types.ObjectId();
const adminId = new Types.ObjectId();
const managerId = new Types.ObjectId();
const requestId = new Types.ObjectId();

const requester = {
    _id: requesterId,
    email: 'emp@example.com',
    full_name: 'Employee One',
    role: ROLES.EMPLOYEE,
};
const admin = {
    _id: adminId,
    email: 'admin@example.com',
    full_name: 'Adam Admin',
    role: ROLES.ADMIN,
};
const manager = {
    _id: managerId,
    email: 'manager@example.com',
    full_name: 'Mary Manager',
    role: ROLES.MANAGER,
};

const reviewerPool = [admin, manager];

beforeEach(() => {
    notificationCreateMock.mockReset();
    sendEmailMock.mockReset();
    userFindByIdMock.mockReset();
    userFindMock.mockReset();
    loggerWarnMock.mockReset();

    notificationCreateMock.mockResolvedValue({ _id: new Types.ObjectId() });
    sendEmailMock.mockResolvedValue(undefined);

    // Default: any `findById` returns the requester (overridden per test).
    userFindByIdMock.mockImplementation((id: Types.ObjectId) => {
        if (id.equals(adminId)) return queryReturning(admin);
        if (id.equals(managerId)) return queryReturning(manager);
        return queryReturning(requester);
    });
    // Default: reviewer-pool query returns admin + manager.
    userFindMock.mockReturnValue(queryReturning(reviewerPool));
});

// ─── notifyLeaveSubmitted ────────────────────────────────────────────────

describe('notifyLeaveSubmitted', () => {
    const baseInput = {
        request_id: requestId,
        requester_id: requesterId,
        leave_type_label: 'CL — Casual Leave',
        start_date: '2026-05-04',
        end_date: '2026-05-05',
        total_days: 2,
    };

    it('fans out one in-app row + one email per reviewer; excludes the requester from the pool', async () => {
        await dispatcher.notifyLeaveSubmitted(baseInput);

        expect(notificationCreateMock).toHaveBeenCalledTimes(2);
        expect(sendEmailMock).toHaveBeenCalledTimes(2);

        // The reviewer-pool fetch must have excluded the requester id
        const findCall = userFindMock.mock.calls[0][0];
        expect(findCall._id).toEqual({ $ne: requesterId });
        expect(findCall.role).toEqual({ $in: [ROLES.ADMIN, ROLES.MANAGER] });

        // Each in-app row points at the leave_request entity
        for (const call of notificationCreateMock.mock.calls) {
            const payload = call[0];
            expect(payload.type).toBe('leave_requested');
            expect(payload.related_entity).toEqual({ kind: 'leave_request', id: requestId });
            expect(payload.is_read).toBe(false);
            expect(payload.link_url).toBe(`/leaves/${requestId.toString()}`);
        }
    });

    it('skips dispatch quietly when the reviewer pool is empty', async () => {
        userFindMock.mockReturnValue(queryReturning([]));

        await expect(dispatcher.notifyLeaveSubmitted(baseInput)).resolves.toBeUndefined();
        expect(notificationCreateMock).not.toHaveBeenCalled();
        expect(sendEmailMock).not.toHaveBeenCalled();
    });

    it('never throws when Notification.create fails — email still attempted', async () => {
        notificationCreateMock.mockRejectedValueOnce(new Error('mongo down'));

        await expect(dispatcher.notifyLeaveSubmitted(baseInput)).resolves.toBeUndefined();
        // 2 reviewers → 2 attempts each side; in-app's first call rejected,
        // but the second still happened, and both emails went out.
        expect(notificationCreateMock).toHaveBeenCalledTimes(2);
        expect(sendEmailMock).toHaveBeenCalledTimes(2);
    });

    it('never throws when sendEmail fails', async () => {
        sendEmailMock.mockRejectedValue(new Error('SMTP unreachable'));

        await expect(dispatcher.notifyLeaveSubmitted(baseInput)).resolves.toBeUndefined();
        expect(notificationCreateMock).toHaveBeenCalledTimes(2); // in-app still wrote
        expect(sendEmailMock).toHaveBeenCalledTimes(2);
    });
});

// ─── notifyLeaveDecided ──────────────────────────────────────────────────

describe('notifyLeaveDecided', () => {
    const decisionInput = {
        request_id: requestId,
        requester_id: requesterId,
        leave_type_label: 'CL',
        start_date: '2026-05-04',
        end_date: '2026-05-04',
        total_days: 1,
        actor: { id: adminId },
        remarks: 'looks good',
    };

    it('approved → notifies only the requester (1 in-app + 1 email)', async () => {
        await dispatcher.notifyLeaveDecided({ ...decisionInput, decision: 'approved' });

        expect(loggerWarnMock).not.toHaveBeenCalled();
        expect(notificationCreateMock).toHaveBeenCalledTimes(1);
        expect(sendEmailMock).toHaveBeenCalledTimes(1);

        const payload = notificationCreateMock.mock.calls[0][0];
        expect(payload.type).toBe('leave_approved');
        expect(payload.user_id).toEqual(requesterId);
    });

    it('rejected → notifies only the requester', async () => {
        await dispatcher.notifyLeaveDecided({ ...decisionInput, decision: 'rejected' });

        expect(notificationCreateMock).toHaveBeenCalledTimes(1);
        const payload = notificationCreateMock.mock.calls[0][0];
        expect(payload.type).toBe('leave_rejected');
    });

    it('cancelled by admin → notifies requester + reviewer pool (de-duped, actor excluded)', async () => {
        // Reviewer pool here is [admin, manager] from beforeEach; the actor
        // is `adminId`, so the pool query was called with $ne: adminId. To
        // accurately simulate, we override the pool query to drop admin.
        userFindMock.mockReturnValue(queryReturning([manager]));

        await dispatcher.notifyLeaveDecided({ ...decisionInput, decision: 'cancelled' });

        // Recipients: requester (admin cancelled on their behalf) + manager
        expect(notificationCreateMock).toHaveBeenCalledTimes(2);
        const types = notificationCreateMock.mock.calls.map((c) => c[0].type);
        expect(types).toEqual(['leave_cancelled', 'leave_cancelled']);
        // Only the requester gets the email — reviewers see in-app only.
        expect(sendEmailMock).toHaveBeenCalledTimes(1);
    });

    it('cancelled by self → no email duplicate; only reviewer pool gets in-app', async () => {
        userFindMock.mockReturnValue(queryReturning([admin, manager]));

        await dispatcher.notifyLeaveDecided({
            ...decisionInput,
            decision: 'cancelled',
            actor: { id: requesterId },
        });

        // Self-cancel: requester is excluded from recipients (actorIsRequester
        // skips the requester push), reviewer pool gets two rows.
        expect(notificationCreateMock).toHaveBeenCalledTimes(2);
        // No email — emails are only sent to the requester branch.
        expect(sendEmailMock).not.toHaveBeenCalled();
    });
});

// ─── notifyAttendanceCorrectionDecided ───────────────────────────────────

describe('notifyAttendanceCorrectionDecided', () => {
    it('sends exactly one in-app + one email to the requester', async () => {
        await dispatcher.notifyAttendanceCorrectionDecided({
            request_id: requestId,
            requester_id: requesterId,
            local_date: '2026-05-04',
            decision: 'approved',
            actor: { id: adminId },
            remarks: null,
        });

        expect(notificationCreateMock).toHaveBeenCalledTimes(1);
        expect(sendEmailMock).toHaveBeenCalledTimes(1);

        const payload = notificationCreateMock.mock.calls[0][0];
        expect(payload.type).toBe('attendance_correction_decided');
        expect(payload.related_entity).toEqual({ kind: 'attendance_correction_request', id: requestId });
    });

    it('skips when actor is the requester (self-review edge case)', async () => {
        await dispatcher.notifyAttendanceCorrectionDecided({
            request_id: requestId,
            requester_id: requesterId,
            local_date: '2026-05-04',
            decision: 'approved',
            actor: { id: requesterId },
            remarks: null,
        });

        expect(notificationCreateMock).not.toHaveBeenCalled();
        expect(sendEmailMock).not.toHaveBeenCalled();
    });
});

// ─── notifyUserInvited ───────────────────────────────────────────────────

describe('notifyUserInvited', () => {
    it('sends exactly one email; never writes an in-app row (no session yet)', async () => {
        await dispatcher.notifyUserInvited({
            recipient_user_id: requesterId,
            invited_by: { id: adminId },
            initial_password: 'temp-pass-123',
        });

        expect(notificationCreateMock).not.toHaveBeenCalled();
        expect(sendEmailMock).toHaveBeenCalledTimes(1);

        const emailCall = sendEmailMock.mock.calls[0][0];
        expect(emailCall.to).toBe('emp@example.com');
        expect(emailCall.subject).toMatch(/Welcome/i);
        expect(emailCall.text).toContain('temp-pass-123');
    });

    it('never throws when sendEmail fails', async () => {
        sendEmailMock.mockRejectedValue(new Error('mailbox full'));
        await expect(
            dispatcher.notifyUserInvited({
                recipient_user_id: requesterId,
                invited_by: { id: adminId },
                initial_password: 'p',
            })
        ).resolves.toBeUndefined();
    });
});
