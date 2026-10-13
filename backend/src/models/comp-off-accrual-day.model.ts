import { Schema, Types, model, type Document, type Model } from 'mongoose';

import { BASE_SCHEMA_OPTIONS } from './_base.js';
import { COLLECTIONS } from '../constants/collections.js';

/**
 * `comp_off_accrual_days` — idempotency marker for the FORWARD-ONLY overtime-
 * bank accrual. One row per (user, day) once that day has been folded into the
 * user's overtime bank, so the nightly job (and any re-run) never processes the
 * same day twice — which matters because the bank carries state across days and
 * comp-off is HELD once earned (edits to the timesheet do NOT re-accrue).
 */
export interface CompOffAccrualDayDocument extends Document {
    _id: Types.ObjectId;
    user_id: Types.ObjectId;
    local_date: string; // YYYY-MM-DD (IST)
    overtime_minutes: number; // billable OT folded into the bank that day
    granted_days: number; // comp-off minted when this day tipped the bank
    created_at: Date;
    updated_at: Date;
}

const schema = new Schema<CompOffAccrualDayDocument>(
    {
        user_id: { type: Schema.Types.ObjectId, ref: COLLECTIONS.USERS, required: true },
        local_date: { type: String, required: true },
        overtime_minutes: { type: Number, default: 0, min: 0 },
        granted_days: { type: Number, default: 0, min: 0 },
    },
    { ...BASE_SCHEMA_OPTIONS, collection: COLLECTIONS.COMP_OFF_ACCRUAL_DAYS }
);

// One marker per user per day — the accrual guard.
schema.index({ user_id: 1, local_date: 1 }, { unique: true });

export const CompOffAccrualDay: Model<CompOffAccrualDayDocument> = model<CompOffAccrualDayDocument>(
    COLLECTIONS.COMP_OFF_ACCRUAL_DAYS,
    schema
);
