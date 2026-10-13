import { Schema, model, Types, type Document, type Model } from 'mongoose';

import { BASE_SCHEMA_OPTIONS } from './_base.js';
import { COLLECTIONS } from '../constants/collections.js';
import { REPORT_PRESET_NAME_MAX } from '../constants/report-preset.js';
import { REPORT_EXPORT_NAMES, type ReportExportName } from '../constants/export.js';

/**
 * `report_presets` — Phase 4 Step 42.
 *
 * Personal saved-filter shortcuts on top of the Step-29 report
 * surface. Each preset belongs to ONE user — there's no "shared
 * preset" concept in v1. (If team-shared presets become a real
 * customer ask, that's a separate concept with its own RBAC story.)
 *
 * `report_name` is locked at creation. To change the report a preset
 * targets, the user deletes the preset and creates a new one — keeps
 * the per-name filter validation tractable (PATCH only re-validates
 * `filters` against the existing `report_name`).
 *
 * `filters` is freeform JSON; the service validates against the
 * matching Step-29 schema on both create AND patch. The model accepts
 * `Schema.Types.Mixed` because the four reports take different filter
 * shapes — one schema can't cover them.
 */

export interface ReportPresetDocument extends Document {
    _id: Types.ObjectId;

    user_id: Types.ObjectId;
    name: string;
    report_name: ReportExportName;
    filters: Record<string, unknown>;

    created_at: Date;
    updated_at: Date;
}

const reportPresetSchema = new Schema<ReportPresetDocument>(
    {
        user_id: {
            type: Schema.Types.ObjectId,
            ref: COLLECTIONS.USERS,
            required: true,
        },
        name: {
            type: String,
            required: true,
            trim: true,
            maxlength: REPORT_PRESET_NAME_MAX,
        },
        report_name: {
            type: String,
            required: true,
            enum: REPORT_EXPORT_NAMES,
        },
        filters: {
            type: Schema.Types.Mixed,
            required: true,
            default: () => ({}),
        },
    },
    {
        ...BASE_SCHEMA_OPTIONS,
        collection: COLLECTIONS.REPORT_PRESETS,
    }
);

// `(user_id, name)` unique compound — prevents accidental duplicate-
// named presets per user. Different users can independently use the
// same name. Concurrent creates collide on E11000; the service maps
// to a clear validation error.
reportPresetSchema.index({ user_id: 1, name: 1 }, { unique: true });

// Per-user list page sorts by name ASC; `(user_id, name)` already
// covers it.

export const ReportPreset: Model<ReportPresetDocument> = model<ReportPresetDocument>(
    COLLECTIONS.REPORT_PRESETS,
    reportPresetSchema
);
