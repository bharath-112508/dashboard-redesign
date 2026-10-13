import { Schema, model, Types, type Document, type Model } from 'mongoose';

import { BASE_SCHEMA_OPTIONS } from './_base.js';
import { COLLECTIONS } from '../constants/collections.js';

/**
 * `audit_archives` — Phase 4 Step 39.
 *
 * One row per archived day of `audit_logs`. The chain link
 * (`previous_archive_id` + `previous_archive_hash`) makes archive
 * tampering detectable even without Azure's immutability policy
 * configured — modifying any archive's bytes changes its hash, which
 * breaks the chain at the next archive's `previous_archive_hash`
 * reference.
 *
 * **Append-only by application convention** (mirrors the
 * `audit_logs` rule it descends from). The service exports no
 * `update` or `delete` against this collection; the cron job only
 * `create`s rows.
 *
 * `archive_date` is the **content date** (the day whose audit rows
 * are inside the file), not the upload date. Stored as `YYYY-MM-DD`
 * for stable ordering + index alignment with the file naming
 * convention.
 *
 * `row_count = 0` is allowed — the archival job MAY skip writing a
 * Blob for empty days (no audit activity that day) but still records
 * a chain row so the integrity-walk is unbroken. Decision deferred
 * to the service layer; the schema accepts both shapes.
 */

export interface AuditArchiveDocument extends Document {
    _id: Types.ObjectId;

    /** YYYY-MM-DD — the calendar day whose audit rows live in this archive. */
    archive_date: string;

    /** Azure Blob container; `null` only when `row_count = 0` and we elected to skip the upload. */
    blob_container: string | null;
    blob_key: string | null;

    row_count: number;
    file_size_bytes: number | null;

    /** SHA-256 of the gzipped file bytes (hex, lowercase). `null` mirrors `blob_*` for empty-day rows. */
    sha256_hash: string | null;

    /** Pointer + hash of the immediately-preceding archive (chronological). Null only on the very first archive. */
    previous_archive_id: Types.ObjectId | null;
    previous_archive_hash: string | null;

    created_at: Date;
    updated_at: Date;
}

const auditArchiveSchema = new Schema<AuditArchiveDocument>(
    {
        archive_date: {
            type: String,
            required: true,
            unique: true,
            match: /^\d{4}-\d{2}-\d{2}$/,
        },

        blob_container: { type: String, default: null },
        blob_key: { type: String, default: null },

        row_count: { type: Number, required: true, min: 0 },
        file_size_bytes: { type: Number, default: null, min: 0 },

        sha256_hash: {
            type: String,
            default: null,
            match: /^[a-f0-9]{64}$/, // 64 hex chars
        },

        previous_archive_id: {
            type: Schema.Types.ObjectId,
            ref: COLLECTIONS.AUDIT_ARCHIVES,
            default: null,
        },
        previous_archive_hash: {
            type: String,
            default: null,
            match: /^[a-f0-9]{64}$/,
        },
    },
    {
        ...BASE_SCHEMA_OPTIONS,
        collection: COLLECTIONS.AUDIT_ARCHIVES,
    }
);

// List queries page through chronological order; `archive_date` already
// has a unique index. The `_id` natural index covers chronological
// ordering by creation time as a secondary tiebreak.

export const AuditArchive: Model<AuditArchiveDocument> = model<AuditArchiveDocument>(
    COLLECTIONS.AUDIT_ARCHIVES,
    auditArchiveSchema
);
