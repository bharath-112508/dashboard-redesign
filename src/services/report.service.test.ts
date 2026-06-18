import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Types } from 'mongoose';

import { ROLES } from '../constants/roles.js';

/**
 * Unit tests for `report.service` (Step 29).
 *
 * Coverage focus:
 *   1. **Billing rate precedence** — task-specific row preferred over
 *      project-level fallback per Data_Model §6.2.
 *   2. **Billing — no-rate handling** — entries without a matching rate
 *      report hours but contribute zero to `billable_amount`.
 *   3. **Utilization expected math** — `working_days × daily_threshold ×
 *      60` minutes; `utilization_pct` rounded to 2 decimal places;
 *      holidays + weekends excluded from the working-day count.
 *   4. **Attendance counts** — `$group` rows by `(user_id, status)`
 *      pivot into the 6 status buckets; missing buckets default to 0.
 *   5. **Leave roll-up** — joins balances with their leave-type label
 *      and sorts by label; users with no balances render an empty
 *      `by_type`.
 */

// ─── Hoisted mocks ───────────────────────────────────────────────────────

const {
    timesheetAggregateMock,
    billingRateFindOneMock,
    billingRateFindMock,
    attendanceAggregateMock,
    leaveBalanceFindMock,
    leaveTypeFindMock,
    userFindMock,
    projectFindByIdMock,
    holidayFindMock,
    taskFindMock,
    settingsLoadMock,
} = vi.hoisted(() => ({
    timesheetAggregateMock: vi.fn(),
    billingRateFindOneMock: vi.fn(),
    billingRateFindMock: vi.fn(),
    attendanceAggregateMock: vi.fn(),
    leaveBalanceFindMock: vi.fn(),
    leaveTypeFindMock: vi.fn(),
    userFindMock: vi.fn(),
    projectFindByIdMock: vi.fn(),
    holidayFindMock: vi.fn(),
    taskFindMock: vi.fn(),
    settingsLoadMock: vi.fn(),
}));

vi.mock('../models/timesheet-entry.model.js', () => ({
    TimesheetEntry: { aggregate: timesheetAggregateMock },
}));

vi.mock('../models/billing-rate.model.js', () => ({
    BillingRate: {
        findOne: billingRateFindOneMock,
        // H23 — `buildBillingReport` now uses a single batched
        // `BillingRate.find({ ... })` instead of per-row findOne.
        // Tests seed the rate set on `billingRateFindMock`; the
        // service walks them in `effective_from desc` order, so each
        // test sorts its fixture rows accordingly. Mock the
        // `select().sort().lean()` chain.
        find: (filter: unknown) => ({
            select: () => ({
                sort: () => ({
                    lean: () => Promise.resolve(billingRateFindMock(filter) ?? []),
                }),
            }),
        }),
    },
}));

vi.mock('../models/attendance-record.model.js', () => ({
    AttendanceRecord: { aggregate: attendanceAggregateMock },
}));

vi.mock('../models/leave-balance.model.js', () => ({
    LeaveBalance: { find: leaveBalanceFindMock },
}));

vi.mock('../models/leave-type.model.js', () => ({
    LeaveType: { find: leaveTypeFindMock },
}));

vi.mock('../models/user.model.js', () => ({
    User: { find: userFindMock },
}));

vi.mock('../models/project.model.js', () => ({
    Project: { findById: projectFindByIdMock },
}));

vi.mock('../models/holiday.model.js', () => ({
    Holiday: { find: holidayFindMock },
}));

vi.mock('../models/task.model.js', () => ({
    Task: { find: taskFindMock },
}));

vi.mock('./settings.service.js', () => ({
    getOrInitSettings: settingsLoadMock,
}));

const svc = await import('./report.service.js');

// ─── Tiny chainable Query stub ────────────────────────────────────────────
//
// Mongoose-style `Model.find(...).select(...).limit(...).lean()` chains
// resolve to the configured rows. The terminal step is awaited or `.then`-ed
// in production code; the stub honors both.
const queryStub = (rows: unknown) => {
    const stub: Record<string, unknown> = {
        select: () => stub,
        sort: () => stub,
        limit: () => stub,
        lean: () => Promise.resolve(rows),
        then: (resolve: (v: unknown) => void) => Promise.resolve(rows).then(resolve),
    };
    return stub;
};

const settingsFixture = () => ({
    timesheet: { daily_warn_threshold_hours: 8, self_edit_window_days: 7 },
});

beforeEach(() => {
    vi.resetAllMocks();
    settingsLoadMock.mockResolvedValue(settingsFixture());
    holidayFindMock.mockReturnValue(queryStub([])); // default: no holidays
});

// ─── Billing report ──────────────────────────────────────────────────────

describe('buildBillingReport', () => {
    const baseQuery = (overrides: Record<string, unknown> = {}) => ({
        project_id: new Types.ObjectId().toString(),
        from_date: '2026-04-01',
        to_date: '2026-04-30',
        group_by: 'task' as 'employee' | 'task',
        ...overrides,
    });

    it('prefers a task-specific rate over the project-level fallback', async () => {
        const projectId = new Types.ObjectId();
        const userId = new Types.ObjectId();
        const taskId = new Types.ObjectId();

        projectFindByIdMock.mockReturnValueOnce(queryStub({ _id: projectId, name: 'Apollo' }));

        timesheetAggregateMock.mockResolvedValueOnce([
            {
                rows: [
                    {
                        _id: { user_id: userId, task_id: taskId },
                        billable_minutes: 600,
                        non_billable_minutes: 0,
                    },
                ],
                rangeTotals: [{ billable_minutes: 600, non_billable_minutes: 0 }],
            },
        ]);

        userFindMock.mockReturnValueOnce(queryStub([{ _id: userId, full_name: 'Anna' }]));
        taskFindMock.mockReturnValueOnce(queryStub([{ _id: taskId, title: 'Build login' }]));

        // H23 — single batched `BillingRate.find` returns ALL relevant
        // rates pre-sorted by `effective_from desc`. Seed two: a
        // task-specific row (newer) and a project-level fallback
        // (older). Task-specific wins on the in-JS first-match
        // resolution.
        billingRateFindMock.mockReturnValueOnce([
            {
                user_id: userId,
                task_id: taskId,
                hourly_rate: 3000,
                effective_from: '2026-03-01',
            },
            {
                user_id: userId,
                task_id: null,
                hourly_rate: 1000,
                effective_from: '2026-01-01',
            },
        ]);

        const result = await svc.buildBillingReport(baseQuery({ project_id: projectId.toString() }));

        expect(result.rows).toHaveLength(1);
        expect(result.rows[0].hourly_rate).toBe(3000);
        expect(result.rows[0].billable_amount).toBe(30000); // 10h × 3000
        expect(result.totals.billable_amount).toBe(30000);

        // H23 — one batched query for the whole report, not 1-2 per row.
        expect(billingRateFindMock).toHaveBeenCalledTimes(1);
    });

    it('falls back to the project-level rate when no task-specific row exists', async () => {
        const projectId = new Types.ObjectId();
        const userId = new Types.ObjectId();
        const taskId = new Types.ObjectId();

        projectFindByIdMock.mockReturnValueOnce(queryStub({ _id: projectId, name: 'Apollo' }));
        timesheetAggregateMock.mockResolvedValueOnce([
            {
                rows: [
                    {
                        _id: { user_id: userId, task_id: taskId },
                        billable_minutes: 120,
                        non_billable_minutes: 0,
                    },
                ],
                rangeTotals: [{ billable_minutes: 120, non_billable_minutes: 0 }],
            },
        ]);
        userFindMock.mockReturnValueOnce(queryStub([{ _id: userId, full_name: 'Anna' }]));
        taskFindMock.mockReturnValueOnce(queryStub([{ _id: taskId, title: 'Triage' }]));

        // H23 — only a project-level rate exists; the task-specific
        // lookup falls through to it.
        billingRateFindMock.mockReturnValueOnce([
            {
                user_id: userId,
                task_id: null,
                hourly_rate: 2000,
                effective_from: '2026-01-01',
            },
        ]);

        const result = await svc.buildBillingReport(baseQuery({ project_id: projectId.toString() }));

        expect(result.rows[0].hourly_rate).toBe(2000);
        expect(result.rows[0].billable_amount).toBe(4000); // 2h × 2000
        expect(billingRateFindMock).toHaveBeenCalledTimes(1);
    });

    it('reports hours but zero amount when no rate matches at all', async () => {
        const projectId = new Types.ObjectId();
        const userId = new Types.ObjectId();
        const taskId = new Types.ObjectId();

        projectFindByIdMock.mockReturnValueOnce(queryStub({ _id: projectId, name: 'Apollo' }));
        timesheetAggregateMock.mockResolvedValueOnce([
            {
                rows: [
                    {
                        _id: { user_id: userId, task_id: taskId },
                        billable_minutes: 480,
                        non_billable_minutes: 30,
                    },
                ],
                rangeTotals: [{ billable_minutes: 480, non_billable_minutes: 30 }],
            },
        ]);
        userFindMock.mockReturnValueOnce(queryStub([{ _id: userId, full_name: 'Anna' }]));
        taskFindMock.mockReturnValueOnce(queryStub([{ _id: taskId, title: 'Untracked' }]));

        // H23 — no matching rate rows at all.
        billingRateFindMock.mockReturnValueOnce([]);

        const result = await svc.buildBillingReport(baseQuery({ project_id: projectId.toString() }));

        expect(result.rows[0].billable_minutes).toBe(480);
        expect(result.rows[0].hourly_rate).toBeNull();
        expect(result.rows[0].billable_amount).toBe(0);
        // The total amount excludes the no-rate row but the minutes total is still reported.
        expect(result.totals.billable_minutes).toBe(480);
        expect(result.totals.billable_amount).toBe(0);
    });

    it('throws PROJECT_NOT_FOUND when the project_id does not resolve', async () => {
        projectFindByIdMock.mockReturnValueOnce(queryStub(null));
        await expect(svc.buildBillingReport(baseQuery())).rejects.toMatchObject({
            code: 'PROJECT_NOT_FOUND',
        });
    });

    it('group_by=employee rolls up server-side: one row per user, project-level rate only', async () => {
        // Two timesheet rows for the same user fold into one billing
        // row when `group_by=employee`. Mongo returns the already-
        // aggregated shape (one row, no `task_id` key); the service
        // must NOT issue a task-specific rate probe on this row.
        const projectId = new Types.ObjectId();
        const userId = new Types.ObjectId();

        projectFindByIdMock.mockReturnValueOnce(queryStub({ _id: projectId, name: 'Apollo' }));
        timesheetAggregateMock.mockResolvedValueOnce([
            {
                rows: [
                    {
                        _id: { user_id: userId }, // task_id absent — group_by=employee shape
                        billable_minutes: 900,
                        non_billable_minutes: 0,
                    },
                ],
                rangeTotals: [{ billable_minutes: 900, non_billable_minutes: 0 }],
            },
        ]);
        userFindMock.mockReturnValueOnce(queryStub([{ _id: userId, full_name: 'Anna' }]));

        // H23 — group_by=employee rows carry no task_id, so the row
        // resolution falls straight to the project-level rate.
        billingRateFindMock.mockReturnValueOnce([
            {
                user_id: userId,
                task_id: null,
                hourly_rate: 2500,
                effective_from: '2026-01-01',
            },
        ]);

        const result = await svc.buildBillingReport(
            baseQuery({ project_id: projectId.toString(), group_by: 'employee' })
        );

        expect(result.rows).toHaveLength(1);
        expect(result.rows[0].task).toEqual({ id: null, title: null });
        expect(result.rows[0].hourly_rate).toBe(2500);
        expect(result.rows[0].billable_amount).toBe(37500); // 15h × 2500
        expect(billingRateFindMock).toHaveBeenCalledTimes(1);
        // Task display batch must be SKIPPED — there are no tasks to hydrate.
        expect(taskFindMock).not.toHaveBeenCalled();
    });
});

// ─── Utilization report ──────────────────────────────────────────────────

describe('buildUtilizationReport', () => {
    it('expected = working_days × daily_threshold × 60 (Mon–Fri minus holidays)', async () => {
        const userId = new Types.ObjectId();
        // 2026-05-01 (Fri) → 2026-05-08 (Fri) inclusive = 8 days.
        // Weekends: Sat 2026-05-02, Sun 2026-05-03 → 6 weekdays.
        // Holiday: 2026-05-05 → 5 working days.
        holidayFindMock.mockReturnValueOnce(queryStub([{ date: '2026-05-05' }]));

        userFindMock.mockReturnValueOnce(queryStub([{ _id: userId, full_name: 'Anna', role: ROLES.EMPLOYEE }]));
        timesheetAggregateMock.mockResolvedValueOnce([
            { _id: userId, billable_minutes: 1200, non_billable_minutes: 0 },
        ]);

        const result = await svc.buildUtilizationReport({
            from_date: '2026-05-01',
            to_date: '2026-05-08',
        });

        // 5 working days × 8 hours × 60 min = 2400.
        expect(result.expected_per_user_minutes).toBe(2400);
        expect(result.rows[0].expected_minutes).toBe(2400);
        // 1200 / 2400 = 50.00.
        expect(result.rows[0].utilization_pct).toBe(50);
        expect(result.rows[0].logged_billable_minutes).toBe(1200);
    });

    it('rounds utilization_pct to two decimals', async () => {
        const userId = new Types.ObjectId();
        holidayFindMock.mockReturnValueOnce(queryStub([]));
        userFindMock.mockReturnValueOnce(queryStub([{ _id: userId, full_name: 'Anna', role: ROLES.EMPLOYEE }]));
        // Mon–Fri (5 working days) × 8h × 60 = 2400 expected. Logged 1234.
        timesheetAggregateMock.mockResolvedValueOnce([
            { _id: userId, billable_minutes: 1000, non_billable_minutes: 234 },
        ]);

        const result = await svc.buildUtilizationReport({
            from_date: '2026-05-04', // Monday
            to_date: '2026-05-08', // Friday
        });

        // 1234 / 2400 = 0.51416..., × 100 = 51.4166..., rounded to 51.42.
        expect(result.rows[0].utilization_pct).toBeCloseTo(51.42, 2);
    });

    it('returns null utilization_pct when expected is 0 (no working days in range)', async () => {
        const userId = new Types.ObjectId();
        holidayFindMock.mockReturnValueOnce(queryStub([]));
        userFindMock.mockReturnValueOnce(queryStub([{ _id: userId, full_name: 'Anna', role: ROLES.EMPLOYEE }]));
        timesheetAggregateMock.mockResolvedValueOnce([]);
        // Sat–Sun = 0 working days.
        const result = await svc.buildUtilizationReport({
            from_date: '2026-05-09',
            to_date: '2026-05-10',
        });
        expect(result.expected_per_user_minutes).toBe(0);
        expect(result.rows[0].utilization_pct).toBeNull();
    });

    it('returns an empty rows[] when no users match the role filter', async () => {
        userFindMock.mockReturnValueOnce(queryStub([]));
        const result = await svc.buildUtilizationReport({
            from_date: '2026-05-04',
            to_date: '2026-05-08',
        });
        expect(result.rows).toEqual([]);
        // No timesheet aggregation when there are no users to roll up.
        expect(timesheetAggregateMock).not.toHaveBeenCalled();
    });
});

// ─── Attendance report ───────────────────────────────────────────────────

describe('buildAttendanceReport', () => {
    it('pivots (user_id, status) group rows into the 6 status buckets per user', async () => {
        const userA = new Types.ObjectId();
        const userB = new Types.ObjectId();

        userFindMock.mockReturnValueOnce(
            queryStub([
                { _id: userA, full_name: 'Anna' },
                { _id: userB, full_name: 'Ben' },
            ])
        );
        // First aggregate call: status-pivot counts.
        attendanceAggregateMock.mockResolvedValueOnce([
            { _id: { user_id: userA, status: 'present' }, count: 18 },
            { _id: { user_id: userA, status: 'on_leave' }, count: 2 },
            { _id: { user_id: userA, status: 'weekend' }, count: 8 },
            { _id: { user_id: userB, status: 'present' }, count: 15 },
            { _id: { user_id: userB, status: 'absent' }, count: 1 },
            { _id: { user_id: userB, status: 'incomplete' }, count: 4 },
        ]);
        // Second aggregate call: per-user break-minute totals.
        attendanceAggregateMock.mockResolvedValueOnce([
            { _id: userA, total_break_minutes: 0 },
            { _id: userB, total_break_minutes: 0 },
        ]);

        const result = await svc.buildAttendanceReport({
            from_date: '2026-04-01',
            to_date: '2026-04-30',
        });

        const rowA = result.rows.find((r) => r.user.id === userA.toString())!;
        expect(rowA.present).toBe(18);
        expect(rowA.on_leave).toBe(2);
        expect(rowA.weekend).toBe(8);
        // Buckets that didn't appear in the aggregation default to 0.
        expect(rowA.absent).toBe(0);
        expect(rowA.holiday).toBe(0);
        expect(rowA.incomplete).toBe(0);
        expect(rowA.total_days).toBe(28);

        const rowB = result.rows.find((r) => r.user.id === userB.toString())!;
        expect(rowB.present).toBe(15);
        expect(rowB.incomplete).toBe(4);
        expect(rowB.total_days).toBe(20);
    });

    it('returns a zero-filled row for users with no attendance rows in range', async () => {
        const userId = new Types.ObjectId();
        userFindMock.mockReturnValueOnce(queryStub([{ _id: userId, full_name: 'Anna' }]));
        // Two aggregate calls: status-pivot then break-totals — both empty.
        attendanceAggregateMock.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

        const result = await svc.buildAttendanceReport({
            from_date: '2026-04-01',
            to_date: '2026-04-30',
        });

        expect(result.rows).toHaveLength(1);
        expect(result.rows[0]).toMatchObject({
            present: 0,
            absent: 0,
            on_leave: 0,
            holiday: 0,
            weekend: 0,
            incomplete: 0,
            total_days: 0,
            total_break_minutes: 0,
        });
    });

    it('sums total_break_minutes across all attendance records in the range', async () => {
        const userA = new Types.ObjectId();
        const userB = new Types.ObjectId();

        userFindMock.mockReturnValueOnce(
            queryStub([
                { _id: userA, full_name: 'Anna' },
                { _id: userB, full_name: 'Ben' },
            ])
        );
        // First aggregate call: status-pivot counts.
        attendanceAggregateMock.mockResolvedValueOnce([
            { _id: { user_id: userA, status: 'present' }, count: 10 },
            { _id: { user_id: userB, status: 'present' }, count: 8 },
        ]);
        // Second aggregate call: per-user break-minute totals.
        attendanceAggregateMock.mockResolvedValueOnce([
            { _id: userA, total_break_minutes: 150 },
            { _id: userB, total_break_minutes: 60 },
        ]);

        const result = await svc.buildAttendanceReport({
            from_date: '2026-05-01',
            to_date: '2026-05-31',
        });

        const rowA = result.rows.find((r) => r.user.id === userA.toString())!;
        expect(rowA.total_break_minutes).toBe(150);

        const rowB = result.rows.find((r) => r.user.id === userB.toString())!;
        expect(rowB.total_break_minutes).toBe(60);
    });

    it('defaults total_break_minutes to 0 for users with no break records in range', async () => {
        const userId = new Types.ObjectId();
        userFindMock.mockReturnValueOnce(queryStub([{ _id: userId, full_name: 'Anna' }]));
        attendanceAggregateMock
            .mockResolvedValueOnce([{ _id: { user_id: userId, status: 'present' }, count: 5 }])
            .mockResolvedValueOnce([]); // No break totals row for this user.

        const result = await svc.buildAttendanceReport({
            from_date: '2026-05-01',
            to_date: '2026-05-31',
        });

        expect(result.rows[0].total_break_minutes).toBe(0);
    });
});

// ─── Leave report ────────────────────────────────────────────────────────

describe('buildLeaveReport', () => {
    it('joins balances with leave-type label, sorted alphabetically by label', async () => {
        const userId = new Types.ObjectId();
        const clTypeId = new Types.ObjectId();
        const slTypeId = new Types.ObjectId();

        userFindMock.mockReturnValueOnce(queryStub([{ _id: userId, full_name: 'Anna' }]));
        leaveBalanceFindMock.mockReturnValueOnce(
            queryStub([
                {
                    user_id: userId,
                    leave_type_id: slTypeId,
                    allocated: 10,
                    carried_forward: 0,
                    used: 1,
                    pending: 0,
                    adjusted: 0,
                    monthly_forfeited: 1,
                    available: 8,
                },
                {
                    user_id: userId,
                    leave_type_id: clTypeId,
                    allocated: 12,
                    carried_forward: 5,
                    used: 2,
                    pending: 1,
                    adjusted: 0,
                    monthly_forfeited: 0,
                    available: 14,
                },
            ])
        );
        leaveTypeFindMock.mockReturnValueOnce(
            queryStub([
                { _id: clTypeId, code: 'CL', name: 'Casual Leave' },
                { _id: slTypeId, code: 'SL', name: 'Sick Leave' },
            ])
        );

        const result = await svc.buildLeaveReport({ year: 2026 });

        expect(result.year).toBe(2026);
        expect(result.rows).toHaveLength(1);
        const types = result.rows[0].by_type;
        expect(types).toHaveLength(2);
        // Sorted by label: "Casual Leave" before "Sick Leave".
        expect(types[0].leave_type.key).toBe('CL');
        expect(types[0].available).toBe(14);
        expect(types[0].carried_forward).toBe(5);
        expect(types[1].leave_type.key).toBe('SL');
        expect(types[1].monthly_forfeited).toBe(1);
    });

    it('renders an empty by_type for users without balances in the year', async () => {
        const userId = new Types.ObjectId();
        userFindMock.mockReturnValueOnce(queryStub([{ _id: userId, full_name: 'Anna' }]));
        leaveBalanceFindMock.mockReturnValueOnce(queryStub([]));
        leaveTypeFindMock.mockReturnValueOnce(queryStub([]));

        const result = await svc.buildLeaveReport({ year: 2026 });

        expect(result.rows).toHaveLength(1);
        expect(result.rows[0].by_type).toEqual([]);
    });

    it('returns empty rows when no users match the role filter', async () => {
        userFindMock.mockReturnValueOnce(queryStub([]));
        const result = await svc.buildLeaveReport({ year: 2026 });
        expect(result.rows).toEqual([]);
        // Skip the balance load entirely when there's nobody to report on.
        expect(leaveBalanceFindMock).not.toHaveBeenCalled();
    });
});
