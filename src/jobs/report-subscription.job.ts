import { JOB_NAMES, reportSubscriptionSweepRunKey } from '../constants/jobs.js';
import { runWeeklyReportSweep } from '../services/report-subscription.service.js';
import { runJob, type JobContext, type RunJobOptions, type RunJobResult } from './runner.js';

/**
 * Phase-4 Step 43 — daily 07:00 IST sweep that delivers report-
 * subscription emails to active subscriptions whose `day_of_week`
 * matches today (IST).
 *
 * Idempotency:
 *   - Outer: `job_runs` unique index on `(name, run_key)` (run-key is
 *     YYYY-MM-DD).
 *   - Inner: per-subscription `last_sent_at` stamp via atomic CAS.
 *
 * Failure isolation: per-subscription send failures (mailer outage,
 * deactivated owner, report builder threw) increment
 * `summary.failures` but do NOT abort the rest of the sweep. Each
 * failure also writes a `report_subscription.send` system audit row
 * with `metadata.delivery: 'failed'` so operators have a forensic
 * trail without scraping the application logs.
 */

interface ReportSubscriptionSweepSummary extends Record<string, unknown> {
    subscriptions_scanned: number;
    emails_sent: number;
    skipped_already_today: number;
    failures: number;
}

export const sweepReportSubscriptions = async (
    now: Date,
    log: JobContext['log']
): Promise<ReportSubscriptionSweepSummary> => {
    const summary = await runWeeklyReportSweep(now);
    const out: ReportSubscriptionSweepSummary = {
        subscriptions_scanned: summary.subscriptions_scanned,
        emails_sent: summary.emails_sent,
        skipped_already_today: summary.skipped_already_today,
        failures: summary.failures,
    };
    log.info(out, 'Report-subscription sweep finished');
    return out;
};

export const runReportSubscriptionSweepJob = (
    now: Date = new Date(),
    opts: RunJobOptions = {}
): Promise<RunJobResult> => {
    const runKey = reportSubscriptionSweepRunKey(now);
    return runJob(
        JOB_NAMES.REPORT_SUBSCRIPTION_SWEEP,
        runKey,
        async (ctx) => sweepReportSubscriptions(now, ctx.log),
        opts
    );
};
