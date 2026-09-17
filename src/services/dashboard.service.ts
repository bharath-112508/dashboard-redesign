import { Types } from 'mongoose';

import { User } from '../models/user.model.js';
import { AttendanceRecord } from '../models/attendance-record.model.js';
import { LeaveRequest } from '../models/leave-request.model.js';
import { LeaveBalance, presentedAvailable } from '../models/leave-balance.model.js';
import { LeaveType, type LeaveTypeDocument } from '../models/leave-type.model.js';
import { Holiday } from '../models/holiday.model.js';
import { Notification } from '../models/notification.model.js';
import { buildProjectVisibilityFilter, type ProjectCaller } from './project.service.js';
import { Project } from '../models/project.model.js';
import { isAdminLike } from '../utils/role-check.js';
import { resolveTeamLeadScope } from './dashboard-analytics.service.js';
import { Task } from '../models/task.model.js';
import { DEFAULT_DONE_TASK_STATUS_KEY } from '../constants/story.js';
import logger from '../utils/logger.js';
import dayjs, { DEFAULT_TIMEZONE, DATE_FORMAT } from '../utils/date.js';
import { callerCan } from '../utils/caller-permissions.js';
import { PERMISSIONS } from '../constants/permissions.js';
import { CLIENT_SIDE_ROLES, ROLES, type RoleType } from '../constants/roles.js';
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
        [ROLES.REPRESENTATIVE]: 0,
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
            role: { $nin: CLIENT_SIDE_ROLES },
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

    // Hydrate the requester's name so the card shows a person, not an id
    // (matches `computeUpcomingLeaves`).
    const users = await User.find({ _id: { $in: recentRows.map((r) => r.user_id) } })
        .select({ full_name: 1 })
        .lean<{ _id: Types.ObjectId; full_name: string }[]>();
    const nameById = new Map(users.map((u) => [u._id.toString(), u.full_name]));

    return {
        count,
        requires_additional_approval: additional,
        recent: recentRows.map((r) => ({
            id: r._id.toString(),
            user_id: r.user_id.toString(),
            user_name: nameById.get(r.user_id.toString()) ?? null,
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
    headcount?: AdminHeadcount;
    attendance_today?: AttendanceTodayCard;
    pending_leave_approvals?: PendingLeaveCard;
    holidays_this_month?: number;
}

const EMPTY_HEADCOUNT: AdminHeadcount = {
    active: 0,
    deactivated: 0,
    by_role: {
        [ROLES.ADMIN]: 0,
        [ROLES.MANAGER]: 0,
        [ROLES.TEAM_LEAD]: 0,
        [ROLES.EMPLOYEE]: 0,
        [ROLES.CLIENT]: 0,
        [ROLES.REPRESENTATIVE]: 0,
    },
};

const EMPTY_ATTENDANCE: AttendanceTodayCard = {
    date: '',
    present: 0,
    on_leave: 0,
    incomplete: 0,
    flagged_for_correction: 0,
    total_internal_active: 0,
};

const EMPTY_PENDING: PendingLeaveCard = {
    count: 0,
    requires_additional_approval: 0,
    recent: [],
};

export const buildAdminDashboard = async (held: readonly string[] | undefined): Promise<AdminDashboardPayload> => {
    const payload: AdminDashboardPayload = { generated_at: new Date().toISOString() };
    const jobs: Promise<void>[] = [];

    if (callerCan(held, PERMISSIONS.USER_READ)) {
        jobs.push(
            safeCard('admin.headcount', computeHeadcount, EMPTY_HEADCOUNT).then((v) => {
                payload.headcount = v;
            })
        );
    }
    if (callerCan(held, PERMISSIONS.ATTENDANCE_READ_TEAM)) {
        jobs.push(
            safeCard('admin.attendance_today', computeAttendanceToday, {
                ...EMPTY_ATTENDANCE,
                date: todayLocalDate(),
            }).then((v) => {
                payload.attendance_today = v;
            })
        );
    }
    if (callerCan(held, PERMISSIONS.LEAVE_REQUEST_APPROVE)) {
        jobs.push(
            safeCard('admin.pending_leaves', () => computePendingLeaves({}), EMPTY_PENDING).then((v) => {
                payload.pending_leave_approvals = v;
            })
        );
    }
    if (callerCan(held, PERMISSIONS.HOLIDAY_READ)) {
        jobs.push(
            safeCard('admin.holidays_this_month', computeHolidaysThisMonth, 0).then((v) => {
                payload.holidays_this_month = v;
            })
        );
    }

    await Promise.all(jobs);
    return payload;
};

// ─── Manager dashboard ────────────────────────────────────────────────────

interface ManagerDashboardPayload {
    generated_at: string;
    scope: 'team' | 'org';
    team_size: number;
    pending_leave_approvals?: PendingLeaveCard;
}

export const buildManagerDashboard = async (
    caller: {
        id: Types.ObjectId;
        role: RoleType;
        /** Step-47 RBAC signal (BACKEND_AUDIT.md R4). */
        role_keys?: readonly string[];
    },
    held: readonly string[] | undefined
): Promise<ManagerDashboardPayload> => {
    // Admins + Managers are org-wide; a Team Lead is scoped to the members of
    // the projects they belong to (so team_size + the pending-approval queue
    // reflect their projects' people, not the whole org).
    const orgWide = isAdminLike(caller) || caller.role === ROLES.MANAGER;

    if (orgWide) {
        const team_size = await safeCard(
            'manager.team_size',
            () => User.countDocuments({ status: USER_STATUSES.ACTIVE, role: { $nin: CLIENT_SIDE_ROLES } }),
            0
        );
        const payload: ManagerDashboardPayload = {
            generated_at: new Date().toISOString(),
            scope: 'org',
            team_size,
        };
        if (callerCan(held, PERMISSIONS.LEAVE_REQUEST_APPROVE)) {
            payload.pending_leave_approvals = await safeCard(
                'manager.pending_leaves',
                () => computePendingLeaves({}),
                EMPTY_PENDING
            );
        }
        return payload;
    }

    // Team lead — scope to the people who share a project with them, minus self
    // (a lead can't approve their own leave).
    const { memberIds } = await safeCard('manager.team_scope', () => resolveTeamLeadScope(caller.id), {
        projectIds: [],
        memberIds: [],
    });
    const reviewIds = memberIds.filter((id) => !id.equals(caller.id));

    const payload: ManagerDashboardPayload = {
        generated_at: new Date().toISOString(),
        scope: 'team',
        team_size: memberIds.length,
    };
    if (callerCan(held, PERMISSIONS.LEAVE_REQUEST_APPROVE)) {
        payload.pending_leave_approvals = await safeCard(
            'manager.pending_leaves',
            () =>
                reviewIds.length === 0
                    ? Promise.resolve(EMPTY_PENDING)
                    : computePendingLeaves({ user_id: { $in: reviewIds } }),
            EMPTY_PENDING
        );
    }
    return payload;
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
    /** WFH and friends: no annual cap, so `available` is always 0 here. */
    is_unlimited: boolean;
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

    return rows.flatMap((r) => {
        const lt = typeMap.get(r.leave_type_id.toString()) ?? null;
        // A retired type can't be applied for, so whatever sits on its row is
        // unspendable. The card's consumer sums these into a single "leave
        // available" headline, and leftovers on long-dead types were inflating
        // it well past anything the employee could actually take.
        if (!lt || lt.is_active === false) return [];
        return {
            leave_type_id: r.leave_type_id.toString(),
            code: lt.code ?? null,
            name: lt.name ?? null,
            // An uncapped type contributes nothing to "days left" rather
            // than a negative — see `presentedAvailable`. The flag rides
            // along so the card can label it instead of printing a bare 0.
            available: presentedAvailable(r, lt),
            allocated: r.allocated,
            used: r.used,
            pending: r.pending,
            is_unlimited: lt.is_unlimited ?? false,
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
// Serves both client-side roles. Visibility differs between them — a
// `client` sees every project of their company; a `representative` sees only
// projects they're rostered on — so this does NOT hard-code a filter. It
// composes `buildProjectVisibilityFilter` from project.service, the single
// source of truth, and passes the resolved id set through to each card.
//
// Composing rather than duplicating matters: the previous hard-coded
// `{ client_ids: caller.id }` here would have silently returned ZERO
// projects once the field was renamed — a dead dashboard with no error.

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

/** Resolve the set of project IDs visible to this client-side caller. Every
 *  card below scopes its query through this list. The role → filter rule
 *  itself lives in `project.service` — never re-implement it here.
 *
 *  Exported for reuse by `dashboard-overview.service.ts` (Task 3's client
 *  overview builder) — same rule, don't duplicate the query. */
export const resolveClientProjectIds = async (caller: ProjectCaller): Promise<Types.ObjectId[]> => {
    const rows = await Project.find(buildProjectVisibilityFilter(caller))
        .select({ _id: 1 })
        .lean<{ _id: Types.ObjectId }[]>();
    return rows.map((r) => r._id);
};

/** Per-project rollup → ClientProjectCard for the top-N most recently active.
 *  One aggregation pipeline so we don't N+1 over projects.
 *
 *  M10 — accepts the pre-resolved `projectIds` from
 *  `resolveClientProjectIds` instead of re-running the visibility filter.
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

export const buildClientDashboard = async (caller: ProjectCaller): Promise<ClientDashboardPayload> => {
    const user_id = caller.id;
    // Resolve visible projects once; pass the id list to dependent cards so
    // we don't run the visibility query twice.
    const projectIds = await safeCard(
        'client.resolve_projects',
        () => resolveClientProjectIds(caller),
        [] as Types.ObjectId[]
    );

    const [projects, recent_task_activity, unread_notifications] = await Promise.all([
        safeCard(
            'client.projects',
            // M10 — pass the resolved projectIds (instead of re-running the
            // visibility query) so the second query is a cheap `_id`-key
            // lookup instead of a duplicate scan.
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
