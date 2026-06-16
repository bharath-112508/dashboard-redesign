import type { Types } from 'mongoose';

import { getMyToday, getTodayAttendanceSummary, type TodayAttendanceSummary } from './attendance.service.js';
import { listOwnBalances } from './leave-balance.service.js';
import { listLeaves, calendarLeaves } from './leave-request.service.js';
import { resolvePermissionsForUser } from './role.service.js';
import { callerCan } from '../utils/caller-permissions.js';
import { PERMISSIONS } from '../constants/permissions.js';
import { ROLES, type RoleType } from '../constants/roles.js';
import dayjs, { DEFAULT_TIMEZONE, DATE_FORMAT } from '../utils/date.js';
import logger from '../utils/logger.js';

/**
 * Aggregates the role-scoped data for the Slack Home dashboard. Each section
 * is fetched independently and wrapped so one failure yields `null` for that
 * section (rendered as "couldn't load") rather than breaking the whole view.
 */

export interface DashboardUser {
    _id: Types.ObjectId;
    role: RoleType;
    full_name?: string | null;
}

export interface HomeDashboardData {
    user: DashboardUser;
    my_today: Record<string, unknown> | null;
    my_balances: Record<string, unknown>[] | null;
    my_pending: Record<string, unknown>[] | null;
    whos_out: Record<string, unknown>[] | null;
    team_attendance: TodayAttendanceSummary | null;
    pending_leaves: Record<string, unknown>[] | null;
}

/** Per-list caps (Block Kit 100-block ceiling). */
export const ATT_ROSTER_CAP = 10;
export const PENDING_CAP = 10;
export const WHOSOUT_CAP = 15;

const isReviewer = (role: RoleType): boolean =>
    role === ROLES.ADMIN || role === ROLES.MANAGER || role === ROLES.TEAM_LEAD;

/** Run a section fetch; on error log + return null so the view still renders. */
const safe = async <T>(label: string, fn: () => Promise<T>): Promise<T | null> => {
    try {
        return await fn();
    } catch (err) {
        logger.warn({ err, section: label, code: 'SLACK_HOME_SECTION_FAILED' }, 'Slack Home dashboard section failed');
        return null;
    }
};

export const buildHomeDashboardData = async (user: DashboardUser): Promise<HomeDashboardData> => {
    const today = dayjs().tz(DEFAULT_TIMEZONE).format(DATE_FORMAT);
    const weekEnd = dayjs().tz(DEFAULT_TIMEZONE).add(7, 'day').format(DATE_FORMAT);
    const reviewer = isReviewer(user.role);

    const perms = (await safe('perms', () => resolvePermissionsForUser(user._id)))?.permissions ?? [];
    const canReadTeamAttendance = callerCan(perms, PERMISSIONS.ATTENDANCE_READ_TEAM);

    const [my_today, my_balances, my_pending, whos_out, team_attendance, pending_leaves] = await Promise.all([
        safe('my_today', () => getMyToday(user._id)),
        safe('my_balances', () => listOwnBalances(user._id)),
        safe('my_pending', () =>
            listLeaves(
                { status: 'pending', user_id: user._id.toString(), page: 1, limit: 5 } as Parameters<
                    typeof listLeaves
                >[0],
                { id: user._id, role: user.role }
            ).then((r) => r.data)
        ),
        safe('whos_out', () =>
            calendarLeaves({ from_date: today, to_date: weekEnd } as Parameters<typeof calendarLeaves>[0])
        ),
        canReadTeamAttendance
            ? safe('team_attendance', () => getTodayAttendanceSummary(ATT_ROSTER_CAP))
            : Promise.resolve(null),
        reviewer
            ? safe('pending_leaves', () =>
                  listLeaves(
                      { status: 'pending', page: 1, limit: PENDING_CAP + 1 } as Parameters<typeof listLeaves>[0],
                      { id: user._id, role: user.role }
                  ).then((r) => r.data)
              )
            : Promise.resolve(null),
    ]);

    return { user, my_today, my_balances, my_pending, whos_out, team_attendance, pending_leaves };
};
