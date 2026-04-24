import { Schema, Types, model, type Document, type Model } from 'mongoose';

import { BASE_SCHEMA_OPTIONS } from './_base.js';
import { COLLECTIONS } from '../constants/collections.js';

/**
 * `office_locations` — Data_Model.md §2.2.
 *
 * Static-QR location registry used by attendance check-in (Step 8). Soft-delete
 * via `is_active = false`; nothing in the system hard-deletes a location, since
 * historic `attendance_records.check_in.location_id` references must stay
 * resolvable for audit/reports.
 *
 * Forward-compat fields:
 *  - `qr_code_image_url`: nullable for now. Will be populated with an Azure Blob
 *    URL once Phase 1 Step 22 / Phase 2 Step 21 wires Blob; until then,
 *    callers receive a fresh `qr_data_url` (PNG data URL) computed in the
 *    response by the service layer.
 *
 * Per-location geofence / wifi seams from BUILD_PROGRESS notes are intentionally
 * NOT modelled here — Data_Model.md §2.2 doesn't include them, and Phase 4
 * Step 35 will design the per-location enforcement schema together with the
 * runtime checks.
 */

export interface OfficeLocationDocument extends Document {
    _id: Types.ObjectId;
    name: string;
    address: string;
    qr_code_token: string;
    qr_code_image_url: string | null;
    is_active: boolean;
    created_by: Types.ObjectId;
    created_at: Date;
    updated_at: Date;
}

const officeLocationSchema = new Schema<OfficeLocationDocument>(
    {
        name: { type: String, required: true, trim: true },
        address: { type: String, required: true, trim: true },
        qr_code_token: { type: String, required: true, unique: true, immutable: false },
        qr_code_image_url: { type: String, default: null },
        is_active: { type: Boolean, required: true, default: true },
        created_by: { type: Schema.Types.ObjectId, ref: COLLECTIONS.USERS, required: true },
    },
    {
        ...BASE_SCHEMA_OPTIONS,
        collection: COLLECTIONS.OFFICE_LOCATIONS,
    }
);

// Cheap status filter for the most common list query.
officeLocationSchema.index({ is_active: 1, created_at: -1 });

export const OfficeLocation: Model<OfficeLocationDocument> = model<OfficeLocationDocument>(
    COLLECTIONS.OFFICE_LOCATIONS,
    officeLocationSchema
);
