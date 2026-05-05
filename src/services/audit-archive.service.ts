import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { Types } from 'mongoose';

import { AuditLog, type AuditLogDocument } from '../models/audit-log.model.js';
import { AuditArchive, type AuditArchiveDocument } from '../models/audit-archive.model.js';
import {
    AUDIT_ARCHIVE_AFTER_DAYS,
    AUDIT_ARCHIVE_BLOB_CONTAINER,
    AUDIT_ARCHIVE_CONTENT_TYPE,
    AUDIT_ARCHIVE_DOWNLOAD_SAS_TTL_MINUTES,
    AUDIT_ARCHIVE_MAX_DAYS_PER_RUN,
    buildAuditArchiveBlobKey,
    buildAuditArchiveFileName,
} from '../constants/audit-archive.js';
import { ERROR_CODES } from '../constants/error-codes.js';
import { AppError } from '../utils/app-error.js';
import { downloadBlob, isAzureConfigured, mintDownloadSas, putBlob } from '../utils/azure-blob.js';
import dayjs, { DATE_FORMAT, DEFAULT_TIMEZONE } from '../utils/date.js';
import logger from '../utils/logger.js';
import type { PaginationMeta } from '../utils/api-response.js';
import type { ListAuditArchivesQuery } from '../validators/audit-archive.validator.js';

/**
 * Audit-archive service (Phase 4 Step 39).
 *
 * Three concerns:
 *   1. **Archival** (`archiveDay`, `runArchivalSweep`) — daily cron sweep.
 *      Picks rows from `audit_logs` whose `created_at` falls inside the
 *      target IST day, gzips them as JSONL, uploads to Blob, writes the
 *      `audit_archives` chain row, then deletes the originals from Mongo.
 *   2. **Read** (`listArchives`, `getArchive`) — admin-only paginated
 *      list + detail endpoint that mints a fresh download SAS each
 *      time (no SAS persistence).
 *   3. **Integrity** (`verifyArchive`) — re-downloads the blob bytes,
 *      recomputes SHA-256, compares to the stored chain hash. Tamper-
 *      detection independent of Azure's immutability policy.
 *
 * Concurrency / idempotency: `archive_date` has a unique index, so two
 * concurrent cron ticks for the same day collide on E11000 and only
 * one wins. The `archiveDay` flow is "create archive row last" — the
 * ordering matters: blob upload first, then row write. If the upload
 * succeeds and the row write fails, the next run finds NO archive row
 * for that date and re-uploads — harmless because the upload is
 * `createIfNotExists`-style on the Blob side (overwrites the same key).
 */

// ─── Public types ──────────────────────────────────────────────────────

export interface AuditArchiveSnapshot {
    id: string;
    archive_date: string;
    row_count: number;
    file_size_bytes: number | null;
    sha256_hash: string | null;
    previous_archive_id: string | null;
    previous_archive_hash: string | null;
    created_at: string;
    /** Freshly minted on every read for non-empty archives; null for empty-day rows. */
    download_url: string | null;
    download_url_expires_at: string | null;
    file_name: string | null;
}

export interface VerifyResult {
    id: string;
    archive_date: string;
    integrity: 'ok' | 'hash_mismatch' | 'blob_missing' | 'empty_archive';
    expected_hash: string | null;
    computed_hash: string | null;
    file_size_bytes: number | null;
}

// ─── Date helpers ──────────────────────────────────────────────────────

/**
 * Convert an IST calendar date (`YYYY-MM-DD`) into the UTC timestamp
 * range the row's `created_at` falls into. Mirrors the audit-log read
 * service's `toRangeStart` / `toRangeEnd` (Step 31).
 */
const dayBoundsUtc = (isoDate: string): { startUtc: Date; endUtc: Date } => ({
    startUtc: dayjs.tz(isoDate, DEFAULT_TIMEZONE).startOf('day').toDate(),
    endUtc: dayjs.tz(isoDate, DEFAULT_TIMEZONE).endOf('day').toDate(),
});

// ─── Archival ──────────────────────────────────────────────────────────

interface ArchiveDayResult {
    date: string;
    row_count: number;
    skipped_reason: 'already_archived' | null;
    file_size_bytes: number | null;
    sha256_hash: string | null;
}

/**
 * Archive ONE specific calendar date. Pure entry point for the cron
 * AND for unit tests / one-off catchup scripts.
 *
 * Order of operations:
 *  1. Skip if an archive row already exists for this date.
 *  2. Stream rows for the IST-day range out of `audit_logs`.
 *  3. Serialise to JSONL, gzip, hash.
 *  4. Look up the most recent archive (chronologically) for the
 *     chain-link hash.
 *  5. Upload to Blob.
 *  6. Create the `audit_archives` row.
 *  7. Delete the archived rows from `audit_logs`.
 *
 * Empty-day shortcut: if step 2 yields zero rows, we still write a
 * chain row (with `row_count = 0`, no blob) so the integrity walk
 * isn't broken by gaps. This keeps verification semantics simple — a
 * missing date in the chain is itself a tamper signal.
 */
export const archiveDay = async (isoDate: string): Promise<ArchiveDayResult> => {
    const existing = await AuditArchive.findOne({ archive_date: isoDate }).lean<{ _id: Types.ObjectId } | null>();
    const { startUtc, endUtc } = dayBoundsUtc(isoDate);

    if (existing) {
        // Self-heal a partial-failure recovery path. If a previous
        // run committed the archive row but the subsequent
        // `deleteMany` failed (Mongo blip / process crash mid-loop),
        // source rows are stranded in `audit_logs` for an
        // already-archived date — visible to `GET /audit-logs` as
        // duplicates of what's already in Blob.
        //
        // Idempotent on the normal path (zero rows match → no-op).
        // Self-healing on the partial-failure path (deletes the
        // stranded subset). The deleteCount > 0 case logs a warn so
        // the operator gets a signal that an earlier run had
        // trouble. By the time we reach this branch the date is at
        // least `AUDIT_ARCHIVE_AFTER_DAYS` (90) old, so a new row
        // appearing in this range would be anomalous (clock skew /
        // backdated insert) and deletion is the right answer.
        const result = await AuditLog.deleteMany({ created_at: { $gte: startUtc, $lte: endUtc } });
        if (result.deletedCount && result.deletedCount > 0) {
            logger.warn(
                { archive_date: isoDate, stranded_count: result.deletedCount },
                'Audit-archive self-heal: deleted stranded source rows for an already-archived date'
            );
        }
        return {
            date: isoDate,
            row_count: 0,
            skipped_reason: 'already_archived',
            file_size_bytes: null,
            sha256_hash: null,
        };
    }

    // Stream rows out via cursor — for a 1k-row day this fits in
    // memory comfortably, but using a cursor protects against an
    // anomalous spike (e.g. a malfunctioning cron writing 100k audit
    // rows in a day).
    const cursor = AuditLog.find({ created_at: { $gte: startUtc, $lte: endUtc } })
        .sort({ created_at: 1, _id: 1 })
        .lean<AuditLogDocument[]>()
        .cursor();

    const lines: string[] = [];
    const archivedIds: Types.ObjectId[] = [];
    for await (const row of cursor) {
        archivedIds.push(row._id);
        // Stable JSON shape — `_id` first so a future reader can
        // grep by id without parsing the whole row.
        lines.push(
            JSON.stringify({
                _id: row._id.toString(),
                actor_id: row.actor_id ? row.actor_id.toString() : null,
                actor_role: row.actor_role,
                action: row.action,
                target_entity: {
                    kind: row.target_entity.kind,
                    id: row.target_entity.id ? row.target_entity.id.toString() : null,
                },
                before: row.before ?? null,
                after: row.after ?? null,
                metadata: row.metadata ?? {},
                created_at: row.created_at.toISOString(),
            })
        );
    }

    // Chain link to the most recent **non-empty** archive — empty-day
    // rows have `sha256_hash: null` and would sever the chain (every
    // subsequent archive would store `previous_archive_hash: null`,
    // breaking tamper-detection across the empty day). Skipping them
    // here keeps the chain anchored to verifiable bytes regardless of
    // how many empty days happened in between.
    const previous = await AuditArchive.findOne({ sha256_hash: { $ne: null } })
        .sort({ archive_date: -1 })
        .lean<{
            _id: Types.ObjectId;
            sha256_hash: string | null;
        } | null>();

    if (lines.length === 0) {
        // Empty-day row — no upload, no Mongo delete. Chain still
        // links so the verify walk surfaces "this day was archived
        // intentionally with zero rows".
        await AuditArchive.create({
            archive_date: isoDate,
            blob_container: null,
            blob_key: null,
            row_count: 0,
            file_size_bytes: null,
            sha256_hash: null,
            previous_archive_id: previous?._id ?? null,
            previous_archive_hash: previous?.sha256_hash ?? null,
        });
        return { date: isoDate, row_count: 0, skipped_reason: null, file_size_bytes: null, sha256_hash: null };
    }

    if (!isAzureConfigured()) {
        throw new Error('AUDIT_ARCHIVE_STORAGE_NOT_CONFIGURED');
    }

    // Trailing newline for tools that expect line-terminated JSONL.
    const jsonl = `${lines.join('\n')}\n`;
    const gzipped = gzipSync(Buffer.from(jsonl, 'utf8'));
    const sha256 = createHash('sha256').update(gzipped).digest('hex');
    const blobKey = buildAuditArchiveBlobKey(isoDate);

    await putBlob({
        container: AUDIT_ARCHIVE_BLOB_CONTAINER,
        blobKey,
        body: gzipped,
        contentType: AUDIT_ARCHIVE_CONTENT_TYPE,
    });

    await AuditArchive.create({
        archive_date: isoDate,
        blob_container: AUDIT_ARCHIVE_BLOB_CONTAINER,
        blob_key: blobKey,
        row_count: lines.length,
        file_size_bytes: gzipped.length,
        sha256_hash: sha256,
        previous_archive_id: previous?._id ?? null,
        previous_archive_hash: previous?.sha256_hash ?? null,
    });

    // Mongo delete LAST — if anything before this fails, the rows
    // stay live and the next cron tick re-archives. Idempotent.
    await AuditLog.deleteMany({ _id: { $in: archivedIds } });

    return {
        date: isoDate,
        row_count: lines.length,
        skipped_reason: null,
        file_size_bytes: gzipped.length,
        sha256_hash: sha256,
    };
};

// ─── Sweep (cron entry point) ──────────────────────────────────────────

interface SweepSummary extends Record<string, unknown> {
    days_archived: number;
    rows_archived: number;
    days_skipped: number;
    bytes_uploaded: number;
}

/**
 * Identify the dates that need archiving and process them in order.
 *
 * Algorithm: walk backward from `(now - AUDIT_ARCHIVE_AFTER_DAYS)` —
 * the youngest age that's eligible — finding dates that don't yet
 * have an archive row, until we hit an already-archived date OR the
 * `AUDIT_ARCHIVE_MAX_DAYS_PER_RUN` cap. Archive each in chronological
 * order so the chain links are written newest-after-oldest.
 *
 * Why walk backward to find the dates, then archive forward? Two
 * reasons:
 *  1. The "stop on already-archived" rule means we don't iterate the
 *     whole history every run — once steady state is reached, the
 *     scan is O(1) for the no-op case.
 *  2. The chronological-archive order keeps `previous_archive_hash`
 *     monotonically chained even when catching up a backlog.
 */
export const runArchivalSweep = async (now: Date = new Date()): Promise<SweepSummary> => {
    const summary: SweepSummary = {
        days_archived: 0,
        rows_archived: 0,
        days_skipped: 0,
        bytes_uploaded: 0,
    };

    // The youngest date that's old enough to archive. Anything more
    // recent stays live for fast `GET /audit-logs` reads.
    const eligibleFrom = dayjs(now).tz(DEFAULT_TIMEZONE).subtract(AUDIT_ARCHIVE_AFTER_DAYS, 'day');

    const datesToArchive: string[] = [];
    for (let i = 0; i < AUDIT_ARCHIVE_MAX_DAYS_PER_RUN; i += 1) {
        const candidate = eligibleFrom.subtract(i, 'day').format(DATE_FORMAT);
        const exists = await AuditArchive.findOne({ archive_date: candidate }).lean();
        if (exists) {
            // Steady state — once we hit an already-archived date,
            // older dates were processed in earlier runs.
            break;
        }
        datesToArchive.push(candidate);
    }

    // Archive oldest first so the chain writes in chronological order.
    datesToArchive.reverse();

    for (const date of datesToArchive) {
        try {
            const result = await archiveDay(date);
            if (result.skipped_reason) {
                summary.days_skipped += 1;
            } else {
                summary.days_archived += 1;
                summary.rows_archived += result.row_count;
                summary.bytes_uploaded += result.file_size_bytes ?? 0;
            }
        } catch (err) {
            // One failed day shouldn't stall the whole sweep — log,
            // increment skipped, continue. The next run picks it up.
            logger.warn({ err, archive_date: date }, 'Audit-archive day failed; will retry next run');
            summary.days_skipped += 1;
        }
    }

    return summary;
};

// ─── Read endpoints ────────────────────────────────────────────────────

const toSnapshot = (doc: AuditArchiveDocument): AuditArchiveSnapshot => {
    let downloadUrl: string | null = null;
    let downloadExpires: string | null = null;
    let fileName: string | null = null;
    if (doc.blob_container && doc.blob_key) {
        fileName = buildAuditArchiveFileName(doc.archive_date);
        const sas = mintDownloadSas({
            container: doc.blob_container,
            blobKey: doc.blob_key,
            ttlMinutes: AUDIT_ARCHIVE_DOWNLOAD_SAS_TTL_MINUTES,
            fileName,
        });
        downloadUrl = sas.url;
        downloadExpires = sas.expires_at.toISOString();
    }
    return {
        id: doc._id.toString(),
        archive_date: doc.archive_date,
        row_count: doc.row_count,
        file_size_bytes: doc.file_size_bytes,
        sha256_hash: doc.sha256_hash,
        previous_archive_id: doc.previous_archive_id?.toString() ?? null,
        previous_archive_hash: doc.previous_archive_hash,
        created_at: doc.created_at.toISOString(),
        download_url: downloadUrl,
        download_url_expires_at: downloadExpires,
        file_name: fileName,
    };
};

export const listArchives = async (
    query: ListAuditArchivesQuery
): Promise<{ data: AuditArchiveSnapshot[]; meta: PaginationMeta }> => {
    const filter: Record<string, unknown> = {};
    if (query.from_date || query.to_date) {
        const range: Record<string, string> = {};
        if (query.from_date) range.$gte = query.from_date;
        if (query.to_date) range.$lte = query.to_date;
        filter.archive_date = range;
    }

    const skip = (query.page - 1) * query.limit;
    const [rows, total] = await Promise.all([
        AuditArchive.find(filter).sort({ archive_date: -1 }).skip(skip).limit(query.limit),
        AuditArchive.countDocuments(filter),
    ]);

    return {
        data: rows.map(toSnapshot),
        meta: {
            page: query.page,
            limit: query.limit,
            total,
            total_pages: Math.max(1, Math.ceil(total / query.limit)),
        },
    };
};

export const getArchive = async (id: Types.ObjectId): Promise<AuditArchiveSnapshot> => {
    const doc = await AuditArchive.findById(id);
    if (!doc) throw AppError.notFound('Audit archive not found', ERROR_CODES.AUDIT_ARCHIVE_NOT_FOUND);
    return toSnapshot(doc);
};

// ─── Integrity verification ────────────────────────────────────────────

/**
 * Re-download the blob, recompute SHA-256, compare to the stored
 * `sha256_hash`. Returns a structured result rather than throwing on
 * mismatch — the admin UI surfaces the diagnostic; ops decides what to
 * do (typically: file an incident, query the immutability policy on
 * the container).
 *
 * Empty-day archives (`row_count = 0`, no blob) report `empty_archive`
 * — there's nothing to verify on the storage side; the chain link is
 * still recorded in Mongo and is checked at the list-walk level.
 */
export const verifyArchive = async (id: Types.ObjectId): Promise<VerifyResult> => {
    const doc = await AuditArchive.findById(id);
    if (!doc) throw AppError.notFound('Audit archive not found', ERROR_CODES.AUDIT_ARCHIVE_NOT_FOUND);

    if (!doc.blob_container || !doc.blob_key || !doc.sha256_hash) {
        return {
            id: doc._id.toString(),
            archive_date: doc.archive_date,
            integrity: 'empty_archive',
            expected_hash: null,
            computed_hash: null,
            file_size_bytes: null,
        };
    }

    let bytes: Buffer;
    try {
        bytes = await downloadBlob(doc.blob_container, doc.blob_key);
    } catch (err) {
        // Blob missing entirely — tamper signal in itself. Surface as
        // a structured result rather than a 500 so the admin sees
        // the actual integrity state.
        if (err instanceof Error && err.name === 'BlobNotFoundError') {
            return {
                id: doc._id.toString(),
                archive_date: doc.archive_date,
                integrity: 'blob_missing',
                expected_hash: doc.sha256_hash,
                computed_hash: null,
                file_size_bytes: doc.file_size_bytes,
            };
        }
        throw err;
    }

    const computed = createHash('sha256').update(bytes).digest('hex');
    return {
        id: doc._id.toString(),
        archive_date: doc.archive_date,
        integrity: computed === doc.sha256_hash ? 'ok' : 'hash_mismatch',
        expected_hash: doc.sha256_hash,
        computed_hash: computed,
        file_size_bytes: bytes.length,
    };
};
