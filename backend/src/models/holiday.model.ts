import { Schema, Types, model, type Document, type Model } from 'mongoose';

import { BASE_SCHEMA_OPTIONS } from './_base.js';
import { COLLECTIONS } from '../constants/collections.js';
import {
    DEFAULT_HOLIDAY_TYPE,
    DESCRIPTION_MAX,
    HOLIDAY_TYPES,
    ISO_DATE_REGEX,
    NAME_MAX,
    type HolidayType,
} from '../constants/holiday.js';

/**
 * `holidays` — Data_Model.md §2.3.
 *
 * Single-tenant company calendar. One row per IST date; `date` is the
 * canonical join key for downstream consumers (leave segment generator
 * §10.2, attendance finalizer Step 14).
 *
 * `type` (public | optional | special) replaces the legacy boolean
 * `is_optional` flag — see `src/constants/holiday.ts` for the semantics.
 * The leave / attendance engines still treat every row as a
 * non-working day regardless of type; the type is informational so the
 * FE can render distinct chips.
 *
 * `description` is free text (≤ 500 chars) so HR can attach context
 * like "Diwali — office closed Mon–Tue" or "Pandemic shutdown — see
 * intranet bulletin".
 *
 * Hard delete is OK here: nothing else stores a foreign key to this row, and
 * deleting a holiday simply means "we got the calendar wrong" — the leave
 * segment generator should re-evaluate working days at apply time anyway.
 */

export interface HolidayDocument extends Document {
    _id: Types.ObjectId;
    date: string;
    name: string;
    type: HolidayType;
    description: string;
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
        type: {
            type: String,
            enum: HOLIDAY_TYPES,
            required: true,
            default: DEFAULT_HOLIDAY_TYPE,
        },
        description: {
            type: String,
            default: '',
            trim: true,
            maxlength: DESCRIPTION_MAX,
        },
        created_by: { type: Schema.Types.ObjectId, ref: COLLECTIONS.USERS, required: true },
    },
    {
        ...BASE_SCHEMA_OPTIONS,
        collection: COLLECTIONS.HOLIDAYS,
    }
);

export const Holiday: Model<HolidayDocument> = model<HolidayDocument>(COLLECTIONS.HOLIDAYS, holidaySchema);
