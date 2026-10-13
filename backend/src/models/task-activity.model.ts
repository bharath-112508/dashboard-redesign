import { Schema, Types, model, type Document, type Model } from 'mongoose';

import { BASE_SCHEMA_OPTIONS } from './_base.js';
import { COLLECTIONS } from '../constants/collections.js';
import { ACTIVITY_TYPE_MAX, TASK_ACTIVITY_TYPE_VALUES, type TaskActivityType } from '../constants/task-activity.js';

/**
 * `task_activities` — Data_Model.md §5.7.
 *
 * UI-facing change history rendered on the task detail screen as
 * "Activity". Distinct from `audit_logs` (system-wide compliance trail);
 * the same domain event may legitimately write to both.
 *
 * Field shape:
 *  - `from_value` / `to_value` — `Schema.Types.Mixed` so the same field
 *    can hold a status string, an assignee ObjectId, a due_date string
 *    (`YYYY-MM-DD`), an estimated_hours number, etc. Recorders should
 *    keep payloads small (single value, never the full doc).
 *  - `metadata` — free-form per `activity_type`. Used today for
 *    `{ comment_id }` on comment events, `{ subtask_id }` on subtask
 *    additions, `{ depends_on_task_id }` on dependency edges, and
 *    `{ user_id }` on collaborator add/remove.
 *
 * The `actor_id` is required for every row; system-generated rows (none
 * today, but possible in Phase 2 jobs) would store the system user id.
 *
 * Indexes match the spec:
 *  - `{ task_id: 1, created_at: -1 }` powers the chronological feed
 *    rendered on the task detail screen.
 *  - `{ actor_id: 1, created_at: -1 }` powers a future "what did this
 *    user do recently" view (not exposed in Phase 1).
 */

export interface TaskActivityDocument extends Document {
    _id: Types.ObjectId;
    task_id: Types.ObjectId;
    actor_id: Types.ObjectId;
    activity_type: TaskActivityType;
    from_value: unknown;
    to_value: unknown;
    metadata: Record<string, unknown>;
    created_at: Date;
    updated_at: Date;
}

const taskActivitySchema = new Schema<TaskActivityDocument>(
    {
        task_id: {
            type: Schema.Types.ObjectId,
            ref: COLLECTIONS.TASKS,
            required: true,
            index: true,
        },
        actor_id: {
            type: Schema.Types.ObjectId,
            ref: COLLECTIONS.USERS,
            required: true,
            index: true,
        },
        activity_type: {
            type: String,
            required: true,
            maxlength: ACTIVITY_TYPE_MAX,
            enum: TASK_ACTIVITY_TYPE_VALUES as readonly string[],
        },
        from_value: { type: Schema.Types.Mixed, default: null },
        to_value: { type: Schema.Types.Mixed, default: null },
        metadata: { type: Schema.Types.Mixed, default: {} },
    },
    {
        ...BASE_SCHEMA_OPTIONS,
        collection: COLLECTIONS.TASK_ACTIVITIES,
    }
);

taskActivitySchema.index({ task_id: 1, created_at: -1 });
taskActivitySchema.index({ actor_id: 1, created_at: -1 });

export const TaskActivity: Model<TaskActivityDocument> = model<TaskActivityDocument>(
    'TaskActivity',
    taskActivitySchema
);
