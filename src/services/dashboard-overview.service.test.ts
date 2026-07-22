import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Types } from 'mongoose';

import { ROLES } from '../constants/roles.js';
import { USER_STATUSES } from '../constants/user-statuses.js';
import { PROJECT_STATUSES } from '../constants/project.js';
import { LEAVE_REQUEST_STATUSES } from '../constants/leave.js';
import { DEFAULT_DONE_TASK_STATUS_KEY } from '../constants/story.js';

/**
 * Unit tests for the range-aware dashboard overview aggregation helpers
 * (Task 2, docs/superpowers/plans dashboard rework).
 *
 * These are pure, reusable building blocks — later per-role dashboard
 * builders compose them. Kept fully decoupled from `dashboard.service.ts`
 * (which owns the existing Phase-1 single-day payloads) so this file can
 * mock exactly the models it needs.
 */

// ─── Hoisted mocks ──────────────────────────────────────────────────────

const {
    userAggregateMock,
    userCountMock,
    attendanceAggregateMock,
    attendanceDistinctMock,
    correctionCountMock,
    projectAggregateMock,
    leaveRequestCountMock,
    taskCountMock,
    buildProjectVisibilityFilterMock,
    resolveTeamLeadScopeMock,
    resolveClientProjectIdsMock,
    loggerWarnMock,
} = vi.hoisted(() => ({
    userAggregateMock: vi.fn(),
    userCountMock: vi.fn(),
    attendanceAggregateMock: vi.fn(),
    attendanceDistinctMock: vi.fn(),
    correctionCountMock: vi.fn(),
    projectAggregateMock: vi.fn(),
    leaveRequestCountMock: vi.fn(),
    taskCountMock: vi.fn(),
    buildProjectVisibilityFilterMock: vi.fn(),
    resolveTeamLeadScopeMock: vi.fn(),
    resolveClientProjectIdsMock: vi.fn(),
    loggerWarnMock: vi.fn(),
}));

vi.mock('../models/user.model.js', () => ({
    User: {
        aggregate: userAggregateMock,
        countDocuments: userCountMock,
    },
}));

vi.mock('../models/attendance-record.model.js', () => ({
    AttendanceRecord: {
        aggregate: attendanceAggregateMock,
        distinct: attendanceDistinctMock,
    },
}));

vi.mock('../models/attendance-correction-request.model.js', () => ({
    AttendanceCorrectionRequest: {
        countDocuments: correctionCountMock,
    },
}));

vi.mock('../models/project.model.js', () => ({
    Project: {
        aggregate: projectAggregateMock,
    },
}));

vi.mock('../models/leave-request.model.js', () => ({
    LeaveRequest: {
        countDocuments: leaveRequestCountMock,
    },
}));

vi.mock('../models/task.model.js', () => ({
    Task: {
        countDocuments: taskCountMock,
    },
}));

vi.mock('./project.service.js', () => ({
    buildProjectVisibilityFilter: buildProjectVisibilityFilterMock,
}));

vi.mock('./dashboard-analytics.service.js', () => ({
    resolveTeamLeadScope: resolveTeamLeadScopeMock,
}));

vi.mock('./dashboard.service.js', () => ({
    resolveClientProjectIds: resolveClientProjectIdsMock,
}));

vi.mock('../utils/logger.js', () => ({
    default: { warn: loggerWarnMock, info: vi.fn() },
}));

const overview = await import('./dashboard-overview.service.js');

beforeEach(() => {
    userAggregateMock.mockReset();
    userCountMock.mockReset();
    attendanceAggregateMock.mockReset();
    attendanceDistinctMock.mockReset();
    correctionCountMock.mockReset();
    projectAggregateMock.mockReset();
    leaveRequestCountMock.mockReset();
    taskCountMock.mockReset();
    buildProjectVisibilityFilterMock.mockReset();
    resolveTeamLeadScopeMock.mockReset();
    resolveClientProjectIdsMock.mockReset();
    loggerWarnMock.mockReset();
});

// ─── headcountAsOf ─────────────────────────────────────────────────────

describe('headcountAsOf', () => {
    it('counts users created on/before the date, active or deactivated after it', async () => {
        userCountMock.mockResolvedValueOnce(7);

        const out = await overview.headcountAsOf('2026-07-22', [ROLES.EMPLOYEE, ROLES.TEAM_LEAD]);

        expect(out).toBe(7);
        const filter = userCountMock.mock.calls[0][0] as Record<string, unknown>;
        expect(filter.role).toEqual({ $in: [ROLES.EMPLOYEE, ROLES.TEAM_LEAD] });
        expect(filter.created_at).toHaveProperty('$lte');
        expect(filter.$or).toEqual([
            { deactivated_at: null },
            { deactivated_at: { $gt: (filter.created_at as { $lte: Date }).$lte } },
        ]);
    });

    it('falls back to 0 and logs when the count throws', async () => {
        userCountMock.mockRejectedValueOnce(new Error('boom'));

        const out = await overview.headcountAsOf('2026-07-22', [ROLES.EMPLOYEE]);

        expect(out).toBe(0);
        expect(loggerWarnMock).toHaveBeenCalledWith(
            expect.objectContaining({ card: 'overview.headcount_as_of' }),
            'Dashboard card aggregation failed'
        );
    });
});

// ─── projectStatusFor ───────────────────────────────────────────────────

describe('projectStatusFor', () => {
    it('groups by status into active/completed/on_hold + total, excluding archived', async () => {
        projectAggregateMock.mockResolvedValueOnce([
            { _id: PROJECT_STATUSES.ACTIVE, count: 5 },
            { _id: PROJECT_STATUSES.COMPLETED, count: 3 },
            { _id: PROJECT_STATUSES.ON_HOLD, count: 1 },
        ]);

        const out = await overview.projectStatusFor({ company_id: new Types.ObjectId() });

        expect(out).toEqual({ active: 5, completed: 3, on_hold: 1, total: 9 });
        const pipeline = projectAggregateMock.mock.calls[0][0] as Array<Record<string, unknown>>;
        const matchStage = pipeline[0].$match as Record<string, unknown>;
        expect(matchStage.is_archived).toEqual({ $ne: true });
    });

    it('falls back to all-zero shape when the aggregation throws', async () => {
        projectAggregateMock.mockRejectedValueOnce(new Error('boom'));

        const out = await overview.projectStatusFor({});

        expect(out).toEqual({ active: 0, completed: 0, on_hold: 0, total: 0 });
        expect(loggerWarnMock).toHaveBeenCalledWith(
            expect.objectContaining({ card: 'overview.project_status' }),
            'Dashboard card aggregation failed'
        );
    });
});

// ─── attendanceOverviewFor ────────────────────────────────────────────────

describe('attendanceOverviewFor', () => {
    it('single day: present = that day count, is_single_day true', async () => {
        attendanceAggregateMock.mockResolvedValueOnce([
            { _id: 'present', count: 9 },
            { _id: 'on_leave', count: 2 },
        ]);
        correctionCountMock.mockResolvedValueOnce(1);
        userCountMock.mockResolvedValueOnce(20);

        const out = await overview.attendanceOverviewFor('2026-07-22', '2026-07-22', null);

        expect(out).toMatchObject({
            present: 9,
            on_leave: 2,
            correction_requests: 1,
            incomplete: 0,
            is_single_day: true,
        });
        expect(out.total_internal_active).toBe(20);
        // Single-day path must not query distinct working days.
        expect(attendanceDistinctMock).not.toHaveBeenCalled();
    });

    it('single day: incomplete comes from the status group', async () => {
        attendanceAggregateMock.mockResolvedValueOnce([
            { _id: 'present', count: 9 },
            { _id: 'incomplete', count: 3 },
        ]);
        correctionCountMock.mockResolvedValueOnce(3);
        userCountMock.mockResolvedValueOnce(20);

        const out = await overview.attendanceOverviewFor('2026-07-22', '2026-07-22', null);

        expect(out.incomplete).toBe(3);
        expect(out.correction_requests).toBe(3);
    });

    it('range: present = round(total present-records / distinct working days), on_leave = total leave-days', async () => {
        attendanceAggregateMock.mockResolvedValueOnce([
            { _id: 'present', count: 27 },
            { _id: 'on_leave', count: 4 },
            { _id: 'incomplete', count: 2 },
        ]);
        // 4 distinct working days in the window.
        attendanceDistinctMock.mockResolvedValueOnce(['2026-07-20', '2026-07-21', '2026-07-22', '2026-07-23']);
        correctionCountMock.mockResolvedValueOnce(5);
        userCountMock.mockResolvedValueOnce(15);

        const out = await overview.attendanceOverviewFor('2026-07-20', '2026-07-24', null);

        expect(out.is_single_day).toBe(false);
        expect(out.present).toBe(7); // round(27/4) = 6.75 → 7
        expect(out.on_leave).toBe(4);
        expect(out.incomplete).toBe(2);
        expect(out.correction_requests).toBe(5);
        expect(out.total_internal_active).toBe(15);
    });

    it('range: zero working days degrades present to 0 instead of dividing by zero', async () => {
        attendanceAggregateMock.mockResolvedValueOnce([]);
        attendanceDistinctMock.mockResolvedValueOnce([]);
        correctionCountMock.mockResolvedValueOnce(0);
        userCountMock.mockResolvedValueOnce(0);

        const out = await overview.attendanceOverviewFor('2026-07-20', '2026-07-24', null);

        expect(out.present).toBe(0);
    });

    it('scopes user_id filter on every query when userIds is provided', async () => {
        const u1 = new Types.ObjectId();
        const u2 = new Types.ObjectId();
        attendanceAggregateMock.mockResolvedValueOnce([{ _id: 'present', count: 2 }]);
        correctionCountMock.mockResolvedValueOnce(0);
        userCountMock.mockResolvedValueOnce(2);

        await overview.attendanceOverviewFor('2026-07-22', '2026-07-22', [u1, u2]);

        const pipeline = attendanceAggregateMock.mock.calls[0][0] as Array<Record<string, unknown>>;
        const matchStage = pipeline[0].$match as Record<string, unknown>;
        expect(matchStage.user_id).toEqual({ $in: [u1, u2] });

        const correctionFilter = correctionCountMock.mock.calls[0][0] as Record<string, unknown>;
        expect(correctionFilter.user_id).toEqual({ $in: [u1, u2] });

        const userFilter = userCountMock.mock.calls[0][0] as Record<string, unknown>;
        expect(userFilter._id).toEqual({ $in: [u1, u2] });
    });

    it('does not filter by user_id when userIds is null (org-wide scope)', async () => {
        attendanceAggregateMock.mockResolvedValueOnce([{ _id: 'present', count: 2 }]);
        correctionCountMock.mockResolvedValueOnce(0);
        userCountMock.mockResolvedValueOnce(2);

        await overview.attendanceOverviewFor('2026-07-22', '2026-07-22', null);

        const pipeline = attendanceAggregateMock.mock.calls[0][0] as Array<Record<string, unknown>>;
        const matchStage = pipeline[0].$match as Record<string, unknown>;
        expect(matchStage.user_id).toBeUndefined();

        const correctionFilter = correctionCountMock.mock.calls[0][0] as Record<string, unknown>;
        expect(correctionFilter.user_id).toBeUndefined();
    });

    it('falls back to a zero shape (preserving is_single_day) when the status aggregate throws', async () => {
        attendanceAggregateMock.mockRejectedValueOnce(new Error('boom'));

        const out = await overview.attendanceOverviewFor('2026-07-20', '2026-07-24', null);

        expect(out).toEqual({
            present: 0,
            on_leave: 0,
            correction_requests: 0,
            incomplete: 0,
            total_internal_active: 0,
            is_single_day: false,
        });
        expect(loggerWarnMock).toHaveBeenCalledWith(
            expect.objectContaining({ card: 'overview.attendance' }),
            'Dashboard card aggregation failed'
        );
    });
});

// ─── representativesStatusFor ───────────────────────────────────────────

describe('representativesStatusFor', () => {
    it('groups representatives of a company by active/deactivated', async () => {
        const companyId = new Types.ObjectId();
        userAggregateMock.mockResolvedValueOnce([
            { _id: USER_STATUSES.ACTIVE, count: 4 },
            { _id: USER_STATUSES.DEACTIVATED, count: 1 },
        ]);

        const out = await overview.representativesStatusFor(companyId);

        expect(out).toEqual({ active: 4, inactive: 1, total: 5 });
        const pipeline = userAggregateMock.mock.calls[0][0] as Array<Record<string, unknown>>;
        const matchStage = pipeline[0].$match as Record<string, unknown>;
        expect(matchStage.role).toBe(ROLES.REPRESENTATIVE);
        expect(matchStage['client_profile.company_id']).toEqual(companyId);
    });

    it('falls back to all-zero shape when the aggregation throws', async () => {
        userAggregateMock.mockRejectedValueOnce(new Error('boom'));

        const out = await overview.representativesStatusFor(new Types.ObjectId());

        expect(out).toEqual({ active: 0, inactive: 0, total: 0 });
        expect(loggerWarnMock).toHaveBeenCalledWith(
            expect.objectContaining({ card: 'overview.representatives_status' }),
            'Dashboard card aggregation failed'
        );
    });
});

// ─── Per-scope overview builders (Task 3) ───────────────────────────────

describe('buildAdminOverview', () => {
    it('returns 3 summary cards, org-wide attendance, no representatives', async () => {
        userCountMock.mockImplementation((filter: Record<string, unknown>) => {
            const roleFilter = filter?.role as { $in?: string[] } | undefined;
            if (roleFilter?.$in) {
                if (roleFilter.$in.length === 1 && roleFilter.$in[0] === ROLES.CLIENT) return Promise.resolve(4);
                return Promise.resolve(50);
            }
            return Promise.resolve(20); // total_internal_active (role: {$ne: CLIENT})
        });
        projectAggregateMock.mockResolvedValueOnce([
            { _id: PROJECT_STATUSES.ACTIVE, count: 5 },
            { _id: PROJECT_STATUSES.COMPLETED, count: 2 },
        ]);
        attendanceAggregateMock.mockResolvedValueOnce([{ _id: 'present', count: 9 }]);
        correctionCountMock.mockResolvedValueOnce(0);

        const out = await overview.buildAdminOverview('2026-07-22', '2026-07-22');

        expect(out.scope).toBe('admin');
        expect(out.range).toEqual({ from: '2026-07-22', to: '2026-07-22', is_single_day: true });
        expect(out.summary).toEqual([
            { label: 'Total Employees', value: 50 },
            { label: 'Total Clients', value: 4 },
            { label: 'Total Projects', value: 7 },
        ]);
        expect(out.attendance).not.toBeNull();
        expect(out.attendance?.present).toBe(9);
        expect(out.representatives).toBeNull();
        expect(out.projects).toEqual({ active: 5, completed: 2, on_hold: 0, total: 7 });

        // headcount roles: employees call spans admin/manager/team_lead/employee.
        const employeeRolesCall = userCountMock.mock.calls.find(
            (c) => (c[0].role as { $in?: string[] }).$in && (c[0].role as { $in: string[] }).$in.length > 1
        );
        expect(employeeRolesCall?.[0].role.$in).toEqual(
            expect.arrayContaining([ROLES.ADMIN, ROLES.MANAGER, ROLES.TEAM_LEAD, ROLES.EMPLOYEE])
        );
    });
});

describe('buildManagerOverview', () => {
    const caller = { id: new Types.ObjectId(), role: ROLES.TEAM_LEAD } as const;

    it('scopes team members/projects/pending-approvals via buildProjectVisibilityFilter + resolveTeamLeadScope', async () => {
        const memberIds = [new Types.ObjectId(), new Types.ObjectId(), new Types.ObjectId()];
        const filter = { member_ids: caller.id };
        buildProjectVisibilityFilterMock.mockReturnValueOnce(filter);
        resolveTeamLeadScopeMock.mockResolvedValueOnce({ projectIds: [], memberIds });
        leaveRequestCountMock.mockResolvedValueOnce(2);
        projectAggregateMock.mockResolvedValueOnce([{ _id: PROJECT_STATUSES.ACTIVE, count: 4 }]);
        attendanceAggregateMock.mockResolvedValueOnce([{ _id: 'present', count: 3 }]);
        correctionCountMock.mockResolvedValueOnce(0);
        userCountMock.mockResolvedValueOnce(3); // total_internal_active

        const out = await overview.buildManagerOverview(caller, '2026-07-22', '2026-07-22');

        expect(buildProjectVisibilityFilterMock).toHaveBeenCalledWith(caller);
        expect(resolveTeamLeadScopeMock).toHaveBeenCalledWith(caller.id);
        expect(out.scope).toBe('manager');
        expect(out.summary).toEqual([
            { label: 'Team members', value: 3 },
            { label: 'My Projects', value: 4 },
            { label: 'Pending approvals', value: 2 },
        ]);
        expect(out.attendance).not.toBeNull();
        expect(out.representatives).toBeNull();
        expect(out.projects.total).toBe(4);

        const pendingFilter = leaveRequestCountMock.mock.calls[0][0] as Record<string, unknown>;
        expect(pendingFilter.status).toBe(LEAVE_REQUEST_STATUSES.PENDING);
        expect(pendingFilter.user_id).toEqual({ $in: memberIds });

        const attendancePipeline = attendanceAggregateMock.mock.calls[0][0] as Array<Record<string, unknown>>;
        const attendanceMatch = attendancePipeline[0].$match as Record<string, unknown>;
        expect(attendanceMatch.user_id).toEqual({ $in: memberIds });
    });
});

describe('buildEmployeeOverview', () => {
    const caller = { id: new Types.ObjectId(), role: ROLES.EMPLOYEE } as const;

    it('reports present-days/projects/open-tasks scoped to the caller only', async () => {
        const filter = { member_ids: caller.id };
        buildProjectVisibilityFilterMock.mockReturnValueOnce(filter);
        projectAggregateMock.mockResolvedValueOnce([{ _id: PROJECT_STATUSES.ACTIVE, count: 2 }]);
        attendanceAggregateMock.mockResolvedValueOnce([{ _id: 'present', count: 1 }]);
        correctionCountMock.mockResolvedValueOnce(0);
        userCountMock.mockResolvedValueOnce(1); // total_internal_active
        taskCountMock.mockResolvedValueOnce(5);

        const out = await overview.buildEmployeeOverview(caller, '2026-07-22', '2026-07-22');

        expect(buildProjectVisibilityFilterMock).toHaveBeenCalledWith(caller);
        expect(out.scope).toBe('employee');
        expect(out.summary).toEqual([
            { label: 'My present days', value: 1 },
            { label: 'My Projects', value: 2 },
            { label: 'My open tasks', value: 5 },
        ]);
        expect(out.attendance).not.toBeNull();
        expect(out.representatives).toBeNull();
        expect(out.projects.total).toBe(2);

        const attendancePipeline = attendanceAggregateMock.mock.calls[0][0] as Array<Record<string, unknown>>;
        const attendanceMatch = attendancePipeline[0].$match as Record<string, unknown>;
        expect(attendanceMatch.user_id).toEqual({ $in: [caller.id] });

        const taskFilter = taskCountMock.mock.calls[0][0] as Record<string, unknown>;
        expect(taskFilter.$or).toEqual([{ created_by: caller.id }, { primary_assignee_id: caller.id }]);
        expect(taskFilter.status).toEqual({ $ne: DEFAULT_DONE_TASK_STATUS_KEY });
    });
});

describe('buildClientOverview', () => {
    const companyId = new Types.ObjectId();
    const caller = { id: new Types.ObjectId(), role: ROLES.CLIENT, company_id: companyId } as const;

    it('reports company projects/representatives/active-vs-completed, attendance null', async () => {
        const projectIds = [new Types.ObjectId(), new Types.ObjectId()];
        resolveClientProjectIdsMock.mockResolvedValueOnce(projectIds);
        projectAggregateMock.mockResolvedValueOnce([
            { _id: PROJECT_STATUSES.ACTIVE, count: 2 },
            { _id: PROJECT_STATUSES.COMPLETED, count: 1 },
        ]);
        userAggregateMock.mockResolvedValueOnce([
            { _id: USER_STATUSES.ACTIVE, count: 3 },
            { _id: USER_STATUSES.DEACTIVATED, count: 1 },
        ]);

        const out = await overview.buildClientOverview(caller, '2026-07-22', '2026-07-22');

        expect(resolveClientProjectIdsMock).toHaveBeenCalledWith(caller);
        expect(out.scope).toBe('client');
        expect(out.summary).toEqual([
            { label: 'Company Projects', value: 3 },
            { label: 'Representatives', value: 4 },
            { label: 'Active vs Completed', value: 2, hint: '1 completed' },
        ]);
        expect(out.attendance).toBeNull();
        expect(out.representatives).toEqual({ active: 3, inactive: 1, total: 4 });
        expect(out.projects).toEqual({ active: 2, completed: 1, on_hold: 0, total: 3 });

        const projectPipeline = projectAggregateMock.mock.calls[0][0] as Array<Record<string, unknown>>;
        const projectMatch = projectPipeline[0].$match as Record<string, unknown>;
        expect(projectMatch._id).toEqual({ $in: projectIds });

        const repPipeline = userAggregateMock.mock.calls[0][0] as Array<Record<string, unknown>>;
        const repMatch = repPipeline[0].$match as Record<string, unknown>;
        expect(repMatch['client_profile.company_id']).toEqual(companyId);
    });
});
