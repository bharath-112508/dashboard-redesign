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

const {
    notificationCreateMock,
    sendEmailMock,
    userFindByIdMock,
    userFindMock,
    userFindOneMock,
    leaveRequestFindByIdMock,
    leaveRequestFindByIdAndUpdateMock,
    loggerWarnMock,
    getOrInitSettingsMock,
    postSlackMessageMock,
    postOrUpdateSlackMessageMock,
    isPushConfiguredMock,
    sendPushNotificationMock,
    listSubscriptionsForUserMock,
} = vi.hoisted(() => {
    return {
        notificationCreateMock: vi.fn(),
        sendEmailMock: vi.fn(),
        userFindByIdMock: vi.fn(),
        userFindMock: vi.fn(),
        userFindOneMock: vi.fn(),
        leaveRequestFindByIdMock: vi.fn(),
        leaveRequestFindByIdAndUpdateMock: vi.fn().mockResolvedValue(null),
        loggerWarnMock: vi.fn(),
        isPushConfiguredMock: vi.fn().mockReturnValue(false),
        sendPushNotificationMock: vi.fn().mockResolvedValue(true),
        listSubscriptionsForUserMock: vi.fn().mockResolvedValue([]),
        // Step-25 dispatcher gates Slack on `system_settings.slack`. The
        // existing tests don't care about Slack, so the default is "Slack
        // disabled" — `loadSlackDispatchForType` returns null and the
        // notify helpers skip Slack entirely.
        getOrInitSettingsMock: vi.fn().mockResolvedValue({
            slack: {
                enabled: false,
                bot_token: null,
                channels: {
                    leaves: '#leaves',
                    attendance: '#attendance',
                    projects: '#projects',
                    timesheet: '#timesheet',
                    general: '#general',
                },
            },
        }),
        // DM path uses postSlackMessage (text-only). Broadcast path
        // for leaves uses postOrUpdateSlackMessage (Block Kit + chat.update).
        postSlackMessageMock: vi.fn().mockResolvedValue({ success: true, ts: '1.1', channel: 'CDM' }),
        postOrUpdateSlackMessageMock: vi.fn().mockResolvedValue({
            success: true,
            ts: '1.1',
            channel: 'CCHAN',
        }),
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

const publishMock = vi.hoisted(() => vi.fn());
vi.mock('./realtime.service.js', () => ({ publish: publishMock }));

vi.mock('../models/notification.model.js', () => ({
    Notification: {
        create: notificationCreateMock,
    },
}));

vi.mock('../models/user.model.js', () => ({
    User: {
        findById: userFindByIdMock,
        find: userFindMock,
        findOne: userFindOneMock,
    },
}));

// Phase 1 — dispatcher reads `slack_message` from the leave doc on
// decisions to chat.update the original message, and writes
// `slack_message` back after the initial post. Mock both.
vi.mock('../models/leave-request.model.js', () => ({
    LeaveRequest: {
        findById: leaveRequestFindByIdMock,
        findByIdAndUpdate: leaveRequestFindByIdAndUpdateMock,
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

// Step-25 — dispatcher loads `system_settings` to gate Slack fan-out.
// Mock returns "Slack disabled" by default; the per-test overrides flip
// it on when needed.
vi.mock('./settings.service.js', () => ({
    getOrInitSettings: getOrInitSettingsMock,
}));

vi.mock('../utils/slack.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../utils/slack.js')>();
    return {
        ...actual,
        postSlackMessage: postSlackMessageMock,
        postOrUpdateSlackMessage: postOrUpdateSlackMessageMock,
    };
});

// V2-BE-10 — push channel is silently disabled by default (`isPushConfigured`
// returns false) so existing tests stay unchanged. The push-specific test
// below flips it on and verifies the 4th channel fires.
vi.mock('../utils/push.js', () => ({
    isPushConfigured: isPushConfiguredMock,
    sendPushNotification: sendPushNotificationMock,
}));

vi.mock('./push-subscription.service.js', () => ({
    listSubscriptionsForUser: listSubscriptionsForUserMock,
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
    leaveRequestFindByIdMock.mockReset();
    leaveRequestFindByIdAndUpdateMock.mockReset();
    leaveRequestFindByIdMock.mockResolvedValue(null);
    leaveRequestFindByIdAndUpdateMock.mockResolvedValue(null);
    loggerWarnMock.mockReset();
    isPushConfiguredMock.mockReset();
    sendPushNotificationMock.mockReset();
    listSubscriptionsForUserMock.mockReset();
    // Phase 1 — broadcast path uses postOrUpdateSlackMessage; DM path
    // uses postSlackMessage. Both default to success so failure paths
    // are opt-in via the individual test.
    postSlackMessageMock.mockReset();
    postSlackMessageMock.mockResolvedValue({ success: true, ts: '1.1', channel: 'CDM' });
    postOrUpdateSlackMessageMock.mockReset();
    postOrUpdateSlackMessageMock.mockResolvedValue({
        success: true,
        ts: '1.1',
        channel: 'CCHAN',
    });
    // Settings mock leaks between tests if not reset — restore the
    // "Slack disabled" default so tests that don't override see no
    // Slack fan-out.
    getOrInitSettingsMock.mockReset();
    getOrInitSettingsMock.mockResolvedValue({
        slack: {
            enabled: false,
            bot_token: null,
            channels: {
                leaves: '#leaves',
                attendance: '#attendance',
                projects: '#projects',
                timesheet: '#timesheet',
                general: '#general',
            },
        },
    });

    notificationCreateMock.mockResolvedValue({ _id: new Types.ObjectId() });
    sendEmailMock.mockResolvedValue(undefined);
    // Push is off by default; the push-channel test flips it on.
    isPushConfiguredMock.mockReturnValue(false);
    sendPushNotificationMock.mockResolvedValue(true);
    listSubscriptionsForUserMock.mockResolvedValue([]);

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

    // Was manager-ONLY. A single recipient meant an away or slow manager left
    // the request surfaced to nobody else who could approve it, which is how
    // requests sat unactioned — admins hold `leave_request.approve` too.
    it('notifies the reporting manager AND the admins', async () => {
        userFindByIdMock.mockImplementation((id: Types.ObjectId) =>
            id.equals(requesterId)
                ? queryReturning({ ...requester, internal_profile: { reporting_manager_id: managerId } })
                : queryReturning(requester)
        );
        userFindOneMock.mockReturnValue(queryReturning(manager));
        userFindMock.mockReturnValue(queryReturning([admin]));

        await dispatcher.notifyLeaveSubmitted(baseInput);

        expect(userFindOneMock.mock.calls[0][0]._id).toEqual(managerId);
        expect(userFindMock.mock.calls[0][0].role).toEqual(ROLES.ADMIN);
        const notified = notificationCreateMock.mock.calls.map((c) => String(c[0].user_id));
        expect(notified.sort()).toEqual([String(managerId), String(adminId)].sort());
    });

    it('de-dupes when the reporting manager IS an admin', async () => {
        userFindByIdMock.mockImplementation((id: Types.ObjectId) =>
            id.equals(requesterId)
                ? queryReturning({ ...requester, internal_profile: { reporting_manager_id: adminId } })
                : queryReturning(requester)
        );
        userFindOneMock.mockReturnValue(queryReturning(admin));
        userFindMock.mockReturnValue(queryReturning([admin]));

        await dispatcher.notifyLeaveSubmitted(baseInput);

        // One person, one notification — not two.
        expect(notificationCreateMock).toHaveBeenCalledTimes(1);
        expect(String(notificationCreateMock.mock.calls[0][0].user_id)).toBe(String(adminId));
    });

    it('never tells an admin about their OWN leave request', async () => {
        userFindByIdMock.mockImplementation(() => queryReturning(admin));
        userFindOneMock.mockReturnValue(queryReturning(null));
        userFindMock.mockReturnValue(queryReturning([admin]));

        await dispatcher.notifyLeaveSubmitted({ ...baseInput, requester_id: adminId });

        expect(notificationCreateMock).not.toHaveBeenCalled();
    });

    it('still notifies the admins when no reporting manager is set', async () => {
        await dispatcher.notifyLeaveSubmitted(baseInput);

        expect(notificationCreateMock).toHaveBeenCalledTimes(2);
        expect(sendEmailMock).toHaveBeenCalledTimes(2);

        // Admins are queried unfiltered now; the requester is removed after
        // the query so the same exclusion also covers the manager branch.
        const findCall = userFindMock.mock.calls[0][0];
        expect(findCall._id).toBeUndefined();
        expect(findCall.role).toEqual(ROLES.ADMIN);

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

    // ─── Phase 1: editable Slack message ─────────────────────────────────
    const enabledSlackForPhase1 = {
        slack: {
            enabled: true,
            bot_token: 'xoxb-test',
            channels: {
                leaves: '#leaves',
                attendance: '#attendance',
                projects: '#projects',
                timesheet: '#timesheet',
                general: '#general',
            },
        },
    };
    const requesterWithSlackForPhase1 = {
        ...requester,
        slack_user_id: 'U-EMP',
        slack_notifications_enabled: true,
    };
    const adminWithSlackForPhase1 = {
        ...admin,
        slack_user_id: 'U-ADM',
        slack_notifications_enabled: true,
    };

    it('Phase 1 — calls chat.update with the persisted slack_message coordinates', async () => {
        getOrInitSettingsMock.mockResolvedValue(enabledSlackForPhase1);
        userFindByIdMock.mockImplementation(() => queryReturning(requesterWithSlackForPhase1));
        userFindMock.mockReturnValue(queryReturning([adminWithSlackForPhase1]));
        // The leave was posted earlier and persisted its coordinates.
        leaveRequestFindByIdMock.mockReturnValue({
            select: () =>
                Promise.resolve({
                    slack_message: { channel: 'CSAVED', ts: '999.999' },
                }),
        });

        await dispatcher.notifyLeaveDecided({
            ...decisionInput,
            decision: 'approved',
            actor: { id: adminId },
        });

        expect(postOrUpdateSlackMessageMock).toHaveBeenCalledTimes(1);
        const call = postOrUpdateSlackMessageMock.mock.calls[0][1] as {
            existing: { channel: string; ts: string };
        };
        expect(call.existing).toEqual({ channel: 'CSAVED', ts: '999.999' });
        // No fresh-post write-back when we updated an existing message.
        expect(leaveRequestFindByIdAndUpdateMock).not.toHaveBeenCalled();
    });

    it('Phase 1 — falls back to fresh post when slack_message is null (legacy leave) + persists back', async () => {
        getOrInitSettingsMock.mockResolvedValue(enabledSlackForPhase1);
        userFindByIdMock.mockImplementation(() => queryReturning(requesterWithSlackForPhase1));
        userFindMock.mockReturnValue(queryReturning([adminWithSlackForPhase1]));
        // Legacy leave — submitted before Phase 1, no slack_message saved.
        leaveRequestFindByIdMock.mockReturnValue({
            select: () => Promise.resolve({ slack_message: null }),
        });

        await dispatcher.notifyLeaveDecided({
            ...decisionInput,
            decision: 'approved',
            actor: { id: adminId },
        });

        // existing=null → postOrUpdateSlackMessage falls back to chat.postMessage,
        // and we persist the new coordinates so any further decision can update.
        expect(postOrUpdateSlackMessageMock).toHaveBeenCalledTimes(1);
        const call = postOrUpdateSlackMessageMock.mock.calls[0][1] as { existing: unknown };
        expect(call.existing).toBeNull();
        expect(leaveRequestFindByIdAndUpdateMock).toHaveBeenCalledWith(
            requestId,
            expect.objectContaining({
                slack_message: expect.objectContaining({ channel: 'CCHAN', ts: '1.1' }),
            })
        );
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

// ─── Slack integration (Step 25) ─────────────────────────────────────────

describe('Slack integration', () => {
    const enabledSlackSettings = {
        slack: {
            enabled: true,
            bot_token: 'xoxb-test',
            channels: {
                leaves: '#leaves',
                attendance: '#attendance',
                projects: '#projects',
                timesheet: '#timesheet',
                general: '#general',
            },
        },
    };

    const requesterWithSlack = { ...requester, slack_user_id: 'U-EMP', slack_notifications_enabled: true };
    const adminWithSlack = { ...admin, slack_user_id: 'U-ADM', slack_notifications_enabled: true };
    const managerNoSlackId = { ...manager, slack_user_id: null, slack_notifications_enabled: true };
    const adminOptedOut = { ...admin, slack_user_id: 'U-ADM', slack_notifications_enabled: false };

    beforeEach(() => {
        notificationCreateMock.mockResolvedValue({});
        sendEmailMock.mockResolvedValue(undefined);
        postSlackMessageMock.mockReset();
        postSlackMessageMock.mockResolvedValue({ success: true, ts: '1.1', channel: 'CDM' });
        postOrUpdateSlackMessageMock.mockReset();
        postOrUpdateSlackMessageMock.mockResolvedValue({
            success: true,
            ts: '1.1',
            channel: 'CCHAN',
        });
    });

    it('skips Slack entirely when settings.enabled is false', async () => {
        // Default mock returns enabled=false; this is a sanity check.
        userFindByIdMock.mockReturnValue(queryReturning(requesterWithSlack));
        userFindMock.mockReturnValue(queryReturning([adminWithSlack]));

        await dispatcher.notifyLeaveSubmitted({
            request_id: requestId,
            requester_id: requesterId,
            leave_type_label: 'Casual Leave',
            start_date: '2026-04-22',
            end_date: '2026-04-22',
            total_days: 1,
        });

        expect(postSlackMessageMock).not.toHaveBeenCalled();
    });

    it('fires ONE channel broadcast (Block Kit) + ONE per-recipient DM when fully configured', async () => {
        getOrInitSettingsMock.mockResolvedValue(enabledSlackSettings);
        userFindByIdMock.mockReturnValue(queryReturning(requesterWithSlack));
        userFindMock.mockReturnValue(queryReturning([adminWithSlack]));

        await dispatcher.notifyLeaveSubmitted({
            request_id: requestId,
            requester_id: requesterId,
            leave_type_label: 'Casual Leave',
            start_date: '2026-04-22',
            end_date: '2026-04-22',
            total_days: 1,
        });

        // Phase 1 split: broadcast goes through postOrUpdateSlackMessage
        // (Block Kit + chat.update on later state changes); per-recipient
        // DMs continue through postSlackMessage (plain text).
        expect(postOrUpdateSlackMessageMock).toHaveBeenCalledTimes(1);
        const broadcastCall = postOrUpdateSlackMessageMock.mock.calls[0][1] as {
            channel: string;
            existing: unknown;
        };
        expect(broadcastCall.channel).toBe('#leaves');
        expect(broadcastCall.existing).toBeNull();

        expect(postSlackMessageMock).toHaveBeenCalledTimes(1);
        const dmCall = postSlackMessageMock.mock.calls[0][1] as { channel: string };
        expect(dmCall.channel).toBe('U-ADM');

        // slack_message persisted back so a later decide can chat.update.
        expect(leaveRequestFindByIdAndUpdateMock).toHaveBeenCalledWith(
            requestId,
            expect.objectContaining({
                slack_message: expect.objectContaining({ channel: 'CCHAN', ts: '1.1' }),
            })
        );
    });

    it('skips DM for recipients without slack_user_id (broadcast still fires)', async () => {
        getOrInitSettingsMock.mockResolvedValue(enabledSlackSettings);
        userFindByIdMock.mockReturnValue(queryReturning(requesterWithSlack));
        userFindMock.mockReturnValue(queryReturning([managerNoSlackId]));

        await dispatcher.notifyLeaveSubmitted({
            request_id: requestId,
            requester_id: requesterId,
            leave_type_label: 'CL',
            start_date: '2026-04-22',
            end_date: '2026-04-22',
            total_days: 1,
        });

        // Broadcast (postOrUpdate) yes, DM (postSlackMessage) no — no slack_user_id.
        expect(postOrUpdateSlackMessageMock).toHaveBeenCalledTimes(1);
        expect(postSlackMessageMock).not.toHaveBeenCalled();
    });

    it('skips DM when recipient has slack_notifications_enabled = false', async () => {
        getOrInitSettingsMock.mockResolvedValue(enabledSlackSettings);
        userFindByIdMock.mockReturnValue(queryReturning(requesterWithSlack));
        userFindMock.mockReturnValue(queryReturning([adminOptedOut]));

        await dispatcher.notifyLeaveSubmitted({
            request_id: requestId,
            requester_id: requesterId,
            leave_type_label: 'CL',
            start_date: '2026-04-22',
            end_date: '2026-04-22',
            total_days: 1,
        });

        // Broadcast yes; opted-out admin = no DM.
        expect(postOrUpdateSlackMessageMock).toHaveBeenCalledTimes(1);
        expect(postSlackMessageMock).not.toHaveBeenCalled();
    });

    it('does not block the in-app + email fan-out when Slack send throws (best-effort contract)', async () => {
        getOrInitSettingsMock.mockResolvedValue(enabledSlackSettings);
        // postSlackMessage / postOrUpdateSlackMessage never throw (best-
        // effort contract). Simulate `{ success: false }` to confirm the
        // dispatcher proceeds to the next step regardless.
        postSlackMessageMock.mockResolvedValue({ success: false });
        postOrUpdateSlackMessageMock.mockResolvedValue({ success: false });
        userFindByIdMock.mockReturnValue(queryReturning(requesterWithSlack));
        userFindMock.mockReturnValue(queryReturning([adminWithSlack]));

        await dispatcher.notifyLeaveSubmitted({
            request_id: requestId,
            requester_id: requesterId,
            leave_type_label: 'CL',
            start_date: '2026-04-22',
            end_date: '2026-04-22',
            total_days: 1,
        });

        // In-app + email still happen.
        expect(notificationCreateMock).toHaveBeenCalledTimes(1);
        expect(sendEmailMock).toHaveBeenCalledTimes(1);
    });

    // Corrections used the blanket reviewer pool — EVERY active admin and
    // manager, whether or not the requester reported to them. They now use the
    // same reporting-manager + admins routing as a leave request, so the two
    // approval flows can't drift apart again.
    it('routes an attendance correction to the reporting manager AND the admins', async () => {
        userFindByIdMock.mockImplementation((id: Types.ObjectId) =>
            id.equals(requesterId)
                ? queryReturning({ ...requester, internal_profile: { reporting_manager_id: managerId } })
                : queryReturning(requester)
        );
        userFindOneMock.mockReturnValue(queryReturning(manager));
        userFindMock.mockReturnValue(queryReturning([admin]));

        await dispatcher.notifyAttendanceCorrectionSubmitted({
            request_id: requestId,
            requester_id: requesterId,
            local_date: '2026-04-22',
        });

        // Admins only — a blanket pool query would also ask for MANAGER.
        expect(userFindMock.mock.calls[0][0].role).toEqual(ROLES.ADMIN);
        const notified = notificationCreateMock.mock.calls.map((c) => String(c[0].user_id));
        expect(notified.sort()).toEqual([String(managerId), String(adminId)].sort());
    });

    it('routes attendance-correction broadcasts to #attendance, not #leaves (category mapping regression)', async () => {
        // The type→category map drives broadcast channel selection.
        // A regression that flipped attendance events to #leaves would
        // be silent unless we pin the actual channel value.
        getOrInitSettingsMock.mockResolvedValue(enabledSlackSettings);
        userFindByIdMock.mockReturnValue(queryReturning(requesterWithSlack));
        userFindMock.mockReturnValue(queryReturning([adminWithSlack]));

        await dispatcher.notifyAttendanceCorrectionSubmitted({
            request_id: requestId,
            requester_id: requesterId,
            local_date: '2026-04-22',
        });

        const broadcastCall = postSlackMessageMock.mock.calls.find((c) =>
            (c[1] as { channel: string }).channel.startsWith('#')
        );
        expect(broadcastCall).toBeDefined();
        expect((broadcastCall![1] as { channel: string }).channel).toBe('#attendance');
    });

    it('routes task-comment mentions as DM-only (no #projects broadcast)', async () => {
        getOrInitSettingsMock.mockResolvedValue(enabledSlackSettings);
        const author = { ...admin, slack_user_id: 'U-ADM', slack_notifications_enabled: true };
        const mentioned = { ...manager, slack_user_id: 'U-MGR', slack_notifications_enabled: true };
        userFindByIdMock.mockReturnValue(queryReturning(author));
        userFindMock.mockReturnValue(queryReturning([mentioned]));

        await dispatcher.notifyTaskCommentMention({
            comment_id: new Types.ObjectId(),
            task_id: new Types.ObjectId(),
            project_id: new Types.ObjectId(),
            author_id: adminId,
            mentioned_user_ids: [managerId],
            body_preview: 'hey check this',
        });

        // Only the DM — task-comment mentions are deliberately personal.
        expect(postSlackMessageMock).toHaveBeenCalledTimes(1);
        const channel = (postSlackMessageMock.mock.calls[0][1] as { channel: string }).channel;
        expect(channel).toBe('U-MGR');
    });
});

// ─── Push channel (V2-BE-10) ──────────────────────────────────────────────

describe('push channel', () => {
    const requesterId2 = new Types.ObjectId();
    const adminId2 = new Types.ObjectId();
    const requester2 = {
        _id: requesterId2,
        email: 'emp@example.com',
        full_name: 'Employee One',
        role: ROLES.EMPLOYEE,
        push_notifications_enabled: true,
    };
    const adminWithPush = {
        _id: adminId2,
        email: 'admin@example.com',
        full_name: 'Adam Admin',
        role: ROLES.ADMIN,
        push_notifications_enabled: true,
    };

    const submitInput = () => ({
        request_id: new Types.ObjectId(),
        requester_id: requesterId2,
        leave_type_code: 'CL',
        leave_type_label: 'Casual Leave',
        start_date: '2026-06-10',
        end_date: '2026-06-10',
        total_days: 1,
        reason: 'family event',
    });

    it('fires push for each recipient with at least one subscription when VAPID is configured', async () => {
        isPushConfiguredMock.mockReturnValue(true);
        userFindByIdMock.mockImplementation((id: Types.ObjectId) => {
            if (id.equals(adminId2)) return queryReturning(adminWithPush);
            return queryReturning(requester2);
        });
        userFindMock.mockReturnValue(queryReturning([adminWithPush]));
        listSubscriptionsForUserMock.mockResolvedValueOnce([
            { _id: new Types.ObjectId(), endpoint: 'https://fcm.googleapis.com/fcm/send/a' },
            { _id: new Types.ObjectId(), endpoint: 'https://fcm.googleapis.com/fcm/send/b' },
        ]);

        await dispatcher.notifyLeaveSubmitted(submitInput());

        // One recipient (admin), two subscriptions → two push sends.
        expect(sendPushNotificationMock).toHaveBeenCalledTimes(2);
        const firstCall = sendPushNotificationMock.mock.calls[0]?.[0] as {
            payload: { title: string; type: string };
        };
        expect(firstCall.payload.title).toContain('Leave request from');
        expect(firstCall.payload.type).toBe('leave_requested');
    });

    it('skips push when VAPID is unconfigured (default state)', async () => {
        isPushConfiguredMock.mockReturnValue(false);
        userFindByIdMock.mockImplementation((id: Types.ObjectId) => {
            if (id.equals(adminId2)) return queryReturning(adminWithPush);
            return queryReturning(requester2);
        });
        userFindMock.mockReturnValue(queryReturning([adminWithPush]));

        await dispatcher.notifyLeaveSubmitted(submitInput());

        expect(sendPushNotificationMock).not.toHaveBeenCalled();
        expect(listSubscriptionsForUserMock).not.toHaveBeenCalled();
    });

    it('skips push for a recipient who has opted out (push_notifications_enabled = false)', async () => {
        isPushConfiguredMock.mockReturnValue(true);
        const optedOut = { ...adminWithPush, push_notifications_enabled: false };
        userFindByIdMock.mockImplementation((id: Types.ObjectId) => {
            if (id.equals(adminId2)) return queryReturning(optedOut);
            return queryReturning(requester2);
        });
        userFindMock.mockReturnValue(queryReturning([optedOut]));

        await dispatcher.notifyLeaveSubmitted(submitInput());

        expect(sendPushNotificationMock).not.toHaveBeenCalled();
        // listSubscriptionsForUser shouldn't even fire — opt-out short-
        // circuits the lookup.
        expect(listSubscriptionsForUserMock).not.toHaveBeenCalled();
    });

    it('does not throw when listSubscriptionsForUser fails — logs and continues', async () => {
        isPushConfiguredMock.mockReturnValue(true);
        userFindByIdMock.mockImplementation((id: Types.ObjectId) => {
            if (id.equals(adminId2)) return queryReturning(adminWithPush);
            return queryReturning(requester2);
        });
        userFindMock.mockReturnValue(queryReturning([adminWithPush]));
        listSubscriptionsForUserMock.mockRejectedValueOnce(new Error('mongo timeout'));

        await expect(dispatcher.notifyLeaveSubmitted(submitInput())).resolves.not.toThrow();
        expect(loggerWarnMock).toHaveBeenCalledWith(
            expect.objectContaining({ channel: 'push' }),
            'Notification push fan-out failed'
        );
    });
});

describe('realtime — notifications topic', () => {
    // The realtime-emit middleware derives its topic from the request PATH,
    // so a notification born as a side effect of another write (task
    // assignment, leave approval, a comment) never published `notifications`
    // and the bell sat stale until the 120s fallback poll. The dispatcher
    // publishes it directly now; this pins that.
    it('publishes `notifications` when an in-app row is written', async () => {
        const { notifyTaskAssigned } = await import('./notification-dispatcher.service.js');
        const actor = new Types.ObjectId();
        const assignee = new Types.ObjectId();
        userFindByIdMock.mockReturnValue(
            queryReturning({ _id: actor, full_name: 'Ada Lovelace', email: 'ada@x.com', role: ROLES.ADMIN })
        );
        userFindMock.mockReturnValue(
            queryReturning([
                {
                    _id: assignee,
                    email: 'grace@x.com',
                    full_name: 'Grace Hopper',
                    role: ROLES.EMPLOYEE,
                    slack_user_id: null,
                    slack_notifications_enabled: true,
                    push_notifications_enabled: true,
                },
            ])
        );
        publishMock.mockClear();

        await notifyTaskAssigned({
            task_id: new Types.ObjectId(),
            task_title: 'Wire the OAuth callback',
            actor_id: actor,
            assignee_ids: [assignee],
        });

        expect(notificationCreateMock).toHaveBeenCalled();
        expect(publishMock).toHaveBeenCalledWith(['notifications']);
    });

    it('does not notify the person doing the assigning', async () => {
        const { notifyTaskAssigned } = await import('./notification-dispatcher.service.js');
        const actor = new Types.ObjectId();
        notificationCreateMock.mockClear();
        publishMock.mockClear();

        await notifyTaskAssigned({
            task_id: new Types.ObjectId(),
            task_title: 'Self-assigned work',
            actor_id: actor,
            assignee_ids: [actor],
        });

        expect(notificationCreateMock).not.toHaveBeenCalled();
        expect(publishMock).not.toHaveBeenCalled();
    });
});

// ─── Person-affecting admin actions ──────────────────────────────────────
//
// Four events that change something about a person without them doing
// anything — being added to a project, a balance/comp-off adjustment, a
// role change. All four were silent before; the assertions here pin both
// that a row is written and that the actor never notifies themselves.

describe('person-affecting admin dispatchers', () => {
    const projectId = new Types.ObjectId();
    const balanceId = new Types.ObjectId();

    beforeEach(() => {
        userFindOneMock.mockReset();
        userFindOneMock.mockReturnValue(queryReturning(requester));
    });

    it('notifies each added project member but not the actor', async () => {
        await dispatcher.notifyProjectMembersAdded({
            project_id: projectId,
            project_name: 'Apollo',
            actor_id: adminId,
            member_ids: [requesterId, adminId, managerId],
        });

        expect(notificationCreateMock).toHaveBeenCalledTimes(2);
        const row = notificationCreateMock.mock.calls[0][0];
        expect(row.type).toBe('project_member_added');
        expect(row.title).toContain('Apollo');
        expect(row.link_url).toBe(`/projects/${projectId.toString()}`);
    });

    it('notifies the user whose leave balance was adjusted', async () => {
        await dispatcher.notifyLeaveBalanceAdjusted({
            balance_id: balanceId,
            user_id: requesterId,
            actor_id: adminId,
            leave_type_label: 'CL — Casual Leave',
            delta: -2,
            reason: 'correction',
        });

        expect(notificationCreateMock).toHaveBeenCalledTimes(1);
        const row = notificationCreateMock.mock.calls[0][0];
        expect(row.type).toBe('leave_balance_adjusted');
        expect(row.title).toContain('-2');
        expect(row.body).toContain('correction');
    });

    it('stays silent when an admin adjusts their own balance', async () => {
        await dispatcher.notifyLeaveBalanceAdjusted({
            balance_id: balanceId,
            user_id: adminId,
            actor_id: adminId,
            leave_type_label: 'CL — Casual Leave',
            delta: 1,
            reason: 'self',
        });

        expect(notificationCreateMock).not.toHaveBeenCalled();
    });

    it('notifies a comp-off credit with the right verb', async () => {
        await dispatcher.notifyCompOffAdjusted({
            user_id: requesterId,
            actor_id: adminId,
            days: 1,
            direction: 'earned',
            remarks: 'weekend release',
        });

        const row = notificationCreateMock.mock.calls[0][0];
        expect(row.type).toBe('comp_off_adjusted');
        expect(row.title).toBe('1 comp-off day credited');
    });

    it('notifies a role change with the new roles', async () => {
        await dispatcher.notifyRoleChanged({
            user_id: requesterId,
            actor_id: adminId,
            role_labels: ['team_lead'],
        });

        const row = notificationCreateMock.mock.calls[0][0];
        expect(row.type).toBe('role_changed');
        expect(row.body).toContain('team_lead');
    });

    it('never throws when the recipient lookup fails', async () => {
        userFindOneMock.mockImplementation(() => {
            throw new Error('mongo down');
        });

        await expect(
            dispatcher.notifyRoleChanged({
                user_id: requesterId,
                actor_id: adminId,
                role_labels: ['employee'],
            })
        ).resolves.toBeUndefined();
        expect(loggerWarnMock).toHaveBeenCalled();
    });
});
