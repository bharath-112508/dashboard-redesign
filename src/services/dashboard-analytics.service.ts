// src/services/dashboard-analytics.service.ts
import { Types } from 'mongoose';

import { AttendanceRecord } from '../models/attendance-record.model.js';
import { LeaveRequest } from '../models/leave-request.model.js';
import { LeaveType } from '../models/leave-type.model.js';
import { TimesheetEntry } from '../models/timesheet-entry.model.js';
import { Holiday } from '../models/holiday.model.js';
import { User } from '../models/user.model.js';
import { Project } from '../models/project.model.js';
import { LEAVE_REQUEST_STATUSES } from '../constants/leave.js';
import logger from '../utils/logger.js';
import dayjs, { DEFAULT_TIMEZONE, DATE_FORMAT } from '../utils/date.js';
import { enumerateDates, type ResolvedRange } from '../utils/dashboard-range.js';
import {
    buildDelta,
    type SectionDelta,
    attendanceTrendInsight,
    employeeAttendanceInsight,
    leaveMixInsight,
    hoursByProjectInsight,
    hoursLoggedInsight,
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

// Suppress unused-import lint warnings for constants used by Tasks 5–7 (imported then).
// Tasks 5–7 will add their own imports as needed; this file intentionally omits them
// until those tasks ship (YAGNI).
void WORK_MINUTES_PER_DAY; // referenced in Task 5 computeUtilization
