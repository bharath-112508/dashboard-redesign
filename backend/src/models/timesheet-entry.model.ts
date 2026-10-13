import { Schema, Types, model, type Document, type Model } from 'mongoose';

import { BASE_SCHEMA_OPTIONS } from './_base.js';
import { COLLECTIONS } from '../constants/collections.js';
import {
    TIMESHEET_DESCRIPTION_MAX,
    TIMESHEET_ENTRY_TYPE_VALUES,
    TIMESHEET_GENERAL_CATEGORY_MAX,
    TIMESHEET_HOURS_MAX,
    TIMESHEET_MINUTES_MAX,
} from '../constants/timesheet.js';

/**
 * `timesheet_entries` — Data_Model.md §6.1.
 *
 * One row per logged entry. A given user/day can have many rows; the
 * billable + non-billable split lives on the same row (a previous design
 * with a separate `is_billable` flag was rejected — see plan §6.1
 * "Decisions").
 *
 * Derived totals (`billable_total_minutes`, `non_billable_total_minutes`,
 * `total_minutes`) are computed by the service before save (see
 * `timesheet.service:applyDerivedTotals`) and stored denormalised so the
 * `/summary` aggregate is a single `$group`.
 *
 * Indexes per Data_Model:
 *  - `{ user_id: 1, local_date: -1 }` — own-entries listing
 *  - `{ project_id: 1, local_date: -1 }` — billing-report rollup
 *  - `{ task_id: 1 }`                    — task drilldown
 *  - `{ local_date: 1 }`                 — day-level summary across all users
 */

export interface TimesheetEntryDocument extends Document {
    _id: Types.ObjectId;

    user_id: Types.ObjectId;
    local_date: string; // YYYY-MM-DD
    entry_type: 'task_linked' | 'general';

    project_id: Types.ObjectId | null;
    sprint_id: Types.ObjectId | null;
    task_id: Types.ObjectId | null;
    general_category: string | null;

    billable_hours: number;
    billable_minutes: number;
    billable_total_minutes: number;
    non_billable_hours: number;
    non_billable_minutes: number;
    non_billable_total_minutes: number;
    idle_hours: number;
    idle_minutes: number;
    idle_total_minutes: number;
    total_minutes: number;

    description: string;

    last_edited_by: Types.ObjectId;
    last_edited_at: Date;

    created_at: Date;
    updated_at: Date;
}

const timesheetEntrySchema = new Schema<TimesheetEntryDocument>(
    {
        user_id: { type: Schema.Types.ObjectId, ref: COLLECTIONS.USERS, required: true, index: true },
        // Stored as `YYYY-MM-DD` so timezone math stays explicit; see plan
        // §Dates & Timezones for the same reasoning across attendance/leave.
        local_date: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },

        entry_type: { type: String, required: true, enum: TIMESHEET_ENTRY_TYPE_VALUES },

        project_id: { type: Schema.Types.ObjectId, ref: COLLECTIONS.PROJECTS, default: null },
        sprint_id: { type: Schema.Types.ObjectId, ref: COLLECTIONS.SPRINTS, default: null },
        task_id: { type: Schema.Types.ObjectId, ref: COLLECTIONS.TASKS, default: null },
        general_category: {
            type: String,
            default: null,
            trim: true,
            maxlength: TIMESHEET_GENERAL_CATEGORY_MAX,
        },

        billable_hours: { type: Number, required: true, min: 0, max: TIMESHEET_HOURS_MAX, default: 0 },
        billable_minutes: { type: Number, required: true, min: 0, max: TIMESHEET_MINUTES_MAX, default: 0 },
        billable_total_minutes: { type: Number, required: true, default: 0 },
        non_billable_hours: { type: Number, required: true, min: 0, max: TIMESHEET_HOURS_MAX, default: 0 },
        non_billable_minutes: { type: Number, required: true, min: 0, max: TIMESHEET_MINUTES_MAX, default: 0 },
        non_billable_total_minutes: { type: Number, required: true, default: 0 },
        idle_hours: { type: Number, required: true, min: 0, max: TIMESHEET_HOURS_MAX, default: 0 },
        idle_minutes: { type: Number, required: true, min: 0, max: TIMESHEET_MINUTES_MAX, default: 0 },
        idle_total_minutes: { type: Number, required: true, default: 0 },
        total_minutes: { type: Number, required: true, default: 0 },

        description: { type: String, default: '', trim: true, maxlength: TIMESHEET_DESCRIPTION_MAX },

        last_edited_by: { type: Schema.Types.ObjectId, ref: COLLECTIONS.USERS, required: true },
        last_edited_at: { type: Date, required: true, default: () => new Date() },
    },
    {
        ...BASE_SCHEMA_OPTIONS,
        collection: COLLECTIONS.TIMESHEET_ENTRIES,
    }
);

/**
 * Compute the derived total fields on a partial entry shape. Exported
 * so the service can call it before `create` / `save` and not worry
 * about a stale total slipping through.
 */
export const computeTimesheetTotals = (input: {
    billable_hours: number;
    billable_minutes: number;
    non_billable_hours: number;
    non_billable_minutes: number;
    idle_hours?: number;
    idle_minutes?: number;
}): {
    billable_total_minutes: number;
    non_billable_total_minutes: number;
    idle_total_minutes: number;
    total_minutes: number;
} => {
    const billable_total_minutes = input.billable_hours * 60 + input.billable_minutes;
    const non_billable_total_minutes = input.non_billable_hours * 60 + input.non_billable_minutes;
    const idle_total_minutes = (input.idle_hours ?? 0) * 60 + (input.idle_minutes ?? 0);
    return {
        billable_total_minutes,
        non_billable_total_minutes,
        idle_total_minutes,
        total_minutes: billable_total_minutes + non_billable_total_minutes + idle_total_minutes,
    };
};

timesheetEntrySchema.index({ user_id: 1, local_date: -1 });
timesheetEntrySchema.index({ project_id: 1, local_date: -1 });
timesheetEntrySchema.index({ task_id: 1 });
timesheetEntrySchema.index({ local_date: 1 });

export const TimesheetEntry: Model<TimesheetEntryDocument> = model<TimesheetEntryDocument>(
    'TimesheetEntry',
    timesheetEntrySchema
);
