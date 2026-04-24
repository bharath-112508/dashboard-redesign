import cron, { type ScheduledTask } from 'node-cron';

import { JOB_NAMES, JOB_SCHEDULES, JOB_TIMEZONE, type JobName } from '../constants/jobs.js';
import logger from '../utils/logger.js';
import { runAttendanceFinalizer } from './attendance-finalizer.job.js';
import { runSlMonthlyForfeiture } from './sl-monthly-forfeiture.job.js';
import { runLeaveYearRollover } from './leave-year-rollover.job.js';
import { runTokenCleanup } from './token-cleanup.job.js';

/**
 * Job scheduler — wires every Phase-1 cron job to its `node-cron` trigger.
 *
 * Boot path: `src/index.ts` calls `startScheduler()` after the HTTP server
 * is listening. Tests (and integration runs) pass `JOBS_ENABLED=false` in
 * the env to skip this entirely so vitest doesn't fire real schedules
 * against the test DB.
 *
 * Each registered job:
 *  - Schedules in `JOB_TIMEZONE` (IST) so the cron expression "23:00" means
 *    23:00 IST regardless of the host timezone.
 *  - Wraps the runner call in a try/catch — even though the runner itself
 *    never throws on job error, this is one extra belt against a startup
 *    bug in the wrapper. Cron must never crash the host.
 *
 * Graceful shutdown: `stopScheduler()` walks the registry and calls
 * `task.stop()` on each `ScheduledTask`. Wired into the SIGTERM/SIGINT
 * shutdown sequence in `src/index.ts`.
 */

const tasks = new Map<JobName, ScheduledTask>();

type JobRunner = () => Promise<unknown>;

const REGISTRY: Record<JobName, JobRunner> = {
    [JOB_NAMES.ATTENDANCE_FINALIZER]: () => runAttendanceFinalizer(),
    [JOB_NAMES.SL_MONTHLY_FORFEITURE]: () => runSlMonthlyForfeiture(),
    [JOB_NAMES.LEAVE_YEAR_ROLLOVER]: () => runLeaveYearRollover(),
    [JOB_NAMES.TOKEN_CLEANUP]: () => runTokenCleanup(),
};

const isJobsDisabled = (): boolean => {
    const v = (process.env.JOBS_ENABLED ?? 'true').toLowerCase();
    return v === 'false' || v === '0' || v === 'no';
};

export const startScheduler = (): void => {
    if (isJobsDisabled()) {
        logger.info('Job scheduler disabled via JOBS_ENABLED=false');
        return;
    }

    if (tasks.size > 0) {
        logger.warn({ count: tasks.size }, 'Job scheduler already started — ignoring duplicate startScheduler() call');
        return;
    }

    for (const [name, runner] of Object.entries(REGISTRY) as [JobName, JobRunner][]) {
        const expression = JOB_SCHEDULES[name];
        try {
            const task = cron.schedule(
                expression,
                () => {
                    runner().catch((err: unknown) => {
                        try {
                            logger.error({ err, job: name }, 'Cron tick threw — runner contract violated');
                        } catch {
                            // swallow — never propagate from the cron tick.
                        }
                    });
                },
                {
                    timezone: JOB_TIMEZONE,
                }
            );
            tasks.set(name, task);
            logger.info({ job: name, cron: expression, tz: JOB_TIMEZONE }, 'Scheduled job registered');
        } catch (err) {
            logger.error({ err, job: name, cron: expression }, 'Failed to register scheduled job');
        }
    }
};

export const stopScheduler = (): void => {
    for (const [name, task] of tasks.entries()) {
        try {
            task.stop();
            logger.info({ job: name }, 'Scheduled job stopped');
        } catch (err) {
            logger.warn({ err, job: name }, 'Error stopping scheduled job');
        }
    }
    tasks.clear();
};

/** Number of currently-registered scheduled tasks (for tests / `/health`). */
export const getScheduledJobCount = (): number => tasks.size;
