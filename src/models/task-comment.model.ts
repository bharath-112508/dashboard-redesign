import { Schema, Types, model, type Document, type Model } from 'mongoose';

import { BASE_SCHEMA_OPTIONS } from './_base.js';
import { COLLECTIONS } from '../constants/collections.js';
import { COMMENT_BODY_MAX, COMMENT_MENTIONS_MAX } from '../constants/comment.js';

/**
 * `task_comments` — Data_Model.md §5.5.
 *
 * Soft-delete model:
 *  - `deleted_at` is the only delete marker. The document stays in the
 *    collection so the activity feed can render "comment deleted by ___"
 *    without a separate tombstone collection.
 *  - All read paths exclude `deleted_at != null` by default. The audit
 *    log keeps the full body for the regulatory trail.
 *
 * `is_edited` is set to `true` on the first PATCH and stays true forever
 * after — matches the Slack/GitHub UX where "(edited)" is a permanent
 * marker, not a per-edit timestamp.
 *
 * Indexes match the spec:
 *  - `{ task_id: 1, created_at: 1 }` — chronological list per task.
 *  - `{ mentioned_user_ids: 1 }` — "where am I @-mentioned" lookups.
 *
 * The `body` is stored AS POSTED after sanitisation. The sanitiser strips
 * any HTML tags but leaves markdown text intact; the FE renders markdown
 * client-side. We deliberately do NOT pre-render to HTML — render-time
 * markdown means we can change the renderer without rewriting history.
 */

export interface TaskCommentDocument extends Document {
    _id: Types.ObjectId;
    task_id: Types.ObjectId;
    author_id: Types.ObjectId;
    body: string;
    mentioned_user_ids: Types.ObjectId[];
    is_edited: boolean;
    deleted_at: Date | null;
    created_at: Date;
    updated_at: Date;
}

const taskCommentSchema = new Schema<TaskCommentDocument>(
    {
        task_id: {
            type: Schema.Types.ObjectId,
            ref: COLLECTIONS.TASKS,
            required: true,
            index: true,
        },
        author_id: {
            type: Schema.Types.ObjectId,
            ref: COLLECTIONS.USERS,
            required: true,
            index: true,
        },
        body: {
            type: String,
            required: true,
            trim: true,
            maxlength: COMMENT_BODY_MAX,
        },
        mentioned_user_ids: {
            type: [{ type: Schema.Types.ObjectId, ref: COLLECTIONS.USERS }],
            default: [],
            validate: {
                validator: (arr: Types.ObjectId[]) => arr.length <= COMMENT_MENTIONS_MAX,
                message: `mentioned_user_ids cannot exceed ${COMMENT_MENTIONS_MAX} entries`,
            },
        },
        is_edited: { type: Boolean, required: true, default: false },
        deleted_at: { type: Date, default: null },
    },
    {
        ...BASE_SCHEMA_OPTIONS,
        collection: COLLECTIONS.TASK_COMMENTS,
    }
);

taskCommentSchema.index({ task_id: 1, created_at: 1 });
taskCommentSchema.index({ mentioned_user_ids: 1 });

export const TaskComment: Model<TaskCommentDocument> = model<TaskCommentDocument>('TaskComment', taskCommentSchema);
