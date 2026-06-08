import cron, { type ScheduledTask } from 'node-cron';

import {
    JOB_CONSECUTIVE_FAILURE_THRESHOLD,
    JOB_NAMES,
    JOB_SCHEDULER_DRAIN_TIMEOUT_MS,
    JOB_SCHEDULES,
    JOB_TIMEZONE,
    type JobName,
} from '../constants/jobs.js';
import { JOBS_ENABLED } from '../config/server.config.js';
import logger from '../utils/logger.js';
import { getInFlightRunJobs } from './runner.js';
import { runAttendanceFinalizer } from './attendance-finalizer.job.js';
// M15 — `runSlMonthlyForfeiture` import + cron registration removed
// (job was structurally dead). See `constants/jobs.ts` JOB_NAMES note.
import { runLeaveYearRollover } from './leave-year-rollover.job.js';
import { runTokenCleanup } from './token-cleanup.job.js';
import { runTimesheetReminder } from './timesheet-reminder.job.js';
import { runReportExportCleanup } from './report-export-cleanup.job.js';
import { runAuditArchive } from './audit-archive.job.js';
import { runRecurringTaskSweepJob } from './recurring-task.job.js';
import { runReportSubscriptionSweepJob } from './report-subscription.job.js';
import { runStuckJobSweeperJob } from './stuck-job-sweeper.job.js';
import { runAuditLogMirror } from './audit-log-mirror.job.js';

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

/**
 * L4 — consecutive-failure tracker. Each entry counts how many cron
 * ticks for that job have thrown contract-violation errors back to
 * us in a row. Reset on the first non-throwing tick. When the
 * counter crosses `JOB_CONSECUTIVE_FAILURE_THRESHOLD` we log a
 * CRITICAL line distinct from the per-tick `error` so the operator
 * gets a single "this job has been failing for ~3 hours" signal
 * instead of N×repeat errors blending into the rest of the log.
 *
 * In-process only — a process restart resets the counter. That's
 * fine: a process restart usually means the operator already saw
 * the issue, and the next failure cycle re-counts from zero.
 */
const consecutiveFailures = new Map<JobName, number>();

type JobRunner = () => Promise<unknown>;

const REGISTRY: Record<JobName, JobRunner> = {
    [JOB_NAMES.ATTENDANCE_FINALIZER]: () => runAttendanceFinalizer(),
    [JOB_NAMES.LEAVE_YEAR_ROLLOVER]: () => runLeaveYearRollover(),
    [JOB_NAMES.TOKEN_CLEANUP]: () => runTokenCleanup(),
    [JOB_NAMES.TIMESHEET_REMINDER]: () => runTimesheetReminder(),
    [JOB_NAMES.REPORT_EXPORT_CLEANUP]: () => runReportExportCleanup(),
    [JOB_NAMES.AUDIT_ARCHIVE]: () => runAuditArchive(),
    [JOB_NAMES.RECURRING_TASK_SWEEP]: () => runRecurringTaskSweepJob(),
    [JOB_NAMES.REPORT_SUBSCRIPTION_SWEEP]: () => runReportSubscriptionSweepJob(),
    [JOB_NAMES.STUCK_JOB_SWEEPER]: () => runStuckJobSweeperJob(),
    [JOB_NAMES.AUDIT_LOG_MIRROR]: () => runAuditLogMirror(),
};

export const startScheduler = (): void => {
    if (!JOBS_ENABLED) {
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
                    runner()
                        .then(() => {
                            // L4 — successful tick resets the streak.
                            consecutiveFailures.delete(name);
                        })
                        .catch((err: unknown) => {
                            // L4 — increment per job; emit CRITICAL on
                            // crossing the threshold so the operator
                            // sees a single high-signal line instead
                            // of N×repeat error logs.
                            const next = (consecutiveFailures.get(name) ?? 0) + 1;
                            consecutiveFailures.set(name, next);
                            try {
                                logger.error(
                                    { err, job: name, consecutive_failures: next },
                                    'Cron tick threw — runner contract violated'
                                );
                                if (next === JOB_CONSECUTIVE_FAILURE_THRESHOLD) {
                                    logger.fatal(
                                        {
                                            job: name,
                                            consecutive_failures: next,
                                            threshold: JOB_CONSECUTIVE_FAILURE_THRESHOLD,
                                        },
                                        'Cron job has crossed the consecutive-failure threshold — investigate'
                                    );
                                }
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

export const stopScheduler = async (): Promise<void> => {
    // 1. Stop all timers so no NEW handler invocations start.
    for (const [name, task] of tasks.entries()) {
        try {
            task.stop();
            logger.info({ job: name }, 'Scheduled job stopped');
        } catch (err) {
            logger.warn({ err, job: name }, 'Error stopping scheduled job');
        }
    }
    tasks.clear();

    // 2. F5 — drain in-flight runJob handlers. node-cron's `.stop()`
    //    only cancels future fires; a handler currently mid-execute
    //    keeps running. Without this, a SIGTERM during the
    //    `audit_log_mirror` upload or the `sl_monthly_forfeiture`
    //    user-iteration would truncate the write. We await the
    //    OUTER promise (the one runJob returned) so the runner's
    //    DB-update + audit-emit lifecycle gets to complete.
    const running = getInFlightRunJobs();
    if (running.length === 0) return;

    logger.info({ count: running.length }, 'Awaiting in-flight cron handlers to drain');
    let timer: NodeJS.Timeout | null = null;
    const drainTimeout = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), JOB_SCHEDULER_DRAIN_TIMEOUT_MS);
    });
    const settledOrTimedOut = await Promise.race([
        Promise.allSettled(running).then(() => 'settled' as const),
        drainTimeout,
    ]);
    if (timer) clearTimeout(timer);

    if (settledOrTimedOut === 'timeout') {
        logger.warn(
            { count: running.length, timeout_ms: JOB_SCHEDULER_DRAIN_TIMEOUT_MS },
            'Scheduler drain timed out; outer shutdown watchdog will force-exit'
        );
    } else {
        logger.info('All in-flight cron handlers drained');
    }
};

/** Number of currently-registered scheduled tasks (for tests / `/health`). */
export const getScheduledJobCount = (): number => tasks.size;
