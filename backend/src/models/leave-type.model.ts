import { Schema, Types, model, type Document, type Model } from 'mongoose';

import { BASE_SCHEMA_OPTIONS } from './_base.js';
import { COLLECTIONS } from '../constants/collections.js';
import { PRO_RATA_STRATEGIES, type LeaveCode, type ProRataStrategy } from '../constants/leave.js';

/**
 * `leave_types` — Data_Model.md §3.1.
 *
 * Master configuration table for the leave engine. Default rows
 * (CL/SL/WFH/COMP_OFF) are seeded on every boot from `LEAVE_TYPE_SEEDS` in
 * `constants/leave.ts` (idempotent upsert keyed on `code`). Admins can
 * additionally insert custom types via `POST /leave-types`, but the seed
 * defaults will continue to be re-asserted on each restart so the engine
 * always finds the four canonical codes.
 *
 * Policy fields drive runtime behaviour:
 *  - `monthly_cap` + `monthly_forfeiture` → SL "use it or lose it" rules
 *    (Company_Management_Plan §2.1.1).
 *  - `pro_rata_on_join` selects the new-joiner allocation strategy.
 *  - `is_unlimited` (WFH) skips the balance check entirely.
 *  - `is_earned` (COMP_OFF) means there is no annual `allocated` figure —
 *    balance is reconstructed from `comp_off_ledger`.
 *  - `is_event_based` means no annual cycle; admin grants a one-shot
 *    allocation per event. (No default type uses this today; it remains for
 *    admin-created custom types.)
 *
 * `is_active = false` hides a type from the apply form but does not delete
 * historical balance/segment rows. We never hard-delete a leave type because
 * `leave_requests.leave_segments[].leave_type_id` would be left dangling.
 */

export interface LeaveTypeDocument extends Document {
    _id: Types.ObjectId;
    code: LeaveCode | string;
    name: string;
    default_allocation_days: number;
    carry_forward: boolean;
    carry_forward_cap: number | null;
    monthly_cap: number | null;
    monthly_forfeiture: boolean;
    is_unlimited: boolean;
    is_earned: boolean;
    is_event_based: boolean;
    pro_rata_on_join: ProRataStrategy;
    supports_half_day: boolean;
    advance_notice_days: number;
    resets_yearly: boolean;
    is_active: boolean;
    created_at: Date;
    updated_at: Date;
}

const leaveTypeSchema = new Schema<LeaveTypeDocument>(
    {
        code: { type: String, required: true, unique: true, trim: true, uppercase: true },
        name: { type: String, required: true, trim: true },
        default_allocation_days: { type: Number, required: true, min: 0, default: 0 },
        carry_forward: { type: Boolean, required: true, default: false },
        carry_forward_cap: { type: Number, default: null },
        monthly_cap: { type: Number, default: null, min: 0 },
        monthly_forfeiture: { type: Boolean, required: true, default: false },
        is_unlimited: { type: Boolean, required: true, default: false },
        is_earned: { type: Boolean, required: true, default: false },
        is_event_based: { type: Boolean, required: true, default: false },
        pro_rata_on_join: {
            type: String,
            enum: Object.values(PRO_RATA_STRATEGIES),
            required: true,
            default: PRO_RATA_STRATEGIES.NONE,
        },
        supports_half_day: { type: Boolean, required: true, default: false },
        advance_notice_days: { type: Number, required: true, min: 0, default: 0 },
        resets_yearly: { type: Boolean, required: true, default: false },
        is_active: { type: Boolean, required: true, default: true },
    },
    {
        ...BASE_SCHEMA_OPTIONS,
        collection: COLLECTIONS.LEAVE_TYPES,
    }
);

leaveTypeSchema.index({ is_active: 1 });

export const LeaveType: Model<LeaveTypeDocument> = model<LeaveTypeDocument>(COLLECTIONS.LEAVE_TYPES, leaveTypeSchema);
