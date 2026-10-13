import { Schema, Types, model, type Document } from 'mongoose';
import { BASE_SCHEMA_OPTIONS } from './_base.js';
import { COLLECTIONS } from '../constants/collections.js';

/**
 * Redesign: a week a person has submitted. While the row exists their time
 * in that week is locked (create, edit and delete are refused); reopening the
 * week deletes the row. `week_start` is the Monday, as YYYY-MM-DD.
 */
export interface TimesheetWeekDocument extends Document {
    _id: Types.ObjectId;
    user_id: Types.ObjectId;
    week_start: string;
    submitted_at: Date;
    created_at: Date;
    updated_at: Date;
}

const timesheetWeekSchema = new Schema<TimesheetWeekDocument>(
    {
        user_id: { type: Schema.Types.ObjectId, ref: COLLECTIONS.USERS, required: true },
        week_start: { type: String, required: true },
        submitted_at: { type: Date, required: true },
    },
    { ...BASE_SCHEMA_OPTIONS, collection: COLLECTIONS.TIMESHEET_WEEKS }
);

timesheetWeekSchema.index({ user_id: 1, week_start: 1 }, { unique: true });
timesheetWeekSchema.index({ week_start: 1 });

export const TimesheetWeek = model<TimesheetWeekDocument>('TimesheetWeek', timesheetWeekSchema);
