import { Schema, model, Types, type Document, type Model } from 'mongoose';

import { BASE_SCHEMA_OPTIONS } from './_base.js';
import { COLLECTIONS } from '../constants/collections.js';
import {
    REPORT_SUBSCRIPTION_MAX_DAY_OF_WEEK,
    REPORT_SUBSCRIPTION_MAX_HOUR_LOCAL,
    REPORT_SUBSCRIPTION_MIN_DAY_OF_WEEK,
    REPORT_SUBSCRIPTION_MIN_HOUR_LOCAL,
    REPORT_SUBSCRIPTION_NAME_MAX,
} from '../constants/report-subscription.js';
import { REPORT_EXPORT_NAMES, type ReportExportName } from '../constants/export.js';

/**
 * `report_subscriptions` — Phase 4 Step 43.
 *
 * Saved report query + weekly schedule + active flag. The cron picks
 * up active subscriptions whose `day_of_week` matches today (IST) and
 * `last_sent_at !== today`, runs the matching report, renders the
 * inline HTML body, sends via the existing mailer, then stamps
 * `last_sent_at` (atomic CAS).
 *
 * `report_name` is locked at creation. To re-target a different
 * report, the user deletes + re-creates — keeps the per-name filter
 * validation tractable on PATCH.
 */

export interface ReportSubscriptionDocument extends Document {
    _id: Types.ObjectId;

    user_id: Types.ObjectId;
    name: string;
    report_name: ReportExportName;
    filters: Record<string, unknown>;

    /** 0=Sun..6=Sat. Single weekday in v1 (no multi-day or every-other-week). */
    day_of_week: number;
    /** 0..23 IST. Soft floor at the cron tick; later hours roll over. */
    hour_local: number;

    is_active: boolean;
    /** YYYY-MM-DD (IST) of the most recent successful send. Null until first delivery. */
    last_sent_at: string | null;

    created_at: Date;
    updated_at: Date;
}

const reportSubscriptionSchema = new Schema<ReportSubscriptionDocument>(
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
            maxlength: REPORT_SUBSCRIPTION_NAME_MAX,
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
        day_of_week: {
            type: Number,
            required: true,
            min: REPORT_SUBSCRIPTION_MIN_DAY_OF_WEEK,
            max: REPORT_SUBSCRIPTION_MAX_DAY_OF_WEEK,
        },
        hour_local: {
            type: Number,
            required: true,
            min: REPORT_SUBSCRIPTION_MIN_HOUR_LOCAL,
            max: REPORT_SUBSCRIPTION_MAX_HOUR_LOCAL,
        },
        is_active: { type: Boolean, required: true, default: true },
        last_sent_at: { type: String, default: null, match: /^\d{4}-\d{2}-\d{2}$/ },
    },
    {
        ...BASE_SCHEMA_OPTIONS,
        collection: COLLECTIONS.REPORT_SUBSCRIPTIONS,
    }
);

// `(user_id, name)` unique compound — same dedup contract as presets.
reportSubscriptionSchema.index({ user_id: 1, name: 1 }, { unique: true });

// Cron sweep query: scan ALL active subscriptions whose day_of_week
// matches today. Mongo can use `{is_active, day_of_week}` to drop
// inactive + non-matching-day rows immediately.
reportSubscriptionSchema.index({ is_active: 1, day_of_week: 1 });

export const ReportSubscription: Model<ReportSubscriptionDocument> = model<ReportSubscriptionDocument>(
    COLLECTIONS.REPORT_SUBSCRIPTIONS,
    reportSubscriptionSchema
);
