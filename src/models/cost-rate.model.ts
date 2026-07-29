import { Schema, Types, model, type Document, type Model } from 'mongoose';

import { BASE_SCHEMA_OPTIONS } from './_base.js';
import { COLLECTIONS } from '../constants/collections.js';

/**
 * `cost_rates` — Billing Phase 2 (Cost Rates & Margin).
 *
 * The cost-side twin of `billing_rates` (§6.2): a person's fully-loaded
 * cost/hour, effective-dated. One rate per `user_id`, valid across an
 * effective-date range (no project/task dimension — cost is per-person,
 * not per-engagement).
 *
 * Effective-range semantics (mirrors `billing-rate.model.ts`):
 *  - `effective_from` is required and inclusive.
 *  - `effective_to` is nullable; null means "current". A finite value is
 *    inclusive.
 *  - Non-overlap and auto-closing a predecessor's `effective_to` on a new
 *    overlapping row are service-layer write invariants (Task 3), not
 *    enforced by the model itself.
 *
 * Indexes:
 *  - `{ user_id, effective_from: -1 }` — the lookup path used to resolve
 *    "what did this person cost on date X" (future margin report / Task 3
 *    `resolveCostRateForUser`).
 *  - **Unique** `{ user_id, effective_from }` — defence in depth against
 *    the parallel-create race; two admins POSTing a cost rate for the same
 *    `(user, effective_from)` would both pass an in-process overlap check
 *    (each runs `find` before either has `save`d). The unique index turns
 *    the second insert into a clean E11000 the service maps to 409
 *    `DUPLICATE_RESOURCE`, exactly like `billing_rates`.
 */

export interface CostRateDocument extends Document {
    _id: Types.ObjectId;

    user_id: Types.ObjectId;

    cost_per_hour: number;
    currency: string; // ISO 4217, uppercase
    effective_from: string; // YYYY-MM-DD inclusive
    effective_to: string | null; // YYYY-MM-DD inclusive, null = current

    created_by: Types.ObjectId;
    created_at: Date;
    updated_at: Date;
}

const costRateSchema = new Schema<CostRateDocument>(
    {
        user_id: { type: Schema.Types.ObjectId, ref: COLLECTIONS.USERS, required: true },

        cost_per_hour: { type: Number, required: true, min: 0 },
        currency: { type: String, required: true, uppercase: true, minlength: 3, maxlength: 3 },
        effective_from: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
        effective_to: { type: String, default: null, match: /^\d{4}-\d{2}-\d{2}$/ },

        created_by: { type: Schema.Types.ObjectId, ref: COLLECTIONS.USERS, required: true },
    },
    {
        ...BASE_SCHEMA_OPTIONS,
        collection: COLLECTIONS.COST_RATES,
    }
);

// Lookup index — "what did this person cost on date X" (Task 3).
costRateSchema.index({ user_id: 1, effective_from: -1 });

// **Unique** compound index — race guard, see doc comment above.
costRateSchema.index(
    { user_id: 1, effective_from: 1 },
    { unique: true, name: 'cost_rates_user_effective_from_unique' }
);

export const CostRate: Model<CostRateDocument> = model<CostRateDocument>('CostRate', costRateSchema);
