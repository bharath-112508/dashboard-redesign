import { Schema, model, Types, type Document, type Model } from 'mongoose';

import { BASE_SCHEMA_OPTIONS } from './_base.js';
import { COLLECTIONS } from '../constants/collections.js';
import {
    EXPORT_FORMATS,
    EXPORT_STATUS_VALUES,
    EXPORT_STATUSES,
    REPORT_EXPORT_NAMES,
    type ExportFormat,
    type ExportStatus,
    type ReportExportName,
} from '../constants/export.js';

/**
 * `report_exports` — Step 30. The async export job-queue row.
 *
 * One row per export request. The state machine
 * (`pending → running → ready|failed`) is enforced by the service layer;
 * the schema only documents the legal values.
 *
 * **Filter snapshot:** `filters` is a freeform JSON object captured at
 * enqueue time. We do NOT re-validate it on the worker side — by the time
 * the worker runs, the validator has already coerced + capped the shape
 * (see `report-export.validator.ts`). Storing the snapshot lets the
 * Step-31 audit UI show "what filters did this export run with" without
 * re-deriving from request logs.
 *
 * **Idempotency:** none in v1. Two identical POSTs from the same user
 * produce two rows, two worker runs, two blobs. The downstream cost is
 * bounded (small file, 7-day retention) and a stricter idempotency-key
 * surface is a Phase-4 concern. The user's bell only fires once per row.
 *
 * **Owner-scoped reads:** `requested_by_user_id` is the row's "owner".
 * Even an admin can only see their own exports via GET — for a cross-
 * user view, the Step-31 audit-log viewer (`GET /audit-logs`) surfaces
 * every export action by every user.
 */

export interface ReportExportDocument extends Document {
    _id: Types.ObjectId;

    requested_by_user_id: Types.ObjectId;
    report_name: ReportExportName;
    format: ExportFormat;

    /** Validator-coerced query parameters captured at enqueue time. */
    filters: Record<string, unknown>;

    status: ExportStatus;

    /**
     * Set by the worker on `ready`. Both null until then; both null on
     * `failed`. Container is the org-wide `report-exports` container; key
     * is `exports/<_id>.<ext>`.
     */
    blob_container: string | null;
    blob_key: string | null;

    /** Bytes — populated alongside `blob_*` on `ready`. UI surface for "is this download going to be huge?". */
    file_size_bytes: number | null;

    /** Set on `failed`. Carries the human-readable reason (also surfaced on `GET`). */
    error_message: string | null;
    /** Canonical error code. Example: `STORAGE_NOT_CONFIGURED`, `EXPORT_PDF_NOT_AVAILABLE`. */
    error_code: string | null;

    started_at: Date | null;
    completed_at: Date | null;

    /**
     * Hard expiry — the cleanup cron deletes rows past this date and
     * best-effort wipes the blob. We do NOT use Mongo TTL indexes
     * because the worker needs a chance to delete the blob first
     * (TTL would silently drop the key reference and orphan the file).
     */
    expires_at: Date;

    created_at: Date;
    updated_at: Date;
}

const reportExportSchema = new Schema<ReportExportDocument>(
    {
        requested_by_user_id: {
            type: Schema.Types.ObjectId,
            ref: COLLECTIONS.USERS,
            required: true,
            index: true,
        },
        report_name: {
            type: String,
            required: true,
            enum: REPORT_EXPORT_NAMES,
        },
        format: {
            type: String,
            required: true,
            enum: EXPORT_FORMATS,
        },
        filters: {
            type: Schema.Types.Mixed,
            required: true,
            default: () => ({}),
        },
        status: {
            type: String,
            required: true,
            enum: EXPORT_STATUS_VALUES,
            default: EXPORT_STATUSES.PENDING,
            index: true,
        },
        blob_container: { type: String, default: null },
        blob_key: { type: String, default: null },
        file_size_bytes: { type: Number, default: null, min: 0 },
        error_message: { type: String, default: null, maxlength: 1000 },
        error_code: { type: String, default: null, maxlength: 80 },
        started_at: { type: Date, default: null },
        completed_at: { type: Date, default: null },
        expires_at: { type: Date, required: true },
    },
    {
        ...BASE_SCHEMA_OPTIONS,
        collection: COLLECTIONS.REPORT_EXPORTS,
    }
);

// Cleanup cron scans `expires_at <= now`; index it.
reportExportSchema.index({ expires_at: 1 });

// Owner-scoped polling reads filter by `requested_by_user_id` already
// indexed above; the secondary `created_at` sort uses the implicit `_id`
// index (ObjectId carries a timestamp prefix).

export const ReportExport: Model<ReportExportDocument> = model<ReportExportDocument>(
    COLLECTIONS.REPORT_EXPORTS,
    reportExportSchema
);
