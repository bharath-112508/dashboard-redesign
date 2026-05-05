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
 *  - `attendance_overtime` rows are inserted by the EOD attendance
 *    finalizer job (shipped in Step 14) and reference the originating
 *    attendance record.
 *  - `leave_request` rows are inserted when a comp-off leave is approved
 *    (consume) or refunded on cancel (earn).
 *  - `admin_adjustment` rows come from the manual `POST /comp-off/adjust`
 *    endpoint.
 *
 * Comp-off never expires — there is no year-end forfeiture and no carry-
 * forward toggle. The `users.comp_off_balance` cache is the single number
 * surfaced in the user-facing API.
 */

export interface CompOffLedgerDocument extends Document {
    _id: Types.ObjectId;
    user_id: Types.ObjectId;
    type: CompOffType;
    days: number;
    source_type: CompOffSource;
    source_ref_id: Types.ObjectId | null;
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
        source_type: {
            type: String,
            enum: Object.values(COMP_OFF_SOURCES),
            required: true,
        },
        source_ref_id: { type: Schema.Types.ObjectId, default: null },
        remarks: { type: String, default: '' },
        created_by: { type: Schema.Types.ObjectId, ref: COLLECTIONS.USERS, default: null },
    },
    {
        ...BASE_SCHEMA_OPTIONS,
        collection: COLLECTIONS.COMP_OFF_LEDGER,
    }
);

compOffLedgerSchema.index({ user_id: 1, created_at: -1 });

export const CompOffLedger: Model<CompOffLedgerDocument> = model<CompOffLedgerDocument>(
    COLLECTIONS.COMP_OFF_LEDGER,
    compOffLedgerSchema
);
