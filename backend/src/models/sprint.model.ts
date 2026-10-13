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
    /**
     * T11 — archive flag (mirrors `projects.is_archived` and
     * `task_templates.is_archived`). Distinct from the lifecycle
     * `status` so an admin can move a stuck sprint with lingering
     * tasks into the archive UI without forcing a status transition.
     * Once archived, `deleteSprint` permits the delete even with
     * dependant tasks (R3 escape hatch).
     */
    is_archived: boolean;
    /**
     * Timestamp the sprint was marked `completed` (set by the service when
     * status transitions into `completed`; cleared back to `null` if it's
     * ever moved out of `completed`). Distinct from the planned `end_date`
     * — comparing the two tells us whether the sprint finished on time or
     * late. `null` until the sprint is completed.
     */
    completed_at: Date | null;
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
        is_archived: { type: Boolean, required: true, default: false },
        completed_at: { type: Date, required: false, default: null },
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
// T11 — list endpoints filter `is_archived: false` by default; pair
// with the existing `project_id` index so the active-sprints view is
// covered.
sprintSchema.index({ project_id: 1, is_archived: 1 });

/**
 * Text index for global search (Data_Model.md §Text Indexes line 1122;
 * Step 33 indexes audit). The Step-32 search currently regexes only
 * `name`; adding `goal` here ahead of the Phase-4 `$text` cutover
 * lets goal-keyword search land without a follow-up migration.
 */
sprintSchema.index({ name: 'text', goal: 'text' });

export const Sprint: Model<SprintDocument> = model<SprintDocument>(COLLECTIONS.SPRINTS, sprintSchema);
