import { Types } from 'mongoose';

import { NOTIFICATION_TYPES, RELATED_ENTITY_KINDS } from '../constants/notification.js';
import { JOB_NAMES, taskDueReminderRunKey } from '../constants/jobs.js';
import { Notification } from '../models/notification.model.js';
import { Task } from '../models/task.model.js';
import { User } from '../models/user.model.js';
import { USER_STATUSES } from '../constants/user-statuses.js';
import { DEFAULT_TASK_STATUSES } from '../constants/task.js';
import { getOrInitSettings } from '../services/settings.service.js';
import { publish } from '../services/realtime.service.js';
import { REALTIME_TOPICS } from '../constants/realtime.js';
import { runJob, type JobContext, type RunJobOptions, type RunJobResult } from './runner.js';
import dayjs, { DATE_FORMAT, DEFAULT_TIMEZONE } from '../utils/date.js';
import logger from '../utils/logger.js';

/**
 * Task due-soon / overdue reminders.
 *
 * `NOTIFICATION_TYPES.TASK_DUE_SOON` and `TASK_OVERDUE` were declared from the
 * start, and `reminders.task_due_reminder_run_interval_hours` has been an
 * admin-editable setting — but nothing ever dispatched them, so a task could
 * pass its due date without anyone being told.
 *
 * Cron ticks hourly; the configured interval decides which of those ticks do
 * real work (interval 6 → hours 0, 6, 12, 18 IST). Driving cadence from the
 * setting rather than the crontab means changing it in the admin UI takes
 * effect without restarting the scheduler.
 *
 * Recipients are the task's assignees — the people who have to act. Not the
 * creator, not the project's managers: a nag aimed at someone who can't move
 * the task is noise, and this fires repeatedly by design.
 *
 * Re-notify guard: one reminder per (task, kind) per calendar day. Without it
 * an hourly interval would re-ping every assignee every hour on an overdue
 * task until they closed it.
 */

const DUE_SOON_WINDOW_DAYS = 2;

interface TaskDueReminderSummary extends Record<string, unknown> {
    interval_hours: number;
    /** Set when the tick fell outside the configured interval. */
    skipped_reason?: 'not_scheduled_this_hour';
    due_soon_tasks: number;
    overdue_tasks: number;
    notified: number;
    suppressed_already_sent: number;
}

/** Notifications already sent for this task+kind today, keyed `taskId:type`. */
const alreadySentToday = async (taskIds: Types.ObjectId[], since: Date): Promise<Set<string>> => {
    if (taskIds.length === 0) return new Set();
    const rows = await Notification.find({
        type: { $in: [NOTIFICATION_TYPES.TASK_DUE_SOON, NOTIFICATION_TYPES.TASK_OVERDUE] },
        'related_entity.id': { $in: taskIds },
        created_at: { $gte: since },
    })
        .select('user_id type related_entity')
        .lean<{ user_id: Types.ObjectId; type: string; related_entity?: { id?: Types.ObjectId } }[]>();
    return new Set(rows.map((r) => `${String(r.related_entity?.id)}:${r.type}:${String(r.user_id)}`));
};

export const runTaskDueReminder = (now: Date = new Date(), opts: RunJobOptions = {}): Promise<RunJobResult> =>
    runJob(
        JOB_NAMES.TASK_DUE_REMINDER,
        taskDueReminderRunKey(now),
        async (_ctx: JobContext): Promise<TaskDueReminderSummary> => {
            const settings = await getOrInitSettings();
            const intervalHours = settings.reminders?.task_due_reminder_run_interval_hours ?? 1;

            const hourIst = Number(dayjs(now).tz(DEFAULT_TIMEZONE).format('H'));
            if (hourIst % intervalHours !== 0) {
                return {
                    interval_hours: intervalHours,
                    skipped_reason: 'not_scheduled_this_hour',
                    due_soon_tasks: 0,
                    overdue_tasks: 0,
                    notified: 0,
                    suppressed_already_sent: 0,
                };
            }

            const todayIst = dayjs(now).tz(DEFAULT_TIMEZONE);
            const today = todayIst.format(DATE_FORMAT);
            const dueSoonCutoff = todayIst.add(DUE_SOON_WINDOW_DAYS, 'day').format(DATE_FORMAT);
            const startOfDay = todayIst.startOf('day').toDate();

            // `due_date` is a YYYY-MM-DD string, so lexicographic compare is
            // chronological. Done tasks are never chased.
            const open = await Task.find({
                status: { $ne: DEFAULT_TASK_STATUSES.DONE },
                due_date: { $lte: dueSoonCutoff },
                assignee_ids: { $exists: true, $ne: [] },
            })
                .select('_id title due_date assignee_ids')
                .lean<{ _id: Types.ObjectId; title: string; due_date: string; assignee_ids: Types.ObjectId[] }[]>();

            const overdue = open.filter((t) => t.due_date < today);
            const dueSoon = open.filter((t) => t.due_date >= today);

            const sent = await alreadySentToday(
                open.map((t) => t._id),
                startOfDay
            );

            // One lookup for every assignee across all tasks.
            const assigneeIds = [...new Set(open.flatMap((t) => t.assignee_ids.map(String)))];
            const activeAssignees = new Set(
                (
                    await User.find({
                        _id: { $in: assigneeIds.map((id) => new Types.ObjectId(id)) },
                        status: USER_STATUSES.ACTIVE,
                    })
                        .select('_id')
                        .lean<{ _id: Types.ObjectId }[]>()
                ).map((u) => String(u._id))
            );

            let notified = 0;
            let suppressed = 0;
            const rows: Record<string, unknown>[] = [];

            for (const [bucket, type] of [
                [overdue, NOTIFICATION_TYPES.TASK_OVERDUE],
                [dueSoon, NOTIFICATION_TYPES.TASK_DUE_SOON],
            ] as const) {
                for (const task of bucket) {
                    for (const assignee of task.assignee_ids) {
                        if (!activeAssignees.has(String(assignee))) continue;
                        if (sent.has(`${String(task._id)}:${type}:${String(assignee)}`)) {
                            suppressed += 1;
                            continue;
                        }
                        rows.push({
                            user_id: assignee,
                            type,
                            title:
                                type === NOTIFICATION_TYPES.TASK_OVERDUE
                                    ? `Overdue: ${task.title}`
                                    : `Due soon: ${task.title}`,
                            body:
                                type === NOTIFICATION_TYPES.TASK_OVERDUE
                                    ? `This task was due ${task.due_date} and isn't done yet.`
                                    : `This task is due ${task.due_date}.`,
                            link_url: `/tasks/${String(task._id)}`,
                            related_entity: { kind: RELATED_ENTITY_KINDS.TASK, id: task._id },
                            is_read: false,
                            read_at: null,
                        });
                        notified += 1;
                    }
                }
            }

            if (rows.length > 0) {
                try {
                    await Notification.insertMany(rows, { ordered: false });
                    // Wake every open bell — same reason the dispatcher
                    // publishes: cron writes have no HTTP request for the
                    // realtime-emit middleware to derive a topic from.
                    publish([REALTIME_TOPICS.NOTIFICATIONS]);
                } catch (err) {
                    logger.warn(
                        { err, code: 'TASK_DUE_REMINDER_WRITE_FAILED' },
                        'Some task due reminders failed to write'
                    );
                }
            }

            return {
                interval_hours: intervalHours,
                due_soon_tasks: dueSoon.length,
                overdue_tasks: overdue.length,
                notified,
                suppressed_already_sent: suppressed,
            };
        },
        opts
    );
