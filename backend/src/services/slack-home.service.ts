import { Types } from 'mongoose';
import { TIMESHEET_NO_PROJECT_LABEL } from '../constants/timesheet.js';

import { getMyToday, getTodayAttendanceSummary, type TodayAttendanceSummary } from './attendance.service.js';
import { listOwnBalances } from './leave-balance.service.js';
import { listLeaves, calendarLeaves } from './leave-request.service.js';
import { visibleUserIdsForReviewer } from './reporting-scope.service.js';
import { resolvePermissionsForUser } from './role.service.js';
import { listMyDay } from './timesheet.service.js';
import { getSlackAvatarUrlsByIds } from './user.service.js';
import { Project } from '../models/project.model.js';
import { Task } from '../models/task.model.js';
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
    /** Today's logged time. `null` when the lookup failed — the section still
     *  renders its button so Slack never becomes a dead end.
     *
     *  `total_minutes` mirrors `TimesheetEntry.total_minutes`, which INCLUDES
     *  idle time (`billable + non_billable + idle`), so it does not equal
     *  `billable_minutes + non_billable_minutes` on a day with any idle
     *  logged — deliberate: the headline stays "everything logged today",
     *  and idle simply isn't billable or non-billable, so it's not counted
     *  as either in the breakdown. */
    my_time: {
        total_minutes: number;
        billable_minutes: number;
        non_billable_minutes: number;
        /** The day's individual entries, for the Home tab's table. */
        entries: MyTimeEntry[];
    } | null;
    /** Whether the caller holds `timesheet.write`. Clients and Representatives
     *  don't, and must not see a button that would refuse them. */
    can_log_time: boolean;
}

/**
 * One row of the "Your time" table.
 *
 * `work` is the ticket key (`VLJ-142`) for a task-linked entry, the
 * `general_category` for a general one, and falls back to the description so
 * a row is never blank — `general_category` is optional and most people
 * leave it empty.
 */
export interface MyTimeEntry {
    project: string;
    /** Ticket key (`NMF-142`) or the general category. EMPTY when the entry
     *  has neither — the description is `note`, not a fallback for this. */
    work: string;
    /** The entry's description, rendered on its own line. */
    note: string;
    minutes: number;
}

/** Per-list caps (Block Kit 100-block ceiling). */
export const ATT_ROSTER_CAP = 25;
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

/**
 * Turn today's raw timesheet rows into table rows.
 *
 * `listMyDay` returns `toPublic(doc)` — raw ids, no populated project or
 * task — so names cost two extra reads. Both are `$in` lookups over the
 * handful of DISTINCT ids in one person's day (usually one or two projects),
 * not a query per row, and both are already inside the caller's `safe()`
 * wrapper: a failure here degrades this one card, not the Home tab.
 *
 * Rows keep `listMyDay`'s order (`created_at`), so the table reads in the
 * order the day was actually logged.
 */
const buildMyTimeEntries = async (
    rows: Array<{
        total_minutes?: number;
        project_id?: string | null;
        task_id?: string | null;
        general_category?: string | null;
        description?: string | null;
    }>
): Promise<MyTimeEntry[]> => {
    if (rows.length === 0) return [];

    // `listMyDay` returns `toPublic(doc)` = `doc.toJSON()`, and Mongoose's
    // toJSON leaves ObjectId fields as ObjectId INSTANCES — it does not
    // stringify them. An earlier `typeof v === 'string'` guard here therefore
    // rejected every id, so no lookup ever ran and every row rendered "—".
    // Normalise through String() so both shapes work.
    const key = (v: unknown): string | null => {
        if (v === null || v === undefined) return null;
        const str = String(v);
        return Types.ObjectId.isValid(str) ? str : null;
    };

    const projectKeys = [...new Set(rows.map((r) => key(r.project_id)).filter((v): v is string => v !== null))];
    const taskKeys = [...new Set(rows.map((r) => key(r.task_id)).filter((v): v is string => v !== null))];
    const projectIds = projectKeys.map((k) => new Types.ObjectId(k));
    const taskIds = taskKeys.map((k) => new Types.ObjectId(k));

    const [projects, tasks] = await Promise.all([
        projectIds.length
            ? Project.find({ _id: { $in: projectIds } })
                  .select('name code')
                  .lean()
            : [],
        taskIds.length
            ? Task.find({ _id: { $in: taskIds } })
                  .select('task_number project_id')
                  .lean()
            : [],
    ]);

    const projectById = new Map(
        (projects as Array<{ _id: Types.ObjectId; name?: string; code?: string }>).map((p) => [
            String(p._id),
            { name: p.name ?? '', code: p.code ?? '' },
        ])
    );
    const taskById = new Map(
        (tasks as Array<{ _id: Types.ObjectId; task_number?: number; project_id?: Types.ObjectId }>).map((t) => [
            String(t._id),
            t,
        ])
    );

    return rows.map((r) => {
        const pk = key(r.project_id);
        const tk = key(r.task_id);
        const project = pk ? projectById.get(pk) : undefined;
        const task = tk ? taskById.get(tk) : undefined;
        // Ticket key, else the general category, else nothing. The
        // description is NOT a fallback here any more — it has its own line
        // as `note`, and using it for both printed the same text twice.
        const work = task ? `${project?.code ?? ''}-${task.task_number ?? '?'}` : (r.general_category ?? '');
        return {
            project: project?.name ?? TIMESHEET_NO_PROJECT_LABEL,
            work,
            note: r.description ?? '',
            minutes: r.total_minutes ?? 0,
        };
    });
};

export const buildHomeDashboardData = async (user: DashboardUser): Promise<HomeDashboardData> => {
    const today = dayjs().tz(DEFAULT_TIMEZONE).format(DATE_FORMAT);
    const weekEnd = dayjs().tz(DEFAULT_TIMEZONE).add(7, 'day').format(DATE_FORMAT);
    const reviewer = isReviewer(user.role);

    const perms = (await safe('perms', () => resolvePermissionsForUser(user._id)))?.permissions ?? [];
    const canReadTeamAttendance = callerCan(perms, PERMISSIONS.ATTENDANCE_READ_TEAM);
    const canLogTime = callerCan(perms, PERMISSIONS.TIMESHEET_WRITE);

    // Reuses the same query the web "my day" view uses — no new aggregate.
    // Wrapped in `safe()` like every other section: a timesheet failure must
    // degrade this one card, not the whole Home tab. `today` (DATE_FORMAT =
    // YYYY-MM-DD) is the same local-date string `listMyDay` expects.
    const my_time = canLogTime
        ? await safe('my_time', async () => {
              const day = await listMyDay(today, { id: user._id, role: user.role });
              const rows = day.data as Array<{
                  billable_total_minutes?: number;
                  non_billable_total_minutes?: number;
                  total_minutes?: number;
                  project_id?: string | null;
                  task_id?: string | null;
                  general_category?: string | null;
                  description?: string | null;
              }>;
              const billable = rows.reduce((acc, r) => acc + (r.billable_total_minutes ?? 0), 0);
              // Summed off the rows the same way `billable` is, NOT derived as
              // `total - billable` — that subtraction folds idle_total_minutes
              // (part of `total_minutes` but neither billable nor non-billable)
              // into "non-billable", which is wrong.
              const nonBillable = rows.reduce((acc, r) => acc + (r.non_billable_total_minutes ?? 0), 0);
              return {
                  total_minutes: day.meta.total_minutes,
                  billable_minutes: billable,
                  non_billable_minutes: nonBillable,
                  entries: await buildMyTimeEntries(rows),
              };
          })
        : null;
    // Reporting-chain scope for the team-attendance summary — Admin sees the
    // whole workforce; a Manager/Team-Lead sees only their direct reports
    // (matches the /admin/attendance and pending-approvals scoping).
    const attendanceScope = canReadTeamAttendance
        ? await safe('attendance_scope', () => visibleUserIdsForReviewer({ id: user._id, role: user.role }))
        : null;

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
            ? safe('team_attendance', () => getTodayAttendanceSummary(attendanceScope))
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
        my_time,
        can_log_time: canLogTime,
    };
};
