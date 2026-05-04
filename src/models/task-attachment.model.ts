import { Schema, Types, model, type Document, type Model } from 'mongoose';

import { BASE_SCHEMA_OPTIONS } from './_base.js';
import { COLLECTIONS } from '../constants/collections.js';
import { ATTACHMENT_FILE_NAME_MAX, ATTACHMENT_MIME_TYPE_MAX } from '../constants/attachment.js';

/**
 * `task_attachments` — Data_Model.md §5.6.
 *
 * Files live in a private Azure Blob container. The row is the
 * authoritative metadata pointer (`blob_container` + `blob_key`); SAS
 * URLs are minted on demand and never persisted.
 *
 * Soft-delete model (mirrors `task_comments`):
 *  - `deleted_at` is the only delete marker. Rows stay in the collection
 *    so the activity feed can render "X deleted file Y" without juggling
 *    a tombstone collection, and so the audit trail can be correlated
 *    to the original blob_key for forensic recovery.
 *  - The blob itself is best-effort deleted from storage when a row is
 *    soft-deleted (see `service.deleteAttachment`); restoring a row is
 *    not supported in v1 because the underlying blob is gone.
 *
 * Indexes:
 *  - `{ task_id: 1, created_at: 1 }` — chronological list per task (the
 *    Data_Model spec lists `{ task_id: 1 }` only; we add the secondary
 *    sort key so the list endpoint is index-only without needing to
 *    re-sort 100s of rows in memory).
 *  - `{ blob_key: 1 }` UNIQUE — defence in depth so a re-finalize call
 *    using the same blob_key cannot create a duplicate row pointing at
 *    the same storage object. The unique-violation surfaces as 409 in
 *    the service layer.
 */

export interface TaskAttachmentDocument extends Document {
    _id: Types.ObjectId;
    task_id: Types.ObjectId;
    uploaded_by: Types.ObjectId;
    file_name: string;
    file_size: number;
    mime_type: string;
    blob_container: string;
    blob_key: string;
    deleted_at: Date | null;
    created_at: Date;
    updated_at: Date;
}

const taskAttachmentSchema = new Schema<TaskAttachmentDocument>(
    {
        task_id: {
            type: Schema.Types.ObjectId,
            ref: COLLECTIONS.TASKS,
            required: true,
            index: true,
        },
        uploaded_by: {
            type: Schema.Types.ObjectId,
            ref: COLLECTIONS.USERS,
            required: true,
            index: true,
        },
        file_name: {
            type: String,
            required: true,
            trim: true,
            maxlength: ATTACHMENT_FILE_NAME_MAX,
        },
        file_size: {
            type: Number,
            required: true,
            min: 0,
        },
        mime_type: {
            type: String,
            required: true,
            trim: true,
            maxlength: ATTACHMENT_MIME_TYPE_MAX,
        },
        blob_container: {
            type: String,
            required: true,
            trim: true,
        },
        blob_key: {
            type: String,
            required: true,
            trim: true,
        },
        deleted_at: { type: Date, default: null },
    },
    {
        ...BASE_SCHEMA_OPTIONS,
        collection: COLLECTIONS.TASK_ATTACHMENTS,
    }
);

taskAttachmentSchema.index({ task_id: 1, created_at: 1 });
taskAttachmentSchema.index({ blob_key: 1 }, { unique: true });

export const TaskAttachment: Model<TaskAttachmentDocument> = model<TaskAttachmentDocument>(
    'TaskAttachment',
    taskAttachmentSchema
);
