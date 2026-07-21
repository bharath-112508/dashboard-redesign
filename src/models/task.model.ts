import { Schema, Types, model, type Document, type Model } from 'mongoose';

import { BASE_SCHEMA_OPTIONS } from './_base.js';
import { COLLECTIONS } from '../constants/collections.js';
import {
    DEFAULT_TASK_STATUSES,
    TASK_DESCRIPTION_MAX,
    TASK_ESTIMATED_HOURS_MAX,
    TASK_ISSUE_TYPES,
    TASK_ISSUE_TYPE_VALUES,
    TASK_PRIORITIES,
    TASK_PRIORITY_VALUES,
    TASK_STATUS_KEY_MAX,
    TASK_STORY_POINT_VALUES,
    TASK_TITLE_MAX,
    type TaskIssueType,
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
    /** Per-project running number. Renders as `{project.code}-{task_number}`
     *  (e.g. `VLJ-142`). Assigned atomically from `projects.task_seq` on
     *  create; immutable thereafter. Never reused after delete. */
    task_number: number;
    sprint_id: Types.ObjectId | null;
    story_id: Types.ObjectId | null;
    parent_task_id: Types.ObjectId | null;
    title: string;
    description: string;
    status: string;
    priority: TaskPriority;
    /** Lightweight Jira-style classification — see `TASK_ISSUE_TYPES`. */
    issue_type: TaskIssueType;
    /** Fibonacci estimate (`TASK_STORY_POINT_VALUES`) or `null` = unestimated. */
    story_points: number | null;
    /** Local-calendar `YYYY-MM-DD` per Data_Model §5.4. */
    due_date: string;
    estimated_hours: number;
    primary_assignee_id: Types.ObjectId | null;
    collaborator_ids: Types.ObjectId[];
    depends_on_task_ids: Types.ObjectId[];
    position: number;
    /**
     * Per-project manual ordering value spanning the backlog AND every sprint
     * (Jira ranks issues in one continuous order regardless of sprint). Dense
     * integer scoped to `project_id`, mirroring the board `position` approach
     * but independent of it (`position` orders Kanban columns per status;
     * `backlog_rank` orders the Backlog/sprint lists). Assigned by the service
     * on create (appended to the end); reordered via `POST /tasks/:id/rank`.
     */
    backlog_rank: number;
    created_by: Types.ObjectId;
    updated_by: Types.ObjectId | null;
    created_at: Date;
    updated_at: Date;
}

const taskSchema = new Schema<TaskDocument>(
    {
        project_id: { type: Schema.Types.ObjectId, ref: COLLECTIONS.PROJECTS, required: true },
        // Server-assigned (see task.service.createTask). `required` is NOT set
        // so the backfill migration can run before every row has one; new rows
        // always get a value from the atomic counter.
        task_number: { type: Number, min: 1 },
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
        issue_type: {
            type: String,
            required: true,
            enum: TASK_ISSUE_TYPE_VALUES as unknown as string[],
            default: TASK_ISSUE_TYPES.TASK,
        },
        story_points: {
            type: Number,
            default: null,
            // `null` (unestimated) or one of the Fibonacci values. Enforced
            // here as defence-in-depth behind the Zod validator.
            validate: {
                validator: (v: number | null) => v === null || TASK_STORY_POINT_VALUES.includes(v),
                message: 'story_points must be null or one of the Fibonacci estimate values',
            },
        },
        due_date: { type: String, required: true },
        estimated_hours: { type: Number, required: true, default: 0, min: 0, max: TASK_ESTIMATED_HOURS_MAX },
        primary_assignee_id: { type: Schema.Types.ObjectId, ref: COLLECTIONS.USERS, default: null },
        collaborator_ids: { type: [Schema.Types.ObjectId], ref: COLLECTIONS.USERS, default: [] },
        depends_on_task_ids: { type: [Schema.Types.ObjectId], ref: COLLECTIONS.TASKS, default: [] },
        position: { type: Number, required: true, default: 0, min: 0 },
        // Server-assigned (see task.service.createTask + rankTask). `required`
        // is NOT set so the backfill migration can run before every row has one;
        // new rows always get a value appended to the end of the project order.
        backlog_rank: { type: Number, min: 0 },
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
// Issue-key uniqueness + lookup: a task_number is unique within its project.
// Partial filter skips pre-backfill rows that don't yet carry a number so the
// unique constraint doesn't trip on multiple `null`s.
taskSchema.index(
    { project_id: 1, task_number: 1 },
    { unique: true, partialFilterExpression: { task_number: { $exists: true } } }
);
taskSchema.index({ project_id: 1, sprint_id: 1 });
taskSchema.index({ project_id: 1, status: 1, position: 1 });
// Backlog/sprint list ordering (Phase 2 Backlog screen) — the manual rank
// spans the whole project, so this is scoped by project_id only (not status).
taskSchema.index({ project_id: 1, backlog_rank: 1 });
taskSchema.index({ project_id: 1, story_id: 1 });
taskSchema.index({ story_id: 1 });
taskSchema.index({ primary_assignee_id: 1, status: 1 });
taskSchema.index({ collaborator_ids: 1 });
taskSchema.index({ parent_task_id: 1 });
taskSchema.index({ due_date: 1 });

// Text search joins the global-search set (titles + descriptions).
taskSchema.index({ title: 'text', description: 'text' });

export const Task: Model<TaskDocument> = model<TaskDocument>(COLLECTIONS.TASKS, taskSchema);
