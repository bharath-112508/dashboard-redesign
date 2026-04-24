import { Schema, Types, model, type Document, type Model } from 'mongoose';

import { BASE_SCHEMA_OPTIONS } from './_base.js';
import { COLLECTIONS } from '../constants/collections.js';
import {
    DEFAULT_TASK_STATUSES,
    TASK_DESCRIPTION_MAX,
    TASK_ESTIMATED_HOURS_MAX,
    TASK_PRIORITIES,
    TASK_PRIORITY_VALUES,
    TASK_STATUS_KEY_MAX,
    TASK_TITLE_MAX,
    type TaskPriority,
} from '../constants/task.js';

/**
 * `tasks` — Data_Model.md §5.4.
 *
 * The hub document for project work. Every other Phase-2/3 collection
 * (`task_comments`, `task_attachments`, `task_activities`, `timesheet_entries`)
 * points at a task; keeping this schema lean keeps the JOIN-equivalents fast.
 *
 * Notable design choices:
 *  - `status` is a **free string** rather than an enum. The four defaults from
 *    Data_Model §5.4 plus any project-specific keys from
 *    `projects.custom_task_statuses` are valid; the service rejects anything
 *    else with `TASK_INVALID_STATUS` (422). We intentionally do NOT enforce
 *    this with a schema-level enum because the valid set is per-project and
 *    Mongoose enums are static.
 *  - `due_date` is the **string-shaped** YYYY-MM-DD form Data_Model §5.4
 *    specifies. Storing the local date as text avoids the timezone drift you
 *    get when a `Date` is implicitly converted to UTC midnight.
 *  - `depends_on_task_ids` is embedded (vs. a separate `task_dependencies`
 *    collection) per Data_Model §5.4. The service handles cycle / project /
 *    duplicate checks; cap from `TASK_DEPENDENCIES_MAX` is enforced by the
 *    validator before the array hits the schema.
 *  - `position` is a dense integer scoped to (project_id, status). Reorder
 *    shifts neighbours — same approach as stories. If we hit ~1k tasks per
 *    column we'll switch to a fractional rank without changing the type.
 */

export interface TaskDocument extends Document {
    _id: Types.ObjectId;
    project_id: Types.ObjectId;
    sprint_id: Types.ObjectId | null;
    story_id: Types.ObjectId | null;
    parent_task_id: Types.ObjectId | null;
    title: string;
    description: string;
    status: string;
    priority: TaskPriority;
    /** Local-calendar `YYYY-MM-DD` per Data_Model §5.4. */
    due_date: string;
    estimated_hours: number;
    primary_assignee_id: Types.ObjectId | null;
    collaborator_ids: Types.ObjectId[];
    depends_on_task_ids: Types.ObjectId[];
    position: number;
    created_by: Types.ObjectId;
    updated_by: Types.ObjectId | null;
    created_at: Date;
    updated_at: Date;
}

const taskSchema = new Schema<TaskDocument>(
    {
        project_id: { type: Schema.Types.ObjectId, ref: COLLECTIONS.PROJECTS, required: true },
        sprint_id: { type: Schema.Types.ObjectId, ref: COLLECTIONS.SPRINTS, default: null },
        story_id: { type: Schema.Types.ObjectId, ref: COLLECTIONS.STORIES, default: null },
        parent_task_id: { type: Schema.Types.ObjectId, ref: COLLECTIONS.TASKS, default: null },
        title: { type: String, required: true, trim: true, maxlength: TASK_TITLE_MAX },
        description: { type: String, required: true, default: '', maxlength: TASK_DESCRIPTION_MAX },
        status: {
            type: String,
            required: true,
            trim: true,
            maxlength: TASK_STATUS_KEY_MAX,
            default: DEFAULT_TASK_STATUSES.TO_DO,
        },
        priority: {
            type: String,
            required: true,
            enum: TASK_PRIORITY_VALUES as unknown as string[],
            default: TASK_PRIORITIES.MEDIUM,
        },
        due_date: { type: String, required: true },
        estimated_hours: { type: Number, required: true, default: 0, min: 0, max: TASK_ESTIMATED_HOURS_MAX },
        primary_assignee_id: { type: Schema.Types.ObjectId, ref: COLLECTIONS.USERS, default: null },
        collaborator_ids: { type: [Schema.Types.ObjectId], ref: COLLECTIONS.USERS, default: [] },
        depends_on_task_ids: { type: [Schema.Types.ObjectId], ref: COLLECTIONS.TASKS, default: [] },
        position: { type: Number, required: true, default: 0, min: 0 },
        created_by: { type: Schema.Types.ObjectId, ref: COLLECTIONS.USERS, required: true },
        updated_by: { type: Schema.Types.ObjectId, ref: COLLECTIONS.USERS, default: null },
    },
    {
        ...BASE_SCHEMA_OPTIONS,
        collection: COLLECTIONS.TASKS,
    }
);

// Indexes per Data_Model §5.4. Each one is justified by the dominant read it
// powers — we don't add indexes "just because" since every index slows writes.
//
//  - {project_id, sprint_id}            → sprint board reads (Step 16 list view)
//  - {project_id, status, position}     → Kanban column ordering (the hot path)
//  - {project_id, story_id}             → story board reads + derived rollup
//  - {story_id}                         → reverse lookup (story page → tasks)
//  - {primary_assignee_id, status}      → "my tasks" inbox
//  - {collaborator_ids}                 → "tasks I collaborate on"
//  - {parent_task_id}                   → subtask listing
//  - {due_date}                         → cross-project due-date dashboards
taskSchema.index({ project_id: 1, sprint_id: 1 });
taskSchema.index({ project_id: 1, status: 1, position: 1 });
taskSchema.index({ project_id: 1, story_id: 1 });
taskSchema.index({ story_id: 1 });
taskSchema.index({ primary_assignee_id: 1, status: 1 });
taskSchema.index({ collaborator_ids: 1 });
taskSchema.index({ parent_task_id: 1 });
taskSchema.index({ due_date: 1 });

// Text search joins the global-search set (titles + descriptions).
taskSchema.index({ title: 'text', description: 'text' });

export const Task: Model<TaskDocument> = model<TaskDocument>(COLLECTIONS.TASKS, taskSchema);
