import { Schema, Types, model, type Document, type Model } from 'mongoose';

import { BASE_SCHEMA_OPTIONS } from './_base.js';
import { COLLECTIONS } from '../constants/collections.js';
import {
    ATTENDANCE_STATUSES,
    CHECK_METHODS,
    type AttendanceStatus,
    type CheckMethod,
} from '../constants/attendance.js';

/**
 * `attendance_records` — Data_Model.md §4.1.
 *
 * One document per `(user_id × local_date)`. The `local_date` is computed in
 * the system default timezone (`Asia/Kolkata`) so daily uniqueness lines up
 * with the user's working day, not raw UTC midnight.
 *
 * Lifecycle:
 *  - On `POST /attendance/check-in` → upsert with `status="present"`,
 *    `check_in.{time, method, location_id, ip}`, `check_out=null`.
 *  - On `POST /attendance/check-out` → set `check_out`, compute
 *    `total_worked_minutes` and `overtime_minutes`.
 *  - On EOD finalizer (Step 14, deferred) → either set
 *    `status="incomplete"` + `flagged_for_correction=true` for rows with a
 *    check-in but no check-out, or insert
 *    `absent / on_leave / holiday / weekend` placeholders for missing days.
 *
 * `wfh` is set by the leave module (Step 10). Until that ships it stays
 * `false` — the field is reserved here so the schema doesn't need a
 * migration when WFH semantics turn on.
 */

export interface AttendancePunch {
    time: Date;
    method: CheckMethod;
    location_id: Types.ObjectId | null;
    ip: string;
}

export interface AttendanceRecordDocument extends Document {
    _id: Types.ObjectId;
    user_id: Types.ObjectId;
    local_date: string; // "YYYY-MM-DD"
    check_in: AttendancePunch | null;
    check_out: AttendancePunch | null;
    total_worked_minutes: number | null;
    overtime_minutes: number;
    status: AttendanceStatus;
    flagged_for_correction: boolean;
    wfh: boolean;
    notes: string;
    last_corrected_by: Types.ObjectId | null;
    last_corrected_at: Date | null;
    created_at: Date;
    updated_at: Date;
}

const punchSchema = new Schema<AttendancePunch>(
    {
        time: { type: Date, required: true },
        method: { type: String, enum: CHECK_METHODS, required: true },
        location_id: {
            type: Schema.Types.ObjectId,
            ref: COLLECTIONS.OFFICE_LOCATIONS,
            default: null,
        },
        ip: { type: String, default: '' },
    },
    { _id: false }
);

const attendanceRecordSchema = new Schema<AttendanceRecordDocument>(
    {
        user_id: { type: Schema.Types.ObjectId, ref: COLLECTIONS.USERS, required: true },
        // YYYY-MM-DD in the user's timezone (system default for v1).
        local_date: {
            type: String,
            required: true,
            validate: {
                validator: (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v),
                message: 'local_date must be ISO date (YYYY-MM-DD)',
            },
        },
        check_in: { type: punchSchema, default: null },
        check_out: { type: punchSchema, default: null },
        total_worked_minutes: { type: Number, default: null },
        overtime_minutes: { type: Number, default: 0, min: 0 },
        status: { type: String, enum: ATTENDANCE_STATUSES, required: true, default: 'present' },
        flagged_for_correction: { type: Boolean, required: true, default: false },
        wfh: { type: Boolean, required: true, default: false },
        notes: { type: String, default: '' },
        last_corrected_by: {
            type: Schema.Types.ObjectId,
            ref: COLLECTIONS.USERS,
            default: null,
        },
        last_corrected_at: { type: Date, default: null },
    },
    {
        ...BASE_SCHEMA_OPTIONS,
        collection: COLLECTIONS.ATTENDANCE_RECORDS,
    }
);

// Per Data_Model.md §4.1.
attendanceRecordSchema.index({ user_id: 1, local_date: -1 }, { unique: true });
attendanceRecordSchema.index({ local_date: 1, status: 1 });
attendanceRecordSchema.index({ flagged_for_correction: 1 });

export const AttendanceRecord: Model<AttendanceRecordDocument> = model<AttendanceRecordDocument>(
    COLLECTIONS.ATTENDANCE_RECORDS,
    attendanceRecordSchema
);
