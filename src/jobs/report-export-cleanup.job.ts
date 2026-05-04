import { JOB_NAMES, reportExportCleanupRunKey } from '../constants/jobs.js';
import { cleanupExpiredExports } from '../services/report-export.service.js';
import { runJob, type JobContext, type RunJobOptions, type RunJobResult } from './runner.js';

/**
 * Step 30 — daily 03:00 IST sweep that deletes `report_exports` rows past
 * their `expires_at` (default 7 days from creation) and best-effort wipes
 * the underlying blob.
 *
 * Idempotency: keyed on YYYY-MM-DD, so a same-day manual re-run collides
 * on the `job_runs` unique index. The underlying delete is naturally
 * idempotent — a second pass finds the rows already deleted by the first.
 *
 * Why not a Mongo TTL index?
 *  - Mongo's TTL fires `expireAfterSeconds` deletes WITHOUT a hook into
 *    the application, so the row would be GC'd while the blob in Azure
 *    is still around — orphaned bytes. The cron lets us delete the blob
 *    first, then the row, in the right order.
 */

interface ReportExportCleanupSummary extends Record<string, unknown> {
    rows_deleted: number;
    blobs_deleted: number;
}

export const cleanupReportExports = async (now: Date, log: JobContext['log']): Promise<ReportExportCleanupSummary> => {
    const summary = await cleanupExpiredExports(now);
    const out: ReportExportCleanupSummary = {
        rows_deleted: summary.rows_deleted,
        blobs_deleted: summary.blobs_deleted,
    };
    log.info(out, 'Report-export cleanup finished');
    return out;
};

export const runReportExportCleanup = (now: Date = new Date(), opts: RunJobOptions = {}): Promise<RunJobResult> => {
    const runKey = reportExportCleanupRunKey(now);
    return runJob(JOB_NAMES.REPORT_EXPORT_CLEANUP, runKey, async (ctx) => cleanupReportExports(now, ctx.log), opts);
};
