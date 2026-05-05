import { JOB_NAMES, recurringTaskSweepRunKey } from '../constants/jobs.js';
import { runRecurringTaskSweep } from '../services/task-template.service.js';
import { runJob, type JobContext, type RunJobOptions, type RunJobResult } from './runner.js';

/**
 * Phase-4 Step 40 — daily 06:00 IST sweep that instantiates recurring
 * task templates whose schedule fires today.
 *
 * Idempotency:
 *   - **Outer** — `job_runs` unique index on `(name, run_key)` (the
 *     run-key is YYYY-MM-DD). A same-day manual re-run collides.
 *   - **Inner** — each template has its own `recurrence.last_generated_at`
 *     stamp; templates already generated today are skipped even if the
 *     outer dedup is bypassed (e.g. operator manually re-runs the
 *     service entry point in a shell).
 *
 * Failure semantics: a single failing template does NOT abort the
 * sweep — the underlying service catches per-template errors, logs
 * `warn`, and increments `summary.failures`. Operators grep
 * `system.job_run` rows with `metadata.summary.failures > 0` to
 * surface stuck templates.
 */

interface RecurringTaskSweepSummary extends Record<string, unknown> {
    templates_scanned: number;
    tasks_created: number;
    skipped_already_today: number;
    failures: number;
}

export const sweepRecurringTasks = async (now: Date, log: JobContext['log']): Promise<RecurringTaskSweepSummary> => {
    const summary = await runRecurringTaskSweep(now);
    const out: RecurringTaskSweepSummary = {
        templates_scanned: summary.templates_scanned,
        tasks_created: summary.tasks_created,
        skipped_already_today: summary.skipped_already_today,
        failures: summary.failures,
    };
    log.info(out, 'Recurring task sweep finished');
    return out;
};

export const runRecurringTaskSweepJob = (now: Date = new Date(), opts: RunJobOptions = {}): Promise<RunJobResult> => {
    const runKey = recurringTaskSweepRunKey(now);
    return runJob(JOB_NAMES.RECURRING_TASK_SWEEP, runKey, async (ctx) => sweepRecurringTasks(now, ctx.log), opts);
};
