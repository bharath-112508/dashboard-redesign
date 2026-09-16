import { Schema, Types, model, type Document, type Model } from 'mongoose';

import { BASE_SCHEMA_OPTIONS } from './_base.js';
import { COLLECTIONS } from '../constants/collections.js';

/**
 * `leave_balances` — Data_Model.md §3.2.
 *
 * One row per `(user_id × leave_type_id × year)`. The composite key keeps
 * year-spanning requests honest: a Dec 29 → Jan 3 sick leave creates two
 * segments (one per year) which independently `pending++` against this
 * year's row and next year's row.
 *
 * `available` is denormalized — recomputed on every mutation as
 * `allocated + carried_forward + adjusted − used − pending −
 * monthly_forfeited`. Keeping it stored lets the apply-time check use a
 * single atomic `findOneAndUpdate({ available: { $gte: needed } }, ...)`
 * guard for non-CL types (CL is allowed to go negative when the approver
 * provides `additional_approval_reason`).
 *
 * For COMP_OFF, this row is informational only (`is_earned = true` on the
 * type) — the source of truth is `comp_off_ledger`. We still maintain a
 * matching `(user, COMP_OFF, year)` row so the `/leave-balances/me`
 * response shape stays uniform.
 */

export interface LeaveBalanceDocument extends Document {
    _id: Types.ObjectId;
    user_id: Types.ObjectId;
    leave_type_id: Types.ObjectId;
    year: number;
    allocated: number;
    carried_forward: number;
    used: number;
    pending: number;
    adjusted: number;
    monthly_forfeited: number;
    available: number;
    updated_by: Types.ObjectId | null;
    created_at: Date;
    updated_at: Date;
}

const leaveBalanceSchema = new Schema<LeaveBalanceDocument>(
    {
        user_id: { type: Schema.Types.ObjectId, ref: COLLECTIONS.USERS, required: true },
        leave_type_id: {
            type: Schema.Types.ObjectId,
            ref: COLLECTIONS.LEAVE_TYPES,
            required: true,
        },
        year: { type: Number, required: true, min: 1970 },
        allocated: { type: Number, required: true, default: 0 },
        carried_forward: { type: Number, required: true, default: 0 },
        used: { type: Number, required: true, default: 0 },
        pending: { type: Number, required: true, default: 0 },
        adjusted: { type: Number, required: true, default: 0 },
        monthly_forfeited: { type: Number, required: true, default: 0, min: 0 },
        available: { type: Number, required: true, default: 0 },
        updated_by: { type: Schema.Types.ObjectId, ref: COLLECTIONS.USERS, default: null },
    },
    {
        ...BASE_SCHEMA_OPTIONS,
        collection: COLLECTIONS.LEAVE_BALANCES,
    }
);

leaveBalanceSchema.index({ user_id: 1, leave_type_id: 1, year: 1 }, { unique: true });
leaveBalanceSchema.index({ year: 1 });

export const LeaveBalance: Model<LeaveBalanceDocument> = model<LeaveBalanceDocument>(
    COLLECTIONS.LEAVE_BALANCES,
    leaveBalanceSchema
);

/**
 * The remaining figure a consumer should show or sum.
 *
 * An uncapped type (WFH) is allocated nothing and its balance is never
 * checked on apply, so the raw arithmetic reads `0 − used − pending` and
 * produces a **negative** "remaining" that means nothing: someone with two
 * WFH days booked showed `-2`, and a 45-day pending row dragged an
 * employee's dashboard total down by 45. There is nothing left to count
 * against a type with no limit, so it contributes zero, and the figure that
 * actually matters for it is `used`.
 *
 * Every read path that publishes `available` goes through here — the
 * `/leave-balances` responses, the employee dashboard card, and the leaves
 * report — rather than each one remembering to special-case the flag. The
 * STORED value stays the raw arithmetic so the counters remain auditable.
 */
export function presentedAvailable(
    b: Pick<
        LeaveBalanceDocument,
        'allocated' | 'carried_forward' | 'adjusted' | 'used' | 'pending' | 'monthly_forfeited'
    >,
    leaveType: { is_unlimited?: boolean } | null | undefined
): number {
    return leaveType?.is_unlimited ? 0 : recomputeAvailable(b);
}

/** Pure helper — keeps `available` consistent across services + tests. */
export function recomputeAvailable(
    b: Pick<
        LeaveBalanceDocument,
        'allocated' | 'carried_forward' | 'adjusted' | 'used' | 'pending' | 'monthly_forfeited'
    >
): number {
    return (
        (b.allocated || 0) +
        (b.carried_forward || 0) +
        (b.adjusted || 0) -
        (b.used || 0) -
        (b.pending || 0) -
        (b.monthly_forfeited || 0)
    );
}
