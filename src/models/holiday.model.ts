import { Schema, Types, model, type Document, type Model } from 'mongoose';

import { BASE_SCHEMA_OPTIONS } from './_base.js';
import { COLLECTIONS } from '../constants/collections.js';
import { ISO_DATE_REGEX, NAME_MAX } from '../constants/holiday.js';

/**
 * `holidays` — Data_Model.md §2.3.
 *
 * Single-tenant company calendar. One row per IST date; `date` is the
 * canonical join key for downstream consumers (leave segment generator
 * §10.2, attendance finalizer Step 14).
 *
 * `is_optional` is reserved for future use: HR teams sometimes mark certain
 * regional / restricted holidays as opt-in. The leave/attendance code
 * currently treats every row as a full holiday regardless of this flag —
 * surfacing it only in the calendar response so the FE can render a
 * different chip for optional days.
 *
 * Hard delete is OK here: nothing else stores a foreign key to this row, and
 * deleting a holiday simply means "we got the calendar wrong" — the leave
 * segment generator should re-evaluate working days at apply time anyway.
 */

export interface HolidayDocument extends Document {
    _id: Types.ObjectId;
    date: string;
    name: string;
    is_optional: boolean;
    created_by: Types.ObjectId;
    created_at: Date;
    updated_at: Date;
}

const holidaySchema = new Schema<HolidayDocument>(
    {
        date: {
            type: String,
            required: true,
            unique: true,
            match: [ISO_DATE_REGEX, 'date must be YYYY-MM-DD'],
        },
        name: { type: String, required: true, trim: true, maxlength: NAME_MAX },
        is_optional: { type: Boolean, required: true, default: false },
        created_by: { type: Schema.Types.ObjectId, ref: COLLECTIONS.USERS, required: true },
    },
    {
        ...BASE_SCHEMA_OPTIONS,
        collection: COLLECTIONS.HOLIDAYS,
    }
);

export const Holiday: Model<HolidayDocument> = model<HolidayDocument>(COLLECTIONS.HOLIDAYS, holidaySchema);
