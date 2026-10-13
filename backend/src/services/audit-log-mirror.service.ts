import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { Types } from 'mongoose';

import { AuditLog, type AuditLogDocument } from '../models/audit-log.model.js';
import { AuditLogMirror, type AuditLogMirrorDocument } from '../models/audit-log-mirror.model.js';
import {
    AUDIT_LOG_MIRROR_BLOB_CONTAINER,
    AUDIT_LOG_MIRROR_CONTENT_TYPE,
    AUDIT_LOG_MIRROR_MAX_ROWS_PER_RUN,
    buildAuditLogMirrorBlobKey,
} from '../constants/audit-log-mirror.js';
import { isAzureConfigured, putBlob } from '../utils/azure-blob.js';
import logger from '../utils/logger.js';
import { auditLogMirrorLagRows } from '../utils/metrics.js';

/**
 * Audit-log offsite mirror service (BACKEND_AUDIT.md P1-7).
 *
 * Hourly cron entry point. Picks up every audit_logs row written since
 * the last successful run, gzips them as JSONL, uploads to a WORM Blob
 * container, and writes an `audit_log_mirrors` chain row that links to
 * the previous batch by SHA-256.
 *
 * Watermark: derived from the most-recent existing `audit_log_mirrors`
 * row's `watermark_at`. The very first run starts at the epoch and
 * captures all live rows in Mongo (capped by
 * `AUDIT_LOG_MIRROR_MAX_ROWS_PER_RUN`); subsequent runs catch up
 * incrementally if a backlog accumulates.
 *
 * Empty-hour handling: if no rows have been written since the last
 * watermark, we still create a chain row (row_count=0, blob_*=null)
 * so a "skip an hour" attack can't defeat the integrity walk.
 *
 * The job is idempotent at the cron level (`runJob` lock per
 * hourly run-key). Within the run, lock acquisition is sufficient —
 * we don't double-write a batch because we filter on
 * `_id > previous.to_id`, and a partial-failure (blob uploaded, row
 * not written) is handled by the next run finding no chain row and
 * re-uploading. The blob is keyed by run timestamp so the second
 * upload writes a different key — harmless.
 */

const ROW_SERIALIZE = (row: {
    _id: Types.ObjectId;
    actor_id: Types.ObjectId | null;
    actor_role: string;
    action: string;
    target_entity: { kind: string; id: Types.ObjectId | null };
    before: unknown;
    after: unknown;
    metadata: Record<string, unknown>;
    created_at: Date;
}): string =>
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
    });

export interface MirrorBatchResult {
    /** False when no new rows were written since the previous watermark — empty chain row was still created. */
    rows_mirrored: number;
    file_size_bytes: number;
    sha256_hash: string | null;
    blob_key: string | null;
    /** Watermark at the close of this batch. Used by the next run as `from_id`. */
    watermark_at: Date;
}

/** Read the chain head (most-recent `audit_log_mirrors` row by `_id`). */
const readPrevious = async (): Promise<Pick<
    AuditLogMirrorDocument,
    '_id' | 'to_id' | 'watermark_at' | 'sha256_hash'
> | null> => {
    return AuditLogMirror.findOne({}).sort({ _id: -1 }).select('_id to_id watermark_at sha256_hash').lean<{
        _id: Types.ObjectId;
        to_id: Types.ObjectId | null;
        watermark_at: Date;
        sha256_hash: string | null;
    } | null>();
};

/**
 * Run a single mirror batch. Always returns a result row (success or
 * empty); only throws on configuration / Blob errors so the cron
 * runner records the failure and the next tick retries.
 */
export const mirrorAuditLogs = async (now: Date = new Date()): Promise<MirrorBatchResult> => {
    if (!isAzureConfigured()) {
        // Azure not provisioned in this environment — the cron is a
        // no-op until storage exists. Logging at warn rather than
        // throwing so the boot path of a fresh dev install isn't
        // blocked.
        logger.warn({ code: 'AUDIT_LOG_MIRROR_SKIPPED' }, 'Azure not configured — audit-log mirror cron is a no-op');
        return {
            rows_mirrored: 0,
            file_size_bytes: 0,
            sha256_hash: null,
            blob_key: null,
            watermark_at: now,
        };
    }

    const previous = await readPrevious();
    const idCutoff = previous?.to_id ?? null;

    // Pick up rows whose `_id` > previous `to_id`. ObjectId is monotonic
    // in `_id` order, so this is also chronological on the same shard.
    const filter: Record<string, unknown> = {};
    if (idCutoff) filter._id = { $gt: idCutoff };

    // R9 — pre-fetch the total backlog count so we can emit a metric
    // before truncating to the per-run cap. Cheap on the indexed `_id`
    // even at very large gaps. A non-zero value across multiple runs
    // means the mirror is falling behind and the per-run cap should
    // probably be raised.
    const totalBacklog = await AuditLog.countDocuments(filter);
    auditLogMirrorLagRows.set(totalBacklog);
    if (totalBacklog > AUDIT_LOG_MIRROR_MAX_ROWS_PER_RUN) {
        logger.warn(
            {
                code: 'AUDIT_LOG_MIRROR_BACKLOG',
                backlog_rows: totalBacklog,
                per_run_cap: AUDIT_LOG_MIRROR_MAX_ROWS_PER_RUN,
            },
            'Audit-log mirror backlog exceeds per-run cap — chain is falling behind'
        );
    }

    const rows = await AuditLog.find(filter)
        .sort({ _id: 1 })
        .limit(AUDIT_LOG_MIRROR_MAX_ROWS_PER_RUN)
        .lean<AuditLogDocument[]>();

    // Empty-hour path — write a chain row with row_count=0 so the
    // walk can detect a missing batch. previous_hash points at the
    // last real hash (or null on the very first run).
    //
    // R13 — special-case the cold install: if there's no chain head
    // AND no audit rows at all, skip the no-op chain row. Otherwise
    // hundreds of `{from_id: null, to_id: null}` rows would
    // accumulate over time as pure noise. Once the first real audit
    // row appears + gets mirrored, the chain starts and subsequent
    // empty hours legitimately need a chain row to defeat
    // "skip an hour" tampering.
    if (rows.length === 0) {
        if (!previous) {
            return {
                rows_mirrored: 0,
                file_size_bytes: 0,
                sha256_hash: null,
                blob_key: null,
                watermark_at: now,
            };
        }
        await AuditLogMirror.create({
            from_id: idCutoff,
            to_id: idCutoff,
            watermark_at: now,
            row_count: 0,
            file_size_bytes: null,
            blob_container: null,
            blob_key: null,
            sha256_hash: null,
            previous_mirror_id: previous._id,
            previous_hash: previous.sha256_hash,
        });
        return {
            rows_mirrored: 0,
            file_size_bytes: 0,
            sha256_hash: null,
            blob_key: null,
            watermark_at: now,
        };
    }

    // Serialise rows to JSONL, gzip, hash.
    const jsonl = rows.map(ROW_SERIALIZE).join('\n') + '\n';
    const gz = gzipSync(Buffer.from(jsonl, 'utf-8'));
    const sha256 = createHash('sha256').update(gz).digest('hex');
    const blobKey = buildAuditLogMirrorBlobKey(now);

    // Upload first, then write the row — same ordering as the
    // archive. If the row write fails after a successful upload,
    // the next run's `readPrevious` returns the prior row and the
    // current rows aren't lost — they'll be re-uploaded next time
    // under a new key. Two blobs for the same range is harmless;
    // the chain row is the source of truth for "what was mirrored".
    const { size } = await putBlob({
        container: AUDIT_LOG_MIRROR_BLOB_CONTAINER,
        blobKey,
        body: gz,
        contentType: AUDIT_LOG_MIRROR_CONTENT_TYPE,
    });

    const lastRow = rows[rows.length - 1];
    const watermarkAt = lastRow.created_at;

    await AuditLogMirror.create({
        from_id: idCutoff,
        to_id: lastRow._id,
        watermark_at: watermarkAt,
        row_count: rows.length,
        file_size_bytes: size,
        blob_container: AUDIT_LOG_MIRROR_BLOB_CONTAINER,
        blob_key: blobKey,
        sha256_hash: sha256,
        previous_mirror_id: previous?._id ?? null,
        previous_hash: previous?.sha256_hash ?? null,
    });

    logger.info(
        {
            rows: rows.length,
            bytes: size,
            sha256,
            blob_key: blobKey,
            from_id: idCutoff?.toString() ?? null,
            to_id: lastRow._id.toString(),
        },
        'Audit-log mirror batch uploaded'
    );

    return {
        rows_mirrored: rows.length,
        file_size_bytes: size,
        sha256_hash: sha256,
        blob_key: blobKey,
        watermark_at: watermarkAt,
    };
};
