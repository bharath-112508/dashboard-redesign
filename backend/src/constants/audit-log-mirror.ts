/**
 * Audit-log offsite mirror constants (BACKEND_AUDIT.md P1-7).
 *
 * Purpose: defence-in-depth against "compromised Mongo rewrites
 * recent audit history". The Phase-4 audit-archive (Step 39) already
 * covers rows older than 90 days — but rows in the rolling 0-90 day
 * window live exclusively in Mongo until that sweep runs. A
 * compromised admin with Mongo shell access could mutate them with
 * no external trace.
 *
 * Design: an hourly cron streams every NEW `audit_logs` row written
 * since the last successful run to a separate WORM Blob container.
 * Each batch is hashed, the hash is chained to the previous batch
 * (so a missing or out-of-order batch is detectable), and a watermark
 * row tracks "highest exported `created_at`" so the next run picks up
 * where this one left off.
 *
 * Storage policy: the `audit-log-mirrors` container MUST be configured
 * with Azure immutability (time-based retention OR legal hold) at
 * provisioning time. This module uploads bytes; it does NOT configure
 * the container's retention policy. The hash chain is the
 * complementary defence in case that policy is ever loosened.
 *
 * Relationship to the daily archive:
 *  - Mirror = real-time-ish copy. Hourly. Short retention (e.g. 90
 *    days), then rolled off.
 *  - Archive = cold offload. Daily. Long retention (e.g. 7 years).
 *  - Both write to immutable storage; together they cover the full
 *    "since the row was written" window.
 */

// ─── Cadence / batch limits ────────────────────────────────────────────

/**
 * Maximum number of rows pulled into a single hourly batch. A typical
 * hour holds well under 1k rows; the cap protects against a backlog
 * (e.g. cron disabled for a day) that would otherwise spike memory.
 * 5000 rows = ~10 MB JSONL at the upper end of typical row size; well
 * under any practical Blob chunk limit.
 */
export const AUDIT_LOG_MIRROR_MAX_ROWS_PER_RUN = 5000;

// ─── Storage layout ────────────────────────────────────────────────────

export const AUDIT_LOG_MIRROR_BLOB_CONTAINER = 'audit-log-mirrors';
export const AUDIT_LOG_MIRROR_BLOB_KEY_PREFIX = 'mirrors/';

/**
 * Build the storage key for a single batch. The key is stamped with
 * the batch's run timestamp so a storage-explorer view shows the
 * batches chronologically.
 *
 * Format: `mirrors/2026/05/05/2026-05-05T14:00:00.000Z.jsonl.gz`.
 * The date-tree prefix keeps the container's flat view paginatable.
 */
export const buildAuditLogMirrorBlobKey = (batchAt: Date): string => {
    const iso = batchAt.toISOString();
    const yyyy = iso.slice(0, 4);
    const mm = iso.slice(5, 7);
    const dd = iso.slice(8, 10);
    return `${AUDIT_LOG_MIRROR_BLOB_KEY_PREFIX}${yyyy}/${mm}/${dd}/${iso}.jsonl.gz`;
};

export const AUDIT_LOG_MIRROR_CONTENT_TYPE = 'application/gzip';
