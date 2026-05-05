import { JOB_NAMES, auditLogMirrorRunKey } from '../constants/jobs.js';
import { mirrorAuditLogs } from '../services/audit-log-mirror.service.js';

import { runJob, type JobContext, type RunJobOptions, type RunJobResult } from './runner.js';

/**
 * Hourly cron — audit-log offsite mirror (BACKEND_AUDIT.md P1-7).
 *
 * Wraps `mirrorAuditLogs` in the shared runner so a same-hour re-run
 * is a no-op via the `job_runs` unique index. Failures are recorded as
 * `failed` with the exception message; the watermark stays at the
 * last successful run's `to_id`, so the next hour catches up the
 * missed window. The mirror service caps each batch at
 * `AUDIT_LOG_MIRROR_MAX_ROWS_PER_RUN` so a multi-hour backlog rolls in
 * over multiple ticks rather than spiking memory.
 */

interface AuditLogMirrorSummary extends Record<string, unknown> {
    rows_mirrored: number;
    file_size_bytes: number;
    blob_key: string | null;
}

const mirrorOnce = async (now: Date, log: JobContext['log']): Promise<AuditLogMirrorSummary> => {
    const result = await mirrorAuditLogs(now);
    const out: AuditLogMirrorSummary = {
        rows_mirrored: result.rows_mirrored,
        file_size_bytes: result.file_size_bytes,
        blob_key: result.blob_key,
    };
    log.info(out, 'Audit-log mirror tick finished');
    return out;
};

export const runAuditLogMirror = (now: Date = new Date(), opts: RunJobOptions = {}): Promise<RunJobResult> => {
    const runKey = auditLogMirrorRunKey(now);
    return runJob(JOB_NAMES.AUDIT_LOG_MIRROR, runKey, async (ctx) => mirrorOnce(now, ctx.log), opts);
};
