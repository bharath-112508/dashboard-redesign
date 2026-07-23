import { Schema, Types, model, type Document, type Model } from 'mongoose';

import { BASE_SCHEMA_OPTIONS } from './_base.js';
import { COLLECTIONS } from '../constants/collections.js';
import { COMP_OFF_SOURCES, COMP_OFF_TYPES, type CompOffSource, type CompOffType } from '../constants/leave.js';

/**
 * `comp_off_ledger` — Data_Model.md §3.4.
 *
 * Append-only ledger. Each row is either an `earned` (+) or `consumed` (−).
 * Sign is implied by `type`; `days` itself is always positive. Current
 * comp-off balance for a user = `Σ(earned) − Σ(consumed)`, cached on
 * `users.comp_off_balance` and recomputed inside the service every time
 * we insert a new row.
 *
 * `source_type` + `source_ref_id` make audits trivial:
 *  - `timesheet_billable` rows are auto-accrued lots inserted/updated by the
 *    comp-off accrual engine from a day's billable timesheet hours; they carry
 *    the source project + minutes + date and a 3-month `expires_at`.
 *  - `attendance_overtime` rows are legacy lots from the earlier attendance
 *    finalizer accrual (reference the originating attendance record).
 *  - `leave_request` rows are `consumed` rows written when a comp-off leave is
 *    approved (with `allocations` naming the lots drawn down FIFO).
 *  - `admin_adjustment` rows come from the manual `POST /comp-off/adjust`.
 *
 * ── Lots + expiry ─────────────────────────────────────────────────────────
 * Each `earned` row is a LOT: `remaining_days` is its unconsumed portion
 * (starts = `days`, drawn down oldest-first, 0 once expired). Comp-off expires
 * `COMP_OFF_EXPIRY_MONTHS` after its source date (`expires_at`); the expiry job
 * writes an `expired` movement and zeroes the lot's `remaining_days`.
 *
 * **Balance is authoritative from lots:** `users.comp_off_balance =
 * Σ remaining_days` over non-expired `earned` lots. `consumed`/`expired` rows
 * are history/audit only and do NOT enter the balance sum.
 */

/** On a `consumed` row: which earned lots it drew from (for refund on cancel). */
export interface CompOffAllocation {
    lot_id: Types.ObjectId;
    days: number;
}

export interface CompOffLedgerDocument extends Document {
    _id: Types.ObjectId;
    user_id: Types.ObjectId;
    type: CompOffType;
    days: number;
    /** Earned lots only: unconsumed portion (0 once fully drawn or expired). */
    remaining_days: number;
    /** Earned lots only: source date + COMP_OFF_EXPIRY_MONTHS. */
    expires_at: Date | null;
    /** Earned lots only: set true once the lot's unused days have lapsed. */
    expired: boolean;
    source_type: CompOffSource;
    source_ref_id: Types.ObjectId | null;
    /** Accrual provenance — the project the billable work was on. */
    project_id: Types.ObjectId | null;
    /** Snapshot of the project name at grant time (for display without a join). */
    project_name: string | null;
    /** Billable minutes that generated an accrued lot. */
    source_minutes: number;
    /** `YYYY-MM-DD` worked (accrual) — also the per-day idempotency key. */
    source_date: string | null;
    /** `consumed` rows: the lots this consumption drew down, for refunds. */
    allocations: CompOffAllocation[];
    /** `consumed` rows: set when a cancel/reject reversed the consumption. */
    reversed_at: Date | null;
    remarks: string;
    created_by: Types.ObjectId | null;
    created_at: Date;
    updated_at: Date;
}

const compOffLedgerSchema = new Schema<CompOffLedgerDocument>(
    {
        user_id: { type: Schema.Types.ObjectId, ref: COLLECTIONS.USERS, required: true },
        type: { type: String, enum: Object.values(COMP_OFF_TYPES), required: true },
        days: { type: Number, required: true, min: 0 },
        remaining_days: { type: Number, default: 0, min: 0 },
        expires_at: { type: Date, default: null },
        expired: { type: Boolean, default: false },
        source_type: {
            type: String,
            enum: Object.values(COMP_OFF_SOURCES),
            required: true,
        },
        source_ref_id: { type: Schema.Types.ObjectId, default: null },
        project_id: { type: Schema.Types.ObjectId, ref: COLLECTIONS.PROJECTS, default: null },
        project_name: { type: String, default: null },
        source_minutes: { type: Number, default: 0, min: 0 },
        source_date: { type: String, default: null },
        allocations: {
            type: [
                new Schema<CompOffAllocation>(
                    {
                        lot_id: { type: Schema.Types.ObjectId, required: true },
                        days: { type: Number, required: true, min: 0 },
                    },
                    { _id: false }
                ),
            ],
            default: [],
        },
        reversed_at: { type: Date, default: null },
        remarks: { type: String, default: '' },
        created_by: { type: Schema.Types.ObjectId, ref: COLLECTIONS.USERS, default: null },
    },
    {
        ...BASE_SCHEMA_OPTIONS,
        collection: COLLECTIONS.COMP_OFF_LEDGER,
    }
);

compOffLedgerSchema.index({ user_id: 1, created_at: -1 });
// FIFO consumption + expiry: oldest active earned lots for a user first.
compOffLedgerSchema.index({ user_id: 1, type: 1, expired: 1, source_date: 1 });
// Expiry sweep: active lots past their expiry.
compOffLedgerSchema.index({ type: 1, expired: 1, expires_at: 1 });
// Accrual idempotency: at most one timesheet_billable lot per user per day.
compOffLedgerSchema.index(
    { user_id: 1, source_type: 1, source_date: 1 },
    {
        unique: true,
        partialFilterExpression: { source_type: COMP_OFF_SOURCES.TIMESHEET_BILLABLE, source_date: { $type: 'string' } },
    }
);

export const CompOffLedger: Model<CompOffLedgerDocument> = model<CompOffLedgerDocument>(
    COLLECTIONS.COMP_OFF_LEDGER,
    compOffLedgerSchema
);
