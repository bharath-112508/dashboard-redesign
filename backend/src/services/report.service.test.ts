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
    projectFindMock,
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
    projectFindMock: vi.fn(),
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
    presentedAvailable: (
        b: {
            allocated: number;
            carried_forward: number;
            used: number;
            pending: number;
            adjusted: number;
            monthly_forfeited: number;
        },
        lt: { is_unlimited?: boolean } | null | undefined
    ) =>
        lt?.is_unlimited ? 0 : b.allocated + b.carried_forward + b.adjusted - b.used - b.pending - b.monthly_forfeited,
}));

vi.mock('../models/leave-type.model.js', () => ({
    LeaveType: { find: leaveTypeFindMock },
}));

vi.mock('../models/user.model.js', () => ({
    User: { find: userFindMock },
}));

vi.mock('../models/project.model.js', () => ({
    Project: { findById: projectFindByIdMock, find: projectFindMock },
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
    // Post-multi-user/per-project: the query carries `user_ids` + `billable`
    // (the validator defaults billable → 'all'). This helper mirrors that so
    // tests read like a real request.
    const utilQuery = (overrides: Record<string, unknown> = {}) => ({
        from_date: '2026-05-04',
        to_date: '2026-05-08',
        user_ids: undefined as string[] | undefined,
        billable: 'all' as 'all' | 'billable' | 'non_billable',
        ...overrides,
    });

    it('expected = working_days × daily_threshold × 60 (Mon–Fri minus holidays)', async () => {
        const userId = new Types.ObjectId();
        // 2026-05-01 (Fri) → 2026-05-08 (Fri) inclusive = 8 days.
        // Weekends: Sat 2026-05-02, Sun 2026-05-03 → 6 weekdays.
        // Holiday: 2026-05-05 → 5 working days.
        holidayFindMock.mockReturnValueOnce(queryStub([{ date: '2026-05-05' }]));

        userFindMock.mockReturnValueOnce(queryStub([{ _id: userId, full_name: 'Anna', role: ROLES.EMPLOYEE }]));
        timesheetAggregateMock.mockResolvedValueOnce([
            { _id: { user_id: userId, project_id: null }, billable_minutes: 1200, non_billable_minutes: 0 },
        ]);

        const result = await svc.buildUtilizationReport(utilQuery({ from_date: '2026-05-01', to_date: '2026-05-08' }));

        // 5 working days × 8 hours × 60 min = 2400.
        expect(result.expected_per_user_minutes).toBe(2400);
        expect(result.rows[0].expected_minutes).toBe(2400);
        // 1200 / 2400 = 50.00.
        expect(result.rows[0].utilization_pct).toBe(50);
        expect(result.rows[0].logged_billable_minutes).toBe(1200);
        expect(result.rows[0].logged_total_minutes).toBe(1200);
        expect(result.billable).toBe('all');
    });

    it('rounds utilization_pct to two decimals', async () => {
        const userId = new Types.ObjectId();
        holidayFindMock.mockReturnValueOnce(queryStub([]));
        userFindMock.mockReturnValueOnce(queryStub([{ _id: userId, full_name: 'Anna', role: ROLES.EMPLOYEE }]));
        // Mon–Fri (5 working days) × 8h × 60 = 2400 expected. Logged 1234.
        timesheetAggregateMock.mockResolvedValueOnce([
            { _id: { user_id: userId, project_id: null }, billable_minutes: 1000, non_billable_minutes: 234 },
        ]);

        const result = await svc.buildUtilizationReport(utilQuery());

        // 1234 / 2400 = 0.51416..., × 100 = 51.4166..., rounded to 51.42.
        expect(result.rows[0].utilization_pct).toBeCloseTo(51.42, 2);
    });

    it('returns null utilization_pct when expected is 0 (no working days in range)', async () => {
        const userId = new Types.ObjectId();
        holidayFindMock.mockReturnValueOnce(queryStub([]));
        userFindMock.mockReturnValueOnce(queryStub([{ _id: userId, full_name: 'Anna', role: ROLES.EMPLOYEE }]));
        timesheetAggregateMock.mockResolvedValueOnce([]);
        // Sat–Sun = 0 working days.
        const result = await svc.buildUtilizationReport(utilQuery({ from_date: '2026-05-09', to_date: '2026-05-10' }));
        expect(result.expected_per_user_minutes).toBe(0);
        expect(result.rows[0].utilization_pct).toBeNull();
    });

    it('returns an empty rows[] when no users match the role filter', async () => {
        userFindMock.mockReturnValueOnce(queryStub([]));
        const result = await svc.buildUtilizationReport(utilQuery());
        expect(result.rows).toEqual([]);
        // No timesheet aggregation when there are no users to roll up.
        expect(timesheetAggregateMock).not.toHaveBeenCalled();
    });

    it('splits a user across projects with share_pct summing to ~100 and hydrates project names', async () => {
        const userId = new Types.ObjectId();
        const apollo = new Types.ObjectId();
        const gemini = new Types.ObjectId();
        holidayFindMock.mockReturnValueOnce(queryStub([]));
        userFindMock.mockReturnValueOnce(queryStub([{ _id: userId, full_name: 'Anna', role: ROLES.EMPLOYEE }]));
        // 900 on Apollo, 300 on Gemini, 300 unassigned → 1500 total.
        timesheetAggregateMock.mockResolvedValueOnce([
            { _id: { user_id: userId, project_id: apollo }, billable_minutes: 600, non_billable_minutes: 300 },
            { _id: { user_id: userId, project_id: gemini }, billable_minutes: 300, non_billable_minutes: 0 },
            { _id: { user_id: userId, project_id: null }, billable_minutes: 0, non_billable_minutes: 300 },
        ]);
        projectFindMock.mockReturnValueOnce(
            queryStub([
                { _id: apollo, name: 'Apollo' },
                { _id: gemini, name: 'Gemini' },
            ])
        );

        const result = await svc.buildUtilizationReport(utilQuery());

        const row = result.rows[0];
        expect(row.logged_total_minutes).toBe(1500);
        // Sorted by total_minutes desc: Apollo (900), then Gemini/Unassigned (300 each).
        expect(row.projects).toHaveLength(3);
        expect(row.projects[0].project).toEqual({ id: apollo.toString(), name: 'Apollo' });
        expect(row.projects[0].total_minutes).toBe(900);
        expect(row.projects[0].share_pct).toBe(60); // 900/1500
        // The null-project group renders as an "Unassigned" bucket (project: null).
        expect(row.projects.some((p) => p.project === null)).toBe(true);
        const shareSum = row.projects.reduce((s, p) => s + p.share_pct, 0);
        expect(shareSum).toBeCloseTo(100, 1);
    });

    it('billable=billable excludes non-billable minutes from totals, utilization, and project rows', async () => {
        const userId = new Types.ObjectId();
        const apollo = new Types.ObjectId();
        holidayFindMock.mockReturnValueOnce(queryStub([]));
        userFindMock.mockReturnValueOnce(queryStub([{ _id: userId, full_name: 'Anna', role: ROLES.EMPLOYEE }]));
        // Apollo: 600 billable + 300 non-billable. Chores: 0 billable + 240 non-billable.
        const chores = new Types.ObjectId();
        timesheetAggregateMock.mockResolvedValueOnce([
            { _id: { user_id: userId, project_id: apollo }, billable_minutes: 600, non_billable_minutes: 300 },
            { _id: { user_id: userId, project_id: chores }, billable_minutes: 0, non_billable_minutes: 240 },
        ]);
        projectFindMock.mockReturnValueOnce(
            queryStub([
                { _id: apollo, name: 'Apollo' },
                { _id: chores, name: 'Chores' },
            ])
        );

        const result = await svc.buildUtilizationReport(utilQuery({ billable: 'billable' }));

        const row = result.rows[0];
        expect(result.billable).toBe('billable');
        // Only billable minutes count now: 600 total, not 900+240.
        expect(row.logged_total_minutes).toBe(600);
        expect(row.utilization_pct).toBe(25); // 600 / 2400
        // Raw sub-values are still surfaced for display.
        expect(row.logged_billable_minutes).toBe(600);
        expect(row.logged_non_billable_minutes).toBe(540);
        // The purely non-billable "Chores" project drops out of the breakdown.
        expect(row.projects).toHaveLength(1);
        expect(row.projects[0].project?.name).toBe('Apollo');
        expect(row.projects[0].total_minutes).toBe(600);
        expect(row.projects[0].share_pct).toBe(100);
    });

    it('narrows the user filter to the union of user_ids when provided', async () => {
        const a = new Types.ObjectId();
        const b = new Types.ObjectId();
        holidayFindMock.mockReturnValueOnce(queryStub([]));
        userFindMock.mockReturnValueOnce(queryStub([]));
        await svc.buildUtilizationReport(utilQuery({ user_ids: [a.toString(), b.toString()] }));
        const filterArg = userFindMock.mock.calls[0][0] as { _id?: { $in: Types.ObjectId[] } };
        expect(filterArg._id?.$in).toHaveLength(2);
        expect(filterArg._id?.$in.map((id) => id.toString())).toEqual([a.toString(), b.toString()]);
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
        // April has 30 calendar days — total_days is the range span, NOT
        // the bucket sum (18 + 2 + 8 = 28 here), so a gap in the
        // underlying attendance data doesn't silently shrink it.
        expect(rowA.total_days).toBe(30);

        const rowB = result.rows.find((r) => r.user.id === userB.toString())!;
        expect(rowB.present).toBe(15);
        expect(rowB.incomplete).toBe(4);
        // Same calendar span as rowA, even though rowB's buckets only sum
        // to 19 (15 + 1 + 4).
        expect(rowB.total_days).toBe(30);
    });

    it('total_days is the calendar span of the range, not a sum of the status buckets', async () => {
        // Guards the fix: total_days used to equal
        // present+absent+on_leave+holiday+weekend+incomplete, so a day the
        // nightly finalizer failed to process (server offline at its
        // 23:00 IST run) silently vanished from the total instead of
        // surfacing as a gap. Anchoring it to the calendar span means a
        // shortfall in the buckets is now visible as "buckets don't sum to
        // total_days" rather than an invisible undercount.
        const userId = new Types.ObjectId();
        userFindMock.mockReturnValueOnce(queryStub([{ _id: userId, full_name: 'Anna' }]));
        // Only 6 of the 7 days in range have ANY attendance record — a
        // data gap identical to the one found in production data.
        attendanceAggregateMock
            .mockResolvedValueOnce([
                { _id: { user_id: userId, status: 'present' }, count: 5 },
                { _id: { user_id: userId, status: 'weekend' }, count: 1 },
            ])
            .mockResolvedValueOnce([]);

        const result = await svc.buildAttendanceReport({
            from_date: '2026-07-13',
            to_date: '2026-07-19',
        });

        expect(result.rows[0].total_days).toBe(7);
        const bucketSum =
            result.rows[0].present +
            result.rows[0].absent +
            result.rows[0].on_leave +
            result.rows[0].holiday +
            result.rows[0].weekend +
            result.rows[0].incomplete;
        expect(bucketSum).toBe(6);
        expect(bucketSum).not.toBe(result.rows[0].total_days);
    });

    it('returns a zero-bucket row (but a real calendar-day total_days) for users with no attendance rows in range', async () => {
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
            // NOT 0 — total_days is the calendar span (April = 30 days)
            // regardless of how many (if any) attendance rows exist.
            total_days: 30,
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
