import { Schema, Types, model, type Document, type Model } from 'mongoose';

import { BASE_SCHEMA_OPTIONS } from './_base.js';
import { COLLECTIONS } from '../constants/collections.js';
import { CORRECTION_REQUEST_STATUSES, type CorrectionRequestStatus } from '../constants/attendance.js';

/**
 * `attendance_correction_requests` — Data_Model.md §4.2.
 *
 * Employee-initiated record of a missed / wrong check-in or check-out.
 * Manager or admin reviews via `/correction-requests/:id/{approve,reject}`.
 * On approve, the service applies `requested_changes.check_in`/`check_out`
 * to the underlying `attendance_records` row, recomputes worked minutes,
 * and clears `flagged_for_correction`.
 *
 * Concurrency:
 *  - At most one `pending` request may exist per `attendance_record_id`;
 *    enforced at the service layer via a lookup-then-insert. We don't add a
 *    partial-unique index because the Mongo version on Atlas free-tier
 *    pre-7.0 didn't always honour them; the lookup is cheap and explicit.
 */

export interface RequestedChanges {
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

const requestedChangesSchema = new Schema<RequestedChanges>(
    {
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
