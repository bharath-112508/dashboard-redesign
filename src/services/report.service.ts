import { Types } from 'mongoose';

import { TimesheetEntry } from '../models/timesheet-entry.model.js';
import { BillingRate } from '../models/billing-rate.model.js';
import { AttendanceRecord } from '../models/attendance-record.model.js';
import { LeaveBalance } from '../models/leave-balance.model.js';
import { LeaveType } from '../models/leave-type.model.js';
import { User } from '../models/user.model.js';
import { Project } from '../models/project.model.js';
import { Holiday } from '../models/holiday.model.js';
import { Task } from '../models/task.model.js';
import { AppError } from '../utils/app-error.js';
import { ERROR_CODES } from '../constants/error-codes.js';
import { ROLES } from '../constants/roles.js';
import { USER_STATUSES } from '../constants/user-statuses.js';
import { REPORT_DEFAULT_DAILY_HOURS, REPORT_ROW_CAP } from '../constants/report.js';
import { getOrInitSettings } from './settings.service.js';
import dayjs, { DATE_FORMAT } from '../utils/date.js';
import type {
    AttendanceReportQuery,
    BillingReportQuery,
    LeaveReportQuery,
    UtilizationReportQuery,
} from '../validators/report.validator.js';

/**
 * Reports service (Step 29; API_Contract §10).
 *
 * Four read-only aggregation entry points — one per report. All four
 * are gated to manager+admin at the route layer; the service does not
 * re-check role because every aggregation crosses user boundaries by
 * design. Reports are immutable: no audit, no notification, no
 * persisted state — purely derived from the operational collections.
 *
 * Architecture:
 *  - Date-range bounds are validated upstream (`report.validator`); the
 *    service trusts well-formed `from_date <= to_date` strings.
 *  - All aggregations cap output at `REPORT_ROW_CAP` (1 000 rows). The
 *    Step-30 export pipeline streams the same data without the cap;
 *    JSON responses are always bounded.
 *  - "Working days" (utilization, attendance) = Mon–Fri minus rows in
 *    the `holidays` collection. Per-user contracts (32-hour weeks etc.)
 *    are deferred to v1.5; today the calculation is org-uniform.
 *  - Billing rate lookup follows Data_Model §6.2: task-specific row
 *    first, then project-level fallback (`task_id: null`). Entries
 *    without ANY matching rate are reported in HOURS but excluded
 *    from the BILLABLE_AMOUNT total — losing rate visibility silently
 *    would understate billing.
 */

// ─── Common helpers ──────────────────────────────────────────────────────

const todayLocal = (): string => dayjs().format(DATE_FORMAT);

/**
 * Inclusive working-day count between `from` and `to` (ISO date
 * strings). Excludes Saturdays, Sundays, and any date present in
 * `holidayDates`. Used by both the utilization and attendance reports
 * so the "expected" baseline is identical across surfaces.
 */
const countWorkingDays = (from: string, to: string, holidayDates: ReadonlySet<string>): number => {
    let count = 0;
    let cursor = dayjs(from);
    const end = dayjs(to);
    while (cursor.isBefore(end) || cursor.isSame(end, 'day')) {
        const dow = cursor.day(); // 0 = Sun, 6 = Sat
        const iso = cursor.format(DATE_FORMAT);
        if (dow !== 0 && dow !== 6 && !holidayDates.has(iso)) count += 1;
        cursor = cursor.add(1, 'day');
    }
    return count;
};

const loadHolidayDateSet = async (from: string, to: string): Promise<Set<string>> => {
    const rows = await Holiday.find({ date: { $gte: from, $lte: to } })
        .select('date')
        .lean<{ date: string }[]>();
    return new Set(rows.map((r) => r.date));
};

// ─── /reports/billing ────────────────────────────────────────────────────

interface BillingRow {
    user: { id: string; full_name: string };
    task: { id: string | null; title: string | null };
    billable_minutes: number;
    non_billable_minutes: number;
    hourly_rate: number | null;
    billable_amount: number;
}

interface BillingTotals {
    billable_minutes: number;
    non_billable_minutes: number;
    billable_amount: number;
}

export interface BillingReportResult {
    project: { id: string; name: string };
    from_date: string;
    to_date: string;
    rows: BillingRow[];
    totals: BillingTotals;
}

interface UserDisplay {
    id: string;
    full_name: string;
}

interface TaskDisplay {
    id: string | null;
    title: string | null;
}

const loadUserDisplays = async (ids: Types.ObjectId[]): Promise<Map<string, UserDisplay>> => {
    if (ids.length === 0) return new Map();
    const rows = await User.find({ _id: { $in: ids } })
        .select('_id full_name')
        .lean<{ _id: Types.ObjectId; full_name: string }[]>();
    return new Map(rows.map((r) => [r._id.toString(), { id: r._id.toString(), full_name: r.full_name }]));
};

const loadTaskDisplays = async (ids: Types.ObjectId[]): Promise<Map<string, TaskDisplay>> => {
    if (ids.length === 0) return new Map();
    const rows = await Task.find({ _id: { $in: ids } })
        .select('_id title')
        .lean<{ _id: Types.ObjectId; title: string }[]>();
    return new Map(rows.map((r) => [r._id.toString(), { id: r._id.toString(), title: r.title }]));
};

export const buildBillingReport = async (query: BillingReportQuery): Promise<BillingReportResult> => {
    const projectId = new Types.ObjectId(query.project_id);
    // M14 — `client_id` was previously accepted by the validator but
    // ignored by the service, so a caller passing it got the same data
    // as one omitting it. The billing report has no row-level
    // company field to filter on (client-side users are external, they
    // don't log timesheets), so the meaningful interpretation is a gate:
    // assert the project actually belongs to that company. If not, refuse —
    // the report is per-company meaningless. The check runs before any
    // aggregation so an invalid pairing fails fast.
    //
    // Was `client_id` (a client USER, checked against `client_ids`).
    // Projects belong to a COMPANY now, so the gate is a single equality
    // on `company_id` rather than array containment.
    const projectSelectFields: string[] = ['_id', 'name'];
    if (query.company_id) projectSelectFields.push('company_id');
    const project = await Project.findById(projectId)
        .select(projectSelectFields.join(' '))
        .lean<{ _id: Types.ObjectId; name: string; company_id?: Types.ObjectId | null } | null>();
    if (!project) throw AppError.notFound('Project not found', ERROR_CODES.PROJECT_NOT_FOUND);
    if (query.company_id) {
        const companyId = new Types.ObjectId(query.company_id);
        const onProject = Boolean(project.company_id && project.company_id.equals(companyId));
        if (!onProject) {
            // Same shape as the not-found path — operationally there's
            // nothing to report for this (project, client) pair.
            throw AppError.notFound('Project not found', ERROR_CODES.PROJECT_NOT_FOUND);
        }
    }

    // `$facet` so the rows + totals share one pipeline + one round-trip.
    // Both branches start from the same `$match` (project + date range +
    // task-linked entries — general entries don't have a task_id and
    // are excluded from the billing roll-up by design).
    const matchStage = {
        project_id: projectId,
        local_date: { $gte: query.from_date, $lte: query.to_date },
        entry_type: 'task_linked' as const,
    };

    // `group_by` actually shapes the server-side group key:
    //  - `task`     → one row per (user, task) tuple; rate lookup uses the
    //                 task-specific row with project-level fallback.
    //  - `employee` → one row per user; task is collapsed away. Rate
    //                 lookup uses the project-level row only — there is
    //                 no single task to attach a task-specific rate to
    //                 once N tasks have been summed.
    const groupKey: Record<string, string> =
        query.group_by === 'task' ? { user_id: '$user_id', task_id: '$task_id' } : { user_id: '$user_id' };

    type FacetResult = {
        rows: Array<{
            _id: { user_id: Types.ObjectId; task_id?: Types.ObjectId | null };
            billable_minutes: number;
            non_billable_minutes: number;
        }>;
        rangeTotals: Array<{ billable_minutes: number; non_billable_minutes: number }>;
    };

    const aggregated = await TimesheetEntry.aggregate<FacetResult>([
        { $match: matchStage },
        {
            $facet: {
                rows: [
                    {
                        $group: {
                            _id: groupKey,
                            billable_minutes: { $sum: '$billable_total_minutes' },
                            non_billable_minutes: { $sum: '$non_billable_total_minutes' },
                        },
                    },
                    { $sort: { billable_minutes: -1 } },
                    { $limit: REPORT_ROW_CAP },
                ],
                rangeTotals: [
                    {
                        $group: {
                            _id: null,
                            billable_minutes: { $sum: '$billable_total_minutes' },
                            non_billable_minutes: { $sum: '$non_billable_total_minutes' },
                        },
                    },
                ],
            },
        },
    ]);

    const facet = aggregated[0] ?? { rows: [], rangeTotals: [] };

    // Hydrate user + task display fields in two batched lookups.
    const userIds = Array.from(new Set(facet.rows.map((r) => r._id.user_id.toString()))).map(
        (id) => new Types.ObjectId(id)
    );
    const taskIds =
        query.group_by === 'task'
            ? Array.from(
                  new Set(
                      facet.rows
                          .filter((r) => r._id.task_id != null)
                          .map((r) => (r._id.task_id as Types.ObjectId).toString())
                  )
              ).map((id) => new Types.ObjectId(id))
            : [];

    const [userMap, taskMap] = await Promise.all([loadUserDisplays(userIds), loadTaskDisplays(taskIds)]);

    // Resolve the effective rate per row. `to_date` is the lookup date
    // so the report shows the rate that applied at the END of the
    // window. A future enhancement could weight by per-entry rate at
    // `local_date`, but the simpler "rate-at-window-end" matches what
    // most billing systems report.
    //
    // H23 — pre-H23 this fired up to 2000 sequential `findOne` round-
    // trips per report call (1 task-specific + 1 project-level per
    // row, ×1000 rows cap). Even with `Promise.all` parallelising, the
    // Mongo connection pool (default 100, now capped at 50 per H20)
    // serialised in practice and a billing report on a busy project
    // took seconds-of-wall-time on Mongo I/O alone.
    //
    // Now: ONE find that pulls every rate row matching the date
    // window for the `(user, project)` set used by this report. Pick
    // task-specific first, fall back to project-level — same logic
    // as `findEffectiveRate` but resolved in JS against an in-memory
    // map. Rates are sorted by `effective_from desc` so the first
    // match wins per `(user, task)` key.
    const taskIdSet = facet.rows.map((r) => r._id.task_id).filter((t): t is Types.ObjectId => Boolean(t));
    const rateRows = await BillingRate.find({
        user_id: { $in: userIds },
        project_id: projectId,
        effective_from: { $lte: query.to_date },
        $and: [
            { $or: [{ effective_to: null }, { effective_to: { $gte: query.to_date } }] },
            {
                $or: [...(taskIdSet.length ? [{ task_id: { $in: taskIdSet } }] : []), { task_id: null }],
            },
        ],
    })
        .select('user_id task_id hourly_rate effective_from')
        // H23 follow-through — secondary `_id: -1` makes the sort
        // deterministic when two rates share the same `effective_from`
        // (legitimate: a project + task rate effective on the same day,
        // or two task rates inserted on the same day). Without it,
        // Mongo's order on ties is implementation-defined and the
        // first-write-wins map population could pick different rates
        // on different report runs. Pre-H23 `findOne` had the same
        // risk; this hardens the new batched query.
        .sort({ effective_from: -1, _id: -1 })
        .lean<
            {
                user_id: Types.ObjectId;
                task_id: Types.ObjectId | null;
                hourly_rate: number;
                effective_from: string;
            }[]
        >();

    // Build two maps: task-specific `(user|task) → rate` and
    // project-level `(user) → rate`. Sort is desc so the first
    // insertion wins (= latest effective rate at or before the
    // window end date).
    const taskRateMap = new Map<string, number>();
    const projectRateMap = new Map<string, number>();
    for (const r of rateRows) {
        if (r.task_id) {
            const k = `${r.user_id.toString()}|${r.task_id.toString()}`;
            if (!taskRateMap.has(k)) taskRateMap.set(k, r.hourly_rate);
        } else {
            const k = r.user_id.toString();
            if (!projectRateMap.has(k)) projectRateMap.set(k, r.hourly_rate);
        }
    }
    const rates: (number | null)[] = facet.rows.map((r) => {
        const userKey = r._id.user_id.toString();
        if (r._id.task_id) {
            const taskKey = `${userKey}|${r._id.task_id.toString()}`;
            const taskRate = taskRateMap.get(taskKey);
            if (taskRate !== undefined) return taskRate;
        }
        return projectRateMap.get(userKey) ?? null;
    });

    let totalBillableAmount = 0;
    const hydratedRows: BillingRow[] = facet.rows.map((r, i) => {
        const userDisplay = userMap.get(r._id.user_id.toString()) ?? {
            id: r._id.user_id.toString(),
            full_name: '(unknown user)',
        };
        const taskDisplay: TaskDisplay = r._id.task_id
            ? (taskMap.get(r._id.task_id.toString()) ?? { id: r._id.task_id.toString(), title: '(deleted task)' })
            : { id: null, title: null };

        const hourlyRate = rates[i];
        const billableHours = r.billable_minutes / 60;
        const billableAmount = hourlyRate !== null ? Math.round(billableHours * hourlyRate) : 0;
        totalBillableAmount += billableAmount;

        return {
            user: userDisplay,
            task: taskDisplay,
            billable_minutes: r.billable_minutes,
            non_billable_minutes: r.non_billable_minutes,
            hourly_rate: hourlyRate,
            billable_amount: billableAmount,
        };
    });

    const totalsRow = facet.rangeTotals[0] ?? { billable_minutes: 0, non_billable_minutes: 0 };

    return {
        project: { id: project._id.toString(), name: project.name },
        from_date: query.from_date,
        to_date: query.to_date,
        rows: hydratedRows,
        totals: {
            billable_minutes: totalsRow.billable_minutes,
            non_billable_minutes: totalsRow.non_billable_minutes,
            billable_amount: totalBillableAmount,
        },
    };
};

// ─── /reports/utilization ────────────────────────────────────────────────

/** Per-project slice of a user's logged time. `project: null` = the "Unassigned" bucket. */
interface UtilizationProjectRow {
    project: { id: string; name: string } | null;
    billable_minutes: number;
    non_billable_minutes: number;
    /** billable + non-billable, filtered by the `billable` query param. */
    total_minutes: number;
    /** total_minutes ÷ the user's filtered total, two decimals. 0 when the user has no logged time. */
    share_pct: number;
}

interface UtilizationRow {
    user: { id: string; full_name: string; role: string };
    logged_billable_minutes: number;
    logged_non_billable_minutes: number;
    /** billable + non-billable, filtered by the `billable` query param. */
    logged_total_minutes: number;
    expected_minutes: number;
    /** logged_total / expected — clamped to two decimal places. Null when expected is 0. */
    utilization_pct: number | null;
    /** Per-project breakdown, sorted by total_minutes desc. */
    projects: UtilizationProjectRow[];
}

export interface UtilizationReportResult {
    from_date: string;
    to_date: string;
    expected_per_user_minutes: number;
    /** Echoes the applied filter so the FE can label the utilization column. */
    billable: 'all' | 'billable' | 'non_billable';
    rows: UtilizationRow[];
}

/**
 * Picks the minute count that counts toward utilization given the
 * `billable` filter. Single source of truth so the per-user total, the
 * per-project total, and the utilization % never drift apart.
 */
const filteredMinutes = (billable: number, nonBillable: number, mode: 'all' | 'billable' | 'non_billable'): number => {
    if (mode === 'billable') return billable;
    if (mode === 'non_billable') return nonBillable;
    return billable + nonBillable;
};

export const buildUtilizationReport = async (query: UtilizationReportQuery): Promise<UtilizationReportResult> => {
    // `team_id` accepted by the validator but ignored by the service —
    // no `team` collection exists in v1. Documented at the validator.
    const billableMode = query.billable ?? 'all';
    const settings = await getOrInitSettings();
    const dailyHours = Number.isFinite(settings.timesheet.daily_warn_threshold_hours)
        ? settings.timesheet.daily_warn_threshold_hours
        : REPORT_DEFAULT_DAILY_HOURS;
    const holidayDates = await loadHolidayDateSet(query.from_date, query.to_date);
    const workingDays = countWorkingDays(query.from_date, query.to_date, holidayDates);
    const expectedPerUserMinutes = workingDays * dailyHours * 60;

    // Internal users only — clients don't log time, so their
    // utilization is structurally undefined and they'd render as 0%
    // which would skew the team average. Filtering keeps the report
    // honest.
    const userFilter: Record<string, unknown> = {
        status: USER_STATUSES.ACTIVE,
        role: { $in: [ROLES.ADMIN, ROLES.MANAGER, ROLES.EMPLOYEE] },
    };
    // Union `user_id` (single, back-compat) with `user_ids` (multi). Empty
    // → no `_id` narrowing → all internal users (the default).
    const selectedIds = new Set<string>([...(query.user_ids ?? []), ...(query.user_id ? [query.user_id] : [])]);
    if (selectedIds.size > 0) {
        userFilter._id = { $in: Array.from(selectedIds).map((id) => new Types.ObjectId(id)) };
    }

    const users = await User.find(userFilter)
        .select('_id full_name role')
        .limit(REPORT_ROW_CAP)
        .lean<{ _id: Types.ObjectId; full_name: string; role: string }[]>();

    if (users.length === 0) {
        return {
            from_date: query.from_date,
            to_date: query.to_date,
            expected_per_user_minutes: expectedPerUserMinutes,
            billable: billableMode,
            rows: [],
        };
    }

    const userIds = users.map((u) => u._id);

    // Optional project scope: narrow the entries to this one project.
    // "Unassigned" (project_id: null) general time falls out naturally — it
    // isn't attributable to any project.
    const entryMatch: Record<string, unknown> = {
        user_id: { $in: userIds },
        local_date: { $gte: query.from_date, $lte: query.to_date },
    };
    if (query.project_id) {
        entryMatch.project_id = new Types.ObjectId(query.project_id);
    }

    // Group by (user, project) so each user row can carry a per-project
    // breakdown. `project_id: null` (general/non-project time) groups
    // into its own bucket, rendered as "Unassigned".
    const groups = await TimesheetEntry.aggregate<{
        _id: { user_id: Types.ObjectId; project_id: Types.ObjectId | null };
        billable_minutes: number;
        non_billable_minutes: number;
    }>([
        {
            $match: entryMatch,
        },
        {
            $group: {
                _id: { user_id: '$user_id', project_id: '$project_id' },
                billable_minutes: { $sum: '$billable_total_minutes' },
                non_billable_minutes: { $sum: '$non_billable_total_minutes' },
            },
        },
    ]);

    // Hydrate project names in one batched lookup over the distinct ids.
    const projectIds = Array.from(
        new Set(
            groups
                .map((g) => g._id.project_id)
                .filter((p): p is Types.ObjectId => Boolean(p))
                .map((p) => p.toString())
        )
    ).map((id) => new Types.ObjectId(id));
    const projectRows = projectIds.length
        ? await Project.find({ _id: { $in: projectIds } })
              .select('_id name')
              .lean<{ _id: Types.ObjectId; name: string }[]>()
        : [];
    const projectNameById = new Map(projectRows.map((p) => [p._id.toString(), p.name]));

    // Bucket the (user, project) groups under each user.
    const groupsByUser = new Map<string, typeof groups>();
    for (const g of groups) {
        const key = g._id.user_id.toString();
        const list = groupsByUser.get(key) ?? [];
        list.push(g);
        groupsByUser.set(key, list);
    }

    const rows: UtilizationRow[] = users.map((u) => {
        const userGroups = groupsByUser.get(u._id.toString()) ?? [];
        const billable = userGroups.reduce((sum, g) => sum + g.billable_minutes, 0);
        const nonBillable = userGroups.reduce((sum, g) => sum + g.non_billable_minutes, 0);
        const totalLogged = filteredMinutes(billable, nonBillable, billableMode);
        const utilization =
            expectedPerUserMinutes > 0 ? Math.round((totalLogged / expectedPerUserMinutes) * 10000) / 100 : null;

        const projects: UtilizationProjectRow[] = userGroups
            .map((g) => {
                const projTotal = filteredMinutes(g.billable_minutes, g.non_billable_minutes, billableMode);
                const projectId = g._id.project_id ? g._id.project_id.toString() : null;
                return {
                    project: projectId
                        ? { id: projectId, name: projectNameById.get(projectId) ?? 'Unknown project' }
                        : null,
                    billable_minutes: g.billable_minutes,
                    non_billable_minutes: g.non_billable_minutes,
                    total_minutes: projTotal,
                    share_pct: totalLogged > 0 ? Math.round((projTotal / totalLogged) * 10000) / 100 : 0,
                };
            })
            // Drop projects that contribute nothing under the current filter
            // (e.g. billable-only view hides a purely non-billable project).
            .filter((p) => p.total_minutes > 0)
            .sort((a, b) => b.total_minutes - a.total_minutes);

        return {
            user: { id: u._id.toString(), full_name: u.full_name, role: u.role },
            logged_billable_minutes: billable,
            logged_non_billable_minutes: nonBillable,
            logged_total_minutes: totalLogged,
            expected_minutes: expectedPerUserMinutes,
            utilization_pct: utilization,
            projects,
        };
    });

    return {
        from_date: query.from_date,
        to_date: query.to_date,
        expected_per_user_minutes: expectedPerUserMinutes,
        billable: billableMode,
        rows,
    };
};

// ─── /reports/attendance ─────────────────────────────────────────────────

interface AttendanceRow {
    user: { id: string; full_name: string };
    present: number;
    absent: number;
    on_leave: number;
    holiday: number;
    weekend: number;
    incomplete: number;
    total_days: number;
    total_break_minutes: number;
}

export interface AttendanceReportResult {
    from_date: string;
    to_date: string;
    rows: AttendanceRow[];
}

export const buildAttendanceReport = async (query: AttendanceReportQuery): Promise<AttendanceReportResult> => {
    const userFilter: Record<string, unknown> = {
        status: USER_STATUSES.ACTIVE,
        role: { $in: [ROLES.ADMIN, ROLES.MANAGER, ROLES.EMPLOYEE] },
    };
    if (query.user_id) userFilter._id = new Types.ObjectId(query.user_id);

    const users = await User.find(userFilter)
        .select('_id full_name')
        .limit(REPORT_ROW_CAP)
        .lean<{ _id: Types.ObjectId; full_name: string }[]>();

    if (users.length === 0) {
        return { from_date: query.from_date, to_date: query.to_date, rows: [] };
    }

    const userIds = users.map((u) => u._id);
    const matchStage = {
        $match: {
            user_id: { $in: userIds },
            local_date: { $gte: query.from_date, $lte: query.to_date },
        },
    };
    const [counts, breakTotals] = await Promise.all([
        AttendanceRecord.aggregate<{
            _id: { user_id: Types.ObjectId; status: string };
            count: number;
        }>([
            matchStage,
            {
                $group: {
                    _id: { user_id: '$user_id', status: '$status' },
                    count: { $sum: 1 },
                },
            },
        ]),
        AttendanceRecord.aggregate<{
            _id: Types.ObjectId;
            total_break_minutes: number;
        }>([
            matchStage,
            {
                $group: {
                    _id: '$user_id',
                    total_break_minutes: { $sum: { $ifNull: ['$total_break_minutes', 0] } },
                },
            },
        ]),
    ]);

    const breakByUser = new Map<string, number>(breakTotals.map((t) => [t._id.toString(), t.total_break_minutes]));

    type StatusBuckets = {
        present: number;
        absent: number;
        on_leave: number;
        holiday: number;
        weekend: number;
        incomplete: number;
    };
    const blank = (): StatusBuckets => ({
        present: 0,
        absent: 0,
        on_leave: 0,
        holiday: 0,
        weekend: 0,
        incomplete: 0,
    });
    const byUser = new Map<string, StatusBuckets>();
    for (const c of counts) {
        const key = c._id.user_id.toString();
        const bucket = byUser.get(key) ?? blank();
        if (c._id.status in bucket) {
            (bucket as Record<string, number>)[c._id.status] = c.count;
        }
        byUser.set(key, bucket);
    }

    const rows: AttendanceRow[] = users.map((u) => {
        const b = byUser.get(u._id.toString()) ?? blank();
        const total = b.present + b.absent + b.on_leave + b.holiday + b.weekend + b.incomplete;
        return {
            user: { id: u._id.toString(), full_name: u.full_name },
            ...b,
            total_days: total,
            total_break_minutes: breakByUser.get(u._id.toString()) ?? 0,
        };
    });

    return { from_date: query.from_date, to_date: query.to_date, rows };
};

// ─── /reports/leave ──────────────────────────────────────────────────────

interface LeaveByType {
    leave_type: { id: string; key: string; label: string };
    allocated: number;
    carried_forward: number;
    used: number;
    pending: number;
    adjusted: number;
    monthly_forfeited: number;
    available: number;
}

interface LeaveRow {
    user: { id: string; full_name: string };
    by_type: LeaveByType[];
}

export interface LeaveReportResult {
    year: number;
    rows: LeaveRow[];
}

export const buildLeaveReport = async (query: LeaveReportQuery): Promise<LeaveReportResult> => {
    const userFilter: Record<string, unknown> = {
        status: USER_STATUSES.ACTIVE,
        role: { $in: [ROLES.ADMIN, ROLES.MANAGER, ROLES.EMPLOYEE] },
    };
    if (query.user_id) userFilter._id = new Types.ObjectId(query.user_id);

    const users = await User.find(userFilter)
        .select('_id full_name')
        .limit(REPORT_ROW_CAP)
        .lean<{ _id: Types.ObjectId; full_name: string }[]>();

    if (users.length === 0) return { year: query.year, rows: [] };

    const userIds = users.map((u) => u._id);
    const balances = await LeaveBalance.find({ user_id: { $in: userIds }, year: query.year })
        .select('user_id leave_type_id allocated carried_forward used pending adjusted monthly_forfeited available')
        .lean<
            {
                user_id: Types.ObjectId;
                leave_type_id: Types.ObjectId;
                allocated: number;
                carried_forward: number;
                used: number;
                pending: number;
                adjusted: number;
                monthly_forfeited: number;
                available: number;
            }[]
        >();

    const leaveTypeIds = Array.from(new Set(balances.map((b) => b.leave_type_id.toString()))).map(
        (id) => new Types.ObjectId(id)
    );
    // The LeaveType model stores the human label as `name` (the form's
    // "Name" field). The report's public shape calls it `label` so the
    // FE table renders consistently with other report views — map here.
    const leaveTypeRows = await LeaveType.find({ _id: { $in: leaveTypeIds } })
        .select('_id code name')
        .lean<{ _id: Types.ObjectId; code: string; name: string }[]>();
    const leaveTypeById = new Map(
        leaveTypeRows.map((lt) => [lt._id.toString(), { id: lt._id.toString(), key: lt.code, label: lt.name }])
    );

    const balancesByUser = new Map<string, typeof balances>();
    for (const b of balances) {
        const key = b.user_id.toString();
        if (!balancesByUser.has(key)) balancesByUser.set(key, []);
        balancesByUser.get(key)!.push(b);
    }

    const rows: LeaveRow[] = users.map((u) => {
        const userBalances = balancesByUser.get(u._id.toString()) ?? [];
        const byType: LeaveByType[] = userBalances
            .map((b) => {
                const lt = leaveTypeById.get(b.leave_type_id.toString());
                if (!lt) return null;
                return {
                    leave_type: lt,
                    allocated: b.allocated,
                    carried_forward: b.carried_forward,
                    used: b.used,
                    pending: b.pending,
                    adjusted: b.adjusted,
                    monthly_forfeited: b.monthly_forfeited,
                    available: b.available,
                };
            })
            .filter((x): x is LeaveByType => x !== null)
            // Stable sort by leave-type label so the FE renders rows
            // in a predictable order even when the balance documents
            // arrive out of insertion order.
            .sort((a, b) => a.leave_type.label.localeCompare(b.leave_type.label));

        return { user: { id: u._id.toString(), full_name: u.full_name }, by_type: byType };
    });

    return { year: query.year, rows };
};

// `todayLocal` is reserved for a future "default end_date = today"
// affordance the FE may want — exported so a follow-up that adds the
// query default doesn't have to reimplement.
export { todayLocal as _reportTodayLocal };
