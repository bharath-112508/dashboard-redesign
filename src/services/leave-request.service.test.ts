import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Types } from 'mongoose';

/**
 * Unit tests for `leave-request.service` (Step 15.1 gap-fill).
 *
 * The service is large; this suite focuses on the lifecycle state-machine
 * (approve / reject / cancel) and balance-reservation refund math, which is
 * where production bugs cause silent balance corruption.
 *
 *  1. Approve — additional-approval-required gate, race-loss → 409, happy
 *     path moves `pending → used` per segment, audit + notification fire.
 *  2. Reject  — happy path refunds reservations (pending → 0), races → 409.
 *  3. Cancel  — already-started approved → 422, non-self cancel by employee
 *     → forbidden, approved-cancel refunds used → available, pending-cancel
 *     just releases reservations, double-cancel is idempotent (no refund).
 */

const {
    leaveRequestFindByIdMock,
    leaveRequestFindOneAndUpdateMock,
    leaveBalanceUpdateOneMock,
    leaveTypeFindByIdMock,
    leaveTypeFindMock,
    holidayFindMock,
    settingsLoadMock,
    notifyDecidedMock,
    recordAuditMock,
} = vi.hoisted(() => ({
    leaveRequestFindByIdMock: vi.fn(),
    leaveRequestFindOneAndUpdateMock: vi.fn(),
    leaveBalanceUpdateOneMock: vi.fn(),
    leaveTypeFindByIdMock: vi.fn(),
    leaveTypeFindMock: vi.fn(),
    holidayFindMock: vi.fn(),
    settingsLoadMock: vi.fn(),
    notifyDecidedMock: vi.fn(),
    recordAuditMock: vi.fn(),
}));

vi.mock('../models/leave-request.model.js', () => ({
    LeaveRequest: {
        findById: leaveRequestFindByIdMock,
        findOneAndUpdate: leaveRequestFindOneAndUpdateMock,
        find: vi.fn(),
        countDocuments: vi.fn(),
        create: vi.fn(),
    },
    LEAVE_REQUEST_STATUSES: {
        PENDING: 'pending',
        APPROVED: 'approved',
        REJECTED: 'rejected',
        CANCELLED: 'cancelled',
    },
}));

vi.mock('../models/leave-balance.model.js', () => ({
    LeaveBalance: {
        find: vi.fn().mockResolvedValue([]),
        updateOne: leaveBalanceUpdateOneMock,
        findOneAndUpdate: vi.fn(),
    },
    recomputeAvailable: vi.fn(),
}));

vi.mock('../models/leave-type.model.js', () => ({
    LeaveType: {
        findById: leaveTypeFindByIdMock,
        find: leaveTypeFindMock,
    },
}));

vi.mock('../models/holiday.model.js', () => ({
    Holiday: { find: holidayFindMock },
}));

vi.mock('../models/sl-monthly-forfeiture.model.js', () => ({
    SlMonthlyForfeiture: { find: vi.fn().mockResolvedValue([]) },
}));

vi.mock('./settings.service.js', () => ({
    getOrInitSettings: settingsLoadMock,
}));

vi.mock('./leave-balance.service.js', () => ({
    findOrInitBalance: vi.fn().mockResolvedValue(null),
    initializeBalancesForUserYear: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./leave-segment.engine.js', () => ({
    generateSegments: vi.fn(),
}));

vi.mock('./notification-dispatcher.service.js', () => ({
    notifyLeaveDecided: notifyDecidedMock,
    notifyLeaveSubmitted: vi.fn(),
}));

vi.mock('./audit.service.js', () => ({
    recordAudit: recordAuditMock,
}));

const svc = await import('./leave-request.service.js');
import { ERROR_CODES } from '../constants/error-codes.js';
import { LEAVE_REQUEST_STATUSES } from '../constants/leave.js';
import { ROLES } from '../constants/roles.js';
import { AUDIT_ACTIONS } from '../constants/audit.js';

const baseRequest = (overrides: Record<string, unknown> = {}) => {
    const _id = new Types.ObjectId();
    const user_id = new Types.ObjectId();
    const lt_id = new Types.ObjectId();
    return {
        _id,
        user_id,
        requested_leave_type_id: lt_id,
        start_date: '2026-12-01',
        end_date: '2026-12-03',
        is_half_day: false,
        half_day_slot: null,
        total_days: 3,
        leave_segments: [{ leave_type_id: lt_id, year: 2026, days: 3 }],
        status: LEAVE_REQUEST_STATUSES.PENDING,
        requires_additional_approval: false,
        approver_id: null,
        approver_remarks: '',
        acted_at: null,
        cancelled_at: null,
        cancelled_by: null,
        cancellation_reason: null,
        toJSON() {
            return { id: this._id.toString(), status: this.status };
        },
        ...overrides,
    };
};

beforeEach(() => {
    vi.resetAllMocks();
    leaveBalanceUpdateOneMock.mockResolvedValue({});
    // LeaveType.findById is used both as a plain promise (resolveType in
    // reserveBalances) and as `.select(...)`-chained inside
    // notifyLeaveDecisionFromRequest. Return a thenable that ALSO has a
    // `.select()` so both call shapes resolve to the same type stub.
    const typeStub = { _id: new Types.ObjectId(), code: 'CL', name: 'Casual Leave' };
    leaveTypeFindByIdMock.mockReturnValue({
        select: () => Promise.resolve(typeStub),
        then: (resolve: (v: unknown) => unknown) => Promise.resolve(typeStub).then(resolve),
    });
    leaveTypeFindMock.mockResolvedValue([]);
    // Holiday.find(...).select(...) — chainable query stub.
    holidayFindMock.mockReturnValue({ select: () => Promise.resolve([]) });
    settingsLoadMock.mockResolvedValue({
        work_schedule: { working_days: [1, 2, 3, 4, 5] },
        leave_policy: { cl_advance_notice_days: 14 },
        default_timezone: 'Asia/Kolkata',
    });
    notifyDecidedMock.mockResolvedValue(undefined);
    recordAuditMock.mockResolvedValue(undefined);
});

// ─── Approve ──────────────────────────────────────────────────────────────

describe('approveLeave', () => {
    const reviewer = { id: new Types.ObjectId(), role: ROLES.MANAGER };

    it('throws ADDITIONAL_APPROVAL_REASON_REQUIRED when the request requires it and reason is missing', async () => {
        const r = baseRequest({ requires_additional_approval: true });
        leaveRequestFindByIdMock.mockResolvedValueOnce(r);

        await expect(svc.approveLeave(r._id, { approver_remarks: '' }, reviewer)).rejects.toMatchObject({
            code: ERROR_CODES.ADDITIONAL_APPROVAL_REASON_REQUIRED,
        });

        expect(leaveRequestFindOneAndUpdateMock).not.toHaveBeenCalled();
        expect(leaveBalanceUpdateOneMock).not.toHaveBeenCalled();
    });

    it('throws conflict when the row is no longer pending (race loss)', async () => {
        const r = baseRequest();
        leaveRequestFindByIdMock.mockResolvedValueOnce(r);
        leaveRequestFindOneAndUpdateMock.mockResolvedValueOnce(null);

        await expect(svc.approveLeave(r._id, { approver_remarks: '' }, reviewer)).rejects.toMatchObject({
            code: ERROR_CODES.CORRECTION_REQUEST_NOT_PENDING,
        });
        expect(leaveBalanceUpdateOneMock).not.toHaveBeenCalled();
    });

    it('happy path: moves pending→used per segment, fires audit + notification', async () => {
        const r = baseRequest({
            leave_segments: [
                { leave_type_id: new Types.ObjectId(), year: 2026, days: 2 },
                { leave_type_id: new Types.ObjectId(), year: 2027, days: 1 },
            ],
            total_days: 3,
        });
        leaveRequestFindByIdMock.mockResolvedValueOnce(r);
        leaveRequestFindOneAndUpdateMock.mockResolvedValueOnce({
            ...r,
            status: LEAVE_REQUEST_STATUSES.APPROVED,
            approver_id: reviewer.id,
            approver_remarks: 'lgtm',
            acted_at: new Date(),
            toJSON: () => ({ id: r._id.toString(), status: 'approved' }),
        });

        const out = await svc.approveLeave(
            r._id,
            { approver_remarks: 'lgtm' },
            { ...reviewer, audit: { actor: { id: reviewer.id, role: reviewer.role } } as never }
        );

        expect(out.status).toBe('approved');
        expect(leaveBalanceUpdateOneMock).toHaveBeenCalledTimes(2);
        expect(leaveBalanceUpdateOneMock).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({ year: 2026, leave_type_id: r.leave_segments[0].leave_type_id }),
            { $inc: { pending: -2, used: 2 } }
        );
        expect(recordAuditMock).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ action: AUDIT_ACTIONS.LEAVE_APPROVE })
        );
        expect(notifyDecidedMock).toHaveBeenCalledWith(
            expect.objectContaining({ decision: 'approved', request_id: r._id })
        );
    });

    it('rejects an employee trying to approve their own leave', async () => {
        const r = baseRequest();
        const selfReviewer = { id: r.user_id, role: ROLES.MANAGER };
        leaveRequestFindByIdMock.mockResolvedValueOnce(r);

        await expect(svc.approveLeave(r._id, { approver_remarks: '' }, selfReviewer)).rejects.toMatchObject({
            code: ERROR_CODES.FORBIDDEN,
        });
    });
});

// ─── Reject ───────────────────────────────────────────────────────────────

describe('rejectLeave', () => {
    const reviewer = { id: new Types.ObjectId(), role: ROLES.ADMIN };

    it('refunds reservations (pending→0, available restored) on success', async () => {
        const r = baseRequest({
            leave_segments: [{ leave_type_id: new Types.ObjectId(), year: 2026, days: 4 }],
            total_days: 4,
        });
        leaveRequestFindByIdMock.mockResolvedValueOnce(r);
        leaveRequestFindOneAndUpdateMock.mockResolvedValueOnce({
            ...r,
            status: LEAVE_REQUEST_STATUSES.REJECTED,
            approver_id: reviewer.id,
            approver_remarks: 'no',
            toJSON: () => ({ id: r._id.toString(), status: 'rejected' }),
        });

        await svc.rejectLeave(r._id, { approver_remarks: 'no' }, reviewer);

        expect(leaveBalanceUpdateOneMock).toHaveBeenCalledWith(expect.objectContaining({ year: 2026 }), {
            $inc: { pending: -4, available: 4 },
        });
        expect(notifyDecidedMock).toHaveBeenCalledWith(expect.objectContaining({ decision: 'rejected' }));
    });

    it('returns 409 if the row is no longer pending', async () => {
        const r = baseRequest();
        leaveRequestFindByIdMock.mockResolvedValueOnce(r);
        leaveRequestFindOneAndUpdateMock.mockResolvedValueOnce(null);

        await expect(svc.rejectLeave(r._id, { approver_remarks: 'x' }, reviewer)).rejects.toMatchObject({
            code: ERROR_CODES.CORRECTION_REQUEST_NOT_PENDING,
        });
    });
});

// ─── Cancel ───────────────────────────────────────────────────────────────

describe('cancelLeave', () => {
    const employee = { id: new Types.ObjectId(), role: ROLES.EMPLOYEE };

    it("forbids cancelling another user's request when caller is an employee", async () => {
        const r = baseRequest({ user_id: new Types.ObjectId() });
        leaveRequestFindByIdMock.mockResolvedValueOnce(r);

        await expect(svc.cancelLeave(r._id, { cancellation_reason: 'no' }, employee)).rejects.toMatchObject({
            code: ERROR_CODES.FORBIDDEN,
        });
    });

    it('returns the request unchanged when already cancelled (idempotent)', async () => {
        const r = baseRequest({ user_id: employee.id, status: LEAVE_REQUEST_STATUSES.CANCELLED });
        leaveRequestFindByIdMock.mockResolvedValueOnce(r);

        const out = await svc.cancelLeave(r._id, { cancellation_reason: 'x' }, employee);

        expect(out.status).toBe(LEAVE_REQUEST_STATUSES.CANCELLED);
        expect(leaveRequestFindOneAndUpdateMock).not.toHaveBeenCalled();
        expect(leaveBalanceUpdateOneMock).not.toHaveBeenCalled();
    });

    it('refuses to cancel an approved leave that has already started', async () => {
        // start_date = yesterday in IST. Use the current date to keep the
        // assertion stable across timezones — we just need start <= today.
        const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
        const r = baseRequest({
            user_id: employee.id,
            status: LEAVE_REQUEST_STATUSES.APPROVED,
            start_date: yesterday,
            end_date: yesterday,
        });
        leaveRequestFindByIdMock.mockResolvedValueOnce(r);

        await expect(svc.cancelLeave(r._id, { cancellation_reason: 'x' }, employee)).rejects.toMatchObject({
            code: ERROR_CODES.LEAVE_ALREADY_CONSUMED,
        });
    });

    it('approved cancel refunds used→available per segment', async () => {
        const future = '2099-01-15';
        const segId = new Types.ObjectId();
        const r = baseRequest({
            user_id: employee.id,
            status: LEAVE_REQUEST_STATUSES.APPROVED,
            start_date: future,
            end_date: future,
            leave_segments: [{ leave_type_id: segId, year: 2099, days: 1 }],
            total_days: 1,
        });
        leaveRequestFindByIdMock.mockResolvedValueOnce(r);
        leaveRequestFindOneAndUpdateMock.mockResolvedValueOnce({
            ...r,
            status: LEAVE_REQUEST_STATUSES.CANCELLED,
            cancelled_at: new Date(),
            cancelled_by: employee.id,
            cancellation_reason: 'plans changed',
            toJSON: () => ({ id: r._id.toString(), status: 'cancelled' }),
        });

        await svc.cancelLeave(r._id, { cancellation_reason: 'plans changed' }, employee);

        expect(leaveBalanceUpdateOneMock).toHaveBeenCalledWith(
            expect.objectContaining({ year: 2099, leave_type_id: segId }),
            { $inc: { used: -1, available: 1 } }
        );
    });

    it('pending cancel releases reservations (pending→0, available restored)', async () => {
        const future = '2099-02-01';
        const segId = new Types.ObjectId();
        const r = baseRequest({
            user_id: employee.id,
            status: LEAVE_REQUEST_STATUSES.PENDING,
            start_date: future,
            end_date: future,
            leave_segments: [{ leave_type_id: segId, year: 2099, days: 2 }],
            total_days: 2,
        });
        leaveRequestFindByIdMock.mockResolvedValueOnce(r);
        leaveRequestFindOneAndUpdateMock.mockResolvedValueOnce({
            ...r,
            status: LEAVE_REQUEST_STATUSES.CANCELLED,
            cancelled_at: new Date(),
            cancelled_by: employee.id,
            cancellation_reason: 'mistake',
            toJSON: () => ({ id: r._id.toString(), status: 'cancelled' }),
        });

        await svc.cancelLeave(r._id, { cancellation_reason: 'mistake' }, employee);

        expect(leaveBalanceUpdateOneMock).toHaveBeenCalledWith(
            expect.objectContaining({ year: 2099, leave_type_id: segId }),
            { $inc: { pending: -2, available: 2 } }
        );
    });

    it('refuses to cancel a rejected leave', async () => {
        const r = baseRequest({
            user_id: employee.id,
            status: LEAVE_REQUEST_STATUSES.REJECTED,
        });
        leaveRequestFindByIdMock.mockResolvedValueOnce(r);

        await expect(svc.cancelLeave(r._id, { cancellation_reason: 'x' }, employee)).rejects.toMatchObject({
            code: ERROR_CODES.CORRECTION_REQUEST_NOT_PENDING,
        });
    });

    it('returns 409 on concurrent status change', async () => {
        const future = '2099-03-01';
        const r = baseRequest({
            user_id: employee.id,
            status: LEAVE_REQUEST_STATUSES.PENDING,
            start_date: future,
            end_date: future,
        });
        leaveRequestFindByIdMock.mockResolvedValueOnce(r);
        leaveRequestFindOneAndUpdateMock.mockResolvedValueOnce(null);

        await expect(svc.cancelLeave(r._id, { cancellation_reason: 'x' }, employee)).rejects.toMatchObject({
            code: ERROR_CODES.CONCURRENT_UPDATE_CONFLICT,
        });
    });
});
