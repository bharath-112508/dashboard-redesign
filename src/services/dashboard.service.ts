import { Types } from 'mongoose';

import { User } from '../models/user.model.js';
import { AttendanceRecord } from '../models/attendance-record.model.js';
import { LeaveRequest } from '../models/leave-request.model.js';
import { LeaveBalance } from '../models/leave-balance.model.js';
import { LeaveType, type LeaveTypeDocument } from '../models/leave-type.model.js';
import { Holiday } from '../models/holiday.model.js';
import { Notification } from '../models/notification.model.js';
import { Project } from '../models/project.model.js';
import { Task } from '../models/task.model.js';
import { DEFAULT_DONE_TASK_STATUS_KEY } from '../constants/story.js';
import logger from '../utils/logger.js';
import dayjs, { DEFAULT_TIMEZONE, DATE_FORMAT } from '../utils/date.js';
import { isAdminLike } from '../utils/role-check.js';
import { ROLES, type RoleType } from '../constants/roles.js';
import { USER_STATUSES } from '../constants/user-statuses.js';
import { LEAVE_REQUEST_STATUSES } from '../constants/leave.js';
import { DASHBOARD_PENDING_LEAVES_PREVIEW, DASHBOARD_RECENT_LEAVES_LIMIT } from '../constants/dashboard.js';
import { initializeBalancesForUserYear } from './leave-balance.service.js';

/**
 * Dashboard service — Step 13 (API_Contract.md §14, Plan §6.1).
 *
 * Phase 1 surface is **leave + attendance only**. Project / sprint / task /
 * timesheet cards land in Phase 2. Each card is computed independently and
 * wrapped in `safeCard(...)` so a single failing aggregation cannot black
 * out the whole landing page — failures are logged at warn level and the
 * card defaults to a contractually-shaped empty value.
 *
 * Design notes:
 *  - All `local_date` math runs in `DEFAULT_TIMEZONE` (Asia/Kolkata) for
 *    parity with the attendance module so "today" lines up with the working
 *    day every other surface uses.
 *  - The admin headcount aggregation excludes deactivated users from "by
 *    role" counts (they're surfaced separately as `deactivated`). Single-
 *    admin invariance is observable here as `by_role.admin === 1` once
 *    bootstrap completes.
 *  - Manager dashboard pending-count is scoped to direct reports
 *    (`internal_profile.reporting_manager_id === caller_id`). Admins always
 *    see the org-wide count.
 *  - Employee balances re-use the same self-heal as `/leave-balances/me` so
 *    a brand-new joiner whose year hasn't been initialised still sees
 *    something useful.
 */

// ─── Local helpers ────────────────────────────────────────────────────────

const todayLocalDate = (): string => dayjs().tz(DEFAULT_TIMEZONE).format(DATE_FORMAT);

// H1 — IST business calendar drives "current year" so the year-end window
// between IST midnight and UTC midnight doesn't read last year's balances.
const currentYear = (): number => dayjs().tz(DEFAULT_TIMEZONE).year();

const monthRange = (): { start: string; end: string } => {
    const now = dayjs().tz(DEFAULT_TIMEZONE);
    return {
        start: now.startOf('month').format(DATE_FORMAT),
        end: now.endOf('month').format(DATE_FORMAT),
    };
};

/**
 * Run a card aggregator and fall back to `fallback` if it throws. Dashboards
 * are read-only summaries; one slow/failing collection should never 500 the
 * whole landing page.
 */
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

// ─── Admin dashboard ──────────────────────────────────────────────────────

interface AdminHeadcount {
    active: number;
    deactivated: number;
    by_role: Record<RoleType, number>;
}

const computeHeadcount = async (): Promise<AdminHeadcount> => {
    const rows = await User.aggregate<{ _id: { role: RoleType; status: string }; count: number }>([
        { $group: { _id: { role: '$role', status: '$status' }, count: { $sum: 1 } } },
    ]);

    const by_role: Record<RoleType, number> = {
        [ROLES.ADMIN]: 0,
        [ROLES.MANAGER]: 0,
        [ROLES.TEAM_LEAD]: 0,
        [ROLES.EMPLOYEE]: 0,
        [ROLES.CLIENT]: 0,
    };
    let active = 0;
    let deactivated = 0;
    for (const r of rows) {
        const role = r._id.role;
        const status = r._id.status;
        if (status === USER_STATUSES.ACTIVE) {
            active += r.count;
            if (role in by_role) by_role[role] += r.count;
        } else if (status === USER_STATUSES.DEACTIVATED) {
            deactivated += r.count;
        }
    }
    return { active, deactivated, by_role };
};

interface AttendanceTodayCard {
    date: string;
    present: number;
    on_leave: number;
    incomplete: number;
    flagged_for_correction: number;
    total_internal_active: number;
}

const computeAttendanceToday = async (): Promise<AttendanceTodayCard> => {
    const date = todayLocalDate();

    const [statusAgg, flaggedCount, totalInternal] = await Promise.all([
        AttendanceRecord.aggregate<{ _id: string; count: number }>([
            { $match: { local_date: date } },
            { $group: { _id: '$status', count: { $sum: 1 } } },
        ]),
        AttendanceRecord.countDocuments({ local_date: date, flagged_for_correction: true }),
        User.countDocuments({
            status: USER_STATUSES.ACTIVE,
            role: { $ne: ROLES.CLIENT },
        }),
    ]);

    const byStatus = new Map(statusAgg.map((r) => [r._id, r.count]));
    return {
        date,
        present: byStatus.get('present') ?? 0,
        on_leave: byStatus.get('on_leave') ?? 0,
        incomplete: byStatus.get('incomplete') ?? 0,
        flagged_for_correction: flaggedCount,
        total_internal_active: totalInternal,
    };
};

interface PendingLeaveCard {
    count: number;
    requires_additional_approval: number;
    recent: Record<string, unknown>[];
}

const computePendingLeaves = async (filter: Record<string, unknown>): Promise<PendingLeaveCard> => {
    const baseFilter = { ...filter, status: LEAVE_REQUEST_STATUSES.PENDING };

    const [count, additional, recentRows] = await Promise.all([
        LeaveRequest.countDocuments(baseFilter),
        LeaveRequest.countDocuments({ ...baseFilter, requires_additional_approval: true }),
        LeaveRequest.find(baseFilter).sort({ created_at: -1, _id: -1 }).limit(DASHBOARD_PENDING_LEAVES_PREVIEW),
    ]);

    return {
        count,
        requires_additional_approval: additional,
        recent: recentRows.map((r) => ({
            id: r._id.toString(),
            user_id: r.user_id.toString(),
            requested_leave_type_id: r.requested_leave_type_id.toString(),
            start_date: r.start_date,
            end_date: r.end_date,
            total_days: r.total_days,
            requires_additional_approval: r.requires_additional_approval,
            created_at: r.created_at.toISOString(),
        })),
    };
};

const computeHolidaysThisMonth = async (): Promise<number> => {
    const { start, end } = monthRange();
    return Holiday.countDocuments({ date: { $gte: start, $lte: end } });
};

interface AdminDashboardPayload {
    generated_at: string;
    headcount: AdminHeadcount;
    attendance_today: AttendanceTodayCard;
    pending_leave_approvals: PendingLeaveCard;
    holidays_this_month: number;
}

export const buildAdminDashboard = async (): Promise<AdminDashboardPayload> => {
    const [headcount, attendance_today, pending_leave_approvals, holidays_this_month] = await Promise.all([
        safeCard('admin.headcount', computeHeadcount, {
            active: 0,
            deactivated: 0,
            by_role: {
                [ROLES.ADMIN]: 0,
                [ROLES.MANAGER]: 0,
                [ROLES.TEAM_LEAD]: 0,
                [ROLES.EMPLOYEE]: 0,
                [ROLES.CLIENT]: 0,
            },
        } satisfies AdminHeadcount),
        safeCard('admin.attendance_today', computeAttendanceToday, {
            date: todayLocalDate(),
            present: 0,
            on_leave: 0,
            incomplete: 0,
            flagged_for_correction: 0,
            total_internal_active: 0,
        } satisfies AttendanceTodayCard),
        safeCard('admin.pending_leaves', () => computePendingLeaves({}), {
            count: 0,
            requires_additional_approval: 0,
            recent: [],
        } satisfies PendingLeaveCard),
        safeCard('admin.holidays_this_month', computeHolidaysThisMonth, 0),
    ]);

    return {
        generated_at: new Date().toISOString(),
        headcount,
        attendance_today,
        pending_leave_approvals,
        holidays_this_month,
    };
};

// ─── Manager dashboard ────────────────────────────────────────────────────

interface ManagerDashboardPayload {
    generated_at: string;
    scope: 'team' | 'org';
    team_size: number;
    pending_leave_approvals: PendingLeaveCard;
}

/**
 * Resolve the manager's direct reports — non-client active users whose
 * `internal_profile.reporting_manager_id` points at the caller. Admins are
 * intentionally treated as org-scoped (no team filter) so they see the
 * full pending queue from this endpoint as well as `/dashboard/admin`.
 */
const resolveDirectReportIds = async (manager_id: Types.ObjectId): Promise<Types.ObjectId[]> => {
    const reports = await User.find({
        status: USER_STATUSES.ACTIVE,
        role: { $ne: ROLES.CLIENT },
        'internal_profile.reporting_manager_id': manager_id,
    }).select('_id');
    return reports.map((u) => u._id);
};

export const buildManagerDashboard = async (caller: {
    id: Types.ObjectId;
    role: RoleType;
    /** Step-47 RBAC signal (BACKEND_AUDIT.md R4). */
    role_keys?: readonly string[];
}): Promise<ManagerDashboardPayload> => {
    if (isAdminLike(caller)) {
        const pending = await safeCard('manager.pending_leaves', () => computePendingLeaves({}), {
            count: 0,
            requires_additional_approval: 0,
            recent: [],
        } satisfies PendingLeaveCard);
        const team_size = await safeCard(
            'manager.team_size',
            () =>
                User.countDocuments({
                    status: USER_STATUSES.ACTIVE,
                    role: { $ne: ROLES.CLIENT },
                }),
            0
        );
        return {
            generated_at: new Date().toISOString(),
            scope: 'org',
            team_size,
            pending_leave_approvals: pending,
        };
    }

    const reports = await safeCard(
        'manager.direct_reports',
        () => resolveDirectReportIds(caller.id),
        [] as Types.ObjectId[]
    );

    const pending_leave_approvals = await safeCard(
        'manager.pending_leaves',
        () =>
            reports.length === 0
                ? Promise.resolve({
                      count: 0,
                      requires_additional_approval: 0,
                      recent: [] as Record<string, unknown>[],
                  } satisfies PendingLeaveCard)
                : computePendingLeaves({ user_id: { $in: reports } }),
        { count: 0, requires_additional_approval: 0, recent: [] } satisfies PendingLeaveCard
    );

    return {
        generated_at: new Date().toISOString(),
        scope: 'team',
        team_size: reports.length,
        pending_leave_approvals,
    };
};

// ─── Employee dashboard ───────────────────────────────────────────────────

interface EmployeeAttendanceTodayCard {
    date: string;
    checked_in: boolean;
    check_in_time: string | null;
    checked_out: boolean;
    check_out_time: string | null;
    status: string | null;
    flagged_for_correction: boolean;
}

const computeEmployeeAttendanceToday = async (user_id: Types.ObjectId): Promise<EmployeeAttendanceTodayCard> => {
    const local_date = todayLocalDate();
    const rec = await AttendanceRecord.findOne({ user_id, local_date });
    if (!rec) {
        return {
            date: local_date,
            checked_in: false,
            check_in_time: null,
            checked_out: false,
            check_out_time: null,
            status: null,
            flagged_for_correction: false,
        };
    }
    return {
        date: local_date,
        checked_in: !!rec.check_in,
        check_in_time: rec.check_in?.time ? rec.check_in.time.toISOString() : null,
        checked_out: !!rec.check_out,
        check_out_time: rec.check_out?.time ? rec.check_out.time.toISOString() : null,
        status: rec.status,
        flagged_for_correction: rec.flagged_for_correction,
    };
};

interface LeaveBalanceCard {
    leave_type_id: string;
    code: string | null;
    name: string | null;
    available: number;
    allocated: number;
    used: number;
    pending: number;
}

const computeEmployeeLeaveBalances = async (user_id: Types.ObjectId): Promise<LeaveBalanceCard[]> => {
    const year = currentYear();
    // Self-heal (no-op if rows exist) so the dashboard works for new joiners
    // who haven't read /leave-balances/me yet.
    await initializeBalancesForUserYear({ user_id, year });

    const rows = await LeaveBalance.find({ user_id, year }).sort({ leave_type_id: 1 });
    if (rows.length === 0) return [];

    const typeIds = rows.map((r) => r.leave_type_id);
    const types = await LeaveType.find({ _id: { $in: typeIds } });
    const typeMap = new Map<string, LeaveTypeDocument>(types.map((t) => [t._id.toString(), t]));

    return rows.map((r) => {
        const lt = typeMap.get(r.leave_type_id.toString()) ?? null;
        return {
            leave_type_id: r.leave_type_id.toString(),
            code: lt?.code ?? null,
            name: lt?.name ?? null,
            available: r.available,
            allocated: r.allocated,
            used: r.used,
            pending: r.pending,
        };
    });
};

const computeEmployeeRecentLeaves = async (user_id: Types.ObjectId): Promise<Record<string, unknown>[]> => {
    const rows = await LeaveRequest.find({ user_id })
        .sort({ created_at: -1, _id: -1 })
        .limit(DASHBOARD_RECENT_LEAVES_LIMIT);
    return rows.map((r) => ({
        id: r._id.toString(),
        requested_leave_type_id: r.requested_leave_type_id.toString(),
        start_date: r.start_date,
        end_date: r.end_date,
        total_days: r.total_days,
        status: r.status,
        created_at: r.created_at.toISOString(),
    }));
};

const computeEmployeeUnreadNotifications = async (user_id: Types.ObjectId): Promise<number> => {
    return Notification.countDocuments({ user_id, is_read: false });
};

interface EmployeeDashboardPayload {
    generated_at: string;
    user_id: string;
    today: { attendance: EmployeeAttendanceTodayCard };
    leave_balances: LeaveBalanceCard[];
    recent_leaves: Record<string, unknown>[];
    unread_notifications: number;
}

export const buildEmployeeDashboard = async (user_id: Types.ObjectId): Promise<EmployeeDashboardPayload> => {
    const [attendance, leave_balances, recent_leaves, unread_notifications] = await Promise.all([
        safeCard('employee.attendance_today', () => computeEmployeeAttendanceToday(user_id), {
            date: todayLocalDate(),
            checked_in: false,
            check_in_time: null,
            checked_out: false,
            check_out_time: null,
            status: null,
            flagged_for_correction: false,
        } satisfies EmployeeAttendanceTodayCard),
        safeCard('employee.leave_balances', () => computeEmployeeLeaveBalances(user_id), [] as LeaveBalanceCard[]),
        safeCard('employee.recent_leaves', () => computeEmployeeRecentLeaves(user_id), [] as Record<string, unknown>[]),
        safeCard('employee.unread_notifications', () => computeEmployeeUnreadNotifications(user_id), 0),
    ]);

    return {
        generated_at: new Date().toISOString(),
        user_id: user_id.toString(),
        today: { attendance },
        leave_balances,
        recent_leaves,
        unread_notifications,
    };
};

// ─── Client dashboard (V2-BE-2) ────────────────────────────────────────────
//
// Clients see only the projects they're a client on (`client_ids ∋ caller.id`)
// and tasks within those projects. The same `PROJECT_CLIENT_SCOPED_ROLES`
// filter that `project.service` enforces gates everything below — we resolve
// the visible project-id set once and pass it through to each card. If a
// client is on zero projects, every card returns its empty fallback (no 500s,
// no leaked data from other tenants' projects).

const DASHBOARD_CLIENT_RECENT_PROJECTS = 5;
const DASHBOARD_CLIENT_RECENT_ACTIVITY = 10;

interface ClientProjectCard {
    id: string;
    name: string;
    code: string;
    status: string;
    task_count: number;
    open_task_count: number;
    last_activity_at: string | null;
}

interface ClientTaskActivityCard {
    id: string;
    title: string;
    status: string;
    project_id: string;
    project_name: string;
    updated_at: string;
}

interface ClientDashboardPayload {
    generated_at: string;
    user_id: string;
    scope: 'client';
    projects: {
        total: number;
        recent: ClientProjectCard[];
    };
    recent_task_activity: ClientTaskActivityCard[];
    unread_notifications: number;
}

/** Resolve the set of project IDs visible to this client. Single source of
 *  truth — every card below scopes its query through this list. */
const resolveClientProjectIds = async (user_id: Types.ObjectId): Promise<Types.ObjectId[]> => {
    const rows = await Project.find({ client_ids: user_id }).select({ _id: 1 }).lean<{ _id: Types.ObjectId }[]>();
    return rows.map((r) => r._id);
};

/** Per-project rollup → ClientProjectCard for the top-N most recently active.
 *  One aggregation pipeline so we don't N+1 over projects.
 *
 *  M10 — accepts the pre-resolved `projectIds` from
 *  `resolveClientProjectIds` instead of re-running `{ client_ids: user_id }`.
 *  Pre-M10 the caller resolved the id list once and then this function
 *  queried with the same predicate again — two index hits, two passes.
 *  Using `_id: { $in: projectIds }` collapses the second query to a
 *  fast `_id`-key lookup. Empty `projectIds` is preserved as the
 *  zero-projects branch (Mongo treats `$in: []` as match-nothing). */
const computeClientProjectCards = async (
    visibleProjectIds: Types.ObjectId[],
    limit: number
): Promise<{ total: number; recent: ClientProjectCard[] }> => {
    if (visibleProjectIds.length === 0) return { total: 0, recent: [] };
    const projects = await Project.find({ _id: { $in: visibleProjectIds } })
        .select({
            _id: 1,
            name: 1,
            code: 1,
            status: 1,
            custom_task_statuses: 1,
            updated_at: 1,
        })
        .lean<
            {
                _id: Types.ObjectId;
                name: string;
                code: string;
                status: string;
                custom_task_statuses: { key: string; is_terminal: boolean }[];
                updated_at: Date;
            }[]
        >();

    if (projects.length === 0) return { total: 0, recent: [] };

    const projectIds = projects.map((p) => p._id);

    // Per-project terminal-status set: `done` + any custom status flagged
    // terminal. Used below to compute `open_task_count`.
    const terminalByProject = new Map<string, Set<string>>();
    for (const p of projects) {
        const set = new Set<string>([DEFAULT_DONE_TASK_STATUS_KEY]);
        for (const s of p.custom_task_statuses ?? []) {
            if (s.is_terminal) set.add(s.key);
        }
        terminalByProject.set(p._id.toString(), set);
    }

    // One aggregation over all visible projects: task_count + per-status
    // counts + last task update timestamp per project.
    const rollups = await Task.aggregate<{
        _id: Types.ObjectId;
        task_count: number;
        statuses: { status: string; count: number }[];
        last_activity_at: Date | null;
    }>([
        { $match: { project_id: { $in: projectIds } } },
        {
            $group: {
                _id: { project: '$project_id', status: '$status' },
                count: { $sum: 1 },
                last_activity_at: { $max: '$updated_at' },
            },
        },
        {
            $group: {
                _id: '$_id.project',
                task_count: { $sum: '$count' },
                statuses: { $push: { status: '$_id.status', count: '$count' } },
                last_activity_at: { $max: '$last_activity_at' },
            },
        },
    ]);

    const rollupById = new Map<string, (typeof rollups)[number]>();
    for (const r of rollups) rollupById.set(r._id.toString(), r);

    const cards: ClientProjectCard[] = projects.map((p) => {
        const rollup = rollupById.get(p._id.toString());
        const terminal = terminalByProject.get(p._id.toString()) ?? new Set([DEFAULT_DONE_TASK_STATUS_KEY]);
        const open_task_count = rollup
            ? rollup.statuses.reduce((acc, s) => acc + (terminal.has(s.status) ? 0 : s.count), 0)
            : 0;
        return {
            id: p._id.toString(),
            name: p.name,
            code: p.code,
            status: p.status,
            task_count: rollup?.task_count ?? 0,
            open_task_count,
            last_activity_at: rollup?.last_activity_at?.toISOString() ?? p.updated_at?.toISOString() ?? null,
        };
    });

    // Sort by most recent activity desc, then by name to stabilise ties.
    cards.sort((a, b) => {
        const ad = a.last_activity_at ?? '';
        const bd = b.last_activity_at ?? '';
        if (ad !== bd) return bd.localeCompare(ad);
        return a.name.localeCompare(b.name);
    });

    return { total: projects.length, recent: cards.slice(0, limit) };
};

/** Last N tasks (by updated_at) across all of the client's visible projects. */
const computeClientRecentTaskActivity = async (
    projectIds: readonly Types.ObjectId[],
    limit: number
): Promise<ClientTaskActivityCard[]> => {
    if (projectIds.length === 0) return [];
    const tasks = await Task.find({ project_id: { $in: projectIds } })
        .sort({ updated_at: -1 })
        .limit(limit)
        .select({ _id: 1, title: 1, status: 1, project_id: 1, updated_at: 1 })
        .lean<
            {
                _id: Types.ObjectId;
                title: string;
                status: string;
                project_id: Types.ObjectId;
                updated_at: Date;
            }[]
        >();
    if (tasks.length === 0) return [];

    // One round trip to resolve project names for the labels.
    const projects = await Project.find({ _id: { $in: tasks.map((t) => t.project_id) } })
        .select({ _id: 1, name: 1 })
        .lean<{ _id: Types.ObjectId; name: string }[]>();
    const nameById = new Map<string, string>();
    for (const p of projects) nameById.set(p._id.toString(), p.name);

    return tasks.map((t) => ({
        id: t._id.toString(),
        title: t.title,
        status: t.status,
        project_id: t.project_id.toString(),
        project_name: nameById.get(t.project_id.toString()) ?? '',
        updated_at: t.updated_at.toISOString(),
    }));
};

export const buildClientDashboard = async (user_id: Types.ObjectId): Promise<ClientDashboardPayload> => {
    // Resolve visible projects once; pass the id list to dependent cards so
    // we don't query `Project.find({ client_ids })` twice.
    const projectIds = await safeCard(
        'client.resolve_projects',
        () => resolveClientProjectIds(user_id),
        [] as Types.ObjectId[]
    );

    const [projects, recent_task_activity, unread_notifications] = await Promise.all([
        safeCard(
            'client.projects',
            // M10 — pass the resolved projectIds (instead of re-running
            // `{ client_ids: user_id }`) so the second query is a cheap
            // `_id`-key lookup instead of a duplicate client-side scan.
            () => computeClientProjectCards(projectIds, DASHBOARD_CLIENT_RECENT_PROJECTS),
            { total: 0, recent: [] as ClientProjectCard[] }
        ),
        safeCard(
            'client.recent_task_activity',
            () => computeClientRecentTaskActivity(projectIds, DASHBOARD_CLIENT_RECENT_ACTIVITY),
            [] as ClientTaskActivityCard[]
        ),
        safeCard('client.unread_notifications', () => computeEmployeeUnreadNotifications(user_id), 0),
    ]);

    return {
        generated_at: new Date().toISOString(),
        user_id: user_id.toString(),
        scope: 'client',
        projects,
        recent_task_activity,
        unread_notifications,
    };
};
