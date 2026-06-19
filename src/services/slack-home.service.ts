import { Types } from 'mongoose';

import { getMyToday, getTodayAttendanceSummary, type TodayAttendanceSummary } from './attendance.service.js';
import { listOwnBalances } from './leave-balance.service.js';
import { listLeaves, calendarLeaves } from './leave-request.service.js';
import { resolvePermissionsForUser } from './role.service.js';
import { getSlackAvatarUrlsByIds } from './user.service.js';
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
    /** True total pending count (the fetched list is capped at PENDING_CAP+1
     *  for overflow detection, so the builder uses this for the header + "+N more"). */
    pending_total: number | null;
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

/** Extract a row's user id from either `user_id` or `user.id`. */
const rowUserId = (row: Record<string, unknown>): string | null => {
    const direct = (row as { user_id?: unknown }).user_id;
    if (typeof direct === 'string') return direct;
    const nested = (row as { user?: { id?: unknown } }).user?.id;
    return typeof nested === 'string' ? nested : null;
};

/** Mutate the given row lists, attaching `avatar_url` from the cached map. */
const attachAvatars = async (rowLists: Array<Record<string, unknown>[] | null>): Promise<void> => {
    const allIds = new Set<string>();
    for (const rows of rowLists)
        for (const r of rows ?? []) {
            const id = rowUserId(r);
            if (id) allIds.add(id);
        }
    if (allIds.size === 0) return;
    const validIds = [...allIds].filter((id) => Types.ObjectId.isValid(id)).map((id) => new Types.ObjectId(id));
    const byId = await getSlackAvatarUrlsByIds(validIds);
    for (const rows of rowLists)
        for (const r of rows ?? []) {
            const id = rowUserId(r);
            if (id) (r as Record<string, unknown>).avatar_url = byId.get(id) ?? null;
        }
};

export const buildHomeDashboardData = async (user: DashboardUser): Promise<HomeDashboardData> => {
    const today = dayjs().tz(DEFAULT_TIMEZONE).format(DATE_FORMAT);
    const weekEnd = dayjs().tz(DEFAULT_TIMEZONE).add(7, 'day').format(DATE_FORMAT);
    const reviewer = isReviewer(user.role);

    const perms = (await safe('perms', () => resolvePermissionsForUser(user._id)))?.permissions ?? [];
    const canReadTeamAttendance = callerCan(perms, PERMISSIONS.ATTENDANCE_READ_TEAM);

    const [my_today, my_balances, my_pending, whos_out, team_attendance, pending_result] = await Promise.all([
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
                      // Exclude the reviewer's own request — they can't approve
                      // their own leave, so it must not appear in their queue
                      // (it still shows under "Your leaves" as pending).
                      {
                          status: 'pending',
                          exclude_user_id: user._id.toString(),
                          page: 1,
                          limit: PENDING_CAP + 1,
                      } as Parameters<typeof listLeaves>[0],
                      { id: user._id, role: user.role }
                  )
              )
            : Promise.resolve(null),
    ]);

    // The pending fetch is capped at PENDING_CAP+1 for overflow detection; keep
    // the capped rows for rendering but surface the true total from `meta` so
    // the header count and "+N more" reflect the real backlog, not the cap.
    const pending_leaves = (pending_result?.data ?? null) as Record<string, unknown>[] | null;
    const pending_total =
        (pending_result?.meta as { total?: number } | undefined)?.total ?? pending_leaves?.length ?? null;

    await safe('avatars', () => attachAvatars([whos_out, pending_leaves]));

    return {
        user,
        my_today,
        my_balances,
        my_pending,
        whos_out,
        team_attendance,
        pending_leaves,
        pending_total,
    };
};
