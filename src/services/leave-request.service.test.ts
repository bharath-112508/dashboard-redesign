import { resolvePermissionsForUser } from './role.service.js';

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
    leaveRequestFindMock,
    leaveBalanceUpdateOneMock,
    leaveTypeFindByIdMock,
    leaveTypeFindMock,
    holidayFindMock,
    slForfeitureFindMock,
    settingsLoadMock,
    notifyDecidedMock,
    recordAuditMock,
    userFindMock,
    userFindByIdMock,
} = vi.hoisted(() => ({
    leaveRequestFindByIdMock: vi.fn(),
    leaveRequestFindOneAndUpdateMock: vi.fn(),
    leaveRequestFindMock: vi.fn(),
    leaveBalanceUpdateOneMock: vi.fn(),
    leaveTypeFindByIdMock: vi.fn(),
    leaveTypeFindMock: vi.fn(),
    holidayFindMock: vi.fn(),
    slForfeitureFindMock: vi.fn(),
    settingsLoadMock: vi.fn(),
    notifyDecidedMock: vi.fn(),
    recordAuditMock: vi.fn(),
    userFindMock: vi.fn(),
    userFindByIdMock: vi.fn(),
}));

vi.mock('../models/leave-request.model.js', () => ({
    LeaveRequest: {
        findById: leaveRequestFindByIdMock,
        findOneAndUpdate: leaveRequestFindOneAndUpdateMock,
        find: leaveRequestFindMock,
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

vi.mock('../models/user.model.js', () => ({
    User: { find: userFindMock, findById: userFindByIdMock },
}));

/** Stub `User.find(...).distinct('_id')` → the given report ids. */
const stubDirectReports = (ids: Types.ObjectId[]) => {
    userFindMock.mockReturnValue({ distinct: () => Promise.resolve(ids) });
};
/** Stub `User.findById(...).select(...).lean()` → a reporting_manager_id. */
const stubReportingManager = (managerId: Types.ObjectId | null) => {
    userFindByIdMock.mockReturnValue({
        select: () => ({ lean: () => Promise.resolve({ internal_profile: { reporting_manager_id: managerId } }) }),
    });
};

vi.mock('../models/sl-monthly-forfeiture.model.js', () => ({
    SlMonthlyForfeiture: { find: slForfeitureFindMock },
}));

vi.mock('./settings.service.js', () => ({
    getOrInitSettings: settingsLoadMock,
}));

vi.mock('./leave-balance.service.js', () => ({
    findOrInitBalance: vi.fn().mockResolvedValue(null),
    initializeBalancesForUserYear: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./leave-segment.engine.js', async () => {
    // Forward the real `enumerateWorkingDays` (pure helper used by
    // `buildSlMonthUsedMap`) while keeping `generateSegments` stubbed.
    const actual = await vi.importActual<typeof import('./leave-segment.engine.js')>('./leave-segment.engine.js');
    return {
        ...actual,
        generateSegments: vi.fn(),
    };
});

vi.mock('./notification-dispatcher.service.js', () => ({
    notifyLeaveDecided: notifyDecidedMock,
    notifyLeaveSubmitted: vi.fn(),
}));

// The approve/reject/cancel guards now ask for effective PERMISSIONS rather
// than reading the stale `caller.role` field, so this module is on the write
// path. Default: the caller holds the reviewer permission; individual tests
// override it to assert a refusal.
vi.mock('./role.service.js', () => ({
    resolvePermissionsForUser: vi.fn(async () => ({
        permissions: ['leave_request.approve', 'system.admin'],
    })),
}));

vi.mock('./audit.service.js', () => ({
    recordAudit: recordAuditMock,
}));

const svc = await import('./leave-request.service.js');
import { LeaveRequest } from '../models/leave-request.model.js';
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
    slForfeitureFindMock.mockResolvedValue([]);
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
    // Admin reviewer — bypasses reporting-chain scoping, so these tests stay
    // focused on approval mechanics. Manager/report scoping is tested separately.
    const reviewer = { id: new Types.ObjectId(), role: ROLES.ADMIN };

    it('throws ADDITIONAL_APPROVAL_REASON_REQUIRED when the request requires it and reason is missing', async () => {
        const r = baseRequest({ requires_additional_approval: true });
        leaveRequestFindByIdMock.mockResolvedValueOnce(r);

        await expect(svc.approveLeave(r._id, { approver_remarks: '' }, reviewer)).rejects.toMatchObject({
            code: ERROR_CODES.ADDITIONAL_APPROVAL_REASON_REQUIRED,
        });

        expect(leaveRequestFindOneAndUpdateMock).not.toHaveBeenCalled();
        expect(leaveBalanceUpdateOneMock).not.toHaveBeenCalled();
    });

    it('MANAGER: cannot approve a request from a NON-report (forbidden)', async () => {
        const manager = { id: new Types.ObjectId(), role: ROLES.MANAGER };
        // Reviewer permission WITHOUT the admin wildcard, so the
        // direct-report scoping below is the thing under test.
        vi.mocked(resolvePermissionsForUser).mockResolvedValue({
            permissions: ['leave_request.approve'],
        } as never);
        const r = baseRequest();
        leaveRequestFindByIdMock.mockResolvedValueOnce(r);
        stubReportingManager(new Types.ObjectId()); // requester reports to someone else
        await expect(svc.approveLeave(r._id, { approver_remarks: '' }, manager)).rejects.toMatchObject({
            statusCode: 403,
        });
        expect(leaveRequestFindOneAndUpdateMock).not.toHaveBeenCalled();
    });

    it('MANAGER: CAN review a direct report (passes the scope guard)', async () => {
        const manager = { id: new Types.ObjectId(), role: ROLES.MANAGER };
        // Reviewer permission WITHOUT the admin wildcard, so the
        // direct-report scoping below is the thing under test.
        vi.mocked(resolvePermissionsForUser).mockResolvedValue({
            permissions: ['leave_request.approve'],
        } as never);
        const r = baseRequest();
        leaveRequestFindByIdMock.mockResolvedValueOnce(r);
        stubReportingManager(manager.id); // requester reports to THIS manager
        leaveRequestFindOneAndUpdateMock.mockResolvedValueOnce(null); // race → proves auth passed
        await expect(svc.approveLeave(r._id, { approver_remarks: '' }, manager)).rejects.toMatchObject({
            code: ERROR_CODES.CORRECTION_REQUEST_NOT_PENDING,
        });
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

    it('refuses a reviewer whose legacy role is stale but whose permissions were narrowed', async () => {
        // The bug this guards: `role.service:assignRolesToUser` writes the
        // legacy `User.role` from SYSTEM role keys only, so assigning a user
        // ONLY custom roles leaves the old string in place. A team lead moved
        // to a custom role WITHOUT `leave_request.approve` still reads as
        // 'team_lead'. The HTTP route refused them via requirePermission; this
        // service guard used to wave them through on the role string, giving
        // no defence in depth — they could approve someone else's leave and
        // move that person's balance.
        const staleTeamLead = { id: new Types.ObjectId(), role: ROLES.TEAM_LEAD };
        vi.mocked(resolvePermissionsForUser).mockResolvedValue({ permissions: [] } as never);
        const r = baseRequest({ user_id: new Types.ObjectId() });
        leaveRequestFindByIdMock.mockResolvedValueOnce(r);

        await expect(svc.approveLeave(r._id, {} as never, staleTeamLead as never)).rejects.toMatchObject({
            code: ERROR_CODES.FORBIDDEN,
        });
    });

    it('rejects an employee trying to approve their own leave', async () => {
        const r = baseRequest();
        const selfReviewer = { id: r.user_id, role: ROLES.MANAGER };
        leaveRequestFindByIdMock.mockResolvedValueOnce(r);

        await expect(svc.approveLeave(r._id, { approver_remarks: '' }, selfReviewer)).rejects.toMatchObject({
            code: ERROR_CODES.FORBIDDEN,
        });
    });

    // ─── H2: status flip + balance moves are atomic ────────────────────
    //
    // Pre-H2 the PENDING→APPROVED `findOneAndUpdate` and the per-segment
    // `pending → used` balance updates were two separate writes. A
    // network partition between them left the request approved while
    // the balance was still `pending` — silent +N inflation of
    // available balance until someone noticed.
    //
    // Post-H2 both run inside a single `withTransaction`. In production
    // (replica set), a balance-update failure rolls back the status
    // flip too. In the test environment, `withTransaction` falls back
    // to running the callback without a session, so we can verify the
    // error path but not the transactional rollback itself — the
    // Mongo-side rollback belongs in an integration test against a
    // real replica set.
    it('H2: balance-update failure aborts approve and propagates the error', async () => {
        const r = baseRequest({
            leave_segments: [
                { leave_type_id: new Types.ObjectId(), year: 2026, days: 2 },
                { leave_type_id: new Types.ObjectId(), year: 2026, days: 3 },
            ],
            total_days: 5,
        });
        leaveRequestFindByIdMock.mockResolvedValueOnce(r);
        leaveRequestFindOneAndUpdateMock.mockResolvedValueOnce({
            ...r,
            status: LEAVE_REQUEST_STATUSES.APPROVED,
            toJSON: () => ({ id: r._id.toString(), status: 'approved' }),
        });

        // First balance update succeeds; second throws — simulates a
        // mid-loop network partition or constraint violation.
        const balanceErr = new Error('balance write failed');
        leaveBalanceUpdateOneMock.mockResolvedValueOnce({ acknowledged: true }).mockRejectedValueOnce(balanceErr);

        await expect(
            svc.approveLeave(
                r._id,
                { approver_remarks: 'lgtm' },
                { ...reviewer, audit: { actor: { id: reviewer.id, role: reviewer.role } } as never }
            )
        ).rejects.toBe(balanceErr);

        // The status flip ran (it's the first write inside the tx
        // callback). The first segment's balance update ran. The
        // second segment's balance update threw. Audit + notification
        // live OUTSIDE the tx so they should NOT have fired since we
        // aborted before reaching them.
        expect(leaveRequestFindOneAndUpdateMock).toHaveBeenCalledTimes(1);
        expect(leaveBalanceUpdateOneMock).toHaveBeenCalledTimes(2);
        expect(recordAuditMock).not.toHaveBeenCalled();
        expect(notifyDecidedMock).not.toHaveBeenCalled();
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
        // An employee holds no reviewer permission. This is the assertion the
        // stale-`role` version could not make honestly: it refused on the role
        // string, so a demoted reviewer whose legacy role still said
        // 'team_lead' would have passed.
        vi.mocked(resolvePermissionsForUser).mockResolvedValue({ permissions: [] } as never);

        await expect(svc.cancelLeave(r._id, { cancellation_reason: 'no' }, employee)).rejects.toMatchObject({
            code: ERROR_CODES.FORBIDDEN,
        });
    });

    it('refuses a reviewer cancelling a NON-report', async () => {
        // Cancel used to require the permission but NO reporting-chain
        // scoping, so a manager could cancel a request they were not allowed
        // to approve. It now shares approve/reject's guard.
        const manager = { id: new Types.ObjectId(), role: ROLES.MANAGER };
        vi.mocked(resolvePermissionsForUser).mockResolvedValue({
            permissions: ['leave_request.approve'],
        } as never);
        stubReportingManager(new Types.ObjectId()); // reports to someone else
        const r = baseRequest({ user_id: new Types.ObjectId() });
        leaveRequestFindByIdMock.mockResolvedValueOnce(r);

        await expect(svc.cancelLeave(r._id, { cancellation_reason: 'no' }, manager as never)).rejects.toMatchObject({
            code: ERROR_CODES.FORBIDDEN,
        });
    });

    it("allows a reviewer to cancel their OWN direct report's request", async () => {
        const manager = { id: new Types.ObjectId(), role: ROLES.MANAGER };
        vi.mocked(resolvePermissionsForUser).mockResolvedValue({
            permissions: ['leave_request.approve'],
        } as never);
        stubReportingManager(manager.id); // reports to THIS manager
        const r = baseRequest({ user_id: new Types.ObjectId() });
        leaveRequestFindByIdMock.mockResolvedValueOnce(r);
        leaveRequestFindOneAndUpdateMock.mockResolvedValueOnce(null); // race → proves auth passed

        await expect(svc.cancelLeave(r._id, { cancellation_reason: 'ok' }, manager as never)).rejects.toMatchObject({
            statusCode: 409,
        });
        // Reaching the CAS at all is the point: authorization let them
        // through, unlike the NON-report case above which never gets here.
        expect(leaveRequestFindOneAndUpdateMock).toHaveBeenCalled();
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

// ─── C4 — buildSlMonthUsedMap re-derive month-by-month ────────────────────

describe('buildSlMonthUsedMap — C4 month attribution', () => {
    const userId = new Types.ObjectId();
    const slTypeId = new Types.ObjectId();
    const workingDays = [1, 2, 3, 4, 5] as const;
    const holidays = new Set<string>();

    /** Build a mock LeaveRequest doc with SL segment + `created_at`. */
    const mkReq = (overrides: {
        start_date: string;
        end_date: string;
        sl_days: number;
        year: number;
        created_at: Date;
    }) => ({
        start_date: overrides.start_date,
        end_date: overrides.end_date,
        leave_segments: [
            {
                leave_type_id: slTypeId,
                year: overrides.year,
                days: overrides.sl_days,
                equals: (id: Types.ObjectId) => id.equals(slTypeId),
            },
        ],
        created_at: overrides.created_at,
    });

    /** Stub `LeaveRequest.find(...).sort(...)` to resolve to `docs`. */
    const stubFind = (docs: ReturnType<typeof mkReq>[]) => {
        leaveRequestFindMock.mockReturnValueOnce({
            sort: () =>
                Promise.resolve(
                    docs.map((d) => ({
                        ...d,
                        leave_segments: d.leave_segments.map((s) => ({
                            leave_type_id: {
                                equals: (id: Types.ObjectId) => id.equals(slTypeId),
                            },
                            year: s.year,
                            days: s.days,
                        })),
                    }))
                ),
        });
    };

    it('attributes a single-month SL request to that month only', async () => {
        // Feb 16 (Mon) single-day SL; slDays=1.
        stubFind([
            mkReq({
                start_date: '2026-02-16',
                end_date: '2026-02-16',
                sl_days: 1,
                year: 2026,
                created_at: new Date('2026-02-10T00:00:00Z'),
            }),
        ]);

        const out = await svc.buildSlMonthUsedMap({
            user_id: userId,
            sl_type_id: slTypeId,
            yearsTouched: [2026],
            workingDays,
            holidays,
        });

        expect(out.get('2026-2')).toBe(1);
        expect(out.has('2026-1')).toBe(false);
    });

    it('distributes a cross-month SL span chronologically (Jan 30 → Feb 2, slDays=2 → 1 Jan + 1 Feb)', async () => {
        // Jan 30 Fri, Jan 31 Sat (off), Feb 1 Sun (off), Feb 2 Mon.
        // Working days = {Jan 30, Feb 2}. Engine would assign SL Jan +
        // SL Feb (1 each, slots_per_month=1).
        // Bug-prone case: pre-C4 the helper put both SL days under Jan.
        stubFind([
            mkReq({
                start_date: '2026-01-30',
                end_date: '2026-02-02',
                sl_days: 2,
                year: 2026,
                created_at: new Date('2026-01-25T00:00:00Z'),
            }),
        ]);

        const out = await svc.buildSlMonthUsedMap({
            user_id: userId,
            sl_type_id: slTypeId,
            yearsTouched: [2026],
            workingDays,
            holidays,
        });

        // Expected: Jan and Feb each take 1 SL slot.
        expect(out.get('2026-1')).toBe(1);
        expect(out.get('2026-2')).toBe(1);
    });

    it('replays chronologically so a later cross-month request skips an already-exhausted earlier month', async () => {
        // Request A — Jan 15 (Thu) SL, slDays=1, created_at 2026-01-10.
        // Request B — Jan 28 (Wed) → Mar 4 (Wed), slDays=2,
        //              created_at 2026-01-20.
        //
        // After replay, sl_used[Jan] = 1 (from A). When B is processed,
        // the Jan slot is exhausted; B's 2 SL must spill to Feb + Mar.
        stubFind([
            mkReq({
                start_date: '2026-01-15',
                end_date: '2026-01-15',
                sl_days: 1,
                year: 2026,
                created_at: new Date('2026-01-10T00:00:00Z'),
            }),
            mkReq({
                start_date: '2026-01-28',
                end_date: '2026-03-04',
                sl_days: 2,
                year: 2026,
                created_at: new Date('2026-01-20T00:00:00Z'),
            }),
        ]);

        const out = await svc.buildSlMonthUsedMap({
            user_id: userId,
            sl_type_id: slTypeId,
            yearsTouched: [2026],
            workingDays,
            holidays,
        });

        // Jan stays at 1 (only A); B's 2 SL spill into Feb + Mar.
        expect(out.get('2026-1')).toBe(1);
        expect(out.get('2026-2')).toBe(1);
        expect(out.get('2026-3')).toBe(1);
    });

    it('attributes a half-day SL (0.5 stored) to the request day month', async () => {
        // Single half-day on Mar 18 (Wed). slDays=0.5.
        stubFind([
            mkReq({
                start_date: '2026-03-18',
                end_date: '2026-03-18',
                sl_days: 0.5,
                year: 2026,
                created_at: new Date('2026-03-15T00:00:00Z'),
            }),
        ]);

        const out = await svc.buildSlMonthUsedMap({
            user_id: userId,
            sl_type_id: slTypeId,
            yearsTouched: [2026],
            workingDays,
            holidays,
        });

        expect(out.get('2026-3')).toBe(0.5);
    });

    it('merges SlMonthlyForfeiture rows on top of replayed allocations', async () => {
        // No live SL requests, just a forfeiture row.
        stubFind([]);
        slForfeitureFindMock.mockResolvedValueOnce([{ user_id: userId, year: 2026, month: 4, forfeited_days: 1 }]);

        const out = await svc.buildSlMonthUsedMap({
            user_id: userId,
            sl_type_id: slTypeId,
            yearsTouched: [2026],
            workingDays,
            holidays,
        });

        expect(out.get('2026-4')).toBe(1);
    });
});

// ─── listLeaves — reviewer self-exclusion (bug 3) ──────────────────────────

describe('listLeaves — reviewer approvals queue', () => {
    const stubFindReturningEmpty = (capture: (filter: Record<string, unknown>) => void) => {
        leaveRequestFindMock.mockImplementation((filter: Record<string, unknown>) => {
            capture(filter);
            return { sort: () => ({ skip: () => ({ limit: () => Promise.resolve([]) }) }) };
        });
        vi.mocked(LeaveRequest.countDocuments).mockResolvedValue(0 as never);
    };

    // The queue used to sort by `start_date`, so a request filed this morning
    // for next week ranked below one filed last month for next year and the
    // newest submissions weren't at the top. Nothing asserted the order, so
    // pin it here.
    it('orders newest SUBMISSION first, tiebroken by _id', async () => {
        let sortArg: Record<string, number> = {};
        leaveRequestFindMock.mockImplementation(() => ({
            sort: (arg: Record<string, number>) => {
                sortArg = arg;
                return { skip: () => ({ limit: () => Promise.resolve([]) }) };
            },
        }));
        vi.mocked(LeaveRequest.countDocuments).mockResolvedValue(0 as never);

        await svc.listLeaves({ page: 1, limit: 50 } as never, {
            id: new Types.ObjectId(),
            role: ROLES.ADMIN,
        });

        expect(sortArg).toEqual({ created_at: -1, _id: -1 });
    });

    it("ADMIN: excludes their OWN requests from the queue (can't self-approve)", async () => {
        const reviewerId = new Types.ObjectId();
        let filter: Record<string, unknown> = {};
        stubFindReturningEmpty((f) => (filter = f));

        await svc.listLeaves({ page: 1, limit: 50 } as never, { id: reviewerId, role: ROLES.ADMIN });

        expect(filter.user_id).toEqual({ $ne: reviewerId });
    });

    it('ADMIN: honours a positive user_id filter instead of excluding self', async () => {
        const reviewerId = new Types.ObjectId();
        const targetId = new Types.ObjectId();
        let filter: Record<string, unknown> = {};
        stubFindReturningEmpty((f) => (filter = f));

        await svc.listLeaves({ page: 1, limit: 50, user_id: targetId.toString() } as never, {
            id: reviewerId,
            role: ROLES.ADMIN,
        });

        expect(filter.user_id).toEqual(targetId);
    });

    it('MANAGER: is scoped to ONLY their direct reports', async () => {
        const managerId = new Types.ObjectId();
        const reportA = new Types.ObjectId();
        const reportB = new Types.ObjectId();
        stubDirectReports([reportA, reportB]);
        let filter: Record<string, unknown> = {};
        stubFindReturningEmpty((f) => (filter = f));

        await svc.listLeaves({ page: 1, limit: 50 } as never, { id: managerId, role: ROLES.MANAGER });

        expect(filter.user_id).toEqual({ $in: [reportA, reportB] });
    });

    it('MANAGER: drilling into a NON-report returns nothing', async () => {
        const managerId = new Types.ObjectId();
        const someoneElse = new Types.ObjectId();
        stubDirectReports([new Types.ObjectId()]); // reports, but not `someoneElse`
        let filter: Record<string, unknown> = {};
        stubFindReturningEmpty((f) => (filter = f));

        await svc.listLeaves({ page: 1, limit: 50, user_id: someoneElse.toString() } as never, {
            id: managerId,
            role: ROLES.MANAGER,
        });

        expect(filter.user_id).toEqual({ $in: [] });
    });

    it('scopes an employee to ONLY their own requests', async () => {
        const employeeId = new Types.ObjectId();
        let filter: Record<string, unknown> = {};
        stubFindReturningEmpty((f) => (filter = f));

        await svc.listLeaves({ page: 1, limit: 50 } as never, { id: employeeId, role: ROLES.EMPLOYEE });

        expect(filter.user_id).toEqual(employeeId);
    });
});
