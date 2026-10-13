/**
 * Audit-archive constants (Phase 4 Step 39 — tamper-proof audit-log
 * archival to Blob).
 *
 * The Phase-3 OWASP A08 doc (`docs/step-33-hardening-pass.md`) flags
 * audit-log immutability as enforced via app convention only — no
 * service exports `update`/`delete` against `audit_logs`, but a
 * compromised admin with Mongo shell access could still mutate. This
 * step closes that gap by streaming old rows to **immutable Blob
 * storage** with a SHA-256 hash chain that's verifiable independently
 * of Mongo's row state.
 *
 * Lifecycle of an audit row:
 *   1. Written to `audit_logs` by `audit.service.recordAudit` (Step 12).
 *   2. Read by admins via `GET /audit-logs` (Step 31) for the recent
 *      window (default: 90 days).
 *   3. Picked up by the daily archive cron once the row is older than
 *      `AUDIT_ARCHIVE_AFTER_DAYS`. The cron streams that day's rows
 *      into a single gzipped JSONL file, uploads to Blob, writes the
 *      `audit_archives` chain row, and deletes the rows from Mongo.
 *   4. Archived files are downloadable via `GET /audit-archives/:id`
 *      (admin-only); their integrity is re-verifiable on demand via
 *      `GET /audit-archives/:id/verify`.
 */

// Step 47: route gate is `requirePermission(audit_archive.read)` —
// admin-only. Even managers don't see the archive list; the surface is
// forensic.

// ─── Retention threshold ────────────────────────────────────────────────
//
// Rows in `audit_logs` older than this go to Blob and are deleted from
// Mongo. 90 days keeps the live collection small (fast `GET /audit-logs`
// pagination) while leaving recent forensic context in-line. Compile-time
// for v1; hot-wiring to a `system_settings.security.audit_archive_after_days`
// field is a Phase-4 follow-up (the same architectural concern as the
// Step-33 password-policy hot-wire — Zod schemas are sync, but here
// the consumer is a cron job that's already async, so the lift is
// smaller than for password policy).

export const AUDIT_ARCHIVE_AFTER_DAYS = 90;

// ─── Catch-up cap ───────────────────────────────────────────────────────
//
// If the cron has been disabled for a backlog of N days, a single tick
// only processes this many days of archives. Stops a years-long backlog
// from exhausting one cron tick. With `audit_logs` averaging ~150-1000
// rows/day, 30 days = at most ~30 archives/run, each < 1 MB on disk.

export const AUDIT_ARCHIVE_MAX_DAYS_PER_RUN = 30;

// ─── Storage layout ─────────────────────────────────────────────────────
//
// Container is shared across all archive files; the blob key carries
// the date so a storage-explorer view shows them chronologically.
//
// Operator note: the Azure-side **immutable storage policy**
// (time-based retention OR legal hold) MUST be configured on the
// container at provisioning time — this code uploads bytes; it does
// not configure the container's retention policy. The hash chain
// below is defence-in-depth in case that policy is ever loosened.

export const AUDIT_ARCHIVE_BLOB_CONTAINER = 'audit-archives';
export const AUDIT_ARCHIVE_BLOB_KEY_PREFIX = 'archives/';

/** Pure: build the storage key for a given archive date. */
export const buildAuditArchiveBlobKey = (isoDate: string): string =>
    `${AUDIT_ARCHIVE_BLOB_KEY_PREFIX}${isoDate}.jsonl.gz`;

/** Pure: human-readable filename surfaced as `Content-Disposition: attachment`. */
export const buildAuditArchiveFileName = (isoDate: string): string => `audit-${isoDate}.jsonl.gz`;

// ─── Download SAS TTL ───────────────────────────────────────────────────
//
// Short-lived. The admin downloads the file once for forensic review;
// 30 min is comfortably more than a poll-then-click loop.

export const AUDIT_ARCHIVE_DOWNLOAD_SAS_TTL_MINUTES = 30;

// ─── List endpoint pagination ──────────────────────────────────────────

export const AUDIT_ARCHIVE_LIST_DEFAULT_LIMIT = 20;
export const AUDIT_ARCHIVE_LIST_MAX_LIMIT = 100;

// ─── MIME ──────────────────────────────────────────────────────────────

export const AUDIT_ARCHIVE_CONTENT_TYPE = 'application/gzip';
