// src/services/dashboard-analytics.service.test.ts
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Types } from 'mongoose';

vi.mock('../models/attendance-record.model.js', () => ({ AttendanceRecord: { aggregate: vi.fn() } }));
vi.mock('../models/leave-request.model.js', () => ({
    LeaveRequest: { aggregate: vi.fn(), find: vi.fn(), countDocuments: vi.fn() },
}));
vi.mock('../models/leave-type.model.js', () => ({ LeaveType: { find: vi.fn() } }));
vi.mock('../models/timesheet-entry.model.js', () => ({ TimesheetEntry: { aggregate: vi.fn() } }));
vi.mock('../models/holiday.model.js', () => ({ Holiday: { find: vi.fn(), countDocuments: vi.fn() } }));
vi.mock('../models/user.model.js', () => ({ User: { find: vi.fn(), countDocuments: vi.fn(), aggregate: vi.fn() } }));
vi.mock('../models/project.model.js', () => ({
    Project: { find: vi.fn(), countDocuments: vi.fn() },
}));
vi.mock('../models/task.model.js', () => ({ Task: { aggregate: vi.fn(), find: vi.fn(), countDocuments: vi.fn() } }));
vi.mock('../models/billing-rate.model.js', () => ({ BillingRate: { find: vi.fn() } }));

import { AttendanceRecord } from '../models/attendance-record.model.js';
import { Holiday } from '../models/holiday.model.js';
import { TimesheetEntry } from '../models/timesheet-entry.model.js';
import { LeaveRequest } from '../models/leave-request.model.js';
import { LeaveType } from '../models/leave-type.model.js';
import { User } from '../models/user.model.js';
import { Project } from '../models/project.model.js';
import { Task } from '../models/task.model.js';
import { BillingRate } from '../models/billing-rate.model.js';
import {
    computeAttendanceTrend,
    computeHoursByProject,
    computeUtilization,
    computeHoursTrend,
    computeBillableValue,
    countWorkingDays,
    computeTasksByStatus,
    computeThroughput,
    computeProjectProgress,
    buildAdminAnalytics,
    buildManagerAnalytics,
    buildEmployeeAnalytics,
    buildClientAnalytics,
} from './dashboard-analytics.service.js';

const RANGE = {
    key: 'month' as const,
    label: 'This month',
    prev_label: 'last month',
    from: '2026-06-01',
    to: '2026-06-03',
    prev_from: '2026-05-01',
    prev_to: '2026-05-31',
};

// Chainable .find() stub: find().select().lean() etc resolve to `rows`.
const queryStub = (rows: unknown) => {
    const q: Record<string, unknown> = {};
    for (const m of ['select', 'sort', 'limit', 'lean']) {
        q[m] = vi.fn().mockReturnValue(q);
    }
    (q as { then: unknown }).then = (resolve: (v: unknown) => void) => resolve(rows);
    return q;
};

/**
 * Stubs every mocked model method to empty/zero results so a test
 * only needs to override the subset it actually cares about.
 */
const stubEmptyModels = () => {
    vi.mocked(AttendanceRecord.aggregate).mockResolvedValue([] as never);
    vi.mocked(TimesheetEntry.aggregate).mockResolvedValue([] as never);
    vi.mocked(Task.aggregate).mockResolvedValue([] as never);
    vi.mocked(LeaveRequest.aggregate).mockResolvedValue([] as never);
    vi.mocked(LeaveRequest.find).mockReturnValue(queryStub([]) as never);
    vi.mocked(LeaveType.find).mockReturnValue(queryStub([]) as never);
    vi.mocked(User.countDocuments).mockResolvedValue(0 as never);
    vi.mocked(User.aggregate).mockResolvedValue([] as never);
    vi.mocked(User.find).mockReturnValue(queryStub([]) as never);
    vi.mocked(Project.find).mockReturnValue(queryStub([]) as never);
    vi.mocked(Project.countDocuments).mockResolvedValue(0 as never);
    vi.mocked(Holiday.find).mockReturnValue(queryStub([]) as never);
    vi.mocked(BillingRate.find).mockReturnValue(queryStub([]) as never);
};

beforeEach(() => {
    vi.clearAllMocks();
    // Default Holiday.find stub (returns no holidays) for tests that indirectly
    // call countWorkingDays (e.g. single-user attendance branch).
    vi.mocked(Holiday.find).mockReturnValue(queryStub([]) as never);
});

describe('computeAttendanceTrend', () => {
    it('pivots per-day status counts into a series', async () => {
        vi.mocked(AttendanceRecord.aggregate).mockResolvedValue([
            { _id: { date: '2026-06-01', status: 'present' }, count: 30 },
            { _id: { date: '2026-06-01', status: 'on_leave' }, count: 4 },
            { _id: { date: '2026-06-02', status: 'present' }, count: 36 },
        ] as never);

        const out = await computeAttendanceTrend(null, RANGE, 40);
        expect(out.data).toEqual([
            { date: '2026-06-01', present: 30, on_leave: 4 },
            { date: '2026-06-02', present: 36, on_leave: 0 },
            { date: '2026-06-03', present: 0, on_leave: 0 },
        ]);
        expect(out.insight).toContain('of 40 people');
    });

    it('scopes by user ids when provided', async () => {
        vi.mocked(AttendanceRecord.aggregate).mockResolvedValue([] as never);
        const ids = [new Types.ObjectId()];
        await computeAttendanceTrend(ids, RANGE, 1);
        const pipeline = vi.mocked(AttendanceRecord.aggregate).mock.calls[0][0] as unknown as Record<string, unknown>[];
        expect(pipeline[0]).toEqual({
            $match: {
                local_date: { $gte: '2026-06-01', $lte: '2026-06-03' },
                user_id: { $in: ids },
            },
        });
    });
});

describe('countWorkingDays', () => {
    it('excludes weekends and holidays', async () => {
        // 2026-06-01..07: Mon..Sun. Holiday on Wed 03.
        vi.mocked(Holiday.find).mockReturnValue(queryStub([{ date: '2026-06-03' }]) as never);
        // Mon,Tue,Thu,Fri = 4 working days
        await expect(countWorkingDays('2026-06-01', '2026-06-07')).resolves.toBe(4);
    });
});

describe('computeHoursByProject', () => {
    it('sums minutes per project with names, top-share insight, delta', async () => {
        const p1 = new Types.ObjectId();
        const p2 = new Types.ObjectId();
        vi.mocked(TimesheetEntry.aggregate)
            .mockResolvedValueOnce([
                { _id: p1, minutes: 412 * 60 },
                { _id: p2, minutes: 290 * 60 },
            ] as never)
            .mockResolvedValueOnce([{ _id: null, minutes: 600 * 60 }] as never); // prev total
        vi.mocked(Project.find).mockReturnValue(
            queryStub([
                { _id: p1, name: 'Platform', code: 'PLT' },
                { _id: p2, name: 'Mobile', code: 'MOB' },
            ]) as never
        );

        const out = await computeHoursByProject(null, RANGE);
        expect(out.data[0]).toMatchObject({ project_name: 'Platform', minutes: 412 * 60 });
        expect(out.insight).toContain('Platform took the most time');
        expect(out.delta?.label).toContain('vs last month');
    });
});

describe('computeUtilization', () => {
    it('actual vs expected from working days x heads x 480', async () => {
        vi.mocked(TimesheetEntry.aggregate)
            .mockResolvedValueOnce([{ _id: null, minutes: 2 * 480 * 2 }] as never) // current
            .mockResolvedValueOnce([{ _id: null, minutes: 480 }] as never); // prev
        vi.mocked(Holiday.find).mockReturnValue(queryStub([]) as never);
        // RANGE = Jun 1 (Mon) .. Jun 3 (Wed) → 3 working days; 2 heads
        const out = await computeUtilization(null, RANGE, 2);
        expect(out.expected_minutes).toBe(3 * 480 * 2);
        expect(out.pct).toBe(Math.round(((2 * 480 * 2) / (3 * 480 * 2)) * 100));
        expect(out.insight).toContain('% of expected hours');
    });
});

describe('computeHoursTrend', () => {
    it('one bar per day, zero-filled', async () => {
        vi.mocked(TimesheetEntry.aggregate)
            .mockResolvedValueOnce([{ _id: '2026-06-02', minutes: 300 }] as never)
            .mockResolvedValueOnce([{ _id: null, minutes: 0 }] as never);
        const uid = new Types.ObjectId();
        const out = await computeHoursTrend([uid], RANGE);
        expect(out.data).toEqual([
            { date: '2026-06-01', minutes: 0 },
            { date: '2026-06-02', minutes: 300 },
            { date: '2026-06-03', minutes: 0 },
        ]);
    });
});

describe('computeBillableValue', () => {
    it('joins billable minutes to the rate effective on the entry date', async () => {
        const u = new Types.ObjectId();
        const p = new Types.ObjectId();
        vi.mocked(TimesheetEntry.aggregate)
            .mockResolvedValueOnce([{ _id: { user: u, project: p, date: '2026-06-02' }, billable: 120 }] as never)
            .mockResolvedValueOnce([] as never); // prev window
        vi.mocked(BillingRate.find).mockReturnValue(
            queryStub([
                {
                    user_id: u,
                    project_id: p,
                    task_id: null,
                    hourly_rate: 50,
                    effective_from: '2026-01-01',
                    effective_to: null,
                },
            ]) as never
        );
        const out = await computeBillableValue(null, RANGE);
        expect(out.value).toBe(100); // 2h x 50
    });
});

describe('computeTasksByStatus', () => {
    it('groups by status with done-first ordering', async () => {
        vi.mocked(Task.aggregate).mockResolvedValue([
            { _id: 'in_progress', count: 91 },
            { _id: 'done', count: 128 },
            { _id: 'todo', count: 50 },
        ] as never);
        const out = await computeTasksByStatus({}, RANGE);
        expect(out.data[0]).toEqual({ status: 'done', count: 128 });
        expect(out.total).toBe(269);
        expect(out.insight).toContain('128 of 269');
    });
});

describe('computeThroughput', () => {
    it('buckets done tasks per day for short ranges', async () => {
        vi.mocked(Task.aggregate)
            .mockResolvedValueOnce([{ _id: '2026-06-02', count: 5 }] as never)
            .mockResolvedValueOnce([{ _id: null, count: 3 }] as never);
        const out = await computeThroughput({}, RANGE);
        expect(out.data).toEqual([
            { date: '2026-06-01', count: 0 },
            { date: '2026-06-02', count: 5 },
            { date: '2026-06-03', count: 0 },
        ]);
        expect(out.delta?.pct).toBe(67); // 5 vs 3
    });
});

describe('computeProjectProgress', () => {
    it('done vs total per project', async () => {
        const p = new Types.ObjectId();
        vi.mocked(Project.find).mockReturnValue(
            queryStub([{ _id: p, name: 'Platform', code: 'PLT', status: 'active', custom_task_statuses: [] }]) as never
        );
        vi.mocked(Task.aggregate).mockResolvedValue([
            { _id: { project: p, status: 'done' }, count: 30 },
            { _id: { project: p, status: 'todo' }, count: 10 },
        ] as never);
        const out = await computeProjectProgress([p]);
        expect(out.data[0]).toMatchObject({ name: 'Platform', done: 30, total: 40 });
    });
});

describe('buildAdminAnalytics — permission filtering', () => {
    it('system.admin gets every section', async () => {
        stubEmptyModels();

        const out = await buildAdminAnalytics(['system.admin'], 'month');
        expect(Object.keys(out.sections)).toEqual(
            expect.arrayContaining([
                'kpi',
                'attendance_trend',
                'leave_mix',
                'upcoming_leaves',
                'hours_by_project',
                'utilization',
                'tasks_by_status',
                'throughput',
            ])
        );
        expect(out.range.key).toBe('month');
    });

    it('a caller without timesheet.read gets no hours/utilization sections', async () => {
        stubEmptyModels();

        const out = await buildAdminAnalytics(['attendance.read_team'], 'month');
        expect(out.sections.hours_by_project).toBeUndefined();
        expect(out.sections.utilization).toBeUndefined();
        expect(out.sections.attendance_trend).toBeDefined();
    });

    it('a failing section yields {error:true} without killing the payload', async () => {
        stubEmptyModels();
        // Override attendance to throw
        vi.mocked(AttendanceRecord.aggregate).mockRejectedValue(new Error('boom') as never);

        const out = await buildAdminAnalytics(['attendance.read_team'], 'month');
        expect(out.sections.attendance_trend).toEqual({ error: true });
    });
});

// ─── Scope-isolation security invariants ─────────────────────────────────

describe('buildAdminAnalytics — empty kpi is omitted', () => {
    it('omits sections.kpi entirely when caller holds no kpi-level permissions', async () => {
        stubEmptyModels();
        // Only attendance.read_team — no user.read / project.read / timesheet.read / billing_rate.read.
        const out = await buildAdminAnalytics(['attendance.read_team'], 'month');
        expect(out.sections.kpi).toBeUndefined();
        expect(out.sections.attendance_trend).toBeDefined();
    });
});

describe('buildClientAnalytics — zero-project scope', () => {
    it('returns empty stubs and never calls Task.aggregate when client has zero projects', async () => {
        stubEmptyModels();
        // Project.find for client scope: needs a real promise chain so .lean().catch() works.
        const projectFindStub = {
            select: vi.fn().mockReturnThis(),
            lean: vi.fn().mockResolvedValue([]),
        };
        vi.mocked(Project.find).mockReturnValue(projectFindStub as never);

        const userId = new Types.ObjectId();
        const out = await buildClientAnalytics(userId, ['project.read', 'task.read'], 'month');

        // Project.find must be called with the tenant-isolation filter.
        expect(vi.mocked(Project.find)).toHaveBeenCalledWith({ client_ids: userId });

        // Task.aggregate must NOT be called (no projects → no task query).
        expect(vi.mocked(Task.aggregate)).not.toHaveBeenCalled();

        // Sections should be present but empty/stub shapes.
        expect(out.sections.project_progress).toBeDefined();
        expect((out.sections.project_progress as { data: unknown[] }).data).toEqual([]);
        expect(out.sections.tasks_by_status).toBeDefined();
        expect((out.sections.tasks_by_status as { total: number }).total).toBe(0);
        expect(out.sections.throughput).toBeDefined();
        expect((out.sections.throughput as { data: unknown[] }).data).toEqual([]);
    });
});

describe('buildEmployeeAnalytics — self-scope in aggregation pipelines', () => {
    it('timesheet and attendance pipelines carry the self user_id scope', async () => {
        stubEmptyModels();
        const userId = new Types.ObjectId();

        await buildEmployeeAnalytics(
            userId,
            ['timesheet.write', 'attendance.check_in_out', 'leave_request.write', 'task.read', 'holiday.read'],
            'month'
        );

        // Every TimesheetEntry.aggregate call whose first $match stage carries user_id
        // must scope to exactly {$in: [userId]}.  We also assert at least one such
        // scoped call exists — so removing the userMatch() spread from the service
        // causes scopedCallCount to be 0 and the test fails.
        let timesheetScopedCount = 0;
        for (const call of vi.mocked(TimesheetEntry.aggregate).mock.calls) {
            const pipeline = call[0] as unknown as Record<string, unknown>[];
            const matchStage = pipeline[0] as { $match?: { user_id?: { $in: Types.ObjectId[] } } } | undefined;
            if (matchStage?.$match?.user_id) {
                timesheetScopedCount++;
                expect(matchStage.$match.user_id).toEqual({ $in: [userId] });
            }
        }
        expect(timesheetScopedCount).toBeGreaterThan(0);

        // Same invariant for AttendanceRecord.aggregate.
        let attendanceScopedCount = 0;
        for (const call of vi.mocked(AttendanceRecord.aggregate).mock.calls) {
            const pipeline = call[0] as unknown as Record<string, unknown>[];
            const matchStage = pipeline[0] as { $match?: { user_id?: { $in: Types.ObjectId[] } } } | undefined;
            if (matchStage?.$match?.user_id) {
                attendanceScopedCount++;
                expect(matchStage.$match.user_id).toEqual({ $in: [userId] });
            }
        }
        expect(attendanceScopedCount).toBeGreaterThan(0);
    });
});

describe('buildManagerAnalytics — org-wide scope (read_team is org-wide today)', () => {
    it('does not scope to a reporting_manager_id team — aggregations are org-wide', async () => {
        stubEmptyModels();
        const managerId = new Types.ObjectId();

        await buildManagerAnalytics(
            { id: managerId, role: 'manager', role_keys: ['manager'] },
            ['dashboard.manager', 'attendance.read_team', 'task.read'],
            'month'
        );

        // No User.find call should carry a direct-report team filter any more.
        const hasManagerFilter = vi.mocked(User.find).mock.calls.some((args) => {
            const filter = (args[0] ?? {}) as Record<string, unknown>;
            return Object.prototype.hasOwnProperty.call(filter, 'internal_profile.reporting_manager_id');
        });
        expect(hasManagerFilter).toBe(false);

        // Attendance aggregation must be org-wide: no `user_id: { $in }` scoping.
        for (const call of vi.mocked(AttendanceRecord.aggregate).mock.calls) {
            const pipeline = call[0] as unknown as Record<string, unknown>[];
            const matchStage = pipeline[0] as { $match?: { user_id?: unknown } } | undefined;
            expect(matchStage?.$match?.user_id).toBeUndefined();
        }
    });
});

describe('buildManagerAnalytics — kpi.hours_logged safeSection isolation', () => {
    it('a sumMinutes failure does not kill the entire kpi section', async () => {
        stubEmptyModels();
        const managerId = new Types.ObjectId();
        vi.mocked(User.find).mockReturnValue(queryStub([]) as never);

        // Make TimesheetEntry.aggregate throw so sumMinutes inside kpi.hours_logged fails.
        vi.mocked(TimesheetEntry.aggregate).mockRejectedValue(new Error('db error') as never);

        const out = await buildManagerAnalytics(
            { id: managerId, role: 'manager', role_keys: ['manager'] },
            ['dashboard.manager', 'timesheet.read'],
            'month'
        );

        // kpi section should still exist (team_size is always present).
        expect(out.sections.kpi).toBeDefined();
        const kpi = out.sections.kpi as Record<string, unknown>;
        expect(kpi.team_size).toBeDefined();
        // hours_logged should be the error sentinel from safeSection.
        expect(kpi.hours_logged).toEqual({ error: true });
    });
});
