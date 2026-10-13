/**
 * Report-export constants (Step 30 — `/reports/:name/export` +
 * `/reports/exports/:id`; API_Contract §10.3, Build_Decisions §D2/§D3).
 *
 * Exports are async: the user POSTs an export request → the API returns a
 * `report_exports` row id immediately → an in-process worker generates the
 * file → the FE polls the GET endpoint for status → on `ready` the GET
 * mints a fresh download SAS.
 *
 * v1 scope (current state, post-Phase-4 cleanup):
 *  - **CSV / XLSX / PDF all ship.** PDF runs through the pluggable
 *    generator factory in `services/report-exporters/pdf-generators/`
 *    — pdfkit is the default (in-process, no Chromium); pdfmake +
 *    puppeteer are also available, with puppeteer's Chromium binary
 *    treated as opt-in (see `BUILD_PROGRESS.md` Step-30 follow-up).
 *  - **Worker = in-process `setImmediate` after enqueue.** Same
 *    pattern the notification dispatcher uses today. Lifts to a
 *    queue-backed worker if/when the load profile demands it.
 *  - **Storage = Azure Blob.** When unconfigured (the dev default),
 *    the worker marks `failed` with `STORAGE_NOT_CONFIGURED` — same
 *    fail-loud contract that profile-photo + task-attachment surfaces
 *    use.
 */

// Step 47: route gates use `requirePermission(report_export.write)`
// for POST and `requirePermission(report.read)` for status-poll —
// both held by manager + admin.

// ─── Report names that can be exported ──────────────────────────────────
//
// Mirrors the four `/reports/*` GET surfaces. Path-segment matched at the
// route layer; the validator narrows further by name to dispatch the
// per-report filter schema (the four reports take different filter shapes).

export const REPORT_EXPORT_NAMES = ['billing', 'utilization', 'attendance', 'leaves'] as const;
export type ReportExportName = (typeof REPORT_EXPORT_NAMES)[number];

// ─── Export formats ─────────────────────────────────────────────────────
//
// All three formats are fully implemented. PDF goes through the
// pluggable generator factory; selection via `PDF_ENGINE` env var.

export const EXPORT_FORMATS = ['csv', 'xlsx', 'pdf'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

/** MIME + extension for each format. Used by the upload (Content-Type) and the download SAS (Content-Disposition filename). */
export const EXPORT_FORMAT_CONFIG: Record<ExportFormat, { mime: string; extension: string }> = {
    csv: { mime: 'text/csv', extension: 'csv' },
    xlsx: { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', extension: 'xlsx' },
    pdf: { mime: 'application/pdf', extension: 'pdf' },
};

// ─── Job state machine ──────────────────────────────────────────────────
//
//   pending  → worker hasn't picked it up yet (initial state)
//   running  → worker is generating the file
//   ready    → generator + upload succeeded; download SAS available
//   failed   → terminal; `error_message` carries the reason
//
// `cancelled` is intentionally absent in v1 — there's no admin "kill
// running export" surface and the synchronous worker can't be interrupted
// mid-generation. Re-introduce only when a real queue worker lands.

export const EXPORT_STATUSES = {
    PENDING: 'pending',
    RUNNING: 'running',
    READY: 'ready',
    FAILED: 'failed',
} as const;

export type ExportStatus = (typeof EXPORT_STATUSES)[keyof typeof EXPORT_STATUSES];
export const EXPORT_STATUS_VALUES: readonly ExportStatus[] = Object.values(EXPORT_STATUSES);

// ─── Storage layout ─────────────────────────────────────────────────────
//
// Container is shared across formats — the blob key carries the format
// extension so a single `report_exports/<id>.csv` vs `<id>.xlsx` is
// unambiguous in storage explorer + audit forensics.

export const EXPORT_BLOB_CONTAINER = 'report-exports';
export const EXPORT_BLOB_KEY_PREFIX = 'exports/';

/**
 * Build the storage key for a given export row + format. Pure — no DB
 * read — so the worker can derive it without a round-trip.
 */
export const buildExportBlobKey = (exportId: string, format: ExportFormat): string =>
    `${EXPORT_BLOB_KEY_PREFIX}${exportId}.${EXPORT_FORMAT_CONFIG[format].extension}`;

/**
 * Human-readable filename surfaced as `Content-Disposition: attachment;
 * filename="..."` on the download SAS. Avoids exposing the storage key.
 */
export const buildExportFileName = (name: ReportExportName, format: ExportFormat, requestedAt: Date): string => {
    const stamp = requestedAt.toISOString().slice(0, 10); // YYYY-MM-DD
    return `${name}-${stamp}.${EXPORT_FORMAT_CONFIG[format].extension}`;
};

// ─── TTLs / retention ───────────────────────────────────────────────────
//
// Download SAS TTL: short — the FE polls until ready then the user clicks
// once. 30 min is comfortably more than a normal poll-then-click loop.
//
// Row + blob retention: 7 days. The cleanup cron purges expired rows + best-
// effort deletes the blob. Operators can tune by editing this constant; no
// system-settings exposure in v1 to keep the surface small.

export const EXPORT_DOWNLOAD_SAS_TTL_MINUTES = 30;
export const EXPORT_RETENTION_DAYS = 7;

// ─── Worker bounds ──────────────────────────────────────────────────────
//
// Per-job hard cap: 60s wall time. The synchronous in-process worker can
// stall the event loop on a runaway aggregation; this clamp turns "long
// hang" into "marked failed with EXPORT_TIMEOUT". The four current report
// builders all complete in < 1s on realistic data — 60s is a "something
// is very wrong" upper bound, not a normal-case ceiling.

export const EXPORT_WORKER_TIMEOUT_MS = 60_000;
