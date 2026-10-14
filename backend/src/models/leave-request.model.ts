import { Schema, Types, model, type Document, type Model } from 'mongoose';

import { BASE_SCHEMA_OPTIONS } from './_base.js';
import { COLLECTIONS } from '../constants/collections.js';
import {
    HALF_DAY_SLOTS,
    ISO_DATE_REGEX,
    LEAVE_REQUEST_STATUSES,
    type HalfDaySlot,
    type LeaveRequestStatus,
} from '../constants/leave.js';

/**
 * `leave_requests` — Data_Model.md §3.3.
 *
 * The header doc represents the *user-visible* request (what they applied
 * for, when, why). The actual debits live in `leave_segments[]` because a
 * single SL request can split into `1 SL + N CL` and a year-spanning
 * request creates one segment per year. Storing segments inline (rather
 * than in a side collection) keeps the apply→approve→cancel transactions
 * single-document, which is critical for the atomic status transition
 * guard the concurrency tests in 10.4 exercise.
 *
 * Status state machine:
 *
 *   pending ──approve──▶ approved ──cancel──▶ cancelled (refund used→0)
 *      │                    │
 *      ├──reject──▶ rejected
 *      └──cancel──▶ cancelled (refund pending→0)
 *
 * Approve / reject / cancel-after-approval are protected by an atomic
 * `findOneAndUpdate({ status: 'pending'/'approved' })` so the loser of any
 * race sees `CORRECTION_REQUEST_NOT_PENDING`-style 409 instead of double
 * mutating balances.
 */

export interface LeaveSegment {
    leave_type_id: Types.ObjectId;
    year: number;
    days: number;
}

export interface LeaveRequestDocument extends Document {
    _id: Types.ObjectId;
    user_id: Types.ObjectId;
    requested_leave_type_id: Types.ObjectId;
    start_date: string;
    end_date: string;
    is_half_day: boolean;
    half_day_slot: HalfDaySlot | null;
    total_days: number;
    leave_segments: LeaveSegment[];
    reason: string;
    attachment_url: string | null;
    status: LeaveRequestStatus;
    requires_additional_approval: boolean;
    additional_approval_reason: string | null;
    approver_id: Types.ObjectId | null;
    /** Redesign: who filed the request when it was not the person themselves. */
    applied_by?: Types.ObjectId | null;
    approver_remarks: string;
    acted_at: Date | null;
    cancelled_at: Date | null;
    cancelled_by: Types.ObjectId | null;
    cancellation_reason: string | null;
    /**
     * Slack message coordinates — populated when the dispatcher first
     * posts the request to `#leaves` (Phase 1). Subsequent state
     * changes (approve / reject / cancel) call `chat.update` with the
     * same `(channel, ts)` so the channel has ONE message per leave
     * that mutates in place, not a new post per state change.
     *
     * `channel` is the resolved channel ID Slack returned (e.g. "C123")
     * — store the ID, not the configured channel name, so subsequent
     * updates don't re-resolve.
     *
     * `null` for legacy leaves submitted before the field existed AND
     * for any leave whose first post failed — dispatcher falls back to
     * a fresh `chat.postMessage` if `null`, so older records degrade
     * gracefully.
     *
     * Never indexed — we don't query by these.
     */
    slack_message: {
        channel: string;
        ts: string;
    } | null;
    created_at: Date;
    updated_at: Date;
}

const leaveSegmentSchema = new Schema<LeaveSegment>(
    {
        leave_type_id: {
            type: Schema.Types.ObjectId,
            ref: COLLECTIONS.LEAVE_TYPES,
            required: true,
        },
        year: { type: Number, required: true, min: 1970 },
        days: { type: Number, required: true, min: 0 },
    },
    { _id: false }
);

const leaveRequestSchema = new Schema<LeaveRequestDocument>(
    {
        user_id: { type: Schema.Types.ObjectId, ref: COLLECTIONS.USERS, required: true },
        requested_leave_type_id: {
            type: Schema.Types.ObjectId,
            ref: COLLECTIONS.LEAVE_TYPES,
            required: true,
        },
        start_date: {
            type: String,
            required: true,
            match: [ISO_DATE_REGEX, 'start_date must be YYYY-MM-DD'],
        },
        end_date: {
            type: String,
            required: true,
            match: [ISO_DATE_REGEX, 'end_date must be YYYY-MM-DD'],
        },
        is_half_day: { type: Boolean, required: true, default: false },
        half_day_slot: {
            type: String,
            enum: [...Object.values(HALF_DAY_SLOTS), null],
            default: null,
        },
        total_days: { type: Number, required: true, min: 0 },
        leave_segments: {
            type: [leaveSegmentSchema],
            required: true,
            validate: {
                validator: (v: LeaveSegment[]) => Array.isArray(v) && v.length > 0,
                message: 'Add at least one day to your leave request.',
            },
        },
        reason: { type: String, required: true, trim: true },
        attachment_url: { type: String, default: null },
        status: {
            type: String,
            enum: Object.values(LEAVE_REQUEST_STATUSES),
            required: true,
            default: LEAVE_REQUEST_STATUSES.PENDING,
        },
        requires_additional_approval: { type: Boolean, required: true, default: false },
        additional_approval_reason: { type: String, default: null },
        approver_id: { type: Schema.Types.ObjectId, ref: COLLECTIONS.USERS, default: null },
        applied_by: { type: Schema.Types.ObjectId, ref: COLLECTIONS.USERS, default: null },
        approver_remarks: { type: String, default: '' },
        acted_at: { type: Date, default: null },
        cancelled_at: { type: Date, default: null },
        cancelled_by: { type: Schema.Types.ObjectId, ref: COLLECTIONS.USERS, default: null },
        cancellation_reason: { type: String, default: null },
        slack_message: {
            type: {
                channel: { type: String, required: true },
                ts: { type: String, required: true },
            },
            default: null,
        },
    },
    {
        ...BASE_SCHEMA_OPTIONS,
        collection: COLLECTIONS.LEAVE_REQUESTS,
    }
);

leaveRequestSchema.index({ user_id: 1, start_date: -1 });
leaveRequestSchema.index({ approver_id: 1, status: 1 });
// `{status: 1}` was previously declared standalone but is fully covered
// by the leftmost prefix of the compound below — Mongo serves status-only
// queries from this index. The standalone was a Step-33 redundancy
// candidate; dropped here as part of the Phase-4 indexes-cleanup pass.
leaveRequestSchema.index({ status: 1, requires_additional_approval: 1 });
leaveRequestSchema.index({ start_date: 1, end_date: 1 });
leaveRequestSchema.index({ 'leave_segments.leave_type_id': 1, 'leave_segments.year': 1 });
// M40 — kept for the date-window reads (`calendarLeaves`, the `start_date`
// range predicates in `listLeaves`), which still filter on start_date.
leaveRequestSchema.index({ status: 1, start_date: -1 });
// `listLeaves` sorts the approvals queue by `created_at: -1` (newest
// submission first). Without this, the status-matching rows come back
// unordered and Mongo sorts them in memory — fine on a demo dataset, a
// 32MB-cap blowup on a real one. Leading with `status` because the queue
// is almost always filtered to `pending`; the sort key trails it so one
// index serves predicate AND order.
leaveRequestSchema.index({ status: 1, created_at: -1 });
// Same query without a status filter ("All" in the UI), plus the
// per-user history reads.
leaveRequestSchema.index({ created_at: -1 });

export const LeaveRequest: Model<LeaveRequestDocument> = model<LeaveRequestDocument>(
    COLLECTIONS.LEAVE_REQUESTS,
    leaveRequestSchema
);
