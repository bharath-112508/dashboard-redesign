import { Types } from 'mongoose';

import { ReportExport, type ReportExportDocument } from '../models/report-export.model.js';
import {
    EXPORT_BLOB_CONTAINER,
    EXPORT_DOWNLOAD_SAS_TTL_MINUTES,
    EXPORT_FORMAT_CONFIG,
    EXPORT_RETENTION_DAYS,
    EXPORT_STATUSES,
    EXPORT_WORKER_TIMEOUT_MS,
    buildExportBlobKey,
    buildExportFileName,
    type ExportFormat,
    type ReportExportName,
} from '../constants/export.js';
import { AUDIT_ACTIONS, AUDIT_TARGET_KINDS } from '../constants/audit.js';
import { ERROR_CODES } from '../constants/error-codes.js';
import { EXPORT_WORKER_INLINE } from '../config/server.config.js';
import { AppError } from '../utils/app-error.js';
import { deleteBlob, isAzureConfigured, mintDownloadSas, putBlob } from '../utils/azure-blob.js';
import logger from '../utils/logger.js';
import { recordAudit, recordSystemAudit, type AuditContext } from './audit.service.js';
import {
    buildAttendanceReport,
    buildBillingReport,
    buildLeaveReport,
    buildUtilizationReport,
} from './report.service.js';
import {
    toTabularAttendance,
    toTabularBilling,
    toTabularLeaves,
    toTabularUtilization,
    type TabularReport,
} from './report-exporters/tabular.js';
import { generateCsv } from './report-exporters/csv.js';
import { generateXlsx } from './report-exporters/xlsx.js';
import { generatePdf, PdfNotAvailableError } from './report-exporters/pdf.js';
import type {
    AttendanceReportQuery,
    BillingReportQuery,
    LeaveReportQuery,
    UtilizationReportQuery,
} from './../validators/report.validator.js';

/**
 * Report-export service (Step 30; API_Contract §10.3).
 *
 * Lifecycle of an export:
 *  1. `enqueueExport` — caller's row is created with `status=pending` and
 *     `expires_at` set 7 days out. An audit row is written with the
 *     filter snapshot. We schedule the worker on the next tick via
 *     `setImmediate` so the HTTP response can return immediately.
 *  2. `runExport` (worker) — flips `pending → running`, builds the
 *     report via `report.service`, runs the format generator, uploads
 *     the bytes to Azure Blob, then flips `running → ready`. On any
 *     failure → `failed` with a human-readable `error_message` +
 *     canonical `error_code`.
 *  3. `getExport` — owner-scoped read. On `ready` it mints a fresh
 *     download SAS each time (no SAS persistence) so an admin lowering
 *     `EXPORT_DOWNLOAD_SAS_TTL_MINUTES` always tightens going forward.
 *
 * Concurrency: the in-process worker runs each enqueued export
 * sequentially in its own `setImmediate` callback. Two concurrent
 * `enqueueExport` calls produce two independent rows + two worker runs
 * that don't share state. There's no global queue lock; if the host
 * crashes mid-`running` the row stays `running` until the cleanup cron
 * sweeps it past `expires_at` (a v1 trade-off — adding a "pick up
 * orphaned `running > N min`" recovery sweep is straightforward when
 * Step-D2 swaps in a real queue worker).
 */

// ─── Caller shape ───────────────────────────────────────────────────────

export interface ExportCaller {
    id: Types.ObjectId;
    audit?: AuditContext;
}

// ─── Enqueue ────────────────────────────────────────────────────────────

interface EnqueueInput {
    name: ReportExportName;
    format: ExportFormat;
    /** Already-validated, validator-coerced filter object. */
    filters: Record<string, unknown>;
}

/**
 * Public enqueue entry point. Returns the new row id; the worker runs
 * asynchronously after the HTTP response is sent.
 *
 * Test seam: when `process.env.EXPORT_WORKER_INLINE === 'true'` the
 * enqueue **awaits** the worker to completion before returning. This
 * lets unit tests assert end-state without juggling timers AND without
 * racing the test-runner's `vi.resetAllMocks()` between tests. Production
 * code never sets that flag, so `enqueueExport` returns the moment the
 * row is committed, the worker fires on the next tick, and the HTTP
 * response is dispatched without waiting for file generation.
 */
export const enqueueExport = async (
    input: EnqueueInput,
    caller: ExportCaller
): Promise<{ id: string; status: string }> => {
    const expiresAt = new Date(Date.now() + EXPORT_RETENTION_DAYS * 24 * 60 * 60 * 1000);

    const row = await ReportExport.create({
        requested_by_user_id: caller.id,
        report_name: input.name,
        format: input.format,
        filters: input.filters,
        status: EXPORT_STATUSES.PENDING,
        expires_at: expiresAt,
    });

    if (caller.audit) {
        await recordAudit(caller.audit, {
            action: AUDIT_ACTIONS.REPORT_EXPORT_CREATE,
            target: { kind: AUDIT_TARGET_KINDS.REPORT_EXPORT, id: row._id },
            after: { report_name: input.name, format: input.format, status: EXPORT_STATUSES.PENDING },
            metadata: { filters: input.filters },
        });
    }

    await scheduleWorker(row._id);

    return { id: row._id.toString(), status: row.status };
};

const scheduleWorker = async (id: Types.ObjectId): Promise<void> => {
    const inline = EXPORT_WORKER_INLINE;
    // `runExport` is no-throw (it catches everything internally and writes
    // the failure to the row). The `.catch` here is belt-and-suspenders
    // for an unexpected throw from the wrapper itself — never expected in
    // practice but cheap to leave in.
    const fire = (): Promise<void> =>
        runExport(id).catch((err: unknown) => {
            logger.error({ err, export_id: id.toString() }, 'Export worker tick threw');
        });
    if (inline) {
        // Test seam: await the worker so assertions run AFTER the row
        // has reached its terminal state.
        await fire();
    } else {
        setImmediate(() => {
            void fire();
        });
    }
};

// ─── Worker ─────────────────────────────────────────────────────────────

const REPORT_BUILDERS: {
    [K in ReportExportName]: (filters: Record<string, unknown>) => Promise<TabularReport>;
} = {
    billing: async (filters) => toTabularBilling(await buildBillingReport(filters as BillingReportQuery)),
    utilization: async (filters) =>
        toTabularUtilization(await buildUtilizationReport(filters as UtilizationReportQuery)),
    attendance: async (filters) => toTabularAttendance(await buildAttendanceReport(filters as AttendanceReportQuery)),
    leaves: async (filters) => toTabularLeaves(await buildLeaveReport(filters as LeaveReportQuery)),
};

const FORMAT_GENERATORS: Record<ExportFormat, (table: TabularReport) => Promise<Buffer>> = {
    csv: async (table) => generateCsv(table),
    xlsx: (table) => generateXlsx(table),
    pdf: (table) => generatePdf(table),
};

/**
 * Race the underlying work against `EXPORT_WORKER_TIMEOUT_MS`. The
 * synchronous in-process worker can stall the event loop on a runaway
 * aggregation; this clamp turns "long hang" into "marked failed".
 */
const withTimeout = <T>(work: Promise<T>, ms: number): Promise<T> => {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new ExportTimeoutError(`Export exceeded ${ms}ms — aborted`)), ms);
        work.then(
            (v) => {
                clearTimeout(timer);
                resolve(v);
            },
            (err) => {
                clearTimeout(timer);
                reject(err);
            }
        );
    });
};

class ExportTimeoutError extends Error {
    code = 'EXPORT_TIMEOUT';
    constructor(message: string) {
        super(message);
        this.name = 'ExportTimeoutError';
    }
}

/**
 * Worker entrypoint — runs one export job to completion. Exported so
 * the cleanup cron + tests can call it directly. Always resolves; never
 * throws.
 */
export const runExport = async (id: Types.ObjectId): Promise<void> => {
    // Atomic flip pending → running. If someone else (a test calling
    // `runExport` directly + the `setImmediate` tick) flipped first,
    // the second call gets `null` and bails — no double-generate.
    const row = await ReportExport.findOneAndUpdate(
        { _id: id, status: EXPORT_STATUSES.PENDING },
        { $set: { status: EXPORT_STATUSES.RUNNING, started_at: new Date() } },
        { new: true }
    );
    if (!row) return;

    try {
        if (!isAzureConfigured()) {
            throw new StorageNotConfiguredError();
        }

        const blobKey = buildExportBlobKey(row._id.toString(), row.format);
        const fileName = buildExportFileName(row.report_name, row.format, row.created_at);
        const mime = EXPORT_FORMAT_CONFIG[row.format].mime;

        // Wrap the full work — generate AND upload — in the timeout. The
        // upload is bounded by Azure's own SDK timeout in normal operation,
        // but a hung TCP connection past 60s would otherwise leave the row
        // stuck in `running` until the cleanup cron sweeps `expires_at`.
        const buffer = await withTimeout(
            (async () => {
                const buf = await generate(row);
                await putBlob({
                    container: EXPORT_BLOB_CONTAINER,
                    blobKey,
                    body: buf,
                    contentType: mime,
                });
                return buf;
            })(),
            EXPORT_WORKER_TIMEOUT_MS
        );

        await ReportExport.findByIdAndUpdate(row._id, {
            $set: {
                status: EXPORT_STATUSES.READY,
                blob_container: EXPORT_BLOB_CONTAINER,
                blob_key: blobKey,
                file_size_bytes: buffer.length,
                completed_at: new Date(),
            },
        });

        await recordSystemAudit({
            action: AUDIT_ACTIONS.REPORT_EXPORT_COMPLETE,
            target: { kind: AUDIT_TARGET_KINDS.REPORT_EXPORT, id: row._id },
            metadata: {
                report_name: row.report_name,
                format: row.format,
                size_bytes: buffer.length,
                file_name: fileName,
            },
        });

        logger.info(
            {
                export_id: row._id.toString(),
                report: row.report_name,
                format: row.format,
                size_bytes: buffer.length,
            },
            'Report export completed'
        );
    } catch (err) {
        await markFailed(row, err);
    }
};

const generate = async (row: ReportExportDocument): Promise<Buffer> => {
    const builder = REPORT_BUILDERS[row.report_name];
    const generator = FORMAT_GENERATORS[row.format];
    const table = await builder(row.filters as Record<string, unknown>);
    return generator(table);
};

class StorageNotConfiguredError extends Error {
    code = ERROR_CODES.STORAGE_NOT_CONFIGURED;
    constructor() {
        super(
            'Azure Blob storage is not configured — report exports cannot upload. ' +
                'Set AZURE_STORAGE_CONNECTION_STRING (or ACCOUNT_NAME + ACCOUNT_KEY) and retry.'
        );
        this.name = 'StorageNotConfiguredError';
    }
}

/**
 * Centralise the failure-path: write the row + the system audit. Never
 * throws; logs at warn so the operator gets a clear signal even if the
 * audit write itself fails.
 */
const markFailed = async (row: ReportExportDocument, err: unknown): Promise<void> => {
    const message = err instanceof Error ? err.message : 'Unknown export error';
    const code = (err as { code?: string })?.code ?? ERROR_CODES.INTERNAL_ERROR;

    try {
        await ReportExport.findByIdAndUpdate(row._id, {
            $set: {
                status: EXPORT_STATUSES.FAILED,
                error_message: message.slice(0, 1000),
                error_code: code.slice(0, 80),
                completed_at: new Date(),
            },
        });
    } catch (writeErr) {
        logger.error(
            { err: writeErr, export_id: row._id.toString() },
            'Failed to persist export-failure state — row may be stuck in `running`'
        );
    }

    try {
        await recordSystemAudit({
            action: AUDIT_ACTIONS.REPORT_EXPORT_FAIL,
            target: { kind: AUDIT_TARGET_KINDS.REPORT_EXPORT, id: row._id },
            metadata: {
                report_name: row.report_name,
                format: row.format,
                error_code: code,
                error_message: message.slice(0, 200),
            },
        });
    } catch {
        // recordSystemAudit is itself non-throwing; this is paranoia.
    }

    if (err instanceof PdfNotAvailableError) {
        logger.info(
            { export_id: row._id.toString() },
            'PDF export requested before Container Apps + Puppeteer infra is available'
        );
        return;
    }

    logger.warn(
        {
            err,
            export_id: row._id.toString(),
            report: row.report_name,
            format: row.format,
            error_code: code,
        },
        'Report export failed'
    );
};

// ─── Get / status ───────────────────────────────────────────────────────

export interface ExportSnapshot {
    id: string;
    report_name: ReportExportName;
    format: ExportFormat;
    status: string;
    error_message: string | null;
    error_code: string | null;
    file_size_bytes: number | null;
    requested_at: string;
    started_at: string | null;
    completed_at: string | null;
    expires_at: string;
    /** Freshly minted on every `ready` read; `null` for any other status. */
    download_url: string | null;
    /** ISO of the SAS expiry; `null` until ready. */
    download_url_expires_at: string | null;
    /** Filename Azure uses on the download response; surfaced for FE convenience. */
    file_name: string | null;
}

const toSnapshot = (row: ReportExportDocument): ExportSnapshot => {
    let downloadUrl: string | null = null;
    let downloadExpires: string | null = null;
    let fileName: string | null = null;
    if (row.status === EXPORT_STATUSES.READY && row.blob_container && row.blob_key) {
        fileName = buildExportFileName(row.report_name, row.format, row.created_at);
        const sas = mintDownloadSas({
            container: row.blob_container,
            blobKey: row.blob_key,
            ttlMinutes: EXPORT_DOWNLOAD_SAS_TTL_MINUTES,
            fileName,
        });
        downloadUrl = sas.url;
        downloadExpires = sas.expires_at.toISOString();
    }
    return {
        id: row._id.toString(),
        report_name: row.report_name,
        format: row.format,
        status: row.status,
        error_message: row.error_message,
        error_code: row.error_code,
        file_size_bytes: row.file_size_bytes,
        requested_at: row.created_at.toISOString(),
        started_at: row.started_at?.toISOString() ?? null,
        completed_at: row.completed_at?.toISOString() ?? null,
        expires_at: row.expires_at.toISOString(),
        download_url: downloadUrl,
        download_url_expires_at: downloadExpires,
        file_name: fileName,
    };
};

/**
 * Owner-scoped read. Cross-user IDs surface the same `EXPORT_NOT_FOUND`
 * as unknown IDs so an attacker can't probe whether a specific export
 * exists for a different user.
 */
export const getExport = async (id: Types.ObjectId, caller: ExportCaller): Promise<ExportSnapshot> => {
    const row = await ReportExport.findOne({ _id: id, requested_by_user_id: caller.id });
    if (!row) throw AppError.notFound('Export not found', ERROR_CODES.EXPORT_NOT_FOUND);
    return toSnapshot(row);
};

// ─── Cleanup (called by cron) ───────────────────────────────────────────

interface CleanupSummary {
    rows_deleted: number;
    blobs_deleted: number;
}

/**
 * Delete `report_exports` rows past their `expires_at`, best-effort
 * removing the blob first so storage costs stay bounded. Returns a
 * summary suitable for the cron job-run row.
 */
export const cleanupExpiredExports = async (now: Date = new Date()): Promise<CleanupSummary> => {
    const expired = await ReportExport.find({ expires_at: { $lte: now } })
        .select('_id blob_container blob_key')
        .lean<{ _id: Types.ObjectId; blob_container: string | null; blob_key: string | null }[]>();

    let blobsDeleted = 0;
    if (isAzureConfigured()) {
        for (const row of expired) {
            if (row.blob_container && row.blob_key) {
                try {
                    await deleteBlob(row.blob_container, row.blob_key);
                    blobsDeleted += 1;
                } catch {
                    // `deleteBlob` already logs; never let one bad row stall the cleanup loop.
                }
            }
        }
    }

    let rowsDeleted = 0;
    if (expired.length > 0) {
        const ids = expired.map((r) => r._id);
        const result = await ReportExport.deleteMany({ _id: { $in: ids } });
        rowsDeleted = result.deletedCount ?? 0;
    }

    return { rows_deleted: rowsDeleted, blobs_deleted: blobsDeleted };
};

export { StorageNotConfiguredError, ExportTimeoutError };
