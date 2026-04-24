import { Schema, Types, model, type Document, type Model } from 'mongoose';

import { BASE_SCHEMA_OPTIONS } from './_base.js';
import { COLLECTIONS } from '../constants/collections.js';
import { SL_FORFEITURE_REASONS, type SlForfeitureReason } from '../constants/leave.js';

/**
 * `sl_monthly_forfeitures` — Data_Model.md §3.5.
 *
 * Two jobs at once: idempotency record for the month-end SL forfeiture
 * cron, and audit log for the apply-time SL monthly-cap check.
 *
 * Apply-time semantics (`leave-segment.engine.ts`): when computing whether
 * a user can claim 1 SL day in month M of year Y, we count
 *
 *   approved/pending SL day(s) in (Y, M) on `leave_segments`
 *     +
 *   forfeited_days summed from this collection where (user, Y, M)
 *
 * If that total is `≥ leave_types.SL.monthly_cap` (1 in v1), the request
 * cannot debit SL this month — the engine routes it to CL instead.
 *
 * The unique compound index `(user_id, year, month)` is what makes the
 * monthly cron idempotent — a duplicate `insertOne` raises E11000 and the
 * cron treats that as "already done".
 */

export interface SlMonthlyForfeitureDocument extends Document {
    _id: Types.ObjectId;
    user_id: Types.ObjectId;
    year: number;
    month: number;
    forfeited_days: number;
    reason: SlForfeitureReason;
    run_id: string;
    applied_at: Date;
    created_at: Date;
    updated_at: Date;
}

const slMonthlyForfeitureSchema = new Schema<SlMonthlyForfeitureDocument>(
    {
        user_id: { type: Schema.Types.ObjectId, ref: COLLECTIONS.USERS, required: true },
        year: { type: Number, required: true, min: 1970 },
        month: { type: Number, required: true, min: 1, max: 12 },
        forfeited_days: { type: Number, required: true, default: 1, min: 0 },
        reason: {
            type: String,
            enum: Object.values(SL_FORFEITURE_REASONS),
            required: true,
            default: SL_FORFEITURE_REASONS.UNUSED_MONTHLY_ALLOCATION,
        },
        run_id: { type: String, required: true },
        applied_at: { type: Date, required: true, default: () => new Date() },
    },
    {
        ...BASE_SCHEMA_OPTIONS,
        collection: COLLECTIONS.SL_MONTHLY_FORFEITURES,
    }
);

slMonthlyForfeitureSchema.index({ user_id: 1, year: 1, month: 1 }, { unique: true });
slMonthlyForfeitureSchema.index({ year: 1, month: 1 });

export const SlMonthlyForfeiture: Model<SlMonthlyForfeitureDocument> = model<SlMonthlyForfeitureDocument>(
    COLLECTIONS.SL_MONTHLY_FORFEITURES,
    slMonthlyForfeitureSchema
);
