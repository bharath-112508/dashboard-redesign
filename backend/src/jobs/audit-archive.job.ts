import { JOB_NAMES, auditArchiveRunKey } from '../constants/jobs.js';
import { runArchivalSweep } from '../services/audit-archive.service.js';
import { runJob, type JobContext, type RunJobOptions, type RunJobResult } from './runner.js';

/**
 * Phase-4 Step 39 — daily 04:00 IST sweep that archives `audit_logs`
 * rows past `AUDIT_ARCHIVE_AFTER_DAYS` to immutable Blob storage.
 *
 * Idempotency:
 *   - Outer: `auditArchiveRunKey(now)` is YYYY-MM-DD, so a same-day
 *     manual re-run collides on the `job_runs` unique index.
 *   - Inner: `archive_date` has a unique index on `audit_archives`,
 *     so a previously-archived day is detected pre-upload and
 *     short-circuits with `skipped_reason: 'already_archived'`.
 *
 * Catch-up: if the cron has been disabled for a backlog of N days,
 * `runArchivalSweep` processes at most `AUDIT_ARCHIVE_MAX_DAYS_PER_RUN`
 * (30) days of backlog per tick. A backlog of years catches up over
 * a month of nightly runs.
 *
 * Failure semantics: a single failed day inside the sweep does NOT
 * abort the rest — the underlying service logs `warn` and continues
 * to the next date. The `runJob` wrapper records the summary regardless
 * so operators can grep the audit log for `system.job_run` rows with
 * `metadata.summary.days_skipped > 0` to surface backlogged dates.
 */

interface AuditArchiveSummary extends Record<string, unknown> {
    days_archived: number;
    rows_archived: number;
    days_skipped: number;
    bytes_uploaded: number;
}

export const archiveAuditLogs = async (now: Date, log: JobContext['log']): Promise<AuditArchiveSummary> => {
    const summary = await runArchivalSweep(now);
    const out: AuditArchiveSummary = {
        days_archived: summary.days_archived,
        rows_archived: summary.rows_archived,
        days_skipped: summary.days_skipped,
        bytes_uploaded: summary.bytes_uploaded,
    };
    log.info(out, 'Audit-log archival sweep finished');
    return out;
};

export const runAuditArchive = (now: Date = new Date(), opts: RunJobOptions = {}): Promise<RunJobResult> => {
    const runKey = auditArchiveRunKey(now);
    return runJob(JOB_NAMES.AUDIT_ARCHIVE, runKey, async (ctx) => archiveAuditLogs(now, ctx.log), opts);
};
