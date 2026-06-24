import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Types } from 'mongoose';

import { ROLES } from '../constants/roles.js';
import { USER_STATUSES } from '../constants/user-statuses.js';
import { LEAVE_REQUEST_STATUSES } from '../constants/leave.js';

/**
 * Unit tests for the dashboard aggregation service (Step 13).
 *
 * The service composes read-only Mongoose calls into role-shaped payloads.
 * Logic worth covering at the unit level:
 *   1. Headcount aggregation maps `(role, status)` rows into the contract
 *      shape, with single-admin invariance observable in `by_role.admin`.
 *   2. Attendance "today" pivots `status` counts and surfaces the flagged
 *      total.
 *   3. Manager dashboard scopes pending-leave counts to direct reports,
 *      and admins fall through to the org-wide count.
 *   4. The `safeCard` wrapper guarantees a single failing aggregation can
 *      not crash the whole landing page — the card defaults to its empty
 *      shape and the warn logger is invoked.
 *
 * Cross-collection wiring (router → controller → service) is exercised by
 * the existing smoke harnesses; we deliberately stay in-process here to
 * keep the suite fast and deterministic.
 */

// ─── Hoisted mocks (vitest factories run before module-scope consts) ──────

const {
    userAggregateMock,
    userCountMock,
    userFindMock,
    attendanceAggregateMock,
    attendanceCountMock,
    attendanceFindOneMock,
    leaveCountMock,
    leaveFindMock,
    leaveBalanceFindMock,
    leaveTypeFindMock,
    holidayCountMock,
    notificationCountMock,
    projectFindMock,
    taskAggregateMock,
    taskFindMock,
    initializeBalancesMock,
    loggerWarnMock,
} = vi.hoisted(() => ({
    userAggregateMock: vi.fn(),
    userCountMock: vi.fn(),
    userFindMock: vi.fn(),
    attendanceAggregateMock: vi.fn(),
    attendanceCountMock: vi.fn(),
    attendanceFindOneMock: vi.fn(),
    leaveCountMock: vi.fn(),
    leaveFindMock: vi.fn(),
    leaveBalanceFindMock: vi.fn(),
    leaveTypeFindMock: vi.fn(),
    holidayCountMock: vi.fn(),
    notificationCountMock: vi.fn(),
    projectFindMock: vi.fn(),
    taskAggregateMock: vi.fn(),
    taskFindMock: vi.fn(),
    initializeBalancesMock: vi.fn(),
    loggerWarnMock: vi.fn(),
}));

vi.mock('../models/user.model.js', () => ({
    User: {
        aggregate: userAggregateMock,
        countDocuments: userCountMock,
        find: userFindMock,
    },
}));

vi.mock('../models/attendance-record.model.js', () => ({
    AttendanceRecord: {
        aggregate: attendanceAggregateMock,
        countDocuments: attendanceCountMock,
        findOne: attendanceFindOneMock,
    },
}));

vi.mock('../models/leave-request.model.js', () => ({
    LeaveRequest: {
        countDocuments: leaveCountMock,
        find: leaveFindMock,
    },
}));

vi.mock('../models/leave-balance.model.js', () => ({
    LeaveBalance: {
        find: leaveBalanceFindMock,
    },
}));

vi.mock('../models/leave-type.model.js', () => ({
    LeaveType: {
        find: leaveTypeFindMock,
    },
}));

vi.mock('../models/holiday.model.js', () => ({
    Holiday: {
        countDocuments: holidayCountMock,
    },
}));

vi.mock('../models/notification.model.js', () => ({
    Notification: {
        countDocuments: notificationCountMock,
    },
}));

vi.mock('../models/project.model.js', () => ({
    Project: {
        find: projectFindMock,
    },
}));

vi.mock('../models/task.model.js', () => ({
    Task: {
        aggregate: taskAggregateMock,
        find: taskFindMock,
    },
}));

vi.mock('./leave-balance.service.js', () => ({
    initializeBalancesForUserYear: initializeBalancesMock,
}));

vi.mock('../utils/logger.js', () => ({
    default: { warn: loggerWarnMock, info: vi.fn() },
}));

const dashboard = await import('./dashboard.service.js');

// ─── Tiny chainable Query stub ────────────────────────────────────────────
//
// Mongoose `Model.find().sort().limit()` chains are only used for
// `LeaveRequest`, `LeaveBalance`, `LeaveType`, and `User.find().select(...)`.
// All chainable methods just return the same stub; the terminal `.then` (or
// the cast to array) returns the configured rows.

const queryStub = (rows: unknown[]) => {
    const stub: Record<string, unknown> = {
        sort: () => stub,
        limit: () => stub,
        select: () => stub,
        lean: () => Promise.resolve(rows),
        then: (resolve: (v: unknown) => void) => Promise.resolve(rows).then(resolve),
    };
    return stub;
};

beforeEach(() => {
    userAggregateMock.mockReset();
    userCountMock.mockReset();
    userFindMock.mockReset();
    attendanceAggregateMock.mockReset();
    attendanceCountMock.mockReset();
    attendanceFindOneMock.mockReset();
    leaveCountMock.mockReset();
    leaveFindMock.mockReset();
    leaveBalanceFindMock.mockReset();
    leaveTypeFindMock.mockReset();
    holidayCountMock.mockReset();
    notificationCountMock.mockReset();
    projectFindMock.mockReset();
    taskAggregateMock.mockReset();
    taskFindMock.mockReset();
    initializeBalancesMock.mockReset();
    loggerWarnMock.mockReset();

    initializeBalancesMock.mockResolvedValue(0);
});

// ─── Admin dashboard ──────────────────────────────────────────────────────

describe('buildAdminDashboard', () => {
    it('rolls headcount up by role + status with single-admin invariance', async () => {
        userAggregateMock.mockResolvedValueOnce([
            { _id: { role: ROLES.ADMIN, status: USER_STATUSES.ACTIVE }, count: 1 },
            { _id: { role: ROLES.MANAGER, status: USER_STATUSES.ACTIVE }, count: 3 },
            { _id: { role: ROLES.EMPLOYEE, status: USER_STATUSES.ACTIVE }, count: 12 },
            { _id: { role: ROLES.CLIENT, status: USER_STATUSES.ACTIVE }, count: 4 },
            { _id: { role: ROLES.EMPLOYEE, status: USER_STATUSES.DEACTIVATED }, count: 2 },
        ]);
        attendanceAggregateMock.mockResolvedValueOnce([
            { _id: 'present', count: 9 },
            { _id: 'on_leave', count: 2 },
            { _id: 'incomplete', count: 1 },
        ]);
        attendanceCountMock.mockResolvedValueOnce(1); // flagged_for_correction
        userCountMock.mockResolvedValueOnce(16); // total internal active
        leaveCountMock
            .mockResolvedValueOnce(4) // pending count
            .mockResolvedValueOnce(1); // requires_additional_approval
        leaveFindMock.mockReturnValueOnce(queryStub([])); // pending recent
        holidayCountMock.mockResolvedValueOnce(2);

        const result = await dashboard.buildAdminDashboard(['system.admin']);

        expect(result.headcount!.active).toBe(20);
        expect(result.headcount!.deactivated).toBe(2);
        expect(result.headcount!.by_role.admin).toBe(1);
        expect(result.headcount!.by_role.manager).toBe(3);
        expect(result.headcount!.by_role.employee).toBe(12);
        expect(result.headcount!.by_role.client).toBe(4);

        expect(result.attendance_today!.present).toBe(9);
        expect(result.attendance_today!.on_leave).toBe(2);
        expect(result.attendance_today!.incomplete).toBe(1);
        expect(result.attendance_today!.flagged_for_correction).toBe(1);
        expect(result.attendance_today!.total_internal_active).toBe(16);

        expect(result.pending_leave_approvals!.count).toBe(4);
        expect(result.pending_leave_approvals!.requires_additional_approval).toBe(1);
        expect(result.holidays_this_month).toBe(2);
        expect(typeof result.generated_at).toBe('string');
    });

    it('substitutes empty shape and logs when an aggregation throws', async () => {
        userAggregateMock.mockRejectedValueOnce(new Error('boom'));
        attendanceAggregateMock.mockResolvedValueOnce([]);
        attendanceCountMock.mockResolvedValueOnce(0);
        userCountMock.mockResolvedValueOnce(0);
        leaveCountMock.mockResolvedValueOnce(0).mockResolvedValueOnce(0);
        leaveFindMock.mockReturnValueOnce(queryStub([]));
        holidayCountMock.mockResolvedValueOnce(0);

        const result = await dashboard.buildAdminDashboard(['system.admin']);

        expect(result.headcount!.active).toBe(0);
        expect(result.headcount!.deactivated).toBe(0);
        expect(result.headcount!.by_role.admin).toBe(0);
        expect(loggerWarnMock).toHaveBeenCalledWith(
            expect.objectContaining({ card: 'admin.headcount' }),
            'Dashboard card aggregation failed'
        );
    });

    it('omits sections the caller lacks perms for', async () => {
        // Only attendance.read_team held — no user.read, no leave_request.approve, no holiday.read
        attendanceAggregateMock.mockResolvedValueOnce([]);
        attendanceCountMock.mockResolvedValueOnce(0);
        userCountMock.mockResolvedValueOnce(0);

        const out = await dashboard.buildAdminDashboard(['attendance.read_team']);

        expect(out.headcount).toBeUndefined();
        expect(out.pending_leave_approvals).toBeUndefined();
        expect(out.holidays_this_month).toBeUndefined();
        expect(out.attendance_today).toBeDefined();
    });

    it('system.admin keeps the full payload', async () => {
        userAggregateMock.mockResolvedValueOnce([]);
        attendanceAggregateMock.mockResolvedValueOnce([]);
        attendanceCountMock.mockResolvedValueOnce(0);
        userCountMock.mockResolvedValueOnce(0);
        leaveCountMock.mockResolvedValueOnce(0).mockResolvedValueOnce(0);
        leaveFindMock.mockReturnValueOnce(queryStub([]));
        holidayCountMock.mockResolvedValueOnce(0);

        const out = await dashboard.buildAdminDashboard(['system.admin']);

        expect(out.headcount).toBeDefined();
        expect(out.pending_leave_approvals).toBeDefined();
        expect(out.attendance_today).toBeDefined();
        expect(out.holidays_this_month).toBeDefined();
    });
});

// ─── Manager dashboard ────────────────────────────────────────────────────

describe('buildManagerDashboard', () => {
    it('admins get the org-wide pending count and `scope=org`', async () => {
        leaveCountMock.mockResolvedValueOnce(7).mockResolvedValueOnce(2);
        leaveFindMock.mockReturnValueOnce(queryStub([]));
        userCountMock.mockResolvedValueOnce(42);

        const result = await dashboard.buildManagerDashboard({ id: new Types.ObjectId(), role: ROLES.ADMIN }, [
            'system.admin',
        ]);

        expect(result.scope).toBe('org');
        expect(result.team_size).toBe(42);
        expect(result.pending_leave_approvals!.count).toBe(7);
        expect(result.pending_leave_approvals!.requires_additional_approval).toBe(2);
    });

    it('managers see org-wide data — pending count is NOT scoped to a team (read_team is org-wide today)', async () => {
        const managerId = new Types.ObjectId();

        userCountMock.mockResolvedValueOnce(9);
        leaveCountMock.mockResolvedValueOnce(3).mockResolvedValueOnce(0);
        leaveFindMock.mockReturnValueOnce(queryStub([]));

        const result = await dashboard.buildManagerDashboard({ id: managerId, role: ROLES.MANAGER }, [
            'leave_request.approve',
        ]);

        expect(result.scope).toBe('org');
        expect(result.team_size).toBe(9);
        expect(result.pending_leave_approvals!.count).toBe(3);

        // No reporting_manager_id resolution and no `user_id` team filter on the
        // pending-count call — the scope is org-wide.
        expect(userFindMock).not.toHaveBeenCalled();
        const filter = leaveCountMock.mock.calls[0][0] as { user_id?: unknown; status?: string };
        expect(filter.status).toBe(LEAVE_REQUEST_STATUSES.PENDING);
        expect(filter.user_id).toBeUndefined();
    });

    it('team-leads are scoped to their projects — team_size = project members, pending excludes self', async () => {
        const leadId = new Types.ObjectId();
        const member2 = new Types.ObjectId();
        const projectId = new Types.ObjectId();

        // resolveTeamLeadScope → Project.find({ member_ids }).select().lean()
        projectFindMock.mockReturnValueOnce(queryStub([{ _id: projectId, member_ids: [leadId, member2] }]));
        leaveCountMock.mockResolvedValueOnce(2).mockResolvedValueOnce(0);
        leaveFindMock.mockReturnValueOnce(queryStub([]));

        const result = await dashboard.buildManagerDashboard({ id: leadId, role: ROLES.TEAM_LEAD }, [
            'leave_request.approve',
        ]);

        expect(result.scope).toBe('team');
        expect(result.team_size).toBe(2); // lead + member2
        expect(result.pending_leave_approvals!.count).toBe(2);

        // Pending-approval query is scoped to project members, EXCLUDING the lead.
        const filter = leaveCountMock.mock.calls[0][0] as { user_id?: { $in: Types.ObjectId[] } };
        expect(filter.user_id?.$in?.map(String)).toEqual([member2.toString()]);
        // Org-wide headcount path is NOT taken.
        expect(userCountMock).not.toHaveBeenCalled();
    });

    it('without LEAVE_REQUEST_APPROVE, pending_leave_approvals is absent but team_size is present', async () => {
        userCountMock.mockResolvedValueOnce(11);

        const result = await dashboard.buildManagerDashboard(
            { id: new Types.ObjectId(), role: ROLES.MANAGER },
            ['dashboard.manager'] // no leave_request.approve
        );

        expect(result.scope).toBe('org');
        expect(result.team_size).toBe(11);
        expect(result.pending_leave_approvals).toBeUndefined();
        expect(leaveCountMock).not.toHaveBeenCalled();
    });
});

// ─── Employee dashboard ───────────────────────────────────────────────────

describe('buildEmployeeDashboard', () => {
    it('returns empty `today.attendance` when no record exists for today', async () => {
        const userId = new Types.ObjectId();

        attendanceFindOneMock.mockResolvedValueOnce(null);
        leaveBalanceFindMock.mockReturnValueOnce(queryStub([]));
        leaveFindMock.mockReturnValueOnce(queryStub([]));
        notificationCountMock.mockResolvedValueOnce(0);

        const result = await dashboard.buildEmployeeDashboard(userId);

        expect(result.user_id).toBe(userId.toString());
        expect(result.today.attendance.checked_in).toBe(false);
        expect(result.today.attendance.checked_out).toBe(false);
        expect(result.today.attendance.status).toBeNull();
        expect(result.leave_balances).toEqual([]);
        expect(result.recent_leaves).toEqual([]);
        expect(result.unread_notifications).toBe(0);
        expect(initializeBalancesMock).toHaveBeenCalledWith(expect.objectContaining({ user_id: userId }));
    });

    it('joins balances with their leave-type code/name', async () => {
        const userId = new Types.ObjectId();
        const typeId = new Types.ObjectId();

        attendanceFindOneMock.mockResolvedValueOnce({
            check_in: { time: new Date('2026-04-24T03:30:00Z') },
            check_out: null,
            status: 'present',
            flagged_for_correction: false,
        });
        leaveBalanceFindMock.mockReturnValueOnce(
            queryStub([{ leave_type_id: typeId, allocated: 12, used: 2, pending: 1, available: 9 }])
        );
        leaveTypeFindMock.mockResolvedValueOnce([{ _id: typeId, code: 'CL', name: 'Casual Leave' }]);
        leaveFindMock.mockReturnValueOnce(
            queryStub([
                {
                    _id: new Types.ObjectId(),
                    requested_leave_type_id: typeId,
                    start_date: '2026-05-01',
                    end_date: '2026-05-02',
                    total_days: 2,
                    status: LEAVE_REQUEST_STATUSES.PENDING,
                    created_at: new Date('2026-04-23T00:00:00Z'),
                },
            ])
        );
        notificationCountMock.mockResolvedValueOnce(5);

        const result = await dashboard.buildEmployeeDashboard(userId);

        expect(result.today.attendance.checked_in).toBe(true);
        expect(result.today.attendance.check_in_time).toBe('2026-04-24T03:30:00.000Z');
        expect(result.leave_balances).toEqual([
            {
                leave_type_id: typeId.toString(),
                code: 'CL',
                name: 'Casual Leave',
                allocated: 12,
                used: 2,
                pending: 1,
                available: 9,
            },
        ]);
        expect(result.recent_leaves).toHaveLength(1);
        expect(result.unread_notifications).toBe(5);
    });

    it('does not throw when an individual card aggregation fails', async () => {
        const userId = new Types.ObjectId();

        attendanceFindOneMock.mockRejectedValueOnce(new Error('mongo down'));
        leaveBalanceFindMock.mockReturnValueOnce(queryStub([]));
        leaveFindMock.mockReturnValueOnce(queryStub([]));
        notificationCountMock.mockResolvedValueOnce(0);

        const result = await dashboard.buildEmployeeDashboard(userId);

        expect(result.today.attendance.checked_in).toBe(false);
        expect(loggerWarnMock).toHaveBeenCalledWith(
            expect.objectContaining({ card: 'employee.attendance_today' }),
            'Dashboard card aggregation failed'
        );
    });
});

// ─── Client dashboard (V2-BE-2) ────────────────────────────────────────────

describe('buildClientDashboard', () => {
    it('returns empty cards for a client on zero projects', async () => {
        const userId = new Types.ObjectId();

        // Both `resolveClientProjectIds` and `computeClientProjectCards`
        // call `Project.find({ client_ids })`. Both get an empty list.
        projectFindMock.mockReturnValueOnce(queryStub([])).mockReturnValueOnce(queryStub([]));
        notificationCountMock.mockResolvedValueOnce(0);

        const result = await dashboard.buildClientDashboard(userId);

        expect(result.scope).toBe('client');
        expect(result.user_id).toBe(userId.toString());
        expect(result.projects).toEqual({ total: 0, recent: [] });
        expect(result.recent_task_activity).toEqual([]);
        expect(result.unread_notifications).toBe(0);
        // `Task.aggregate` / `Task.find` MUST NOT be called when the
        // visible project list is empty — short-circuit prevents leaking
        // tasks from other tenants' projects.
        expect(taskAggregateMock).not.toHaveBeenCalled();
        expect(taskFindMock).not.toHaveBeenCalled();
    });

    it('rolls up project + task data for a client on N projects', async () => {
        const userId = new Types.ObjectId();
        const p1 = new Types.ObjectId();
        const p2 = new Types.ObjectId();
        const t1 = new Types.ObjectId();
        const t2 = new Types.ObjectId();

        // `resolveClientProjectIds` — returns the two ids.
        projectFindMock.mockReturnValueOnce(queryStub([{ _id: p1 }, { _id: p2 }]));
        // `computeClientProjectCards` — full project docs (second
        // `Project.find` call).
        projectFindMock.mockReturnValueOnce(
            queryStub([
                {
                    _id: p1,
                    name: 'Acme Site',
                    code: 'ACME',
                    status: 'active',
                    custom_task_statuses: [{ key: 'archived', is_terminal: true }],
                    updated_at: new Date('2026-05-20T00:00:00.000Z'),
                },
                {
                    _id: p2,
                    name: 'Beta Portal',
                    code: 'BETA',
                    status: 'active',
                    custom_task_statuses: [],
                    updated_at: new Date('2026-04-10T00:00:00.000Z'),
                },
            ])
        );
        // `Task.aggregate` rollup — p1 has 3 tasks (1 done + 1 archived terminal
        // + 1 in_progress); p2 has 2 tasks both open.
        taskAggregateMock.mockResolvedValueOnce([
            {
                _id: p1,
                task_count: 3,
                statuses: [
                    { status: 'done', count: 1 },
                    { status: 'archived', count: 1 },
                    { status: 'in_progress', count: 1 },
                ],
                last_activity_at: new Date('2026-06-01T00:00:00.000Z'),
            },
            {
                _id: p2,
                task_count: 2,
                statuses: [
                    { status: 'to_do', count: 1 },
                    { status: 'review', count: 1 },
                ],
                last_activity_at: new Date('2026-05-28T00:00:00.000Z'),
            },
        ]);
        // `recent_task_activity` — `Task.find().sort().limit().select().lean()`.
        taskFindMock.mockReturnValueOnce(
            queryStub([
                {
                    _id: t1,
                    title: 'Set up domain',
                    status: 'in_progress',
                    project_id: p1,
                    updated_at: new Date('2026-06-01T00:00:00.000Z'),
                },
                {
                    _id: t2,
                    title: 'Wire-frame review',
                    status: 'review',
                    project_id: p2,
                    updated_at: new Date('2026-05-28T00:00:00.000Z'),
                },
            ])
        );
        // Project-name lookup inside `computeClientRecentTaskActivity` —
        // third `Project.find` call.
        projectFindMock.mockReturnValueOnce(
            queryStub([
                { _id: p1, name: 'Acme Site' },
                { _id: p2, name: 'Beta Portal' },
            ])
        );
        notificationCountMock.mockResolvedValueOnce(7);

        const result = await dashboard.buildClientDashboard(userId);

        expect(result.projects.total).toBe(2);
        expect(result.projects.recent).toHaveLength(2);

        // Sort: p1 last_activity (2026-06-01) is more recent than p2 (2026-05-28).
        const [first, second] = result.projects.recent;
        expect(first.id).toBe(p1.toString());
        expect(first.name).toBe('Acme Site');
        expect(first.task_count).toBe(3);
        // Terminal set for p1 = {done, archived} — open = in_progress only.
        expect(first.open_task_count).toBe(1);
        expect(first.last_activity_at).toBe('2026-06-01T00:00:00.000Z');
        expect(second.id).toBe(p2.toString());
        expect(second.task_count).toBe(2);
        // No terminals overlap with p2's statuses → all 2 are open.
        expect(second.open_task_count).toBe(2);

        expect(result.recent_task_activity).toHaveLength(2);
        expect(result.recent_task_activity[0].title).toBe('Set up domain');
        expect(result.recent_task_activity[0].project_name).toBe('Acme Site');
        expect(result.recent_task_activity[1].project_name).toBe('Beta Portal');

        expect(result.unread_notifications).toBe(7);
    });

    it('falls back gracefully when a card aggregation throws', async () => {
        const userId = new Types.ObjectId();
        const p1 = new Types.ObjectId();

        // `resolveClientProjectIds` succeeds.
        projectFindMock.mockReturnValueOnce(queryStub([{ _id: p1 }]));
        // `computeClientProjectCards` — `Project.find` succeeds, but the
        // task-aggregate inside it throws.
        projectFindMock.mockReturnValueOnce(
            queryStub([
                {
                    _id: p1,
                    name: 'Acme Site',
                    code: 'ACME',
                    status: 'active',
                    custom_task_statuses: [],
                    updated_at: new Date('2026-05-20T00:00:00.000Z'),
                },
            ])
        );
        taskAggregateMock.mockRejectedValueOnce(new Error('mongo down'));
        // `recent_task_activity` still tries — succeed with empty rows.
        taskFindMock.mockReturnValueOnce(queryStub([]));
        notificationCountMock.mockResolvedValueOnce(0);

        const result = await dashboard.buildClientDashboard(userId);

        // Projects card fell back to the empty shape (NOT a 500).
        expect(result.projects).toEqual({ total: 0, recent: [] });
        expect(result.recent_task_activity).toEqual([]);
        expect(result.unread_notifications).toBe(0);
        expect(loggerWarnMock).toHaveBeenCalledWith(
            expect.objectContaining({ card: 'client.projects' }),
            'Dashboard card aggregation failed'
        );
    });
});
