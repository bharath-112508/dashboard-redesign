import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Types } from 'mongoose';

const taskFindMock = vi.hoisted(() => vi.fn());
const userFindMock = vi.hoisted(() => vi.fn());
const notificationFindMock = vi.hoisted(() => vi.fn());
const insertManyMock = vi.hoisted(() => vi.fn());
const getSettingsMock = vi.hoisted(() => vi.fn());
const publishMock = vi.hoisted(() => vi.fn());

vi.mock('../models/task.model.js', () => ({ Task: { find: taskFindMock } }));
vi.mock('../models/user.model.js', () => ({ User: { find: userFindMock } }));
vi.mock('../models/notification.model.js', () => ({
    Notification: { find: notificationFindMock, insertMany: insertManyMock },
}));
vi.mock('../services/settings.service.js', () => ({ getOrInitSettings: getSettingsMock }));
vi.mock('../services/realtime.service.js', () => ({ publish: publishMock }));
vi.mock('../utils/logger.js', () => ({
    default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
// Run the handler directly so the test targets the job's logic, not the
// job_runs locking already covered by runner.test.ts.
vi.mock('./runner.js', () => ({
    runJob: async (_name: string, _key: string, handler: (ctx: unknown) => Promise<unknown>) => ({
        status: 'completed',
        summary: await handler({ log: vi.fn() }),
    }),
}));

const { runTaskDueReminder } = await import('./task-due-reminder.job.js');

const assignee = new Types.ObjectId();
const overdueTask = { _id: new Types.ObjectId(), title: 'Ship it', due_date: '2026-07-01', assignee_ids: [assignee] };
const dueSoonTask = { _id: new Types.ObjectId(), title: 'Review PR', due_date: '2026-07-31', assignee_ids: [assignee] };

const chain = <T>(value: T) => {
    const c: Record<string, unknown> = { select: vi.fn(), lean: vi.fn().mockResolvedValue(value) };
    (c.select as ReturnType<typeof vi.fn>).mockReturnValue(c);
    return c;
};

// 2026-07-30 06:00 IST → hour 6.
const AT_6AM_IST = new Date('2026-07-30T00:30:00.000Z');
const AT_7AM_IST = new Date('2026-07-30T01:30:00.000Z');

beforeEach(() => {
    vi.clearAllMocks();
    getSettingsMock.mockResolvedValue({ reminders: { task_due_reminder_run_interval_hours: 6 } });
    taskFindMock.mockReturnValue(chain([overdueTask, dueSoonTask]));
    userFindMock.mockReturnValue(chain([{ _id: assignee }]));
    notificationFindMock.mockReturnValue(chain([]));
    insertManyMock.mockResolvedValue([]);
});

describe('runTaskDueReminder', () => {
    // Cron ticks hourly; the admin setting decides which ticks do work, so
    // changing the interval takes effect without a scheduler restart.
    it('no-ops on an hour that does not match the configured interval', async () => {
        const res = await runTaskDueReminder(AT_7AM_IST);
        expect((res.summary as Record<string, unknown>).skipped_reason).toBe('not_scheduled_this_hour');
        expect(insertManyMock).not.toHaveBeenCalled();
    });

    it('splits overdue from due-soon and notifies the assignees', async () => {
        const res = await runTaskDueReminder(AT_6AM_IST);
        const summary = res.summary as Record<string, unknown>;
        expect(summary.overdue_tasks).toBe(1);
        expect(summary.due_soon_tasks).toBe(1);
        expect(summary.notified).toBe(2);

        const rows = insertManyMock.mock.calls[0][0] as Record<string, unknown>[];
        expect(rows.map((r) => r.type).sort()).toEqual(['task_due_soon', 'task_overdue']);
        expect(rows.every((r) => String(r.user_id) === String(assignee))).toBe(true);
    });

    it('never chases a done task', async () => {
        await runTaskDueReminder(AT_6AM_IST);
        expect(taskFindMock.mock.calls[0][0].status).toEqual({ $ne: 'done' });
    });

    // Without this an hourly interval would re-ping every assignee every hour
    // for as long as a task stayed overdue.
    it('suppresses a reminder already sent for that task+kind today', async () => {
        notificationFindMock.mockReturnValue(
            chain([
                { user_id: assignee, type: 'task_overdue', related_entity: { id: overdueTask._id } },
                { user_id: assignee, type: 'task_due_soon', related_entity: { id: dueSoonTask._id } },
            ])
        );
        const res = await runTaskDueReminder(AT_6AM_IST);
        expect((res.summary as Record<string, unknown>).notified).toBe(0);
        expect((res.summary as Record<string, unknown>).suppressed_already_sent).toBe(2);
        expect(insertManyMock).not.toHaveBeenCalled();
    });

    it('skips a deactivated assignee', async () => {
        userFindMock.mockReturnValue(chain([]));
        const res = await runTaskDueReminder(AT_6AM_IST);
        expect((res.summary as Record<string, unknown>).notified).toBe(0);
    });

    // Cron writes have no HTTP request for the realtime-emit middleware, so
    // the bell would not move until the fallback poll.
    it('publishes the notifications topic so open bells refresh', async () => {
        await runTaskDueReminder(AT_6AM_IST);
        expect(publishMock).toHaveBeenCalledWith(['notifications']);
    });
});
