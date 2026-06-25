import { Schema, Types, model, type Document, type Model } from 'mongoose';

import { BASE_SCHEMA_OPTIONS } from './_base.js';
import { COLLECTIONS } from '../constants/collections.js';
import {
    BREAK_TYPES,
    CORRECTION_REQUEST_STATUSES,
    type BreakType,
    type CorrectionRequestStatus,
} from '../constants/attendance.js';

/**
 * `attendance_correction_requests` — Data_Model.md §4.2.
 *
 * Employee-initiated record of a missed / wrong check-in or check-out.
 * Manager or admin reviews via `/correction-requests/:id/{approve,reject}`.
 *
 * BUG-040 multi-segment support:
 *   - `requested_changes.segments[]` is the canonical multi-segment
 *     proposal. When present and non-empty on approve, the service
 *     REPLACES the record's `segments[]` with this exact list, then
 *     recomputes worked minutes and re-syncs the legacy
 *     `check_in` / `check_out` aliases on the attendance record.
 *   - `requested_changes.check_in` / `check_out` are the legacy single
 *     punch fields kept for backwards compatibility. They still work
 *     for old clients that haven't been upgraded yet; on approve they
 *     route to `segments[0].check_in` / `segments[last].check_out`
 *     respectively.
 *   - At submission time, the validator requires EITHER `segments` OR
 *     one of the legacy fields, not both.
 *
 * Concurrency:
 *  - At most one `pending` request may exist per `attendance_record_id`;
 *    enforced at the service layer via a lookup-then-insert. We don't add a
 *    partial-unique index because the Mongo version on Atlas free-tier
 *    pre-7.0 didn't always honour them; the lookup is cheap and explicit.
 */

export interface RequestedBreak {
    break_type: BreakType;
    start: Date;
    end: Date | null;
}

export interface RequestedSegment {
    check_in: Date;
    check_out: Date | null;
    /** Proposed breaks for this segment (manual break correction). */
    breaks?: RequestedBreak[];
}

export interface RequestedChanges {
    /** Multi-segment proposal — replaces the record's segments on approve. */
    segments?: RequestedSegment[];
    /** Legacy single-pair fields — used when `segments` is absent. */
    check_in: Date | null;
    check_out: Date | null;
    reason: string;
}

export interface AttendanceCorrectionRequestDocument extends Document {
    _id: Types.ObjectId;
    user_id: Types.ObjectId;
    attendance_record_id: Types.ObjectId;
    requested_changes: RequestedChanges;
    status: CorrectionRequestStatus;
    reviewer_id: Types.ObjectId | null;
    reviewer_remarks: string;
    acted_at: Date | null;
    created_at: Date;
    updated_at: Date;
}

const requestedBreakSchema = new Schema<RequestedBreak>(
    {
        break_type: { type: String, enum: BREAK_TYPES, required: true },
        start: { type: Date, required: true },
        end: { type: Date, default: null },
    },
    { _id: false }
);

const requestedSegmentSchema = new Schema<RequestedSegment>(
    {
        check_in: { type: Date, required: true },
        check_out: { type: Date, default: null },
        breaks: { type: [requestedBreakSchema], default: undefined },
    },
    { _id: false }
);

const requestedChangesSchema = new Schema<RequestedChanges>(
    {
        segments: { type: [requestedSegmentSchema], default: undefined },
        check_in: { type: Date, default: null },
        check_out: { type: Date, default: null },
        reason: { type: String, required: true },
    },
    { _id: false }
);

const correctionRequestSchema = new Schema<AttendanceCorrectionRequestDocument>(
    {
        user_id: { type: Schema.Types.ObjectId, ref: COLLECTIONS.USERS, required: true },
        attendance_record_id: {
            type: Schema.Types.ObjectId,
            ref: COLLECTIONS.ATTENDANCE_RECORDS,
            required: true,
        },
        requested_changes: { type: requestedChangesSchema, required: true },
        status: {
            type: String,
            enum: CORRECTION_REQUEST_STATUSES,
            required: true,
            default: 'pending',
        },
        reviewer_id: {
            type: Schema.Types.ObjectId,
            ref: COLLECTIONS.USERS,
            default: null,
        },
        reviewer_remarks: { type: String, default: '' },
        acted_at: { type: Date, default: null },
    },
    {
        ...BASE_SCHEMA_OPTIONS,
        collection: COLLECTIONS.ATTENDANCE_CORRECTION_REQUESTS,
    }
);

// Per Data_Model.md §4.2.
correctionRequestSchema.index({ user_id: 1, status: 1 });
correctionRequestSchema.index({ status: 1, created_at: -1 });
correctionRequestSchema.index({ attendance_record_id: 1, status: 1 });

export const AttendanceCorrectionRequest: Model<AttendanceCorrectionRequestDocument> =
    model<AttendanceCorrectionRequestDocument>(COLLECTIONS.ATTENDANCE_CORRECTION_REQUESTS, correctionRequestSchema);
