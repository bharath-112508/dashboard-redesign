import { Schema, Types, model, type Document, type Model } from 'mongoose';

import { BASE_SCHEMA_OPTIONS } from './_base.js';
import { COLLECTIONS } from '../constants/collections.js';

/**
 * `billing_rates` — Data_Model.md §6.2.
 *
 * One rate per `(user × project × task)` tuple, valid across an
 * effective-date range. `task_id = null` is the project-level fallback
 * used when no task-specific rate exists at lookup time. The lookup
 * order at report time is documented on the model in §6.2; the service
 * here is just write-side machinery.
 *
 * Effective-range semantics:
 *  - `effective_from` is required and inclusive.
 *  - `effective_to` is nullable; null means "current". A finite value is
 *    inclusive — a rate from `2026-01-01` → `2026-03-31` covers the
 *    whole of March 31.
 *  - When admin creates a new rate that overlaps an existing range for
 *    the same `(user, project, task)` tuple, the service auto-closes
 *    the predecessor's `effective_to` to the day before the new
 *    `effective_from`. The model itself does not enforce non-overlap;
 *    it's a service-layer write invariant.
 *
 * Indexes per Data_Model:
 *  - `{ user_id, project_id, task_id, effective_from: -1 }` — the lookup
 *    path used by the (future, Phase 3) billing report.
 *  - `{ project_id }` — list-by-project filter on the admin screen.
 */

export interface BillingRateDocument extends Document {
    _id: Types.ObjectId;

    user_id: Types.ObjectId;
    project_id: Types.ObjectId;
    task_id: Types.ObjectId | null;

    hourly_rate: number;
    effective_from: string; // YYYY-MM-DD inclusive
    effective_to: string | null; // YYYY-MM-DD inclusive, null = current

    created_by: Types.ObjectId;
    created_at: Date;
    updated_at: Date;
}

const billingRateSchema = new Schema<BillingRateDocument>(
    {
        user_id: { type: Schema.Types.ObjectId, ref: COLLECTIONS.USERS, required: true },
        project_id: { type: Schema.Types.ObjectId, ref: COLLECTIONS.PROJECTS, required: true },
        task_id: { type: Schema.Types.ObjectId, ref: COLLECTIONS.TASKS, default: null },

        hourly_rate: { type: Number, required: true, min: 0 },
        effective_from: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
        effective_to: { type: String, default: null, match: /^\d{4}-\d{2}-\d{2}$/ },

        created_by: { type: Schema.Types.ObjectId, ref: COLLECTIONS.USERS, required: true },
    },
    {
        ...BASE_SCHEMA_OPTIONS,
        collection: COLLECTIONS.BILLING_RATES,
    }
);

// Compound lookup index used by the (future Phase-3) billing report.
billingRateSchema.index({ user_id: 1, project_id: 1, task_id: 1, effective_from: -1 });

// **Unique** compound index — defence in depth against the parallel-create
// race. Two admins POSTing rates for the same `(user, project, task)`
// tuple with the same `effective_from` would both pass the in-process
// overlap check (each runs `find` before either has `save`d) and create
// two simultaneously-applicable rows. The unique index turns the second
// insert into a clean E11000 → 409 `DUPLICATE_RESOURCE`.
billingRateSchema.index(
    { user_id: 1, project_id: 1, task_id: 1, effective_from: 1 },
    { unique: true, name: 'billing_rates_tuple_unique' }
);
billingRateSchema.index({ project_id: 1 });

export const BillingRate: Model<BillingRateDocument> = model<BillingRateDocument>('BillingRate', billingRateSchema);
