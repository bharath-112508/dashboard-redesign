import { Schema, model, Types, type Document, type Model } from 'mongoose';

import { BASE_SCHEMA_OPTIONS } from './_base.js';
import { COLLECTIONS } from '../constants/collections.js';
import {
    TASK_TEMPLATE_DAY_OF_MONTH_MAX,
    TASK_TEMPLATE_DESCRIPTION_MAX,
    TASK_TEMPLATE_DUE_OFFSET_MAX_DAYS,
    TASK_TEMPLATE_FREQUENCIES,
    TASK_TEMPLATE_NAME_MAX,
    TASK_TEMPLATE_TITLE_MAX,
    type TaskTemplateFrequency,
} from '../constants/task-template.js';
import { TASK_PRIORITIES, type TaskPriority } from '../constants/task.js';

/**
 * `task_templates` — Phase 4 Step 40.
 *
 * One row per reusable task definition. The `recurrence` sub-doc is
 * optional; when present and `enabled: true`, the daily cron treats
 * the row as a recurring task and auto-instantiates it on schedule.
 *
 * Field semantics:
 *  - `name` — display name of the TEMPLATE (admin-facing, in the
 *    template list). Distinct from `title`, which becomes the title
 *    of the instantiated task.
 *  - `default_due_offset_days` — when set, the instantiated task's
 *    `due_date` = (instantiation_date + offset). When null, the task
 *    inherits the project default (today, per task.service).
 *  - `default_collaborator_ids` / `default_assignee_id` — captured at
 *    template-creation time. The instantiation flow re-validates
 *    project membership and silently drops references that no longer
 *    qualify (deactivated user, no longer a project member, etc.).
 *  - `recurrence.last_generated_at` — IST date string of the most
 *    recent successful auto-instantiation. The cron uses this for
 *    idempotency: a same-day re-run is a no-op.
 */

export interface RecurrenceRule {
    enabled: boolean;
    frequency: TaskTemplateFrequency;
    /** weekly only: 0..6 (Sun..Sat). Empty for daily / monthly. */
    weekdays: number[];
    /** monthly only: 1..28. Null for daily / weekly. */
    day_of_month: number | null;
    /** YYYY-MM-DD. Templates produced before this date never auto-instantiate. */
    start_date: string;
    /** YYYY-MM-DD or null = no end. Templates produced after this date stop. */
    end_date: string | null;
    /** YYYY-MM-DD of the last successful auto-instantiation. Null until the first run. */
    last_generated_at: string | null;
}

export interface TaskTemplateDocument extends Document {
    _id: Types.ObjectId;
    project_id: Types.ObjectId;

    name: string;
    title: string;
    description: string;
    priority: TaskPriority;

    default_assignee_id: Types.ObjectId | null;
    default_collaborator_ids: Types.ObjectId[];
    default_story_id: Types.ObjectId | null;
    default_sprint_id: Types.ObjectId | null;
    default_due_offset_days: number | null;
    default_estimated_hours: number;

    recurrence: RecurrenceRule | null;

    is_archived: boolean;

    created_by: Types.ObjectId;
    updated_by: Types.ObjectId | null;
    created_at: Date;
    updated_at: Date;
}

// ─── Sub-doc schema ────────────────────────────────────────────────────

const recurrenceSchema = new Schema<RecurrenceRule>(
    {
        enabled: { type: Boolean, required: true, default: false },
        frequency: { type: String, required: true, enum: TASK_TEMPLATE_FREQUENCIES },
        weekdays: {
            type: [Number],
            required: true,
            default: [],
            validate: {
                validator: (v: number[]) => v.every((n) => Number.isInteger(n) && n >= 0 && n <= 6),
                message: 'weekdays must be integers in [0, 6]',
            },
        },
        day_of_month: {
            type: Number,
            default: null,
            min: 1,
            max: TASK_TEMPLATE_DAY_OF_MONTH_MAX,
        },
        start_date: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
        end_date: { type: String, default: null, match: /^\d{4}-\d{2}-\d{2}$/ },
        last_generated_at: { type: String, default: null, match: /^\d{4}-\d{2}-\d{2}$/ },
    },
    { _id: false }
);

// ─── Top-level schema ──────────────────────────────────────────────────

const taskTemplateSchema = new Schema<TaskTemplateDocument>(
    {
        project_id: {
            type: Schema.Types.ObjectId,
            ref: COLLECTIONS.PROJECTS,
            required: true,
            index: true,
        },

        name: { type: String, required: true, trim: true, maxlength: TASK_TEMPLATE_NAME_MAX },
        title: { type: String, required: true, trim: true, maxlength: TASK_TEMPLATE_TITLE_MAX },
        description: { type: String, required: false, default: '', maxlength: TASK_TEMPLATE_DESCRIPTION_MAX },
        priority: {
            type: String,
            required: true,
            enum: Object.values(TASK_PRIORITIES),
            default: TASK_PRIORITIES.MEDIUM,
        },

        default_assignee_id: { type: Schema.Types.ObjectId, ref: COLLECTIONS.USERS, default: null },
        default_collaborator_ids: { type: [Schema.Types.ObjectId], ref: COLLECTIONS.USERS, default: [] },
        default_story_id: { type: Schema.Types.ObjectId, ref: COLLECTIONS.STORIES, default: null },
        default_sprint_id: { type: Schema.Types.ObjectId, ref: COLLECTIONS.SPRINTS, default: null },
        default_due_offset_days: {
            type: Number,
            default: null,
            min: 0,
            max: TASK_TEMPLATE_DUE_OFFSET_MAX_DAYS,
        },
        default_estimated_hours: { type: Number, required: true, default: 0, min: 0 },

        recurrence: { type: recurrenceSchema, default: null },

        is_archived: { type: Boolean, required: true, default: false },

        created_by: { type: Schema.Types.ObjectId, ref: COLLECTIONS.USERS, required: true },
        updated_by: { type: Schema.Types.ObjectId, ref: COLLECTIONS.USERS, default: null },
    },
    {
        ...BASE_SCHEMA_OPTIONS,
        collection: COLLECTIONS.TASK_TEMPLATES,
    }
);

// Project list page: `{ project_id, is_archived, name }` ordering. The
// `project_id` index on the field above plus `is_archived` is a tight
// compound for the project-templates panel.
taskTemplateSchema.index({ project_id: 1, is_archived: 1 });

// Recurrence sweep query: scan ALL recurring templates whose date
// boundaries cover today. Mongo can use this index to drop the bulk
// of non-recurring rows immediately.
taskTemplateSchema.index({ 'recurrence.enabled': 1, is_archived: 1 });

export const TaskTemplate: Model<TaskTemplateDocument> = model<TaskTemplateDocument>(
    COLLECTIONS.TASK_TEMPLATES,
    taskTemplateSchema
);
