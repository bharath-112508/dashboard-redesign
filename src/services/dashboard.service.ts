import { Types } from 'mongoose';

import { User } from '../models/user.model.js';
import { AttendanceRecord } from '../models/attendance-record.model.js';
import { LeaveRequest } from '../models/leave-request.model.js';
import { LeaveBalance } from '../models/leave-balance.model.js';
import { LeaveType, type LeaveTypeDocument } from '../models/leave-type.model.js';
import { Holiday } from '../models/holiday.model.js';
import { Notification } from '../models/notification.model.js';
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
