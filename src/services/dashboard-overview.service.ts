import { Types } from 'mongoose';

import { User } from '../models/user.model.js';
import { AttendanceRecord } from '../models/attendance-record.model.js';
import { AttendanceCorrectionRequest } from '../models/attendance-correction-request.model.js';
import { Project } from '../models/project.model.js';
import { LeaveRequest } from '../models/leave-request.model.js';
import { Task } from '../models/task.model.js';
import { buildProjectVisibilityFilter, type ProjectCaller } from './project.service.js';
import { resolveTeamLeadScope } from './dashboard-analytics.service.js';
import { resolveClientProjectIds } from './dashboard.service.js';
import { ROLES, type RoleType } from '../constants/roles.js';
import { USER_STATUSES } from '../constants/user-statuses.js';
import { PROJECT_STATUSES } from '../constants/project.js';
import { LEAVE_REQUEST_STATUSES } from '../constants/leave.js';
import { DEFAULT_DONE_TASK_STATUS_KEY } from '../constants/story.js';
import logger from '../utils/logger.js';
import dayjs, { DEFAULT_TIMEZONE } from '../utils/date.js';

/**
 * Shared overview aggregation helpers — range-aware dashboard rework
 * (docs/superpowers/sdd task 2).
 *
 * These are pure, reusable building blocks that later per-role dashboard
 * builders (Tasks 3+) compose into full payloads. Each function accepts an
 * already-resolved scope (role list / filter / user-id set / company id) —
 * none of them resolve caller identity or permissions themselves, so they
 * stay trivially testable and reusable across admin/manager/team-lead/
 * client dashboards without duplicating the scoping logic.
 *
 * Every export is wrapped in `safeCard` so one failing aggregation degrades
 * to a contractually-shaped zero/empty value instead of throwing and
 * blacking out the rest of the dashboard — same contract as
 * `dashboard.service.ts`.
 */

// ─── Local helpers ────────────────────────────────────────────────────────

// `safeCard` isn't exported from `dashboard.service.ts`, so it's replicated
// here verbatim (see that file's copy for the canonical version/rationale).
const safeCard = async <T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> => {
    try {
        return await fn();
    } catch (err) {
        try {
            logger.warn({ err, card: label }, 'Dashboard card aggregation failed');
        } catch {
            // swallow — never block the response on logger faults.
        }
        return fallback;
    }
};

/** "YYYY-MM-DD" → start/end of that calendar day in `DEFAULT_TIMEZONE`, as a UTC `Date`. */
const toRangeStart = (isoDate: string): Date => dayjs.tz(isoDate, DEFAULT_TIMEZONE).startOf('day').toDate();
const toRangeEnd = (isoDate: string): Date => dayjs.tz(isoDate, DEFAULT_TIMEZONE).endOf('day').toDate();

// ─── Contract types ───────────────────────────────────────────────────────

export interface OverviewSummaryCard {
    label: string;
    value: number;
    hint?: string;
}

export interface ProjectStatusBreakdown {
    active: number;
    completed: number;
    on_hold: number;
    total: number;
}

export interface AttendanceOverview {
    /** Single day: that day's present count. Range: avg present per working day (rounded). */
    present: number;
    /** Single day: on-leave count. Range: total leave-days in window. */
    on_leave: number;
    /** Correction requests created in the window (scoped). */
    correction_requests: number;
    /** Check-in but no check-out in the window (scoped) — `status: 'incomplete'` rows. */
    incomplete: number;
    /** Denominator for "present X / Y". */
    total_internal_active: number;
    is_single_day: boolean;
}

export interface RepresentativesStatus {
    active: number;
    inactive: number;
    total: number;
}

// ─── headcountAsOf ────────────────────────────────────────────────────────

const headcountAsOfImpl = async (date: string, roles: RoleType[]): Promise<number> => {
    const endOfDay = toRangeEnd(date);
    return User.countDocuments({
        role: { $in: roles },
        created_at: { $lte: endOfDay },
        $or: [{ deactivated_at: null }, { deactivated_at: { $gt: endOfDay } }],
    });
};

/** Headcount for the given roles "as of" a date — created on/before it, and
 *  not yet deactivated (or deactivated after it). Lets a range-picker ask
 *  "how many employees existed on 2026-06-01" without a separate snapshot
 *  collection. */
export const headcountAsOf = (date: string, roles: RoleType[]): Promise<number> =>
    safeCard('overview.headcount_as_of', () => headcountAsOfImpl(date, roles), 0);

// ─── projectStatusFor ─────────────────────────────────────────────────────

const projectStatusForImpl = async (filter: Record<string, unknown>): Promise<ProjectStatusBreakdown> => {
    const rows = await Project.aggregate<{ _id: string; count: number }>([
        { $match: { ...filter, is_archived: { $ne: true } } },
        { $group: { _id: '$status', count: { $sum: 1 } } },
    ]);

    let active = 0;
    let completed = 0;
    let on_hold = 0;
    for (const r of rows) {
        if (r._id === PROJECT_STATUSES.ACTIVE) active += r.count;
        else if (r._id === PROJECT_STATUSES.COMPLETED) completed += r.count;
        else if (r._id === PROJECT_STATUSES.ON_HOLD) on_hold += r.count;
    }
    return { active, completed, on_hold, total: active + completed + on_hold };
};

/** Project status breakdown for an arbitrary caller-scoped `filter` (e.g.
 *  `{company_id}`, `{member_ids: caller}`) — the visibility filter itself is
 *  the caller's responsibility, this just groups + folds into the contract
 *  shape. Archived projects are always excluded. */
export const projectStatusFor = (filter: Record<string, unknown>): Promise<ProjectStatusBreakdown> =>
    safeCard('overview.project_status', () => projectStatusForImpl(filter), {
        active: 0,
        completed: 0,
        on_hold: 0,
        total: 0,
    });

// ─── attendanceOverviewFor ────────────────────────────────────────────────

const attendanceOverviewForImpl = async (
    from: string,
    to: string,
    userIds: Types.ObjectId[] | null
): Promise<AttendanceOverview> => {
    const is_single_day = from === to;
    const match: Record<string, unknown> = { local_date: { $gte: from, $lte: to } };
    if (userIds !== null) match.user_id = { $in: userIds };

    const correctionFilter: Record<string, unknown> = {
        created_at: { $gte: toRangeStart(from), $lte: toRangeEnd(to) },
    };
    if (userIds !== null) correctionFilter.user_id = { $in: userIds };

    const totalInternalFilter: Record<string, unknown> = {
        status: USER_STATUSES.ACTIVE,
        role: { $ne: ROLES.CLIENT },
    };
    if (userIds !== null) totalInternalFilter._id = { $in: userIds };

    const [statusAgg, workingDays, correctionRequests, totalInternalActive] = await Promise.all([
        AttendanceRecord.aggregate<{ _id: string; count: number }>([
            { $match: match },
            { $group: { _id: '$status', count: { $sum: 1 } } },
        ]),
        // Only needed to average "present" over a range — skip the extra
        // round-trip on the (far more common) single-day request.
        is_single_day
            ? Promise.resolve<string[]>([])
            : AttendanceRecord.distinct('local_date', { ...match, status: { $nin: ['weekend', 'holiday'] } }),
        AttendanceCorrectionRequest.countDocuments(correctionFilter),
        User.countDocuments(totalInternalFilter),
    ]);

    const byStatus = new Map(statusAgg.map((r) => [r._id, r.count]));
    const presentTotal = byStatus.get('present') ?? 0;
    const onLeaveTotal = byStatus.get('on_leave') ?? 0;
    const incomplete = byStatus.get('incomplete') ?? 0;

    const present = is_single_day
        ? presentTotal
        : workingDays.length > 0
          ? Math.round(presentTotal / workingDays.length)
          : 0;

    return {
        present,
        on_leave: onLeaveTotal,
        correction_requests: correctionRequests,
        incomplete,
        total_internal_active: totalInternalActive,
        is_single_day,
    };
};

/** Attendance overview over `[from, to]` (inclusive, `YYYY-MM-DD`), scoped
 *  to `userIds` when given (`null` = org-wide). Single-day requests return
 *  that day's raw counts; multi-day ranges average `present` over the
 *  window's working days (weekend/holiday placeholder rows excluded) and
 *  total the rest. */
export const attendanceOverviewFor = (
    from: string,
    to: string,
    userIds: Types.ObjectId[] | null
): Promise<AttendanceOverview> =>
    safeCard('overview.attendance', () => attendanceOverviewForImpl(from, to, userIds), {
        present: 0,
        on_leave: 0,
        correction_requests: 0,
        incomplete: 0,
        total_internal_active: 0,
        is_single_day: from === to,
    });

// ─── representativesStatusFor ─────────────────────────────────────────────

const representativesStatusForImpl = async (companyId: Types.ObjectId): Promise<RepresentativesStatus> => {
    const rows = await User.aggregate<{ _id: string; count: number }>([
        { $match: { role: ROLES.REPRESENTATIVE, 'client_profile.company_id': companyId } },
        { $group: { _id: '$status', count: { $sum: 1 } } },
    ]);

    let active = 0;
    let inactive = 0;
    for (const r of rows) {
        if (r._id === USER_STATUSES.ACTIVE) active += r.count;
        else inactive += r.count; // deactivated (or any future non-active status)
    }
    return { active, inactive, total: active + inactive };
};

/** Active/inactive breakdown of a company's representatives. */
export const representativesStatusFor = (companyId: Types.ObjectId): Promise<RepresentativesStatus> =>
    safeCard('overview.representatives_status', () => representativesStatusForImpl(companyId), {
        active: 0,
        inactive: 0,
        total: 0,
    });

// ─── Per-scope overview builders (Task 3) ─────────────────────────────────
//
// Each builder composes the Task-2 primitives above with the role's
// existing scope helpers — none of the visibility rules are reimplemented
// here (`buildProjectVisibilityFilter` / `resolveTeamLeadScope` /
// `resolveClientProjectIds` remain the single source of truth, same as
// `dashboard.service.ts`). Every extra sub-aggregation introduced in this
// file (pending-approvals count, open-tasks count, and the scope-resolution
// calls themselves) is wrapped in `safeCard` for the same reason the Task-2
// helpers are: one failing query degrades to a zero/empty value instead of
// blacking out the whole overview.

export interface DashboardOverviewPayload {
    scope: 'admin' | 'manager' | 'employee' | 'client';
    range: { from: string; to: string; is_single_day: boolean };
    /** Exactly 3 cards. */
    summary: OverviewSummaryCard[];
    /** `null` for the client scope (clients have no attendance surface). */
    attendance: AttendanceOverview | null;
    /** Non-null only for the client scope. */
    representatives: RepresentativesStatus | null;
    projects: ProjectStatusBreakdown;
}

const buildRange = (from: string, to: string): { from: string; to: string; is_single_day: boolean } => ({
    from,
    to,
    is_single_day: from === to,
});

// ─── admin ─────────────────────────────────────────────────────────────

export const buildAdminOverview = async (from: string, to: string): Promise<DashboardOverviewPayload> => {
    const [totalEmployees, totalClients, projects, attendance] = await Promise.all([
        headcountAsOf(to, [ROLES.ADMIN, ROLES.MANAGER, ROLES.TEAM_LEAD, ROLES.EMPLOYEE]),
        headcountAsOf(to, [ROLES.CLIENT]),
        projectStatusFor({}),
        attendanceOverviewFor(from, to, null),
    ]);

    return {
        scope: 'admin',
        range: buildRange(from, to),
        summary: [
            { label: 'Total Employees', value: totalEmployees },
            { label: 'Total Clients', value: totalClients },
            { label: 'Total Projects', value: projects.total },
        ],
        attendance,
        representatives: null,
        projects,
    };
};

// ─── manager (also serves team_lead callers) ────────────────────────────

export const buildManagerOverview = async (
    caller: ProjectCaller,
    from: string,
    to: string
): Promise<DashboardOverviewPayload> => {
    const filter = buildProjectVisibilityFilter(caller);
    const { memberIds: teamIds } = await safeCard(
        'overview.manager.team_scope',
        () => resolveTeamLeadScope(caller.id),
        { projectIds: [] as Types.ObjectId[], memberIds: [] as Types.ObjectId[] }
    );

    const [projects, pendingApprovals, attendance] = await Promise.all([
        projectStatusFor(filter),
        safeCard(
            'overview.manager.pending_approvals',
            () => LeaveRequest.countDocuments({ status: LEAVE_REQUEST_STATUSES.PENDING, user_id: { $in: teamIds } }),
            0
        ),
        attendanceOverviewFor(from, to, teamIds),
    ]);

    return {
        scope: 'manager',
        range: buildRange(from, to),
        summary: [
            { label: 'Team members', value: teamIds.length },
            { label: 'My Projects', value: projects.total },
            { label: 'Pending approvals', value: pendingApprovals },
        ],
        attendance,
        representatives: null,
        projects,
    };
};

// ─── employee ────────────────────────────────────────────────────────────

export const buildEmployeeOverview = async (
    caller: ProjectCaller,
    from: string,
    to: string
): Promise<DashboardOverviewPayload> => {
    const filter = buildProjectVisibilityFilter(caller);

    const [projects, attendance, openTasks] = await Promise.all([
        projectStatusFor(filter),
        attendanceOverviewFor(from, to, [caller.id]),
        safeCard(
            'overview.employee.open_tasks',
            () =>
                Task.countDocuments({
                    $or: [{ created_by: caller.id }, { primary_assignee_id: caller.id }],
                    status: { $ne: DEFAULT_DONE_TASK_STATUS_KEY },
                }),
            0
        ),
    ]);

    return {
        scope: 'employee',
        range: buildRange(from, to),
        summary: [
            { label: 'My present days', value: attendance.present },
            { label: 'My Projects', value: projects.total },
            { label: 'My open tasks', value: openTasks },
        ],
        attendance,
        representatives: null,
        projects,
    };
};

// ─── client ──────────────────────────────────────────────────────────────

/** Placeholder id that matches nothing — used when a client-side caller has
 *  no `company_id` resolved, so representatives degrade to zero rather than
 *  throwing. Mirrors `DENY_ALL` in `project.service.ts`. */
const NO_COMPANY_ID = new Types.ObjectId('000000000000000000000000');

export const buildClientOverview = async (
    caller: ProjectCaller,
    from: string,
    to: string
): Promise<DashboardOverviewPayload> => {
    const projectIds = await safeCard(
        'overview.client.resolve_projects',
        () => resolveClientProjectIds(caller),
        [] as Types.ObjectId[]
    );
    const filter = { _id: { $in: projectIds } };
    const companyId = caller.company_id ?? NO_COMPANY_ID;

    const [projects, representatives] = await Promise.all([
        projectStatusFor(filter),
        representativesStatusFor(companyId),
    ]);

    return {
        scope: 'client',
        range: buildRange(from, to),
        summary: [
            { label: 'Company Projects', value: projects.total },
            { label: 'Representatives', value: representatives.total },
            { label: 'Active vs Completed', value: projects.active, hint: `${projects.completed} completed` },
        ],
        attendance: null,
        representatives,
        projects,
    };
};
