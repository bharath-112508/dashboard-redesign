import { User, type UserDocument } from '../models/user.model.js';
import { LeaveRequest } from '../models/leave-request.model.js';
import { ROLES } from '../constants/roles.js';
import { USER_STATUSES } from '../constants/user-statuses.js';
import { LEAVE_REQUEST_STATUSES } from '../constants/leave.js';
import { JOB_NAMES, timesheetReminderRunKey } from '../constants/jobs.js';
import { runJob, type JobContext, type RunJobOptions, type RunJobResult } from './runner.js';
import { userIdsWithEntriesOn } from '../services/timesheet.service.js';
import { notifyTimesheetReminder } from '../services/notification-dispatcher.service.js';
import { getOrInitSettings } from '../services/settings.service.js';
import { TIMESHEET_DEFAULT_DAILY_WARN_THRESHOLD_HOURS } from '../constants/timesheet.js';
import dayjs, { DATE_FORMAT, DEFAULT_TIMEZONE } from '../utils/date.js';

/**
 * 14.5 / 23.x Timesheet reminder (Plan §8 row 5; BUILD_PROGRESS Step 23).
 *
 * Fires daily at 20:00 IST. For each active **internal** user (admin /
 * manager / employee — clients don't log time):
 *
 *   1. Skip if the user has an `approved` leave covering today.
 *   2. Skip if the user has already logged at least one entry for today.
 *   3. Otherwise fire `notifyTimesheetReminder` (in-app + email).
 *
 * The "logged at least one entry" check is intentionally loose — we do
 * not enforce "logged the full expected hours". v1's daily expected total
 * comes from `system_settings.timesheet.daily_warn_threshold_hours`, but
 * a strict comparison would nag users mid-shift; the soft prompt is a
 * gentler default. A future setting can opt teams into the strict variant.
 *
 * Idempotency: run-key is today's IST date. A second tick the same day
 * collides on `job_runs` and skips.
 *
 * Failure isolation: each per-user dispatch is awaited but its errors are
 * already swallowed by `notifyTimesheetReminder` (which catches at the
 * dispatcher layer). The job summary records the count of users notified
 * vs. skipped so ops can spot a regression in a single audit row.
 */

interface TimesheetReminderSummary extends Record<string, unknown> {
    target_date: string;
    headcount: number;
    on_leave: number;
    already_logged: number;
    notified: number;
}

const todayIst = (now: Date): string => dayjs(now).tz(DEFAULT_TIMEZONE).format(DATE_FORMAT);

const loadInternalUsers = async (): Promise<UserDocument[]> => {
    return User.find({
        status: USER_STATUSES.ACTIVE,
        role: { $in: [ROLES.ADMIN, ROLES.MANAGER, ROLES.EMPLOYEE] },
    }).select('_id email full_name role slack_user_id slack_notifications_enabled');
};

const loadOnLeaveUserIds = async (localDate: string): Promise<Set<string>> => {
    const rows = await LeaveRequest.find({
        status: LEAVE_REQUEST_STATUSES.APPROVED,
        start_date: { $lte: localDate },
        end_date: { $gte: localDate },
    }).distinct('user_id');
    return new Set(rows.map((id) => String(id)));
};

/** Pure logic — exported for unit tests. */
export const remindUnloggedUsers = async (now: Date, log: JobContext['log']): Promise<TimesheetReminderSummary> => {
    const targetDate = todayIst(now);

    const settings = await getOrInitSettings();
    const expectedHours = Number.isFinite(settings.timesheet.daily_warn_threshold_hours)
        ? settings.timesheet.daily_warn_threshold_hours
        : TIMESHEET_DEFAULT_DAILY_WARN_THRESHOLD_HOURS;

    const [users, onLeaveIds, alreadyLoggedIds] = await Promise.all([
        loadInternalUsers(),
        loadOnLeaveUserIds(targetDate),
        userIdsWithEntriesOn(targetDate),
    ]);

    const summary: TimesheetReminderSummary = {
        target_date: targetDate,
        headcount: users.length,
        on_leave: 0,
        already_logged: 0,
        notified: 0,
    };

    for (const u of users) {
        const idStr = u._id.toString();
        if (onLeaveIds.has(idStr)) {
            summary.on_leave += 1;
            continue;
        }
        if (alreadyLoggedIds.has(idStr)) {
            summary.already_logged += 1;
            continue;
        }
        await notifyTimesheetReminder({
            recipient: {
                _id: u._id,
                email: u.email,
                full_name: u.full_name,
                role: u.role,
                slack_user_id: u.slack_user_id,
                slack_notifications_enabled: u.slack_notifications_enabled,
                push_notifications_enabled: u.push_notifications_enabled,
            },
            local_date: targetDate,
            expected_hours: expectedHours,
        });
        summary.notified += 1;
    }

    log.info(summary, 'Timesheet reminder finished');
    return summary;
};

export const runTimesheetReminder = (now: Date = new Date(), opts: RunJobOptions = {}): Promise<RunJobResult> => {
    const runKey = timesheetReminderRunKey(now);
    return runJob(JOB_NAMES.TIMESHEET_REMINDER, runKey, async (ctx) => remindUnloggedUsers(now, ctx.log), opts);
};
