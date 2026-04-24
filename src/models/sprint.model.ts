import { Schema, Types, model, type Document, type Model } from 'mongoose';

import { BASE_SCHEMA_OPTIONS } from './_base.js';
import { COLLECTIONS } from '../constants/collections.js';
import {
    SPRINT_GOAL_MAX,
    SPRINT_NAME_MAX,
    SPRINT_STATUSES,
    SPRINT_STATUS_VALUES,
    type SprintStatus,
} from '../constants/project.js';
import { ISO_DATE_REGEX } from '../constants/holiday.js';

/**
 * `sprints` — Data_Model.md §5.2.
 *
 * Sprints belong to exactly one project. Tasks reference `sprint_id` (Step 18)
 * — moving a task between sprints is a single-field PATCH on the task, not on
 * the sprint, so this collection has no embedded task references.
 *
 * Status transitions are not enforced at the schema layer (planned → active →
 * completed) — Data_Model deliberately leaves this open so an admin can mark
 * a sprint completed without ever activating it (e.g. cancelled mid-plan).
 * The service layer adds a single guardrail: end_date >= start_date and both
 * fall within the parent project's window.
 */

export interface SprintDocument extends Document {
    _id: Types.ObjectId;
    project_id: Types.ObjectId;
    name: string;
    goal: string;
    start_date: string;
    end_date: string;
    status: SprintStatus;
    created_by: Types.ObjectId;
    created_at: Date;
    updated_at: Date;
}

const sprintSchema = new Schema<SprintDocument>(
    {
        project_id: { type: Schema.Types.ObjectId, ref: COLLECTIONS.PROJECTS, required: true },
        name: { type: String, required: true, trim: true, maxlength: SPRINT_NAME_MAX },
        goal: { type: String, required: false, default: '', maxlength: SPRINT_GOAL_MAX },
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
        status: {
            type: String,
            required: true,
            enum: SPRINT_STATUS_VALUES,
            default: SPRINT_STATUSES.PLANNED,
        },
        created_by: { type: Schema.Types.ObjectId, ref: COLLECTIONS.USERS, required: true },
    },
    {
        ...BASE_SCHEMA_OPTIONS,
        collection: COLLECTIONS.SPRINTS,
    }
);

// Indexes per Data_Model §5.2.
sprintSchema.index({ project_id: 1, start_date: -1 });
sprintSchema.index({ project_id: 1, status: 1 });

export const Sprint: Model<SprintDocument> = model<SprintDocument>(COLLECTIONS.SPRINTS, sprintSchema);
