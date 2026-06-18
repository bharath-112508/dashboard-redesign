import { Schema, Types, model, type Document, type Model } from 'mongoose';

import { BASE_SCHEMA_OPTIONS } from './_base.js';
import { COLLECTIONS } from '../constants/collections.js';
import {
    ATTENDANCE_STATUSES,
    CHECK_METHODS,
    BREAK_TYPES,
    BREAK_SOURCES,
    type AttendanceStatus,
    type CheckMethod,
    type BreakType,
    type BreakSource,
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
 *  - On EOD finalizer (shipped in Step 14) → either set
 *    `status="incomplete"` + `flagged_for_correction=true` for rows with a
 *    check-in but no check-out, or insert
 *    `absent / on_leave / holiday / weekend` placeholders for missing days.
 *
 * `wfh` is set by the leave module (shipped in Step 10).
 */

export interface AttendancePunch {
    time: Date;
    method: CheckMethod;
    location_id: Types.ObjectId | null;
    ip: string;
}

export interface BreakPunch {
    time: Date;
    source: BreakSource;
}

export interface BreakSession {
    break_type: BreakType;
    start: BreakPunch;
    end: BreakPunch | null;
}

/**
 * BUG-040 — multi-segment attendance. A user can check in and out of
 * the same `local_date` more than once (lunch break that gets logged
 * as a separate session, stepping out for an errand, etc.). The
 * `segments[]` array is the source of truth; the top-level
 * `check_in` / `check_out` fields stay as denormalised aliases for
 * the FIRST segment's `check_in` and the LATEST segment's
 * `check_out`, so existing reads / reports / exports keep working
 * without changes.
 */
export interface AttendanceSegment {
    check_in: AttendancePunch;
    check_out: AttendancePunch | null;
    /** Breaks taken during this work session. Subtracted from worked time. */
    breaks: BreakSession[];
}

export interface AttendanceRecordDocument extends Document {
    _id: Types.ObjectId;
    user_id: Types.ObjectId;
    local_date: string; // "YYYY-MM-DD"
    /** BUG-040 — array of in/out pairs. Latest entry is the "current" one. */
    segments: AttendanceSegment[];
    /** Alias of `segments[0].check_in`. Kept for backwards-compat reads. */
    check_in: AttendancePunch | null;
    /** Alias of `segments[last].check_out`. Null while the latest segment is open. */
    check_out: AttendancePunch | null;
    total_worked_minutes: number | null;
    overtime_minutes: number;
    /** Sum of all CLOSED break durations across segments (minutes). */
    total_break_minutes: number;
    /** Closed-break minutes split by type. */
    break_minutes_by_type: { lunch: number; tea: number; other: number };
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

const breakPunchSchema = new Schema<BreakPunch>(
    {
        time: { type: Date, required: true },
        source: { type: String, enum: BREAK_SOURCES, required: true },
    },
    { _id: false }
);

const breakSessionSchema = new Schema<BreakSession>(
    {
        break_type: { type: String, enum: BREAK_TYPES, required: true },
        start: { type: breakPunchSchema, required: true },
        end: { type: breakPunchSchema, default: null },
    },
    { _id: false }
);

const segmentSchema = new Schema<AttendanceSegment>(
    {
        check_in: { type: punchSchema, required: true },
        check_out: { type: punchSchema, default: null },
        breaks: { type: [breakSessionSchema], default: [] },
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
                message: 'Enter the date as a valid calendar date.',
            },
        },
        segments: { type: [segmentSchema], default: [] },
        check_in: { type: punchSchema, default: null },
        check_out: { type: punchSchema, default: null },
        total_worked_minutes: { type: Number, default: null },
        overtime_minutes: { type: Number, default: 0, min: 0 },
        total_break_minutes: { type: Number, default: 0, min: 0 },
        break_minutes_by_type: {
            type: new Schema(
                {
                    lunch: { type: Number, default: 0, min: 0 },
                    tea: { type: Number, default: 0, min: 0 },
                    other: { type: Number, default: 0, min: 0 },
                },
                { _id: false }
            ),
            default: () => ({ lunch: 0, tea: 0, other: 0 }),
        },
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
