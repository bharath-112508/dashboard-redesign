import { Schema, model, Types, type Document, type Model } from 'mongoose';

import { BASE_SCHEMA_OPTIONS } from './_base.js';
import { COLLECTIONS } from '../constants/collections.js';

/**
 * `audit_log_mirrors` (BACKEND_AUDIT.md P1-7).
 *
 * One row per hourly mirror batch. Each row points at the Blob blob
 * (the `.jsonl.gz` payload) plus the `(from_id, to_id)` range of
 * `audit_logs._id` it covers, plus a hash chain link to the previous
 * batch.
 *
 * Read flow for forensic verification:
 *   1. Walk the `audit_log_mirrors` rows in order.
 *   2. For each row: download the blob, recompute SHA-256, compare
 *      to `sha256_hash`. Then check `previous_hash` matches the prior
 *      row's `sha256_hash` — chain integrity.
 *   3. Walk the contents and reconcile against `audit_logs` for the
 *      portion still in Mongo (rows newer than the last archive cut).
 *
 * **Append-only by application convention** (mirrors `audit_logs` and
 * `audit_archives`). The mirror service exports no update / delete.
 *
 * Empty hours: when no audit rows were written between the last
 * watermark and now, we still write a chain row with `row_count = 0`
 * and `blob_*: null` so the integrity walk can't be defeated by a
 * "skip an hour" attack.
 */

export interface AuditLogMirrorDocument extends Document {
    _id: Types.ObjectId;

    /** Highest `audit_logs._id` (chronological) NOT yet covered when this batch ran (the previous run's `to_id`, or null on the very first run). */
    from_id: Types.ObjectId | null;
    /** Highest `audit_logs._id` covered by this batch. Null only when `row_count = 0`. */
    to_id: Types.ObjectId | null;

    /** Highest `audit_logs.created_at` covered. Watermark for the next run. */
    watermark_at: Date;

    row_count: number;
    file_size_bytes: number | null;

    blob_container: string | null;
    blob_key: string | null;

    /** SHA-256 of the gzipped file bytes (hex, lowercase). `null` for empty batches. */
    sha256_hash: string | null;

    /** Pointer + hash of the immediately-preceding mirror row. Null only on the very first batch. */
    previous_mirror_id: Types.ObjectId | null;
    previous_hash: string | null;

    created_at: Date;
    updated_at: Date;
}

const auditLogMirrorSchema = new Schema<AuditLogMirrorDocument>(
    {
        from_id: { type: Schema.Types.ObjectId, default: null },
        to_id: { type: Schema.Types.ObjectId, default: null },

        watermark_at: { type: Date, required: true },

        row_count: { type: Number, required: true, min: 0 },
        file_size_bytes: { type: Number, default: null, min: 0 },

        blob_container: { type: String, default: null },
        blob_key: { type: String, default: null },

        sha256_hash: { type: String, default: null, match: /^[a-f0-9]{64}$/ },

        previous_mirror_id: {
            type: Schema.Types.ObjectId,
            ref: COLLECTIONS.AUDIT_LOG_MIRRORS,
            default: null,
        },
        previous_hash: { type: String, default: null, match: /^[a-f0-9]{64}$/ },
    },
    {
        ...BASE_SCHEMA_OPTIONS,
        collection: COLLECTIONS.AUDIT_LOG_MIRRORS,
    }
);

// Watermark queries scan the most-recent row chronologically — `_id`'s
// natural index already covers that. The hash chain walk likewise
// follows `_id` order. No additional indexes needed.

export const AuditLogMirror: Model<AuditLogMirrorDocument> = model<AuditLogMirrorDocument>(
    COLLECTIONS.AUDIT_LOG_MIRRORS,
    auditLogMirrorSchema
);
