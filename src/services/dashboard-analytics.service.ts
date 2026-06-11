// src/services/dashboard-analytics.service.ts
import { Types } from 'mongoose';

import { AttendanceRecord } from '../models/attendance-record.model.js';
import { LeaveRequest } from '../models/leave-request.model.js';
import { LeaveType } from '../models/leave-type.model.js';
import { TimesheetEntry } from '../models/timesheet-entry.model.js';
import { Holiday } from '../models/holiday.model.js';
import { User } from '../models/user.model.js';
import { Project } from '../models/project.model.js';
import { Task } from '../models/task.model.js';
import { BillingRate } from '../models/billing-rate.model.js';
import { LEAVE_REQUEST_STATUSES } from '../constants/leave.js';
import { DEFAULT_DONE_TASK_STATUS_KEY } from '../constants/story.js';
import { USER_STATUSES } from '../constants/user-statuses.js';
import { ROLES } from '../constants/roles.js';
import { PERMISSIONS } from '../constants/permissions.js';
import { callerCan } from '../utils/caller-permissions.js';
import {
    resolveDashboardRange,
    enumerateDates,
    type DashboardRangeKey,
    type ResolvedRange,
} from '../utils/dashboard-range.js';
import { isAdminLike } from '../utils/role-check.js';
import logger from '../utils/logger.js';
import dayjs, { DEFAULT_TIMEZONE, DATE_FORMAT } from '../utils/date.js';
import {
    buildDelta,
    type SectionDelta,
    attendanceTrendInsight,
    employeeAttendanceInsight,
    leaveMixInsight,
    hoursByProjectInsight,
    hoursLoggedInsight,
    utilizationInsight,
    tasksByStatusInsight,
    throughputInsight,
    projectProgressInsight,
} from './dashboard-insights.js';

/**
 * Dashboard analytics service (spec §7). Sections are computed only when
 * the caller's JWT permissions allow (assemblers, Task 7); each section
 * is isolated via `safeSection` so one failing aggregation can't 500 the
 * endpoint. All date filters use IST `local_date` strings.
 *
 * `userIds === null` means org-wide (admin / admin-like manager scope);
 * an array means "filter to these user ids" (team / self scope).
 */

type UserScope = Types.ObjectId[] | null;

export interface SectionError {
    error: true;
}

const userMatch = (userIds: UserScope): Record<string, unknown> =>
    userIds === null ? {} : { user_id: { $in: userIds } };

export const safeSection = async <T>(label: string, fn: () => Promise<T>): Promise<T | SectionError> => {
    try {
        return await fn();
    } catch (err) {
        try {
            logger.warn({ err, section: label }, 'Dashboard analytics section failed');
        } catch {
            /* never block on logger faults */
        }
        return { error: true };
    }
};

const WORK_MINUTES_PER_DAY = 480; // platform-wide 8h target (timesheet daily threshold)

/** Working days = calendar days minus Sat/Sun minus org holidays. */
export const countWorkingDays = async (from: string, to: string): Promise<number> => {
    const holidayRows = await Holiday.find({ date: { $gte: from, $lte: to } })
        .select({ date: 1 })
        .lean<{ date: string }[]>();
    const holidays = new Set(holidayRows.map((h) => h.date));
    return enumerateDates(from, to).filter((d) => {
        const dow = dayjs.tz(d, DEFAULT_TIMEZONE).day();
        return dow !== 0 && dow !== 6 && !holidays.has(d);
    }).length;
};

// ─── attendance_trend ─────────────────────────────────────────────────────

export interface AttendanceTrendSection {
    insight: string;
    delta: SectionDelta | null;
    data: { date: string; present: number; on_leave: number }[];
}

export const computeAttendanceTrend = async (
    userIds: UserScope,
    range: ResolvedRange,
    totalHeads: number
): Promise<AttendanceTrendSection> => {
    // `today` renders the last 7 days for context (spec §4).
    const winFrom =
        range.key === 'today'
            ? dayjs.tz(range.to, DEFAULT_TIMEZONE).subtract(6, 'day').format(DATE_FORMAT)
            : range.from;

    const rows = await AttendanceRecord.aggregate<{ _id: { date: string; status: string }; count: number }>([
        { $match: { local_date: { $gte: winFrom, $lte: range.to }, ...userMatch(userIds) } },
        { $group: { _id: { date: '$local_date', status: '$status' }, count: { $sum: 1 } } },
    ]);

    const byDate = new Map<string, { present: number; on_leave: number }>();
    for (const d of enumerateDates(winFrom, range.to)) byDate.set(d, { present: 0, on_leave: 0 });
    for (const r of rows) {
        const slot = byDate.get(r._id.date);
        if (!slot) continue;
        if (r._id.status === 'present') slot.present += r.count;
        else if (r._id.status === 'on_leave') slot.on_leave += r.count;
    }
    const data = [...byDate.entries()].map(([date, v]) => ({ date, ...v }));

    const daysWithData = data.filter((d) => d.present > 0).length;
    const avgPresent = daysWithData === 0 ? 0 : data.reduce((a, d) => a + d.present, 0) / daysWithData;
    const insight =
        userIds !== null && userIds.length === 1
            ? employeeAttendanceInsight(daysWithData, await countWorkingDays(winFrom, range.to), range.label)
            : attendanceTrendInsight(avgPresent, totalHeads, range.label);

    return { insight, delta: null, data };
};

// ─── leave_mix ────────────────────────────────────────────────────────────

export interface LeaveMixSection {
    insight: string;
    delta: SectionDelta | null;
    data: { leave_type_id: string; code: string | null; name: string | null; days: number }[];
}

export const computeLeaveMix = async (userIds: UserScope, range: ResolvedRange): Promise<LeaveMixSection> => {
    const matchFor = (from: string, to: string) => ({
        status: LEAVE_REQUEST_STATUSES.APPROVED,
        start_date: { $gte: from, $lte: to },
        ...userMatch(userIds),
    });

    const [rows, prevRows] = await Promise.all([
        LeaveRequest.aggregate<{ _id: Types.ObjectId; days: number }>([
            { $match: matchFor(range.from, range.to) },
            { $group: { _id: '$requested_leave_type_id', days: { $sum: '$total_days' } } },
        ]),
        LeaveRequest.aggregate<{ _id: null; days: number }>([
            { $match: matchFor(range.prev_from, range.prev_to) },
            { $group: { _id: null, days: { $sum: '$total_days' } } },
        ]),
    ]);

    const types = await LeaveType.find({ _id: { $in: rows.map((r) => r._id) } })
        .select({ code: 1, name: 1 })
        .lean<{ _id: Types.ObjectId; code: string; name: string }[]>();
    const typeById = new Map(types.map((t) => [t._id.toString(), t]));

    const data = rows
        .map((r) => {
            const t = typeById.get(r._id.toString());
            return { leave_type_id: r._id.toString(), code: t?.code ?? null, name: t?.name ?? null, days: r.days };
        })
        .sort((a, b) => b.days - a.days);

    const total = data.reduce((a, r) => a + r.days, 0);
    return {
        insight: leaveMixInsight(data, range.label),
        delta: buildDelta(total, prevRows[0]?.days ?? 0, range.prev_label, 'neutral'),
        data,
    };
};

// ─── upcoming_leaves (next 14 days, list) ─────────────────────────────────

export interface UpcomingLeaveRow {
    id: string;
    user_id: string;
    user_name: string | null;
    leave_type_name: string | null;
    start_date: string;
    end_date: string;
    total_days: number;
}

export const computeUpcomingLeaves = async (
    userIds: UserScope
): Promise<{ insight: string; data: UpcomingLeaveRow[] }> => {
    const today = dayjs().tz(DEFAULT_TIMEZONE).format(DATE_FORMAT);
    const horizon = dayjs().tz(DEFAULT_TIMEZONE).add(14, 'day').format(DATE_FORMAT);
    const rows = await LeaveRequest.find({
        status: LEAVE_REQUEST_STATUSES.APPROVED,
        start_date: { $gte: today, $lte: horizon },
        ...userMatch(userIds),
    })
        .sort({ start_date: 1 })
        .limit(8)
        .lean<
            {
                _id: Types.ObjectId;
                user_id: Types.ObjectId;
                requested_leave_type_id: Types.ObjectId;
                start_date: string;
                end_date: string;
                total_days: number;
            }[]
        >();

    const [users, types] = await Promise.all([
        User.find({ _id: { $in: rows.map((r) => r.user_id) } })
            .select({ full_name: 1 })
            .lean<{ _id: Types.ObjectId; full_name: string }[]>(),
        LeaveType.find({ _id: { $in: rows.map((r) => r.requested_leave_type_id) } })
            .select({ name: 1 })
            .lean<{ _id: Types.ObjectId; name: string }[]>(),
    ]);
    const nameById = new Map(users.map((u) => [u._id.toString(), u.full_name]));
    const typeById = new Map(types.map((t) => [t._id.toString(), t.name]));

    const data = rows.map((r) => ({
        id: r._id.toString(),
        user_id: r.user_id.toString(),
        user_name: nameById.get(r.user_id.toString()) ?? null,
        leave_type_name: typeById.get(r.requested_leave_type_id.toString()) ?? null,
        start_date: r.start_date,
        end_date: r.end_date,
        total_days: r.total_days,
    }));

    return {
        insight:
            data.length === 0
                ? 'Nobody is off in the next two weeks.'
                : `${data.length} ${data.length === 1 ? 'person is' : 'people are'} off in the next two weeks.`,
        data,
    };
};

// ─── hours_by_project ─────────────────────────────────────────────────────

export interface HoursByProjectSection {
    insight: string;
    delta: SectionDelta | null;
    data: { project_id: string | null; project_name: string; project_code: string | null; minutes: number }[];
    total_minutes: number;
}

export const computeHoursByProject = async (
    userIds: UserScope,
    range: ResolvedRange
): Promise<HoursByProjectSection> => {
    const [rows, prev] = await Promise.all([
        TimesheetEntry.aggregate<{ _id: Types.ObjectId | null; minutes: number }>([
            { $match: { local_date: { $gte: range.from, $lte: range.to }, ...userMatch(userIds) } },
            { $group: { _id: '$project_id', minutes: { $sum: '$total_minutes' } } },
            { $sort: { minutes: -1 } },
            { $limit: 8 },
        ]),
        TimesheetEntry.aggregate<{ _id: null; minutes: number }>([
            { $match: { local_date: { $gte: range.prev_from, $lte: range.prev_to }, ...userMatch(userIds) } },
            { $group: { _id: null, minutes: { $sum: '$total_minutes' } } },
        ]),
    ]);

    const projectIds = rows.map((r) => r._id).filter((id): id is Types.ObjectId => id !== null);
    const projects = await Project.find({ _id: { $in: projectIds } })
        .select({ name: 1, code: 1 })
        .lean<{ _id: Types.ObjectId; name: string; code: string }[]>();
    const byId = new Map(projects.map((p) => [p._id.toString(), p]));

    const data = rows.map((r) => {
        const p = r._id ? byId.get(r._id.toString()) : undefined;
        return {
            project_id: r._id?.toString() ?? null,
            project_name: p?.name ?? 'General (no project)',
            project_code: p?.code ?? null,
            minutes: r.minutes,
        };
    });
    const total_minutes = data.reduce((a, r) => a + r.minutes, 0);
    const top = data[0];

    return {
        insight: top
            ? hoursByProjectInsight(top.project_name, top.minutes, total_minutes, range.label)
            : hoursLoggedInsight(0, range.label),
        delta: buildDelta(total_minutes, prev[0]?.minutes ?? 0, range.prev_label, 'neutral'),
        data,
        total_minutes,
    };
};

// ─── utilization ──────────────────────────────────────────────────────────

export interface UtilizationSection {
    insight: string;
    delta: SectionDelta | null;
    pct: number;
    actual_minutes: number;
    expected_minutes: number;
}

const sumMinutes = async (userIds: UserScope, from: string, to: string): Promise<number> => {
    const rows = await TimesheetEntry.aggregate<{ _id: null; minutes: number }>([
        { $match: { local_date: { $gte: from, $lte: to }, ...userMatch(userIds) } },
        { $group: { _id: null, minutes: { $sum: '$total_minutes' } } },
    ]);
    return rows[0]?.minutes ?? 0;
};

export const computeUtilization = async (
    userIds: UserScope,
    range: ResolvedRange,
    headcount: number
): Promise<UtilizationSection> => {
    const [actual_minutes, prevActual, workingDays] = await Promise.all([
        sumMinutes(userIds, range.from, range.to),
        sumMinutes(userIds, range.prev_from, range.prev_to),
        countWorkingDays(range.from, range.to),
    ]);
    const expected_minutes = workingDays * WORK_MINUTES_PER_DAY * Math.max(headcount, 0);
    const pct = expected_minutes === 0 ? 0 : Math.round((actual_minutes / expected_minutes) * 100);
    return {
        insight: utilizationInsight(pct, range.label),
        delta: buildDelta(actual_minutes, prevActual, range.prev_label, 'up'),
        pct,
        actual_minutes,
        expected_minutes,
    };
};

// ─── hours_trend (employee: my minutes per day) ───────────────────────────

export interface HoursTrendSection {
    insight: string;
    delta: SectionDelta | null;
    data: { date: string; minutes: number }[];
}

export const computeHoursTrend = async (userIds: UserScope, range: ResolvedRange): Promise<HoursTrendSection> => {
    const winFrom =
        range.key === 'today'
            ? dayjs.tz(range.to, DEFAULT_TIMEZONE).subtract(6, 'day').format(DATE_FORMAT)
            : range.from;
    const [rows, prev] = await Promise.all([
        TimesheetEntry.aggregate<{ _id: string; minutes: number }>([
            { $match: { local_date: { $gte: winFrom, $lte: range.to }, ...userMatch(userIds) } },
            { $group: { _id: '$local_date', minutes: { $sum: '$total_minutes' } } },
        ]),
        TimesheetEntry.aggregate<{ _id: null; minutes: number }>([
            { $match: { local_date: { $gte: range.prev_from, $lte: range.prev_to }, ...userMatch(userIds) } },
            { $group: { _id: null, minutes: { $sum: '$total_minutes' } } },
        ]),
    ]);
    const byDate = new Map(rows.map((r) => [r._id, r.minutes]));
    const data = enumerateDates(winFrom, range.to).map((date) => ({ date, minutes: byDate.get(date) ?? 0 }));
    const total = data.reduce((a, d) => a + d.minutes, 0);
    return {
        insight: hoursLoggedInsight(total, range.label),
        delta: buildDelta(total, prev[0]?.minutes ?? 0, range.prev_label, 'neutral'),
        data,
    };
};

// ─── billable value (KPI) ─────────────────────────────────────────────────

export interface BillableValueKpi {
    /** Σ billable minutes x hourly rate, rounded to whole currency units. */
    value: number;
    delta: SectionDelta | null;
}

interface RateRow {
    user_id: Types.ObjectId;
    project_id: Types.ObjectId;
    task_id: Types.ObjectId | null;
    hourly_rate: number;
    effective_from: string;
    effective_to: string | null;
}

/** Project-level rate effective on `date` (task-level rates are a billing-
 *  report concern; the dashboard KPI uses the project fallback only). */
const rateFor = (rates: RateRow[], user: string, project: string, date: string): number | null => {
    let best: RateRow | null = null;
    for (const r of rates) {
        if (r.task_id !== null) continue;
        if (r.user_id.toString() !== user || r.project_id.toString() !== project) continue;
        if (r.effective_from > date) continue;
        if (r.effective_to !== null && r.effective_to < date) continue;
        if (!best || r.effective_from > best.effective_from) best = r;
    }
    return best?.hourly_rate ?? null;
};

const billableWindowValue = async (userIds: UserScope, from: string, to: string): Promise<number> => {
    const rows = await TimesheetEntry.aggregate<{
        _id: { user: Types.ObjectId; project: Types.ObjectId | null; date: string };
        billable: number;
    }>([
        {
            $match: {
                local_date: { $gte: from, $lte: to },
                billable_total_minutes: { $gt: 0 },
                project_id: { $ne: null },
                ...userMatch(userIds),
            },
        },
        {
            $group: {
                _id: { user: '$user_id', project: '$project_id', date: '$local_date' },
                billable: { $sum: '$billable_total_minutes' },
            },
        },
    ]);
    if (rows.length === 0) return 0;

    const userSet = [...new Set(rows.map((r) => r._id.user.toString()))].map((s) => new Types.ObjectId(s));
    const projectSet = [...new Set(rows.map((r) => r._id.project!.toString()))].map((s) => new Types.ObjectId(s));
    const rates = await BillingRate.find({ user_id: { $in: userSet }, project_id: { $in: projectSet } }).lean<
        RateRow[]
    >();

    let value = 0;
    for (const r of rows) {
        const rate = rateFor(rates, r._id.user.toString(), r._id.project!.toString(), r._id.date);
        if (rate !== null) value += (r.billable / 60) * rate;
    }
    return Math.round(value);
};

export const computeBillableValue = async (userIds: UserScope, range: ResolvedRange): Promise<BillableValueKpi> => {
    const [value, prev] = await Promise.all([
        billableWindowValue(userIds, range.from, range.to),
        billableWindowValue(userIds, range.prev_from, range.prev_to),
    ]);
    return { value, delta: buildDelta(value, prev, range.prev_label, 'up') };
};

// ─── tasks_by_status ──────────────────────────────────────────────────────
//
// `taskMatch` carries the scope: {} org-wide; { primary_assignee_id: {$in} }
// for team/self; { project_id: {$in} } for clients. v1 counts the default
// 'done' key only as terminal (custom terminal statuses are handled in
// computeProjectProgress where the project doc is in hand).

export interface TasksByStatusSection {
    insight: string;
    delta: SectionDelta | null;
    total: number;
    data: { status: string; count: number }[];
}

export const computeTasksByStatus = async (
    taskMatch: Record<string, unknown>,
    range: ResolvedRange
): Promise<TasksByStatusSection> => {
    const rows = await Task.aggregate<{ _id: string; count: number }>([
        ...(Object.keys(taskMatch).length ? [{ $match: taskMatch }] : []),
        { $group: { _id: '$status', count: { $sum: 1 } } },
    ]);
    const data = rows
        .map((r) => ({ status: r._id, count: r.count }))
        .sort((a, b) =>
            a.status === DEFAULT_DONE_TASK_STATUS_KEY
                ? -1
                : b.status === DEFAULT_DONE_TASK_STATUS_KEY
                  ? 1
                  : b.count - a.count
        );
    const total = data.reduce((a, r) => a + r.count, 0);
    const done = data.find((r) => r.status === DEFAULT_DONE_TASK_STATUS_KEY)?.count ?? 0;
    return { insight: tasksByStatusInsight(done, total, range.label), delta: null, total, data };
};

// ─── throughput (done tasks per day, approximated by updated_at) ─────────

export interface ThroughputSection {
    insight: string;
    delta: SectionDelta | null;
    data: { date: string; count: number }[];
}

const istDayExpr = {
    $dateToString: { format: '%Y-%m-%d', date: '$updated_at', timezone: DEFAULT_TIMEZONE },
};

export const computeThroughput = async (
    taskMatch: Record<string, unknown>,
    range: ResolvedRange
): Promise<ThroughputSection> => {
    const winFrom =
        range.key === 'today'
            ? dayjs.tz(range.to, DEFAULT_TIMEZONE).subtract(6, 'day').format(DATE_FORMAT)
            : range.from;
    const toDate = (d: string, endOfDay: boolean) =>
        endOfDay
            ? dayjs.tz(d, DEFAULT_TIMEZONE).endOf('day').toDate()
            : dayjs.tz(d, DEFAULT_TIMEZONE).startOf('day').toDate();

    const doneMatch = (from: string, to: string) => ({
        ...taskMatch,
        status: DEFAULT_DONE_TASK_STATUS_KEY,
        updated_at: { $gte: toDate(from, false), $lte: toDate(to, true) },
    });

    const [rows, prev] = await Promise.all([
        Task.aggregate<{ _id: string; count: number }>([
            { $match: doneMatch(winFrom, range.to) },
            { $group: { _id: istDayExpr, count: { $sum: 1 } } },
        ]),
        Task.aggregate<{ _id: null; count: number }>([
            { $match: doneMatch(range.prev_from, range.prev_to) },
            { $group: { _id: null, count: { $sum: 1 } } },
        ]),
    ]);

    const byDate = new Map(rows.map((r) => [r._id, r.count]));
    const data = enumerateDates(winFrom, range.to).map((date) => ({ date, count: byDate.get(date) ?? 0 }));
    const completed = data.reduce((a, d) => a + d.count, 0);
    return {
        insight: throughputInsight(completed, range.label),
        delta: buildDelta(completed, prev[0]?.count ?? 0, range.prev_label, 'up'),
        data,
    };
};

// ─── project_progress (client scope) ──────────────────────────────────────

export interface ProjectProgressSection {
    insight: string;
    delta: SectionDelta | null;
    data: { id: string; name: string; code: string; status: string; done: number; total: number }[];
}

export const computeProjectProgress = async (projectIds: Types.ObjectId[]): Promise<ProjectProgressSection> => {
    if (projectIds.length === 0) {
        return { insight: projectProgressInsight(0, 0, 0), delta: null, data: [] };
    }
    const projects = await Project.find({ _id: { $in: projectIds } })
        .select({ name: 1, code: 1, status: 1, custom_task_statuses: 1 })
        .lean<
            {
                _id: Types.ObjectId;
                name: string;
                code: string;
                status: string;
                custom_task_statuses: { key: string; is_terminal: boolean }[];
            }[]
        >();

    const rows = await Task.aggregate<{ _id: { project: Types.ObjectId; status: string }; count: number }>([
        { $match: { project_id: { $in: projectIds } } },
        { $group: { _id: { project: '$project_id', status: '$status' }, count: { $sum: 1 } } },
    ]);

    const data = projects.map((p) => {
        const terminal = new Set<string>([DEFAULT_DONE_TASK_STATUS_KEY]);
        for (const s of p.custom_task_statuses ?? []) if (s.is_terminal) terminal.add(s.key);
        let done = 0;
        let total = 0;
        for (const r of rows) {
            if (r._id.project.toString() !== p._id.toString()) continue;
            total += r.count;
            if (terminal.has(r._id.status)) done += r.count;
        }
        return { id: p._id.toString(), name: p.name, code: p.code, status: p.status, done, total };
    });

    const done = data.reduce((a, p) => a + p.done, 0);
    const total = data.reduce((a, p) => a + p.total, 0);
    return { insight: projectProgressInsight(data.length, done, total), delta: null, data };
};

// ─── Scope assemblers (spec §7) ───────────────────────────────────────────

export interface AnalyticsPayload {
    generated_at: string;
    range: ResolvedRange;
    sections: Record<string, unknown>;
}

type Held = readonly string[] | undefined;

/** Collects permission-gated sections concurrently. */
const sectionCollector = (held: Held) => {
    const sections: Record<string, unknown> = {};
    const jobs: Promise<void>[] = [];
    const add = (key: string, perm: Parameters<typeof callerCan>[1] | null, fn: () => Promise<unknown>) => {
        if (perm !== null && !callerCan(held, perm)) return;
        jobs.push(
            safeSection(key, fn).then((v) => {
                sections[key] = v;
            })
        );
    };
    const settle = async () => {
        await Promise.all(jobs);
        return sections;
    };
    return { add, settle };
};

const activeInternalCount = (): Promise<number> =>
    User.countDocuments({ status: USER_STATUSES.ACTIVE, role: { $ne: ROLES.CLIENT } });

/** Shared: upcoming 5 holidays from today. Used by admin + employee assemblers. */
const computeUpcomingHolidays = async (): Promise<{ data: { id: string; date: string; name: string }[] }> => {
    const today = dayjs().tz(DEFAULT_TIMEZONE).format(DATE_FORMAT);
    const rows = await Holiday.find({ date: { $gte: today } })
        .sort({ date: 1 })
        .limit(5)
        .lean<{ _id: Types.ObjectId; date: string; name: string }[]>();
    return { data: rows.map((h) => ({ id: h._id.toString(), date: h.date, name: h.name })) };
};

export const buildAdminAnalytics = async (held: Held, rangeKey: DashboardRangeKey): Promise<AnalyticsPayload> => {
    const range = resolveDashboardRange(rangeKey);
    const heads = await safeSection('admin.headcount_total', activeInternalCount);
    const totalHeads = typeof heads === 'number' ? heads : 0;

    const { add, settle } = sectionCollector(held);

    // KPI strip — assembled as one section so the FE can render the row together.
    add('kpi', null, async () => {
        const kpi: Record<string, unknown> = {};
        const kpiJobs: Promise<void>[] = [];
        const put = (key: string, perm: Parameters<typeof callerCan>[1], fn: () => Promise<unknown>) => {
            if (!callerCan(held, perm)) return;
            kpiJobs.push(
                safeSection(`kpi.${key}`, fn).then((v) => {
                    kpi[key] = v;
                })
            );
        };
        put('headcount', PERMISSIONS.USER_READ, async () => {
            const rows = await User.aggregate<{ _id: { role: string; status: string }; count: number }>([
                { $group: { _id: { role: '$role', status: '$status' }, count: { $sum: 1 } } },
            ]);
            const by_role: Record<string, number> = {};
            let active = 0;
            let deactivated = 0;
            for (const r of rows) {
                if (r._id.status === USER_STATUSES.ACTIVE) {
                    active += r.count;
                    by_role[r._id.role] = (by_role[r._id.role] ?? 0) + r.count;
                } else if (r._id.status === USER_STATUSES.DEACTIVATED) {
                    deactivated += r.count;
                }
            }
            return { value: active, deactivated, by_role };
        });
        put('active_projects', PERMISSIONS.PROJECT_READ, async () => ({
            value: await Project.countDocuments({ status: 'active' }),
        }));
        put('hours_logged', PERMISSIONS.TIMESHEET_READ, async () => {
            const [cur, prev] = await Promise.all([
                sumMinutes(null, range.from, range.to),
                sumMinutes(null, range.prev_from, range.prev_to),
            ]);
            return { value_minutes: cur, delta: buildDelta(cur, prev, range.prev_label, 'neutral') };
        });
        put('billable_value', PERMISSIONS.BILLING_RATE_READ, () => computeBillableValue(null, range));
        await Promise.all(kpiJobs);
        return kpi;
    });

    add('attendance_trend', PERMISSIONS.ATTENDANCE_READ_TEAM, () => computeAttendanceTrend(null, range, totalHeads));
    add('leave_mix', PERMISSIONS.LEAVE_REQUEST_READ_TEAM, () => computeLeaveMix(null, range));
    add('upcoming_leaves', PERMISSIONS.LEAVE_REQUEST_READ_TEAM, () => computeUpcomingLeaves(null));
    add('hours_by_project', PERMISSIONS.TIMESHEET_READ, () => computeHoursByProject(null, range));
    add('utilization', PERMISSIONS.TIMESHEET_READ, () => computeUtilization(null, range, totalHeads));
    add('tasks_by_status', PERMISSIONS.TASK_READ, () => computeTasksByStatus({}, range));
    add('throughput', PERMISSIONS.TASK_READ, () => computeThroughput({}, range));
    add('holidays', PERMISSIONS.HOLIDAY_READ, computeUpcomingHolidays);

    const sections = await settle();
    // Drop the kpi key entirely when the caller holds no kpi-level permissions
    // (prevents the FE from rendering an empty KPI row).
    if (
        'kpi' in sections &&
        typeof sections.kpi === 'object' &&
        sections.kpi !== null &&
        Object.keys(sections.kpi).length === 0
    ) {
        delete sections.kpi;
    }
    return { generated_at: new Date().toISOString(), range, sections };
};

export const buildManagerAnalytics = async (
    caller: { id: Types.ObjectId; role: string; role_keys?: readonly string[] },
    held: Held,
    rangeKey: DashboardRangeKey
): Promise<AnalyticsPayload> => {
    const range = resolveDashboardRange(rangeKey);

    const orgWide = isAdminLike(caller);
    const teamIds = orgWide
        ? null
        : await User.find({
              status: USER_STATUSES.ACTIVE,
              role: { $ne: ROLES.CLIENT },
              'internal_profile.reporting_manager_id': caller.id,
          })
              .select('_id')
              .lean<{ _id: Types.ObjectId }[]>()
              .then((rows) => rows.map((r) => r._id));
    const headcount = orgWide ? await activeInternalCount().catch(() => 0) : (teamIds?.length ?? 0);
    const taskScope = teamIds === null ? {} : { primary_assignee_id: { $in: teamIds } };

    const { add, settle } = sectionCollector(held);

    add('kpi', null, async () => {
        const kpi: Record<string, unknown> = { team_size: { value: headcount } };
        if (callerCan(held, PERMISSIONS.TIMESHEET_READ)) {
            kpi.hours_logged = await safeSection('kpi.hours_logged', async () => {
                const [cur, prev] = await Promise.all([
                    sumMinutes(teamIds, range.from, range.to),
                    sumMinutes(teamIds, range.prev_from, range.prev_to),
                ]);
                return { value_minutes: cur, delta: buildDelta(cur, prev, range.prev_label, 'neutral') };
            });
        }
        if (callerCan(held, PERMISSIONS.BILLING_RATE_READ)) {
            kpi.billable_value = await safeSection('kpi.billable_value', () => computeBillableValue(teamIds, range));
        }
        return kpi;
    });
    add('attendance_trend', PERMISSIONS.ATTENDANCE_READ_TEAM, () => computeAttendanceTrend(teamIds, range, headcount));
    add('leave_mix', PERMISSIONS.LEAVE_REQUEST_READ_TEAM, () => computeLeaveMix(teamIds, range));
    add('upcoming_leaves', PERMISSIONS.LEAVE_REQUEST_READ_TEAM, () => computeUpcomingLeaves(teamIds));
    add('hours_by_project', PERMISSIONS.TIMESHEET_READ, () => computeHoursByProject(teamIds, range));
    add('utilization', PERMISSIONS.TIMESHEET_READ, () => computeUtilization(teamIds, range, headcount));
    add('tasks_by_status', PERMISSIONS.TASK_READ, () => computeTasksByStatus(taskScope, range));
    add('throughput', PERMISSIONS.TASK_READ, () => computeThroughput(taskScope, range));

    return { generated_at: new Date().toISOString(), range, sections: await settle() };
};

export const buildEmployeeAnalytics = async (
    userId: Types.ObjectId,
    held: Held,
    rangeKey: DashboardRangeKey
): Promise<AnalyticsPayload> => {
    const range = resolveDashboardRange(rangeKey);
    const self = [userId];
    const { add, settle } = sectionCollector(held);

    // Own data: gated on the behavioural perms the role bundles already
    // grant (spec §5) — timesheet.write for own hours, leave_request.write
    // for own leave views, attendance.check_in_out for own attendance.
    add('hours_trend', PERMISSIONS.TIMESHEET_WRITE, () => computeHoursTrend(self, range));
    add('hours_by_project', PERMISSIONS.TIMESHEET_WRITE, () => computeHoursByProject(self, range));
    add('attendance_trend', PERMISSIONS.ATTENDANCE_CHECK_IN_OUT, () => computeAttendanceTrend(self, range, 1));
    add('leave_mix', PERMISSIONS.LEAVE_REQUEST_WRITE, () => computeLeaveMix(self, range));
    add('tasks_by_status', PERMISSIONS.TASK_READ, () => computeTasksByStatus({ primary_assignee_id: userId }, range));
    add('holidays', PERMISSIONS.HOLIDAY_READ, computeUpcomingHolidays);
    // leave_balances / my_leaves / comp-off stay on the snapshot endpoint
    // (range-independent, already built there).

    return { generated_at: new Date().toISOString(), range, sections: await settle() };
};

export const buildClientAnalytics = async (
    userId: Types.ObjectId,
    held: Held,
    rangeKey: DashboardRangeKey
): Promise<AnalyticsPayload> => {
    const range = resolveDashboardRange(rangeKey);
    const projectRows = await Project.find({ client_ids: userId })
        .select({ _id: 1 })
        .lean<{ _id: Types.ObjectId }[]>()
        .catch((err: unknown) => {
            logger.warn({ err }, 'Dashboard analytics client project resolution failed');
            return [] as { _id: Types.ObjectId }[];
        });
    const projectIds = projectRows.map((r) => r._id);
    const taskScope = { project_id: { $in: projectIds } };

    const { add, settle } = sectionCollector(held);
    add('project_progress', PERMISSIONS.PROJECT_READ, () => computeProjectProgress(projectIds));
    add('tasks_by_status', PERMISSIONS.TASK_READ, () =>
        projectIds.length === 0
            ? Promise.resolve({ insight: 'No tasks in scope yet.', delta: null, total: 0, data: [] })
            : computeTasksByStatus(taskScope, range)
    );
    add('throughput', PERMISSIONS.TASK_READ, () =>
        projectIds.length === 0
            ? Promise.resolve({ insight: throughputInsight(0, range.label), delta: null, data: [] })
            : computeThroughput(taskScope, range)
    );

    return { generated_at: new Date().toISOString(), range, sections: await settle() };
};
