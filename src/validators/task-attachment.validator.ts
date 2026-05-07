import { z } from 'zod';

import {
    ATTACHMENT_FILE_NAME_MAX,
    ATTACHMENT_LIST_DEFAULT_LIMIT,
    ATTACHMENT_LIST_MAX_LIMIT,
    ATTACHMENT_MIME_TYPE_MAX,
} from '../constants/attachment.js';
import { booleanish } from './_shared.js';

/**
 * Zod schemas for `/tasks/:task_id/attachments` + `/attachments/:id`
 * (API_Contract.md §8.5, BUILD_PROGRESS.md Step 21).
 *
 * Size + MIME *value* validation lives in the service so the rules can be
 * driven by `system_settings.uploads.*` (which an admin can change without
 * a redeploy). The validator only covers shape + obvious field caps so the
 * service can trust well-typed inputs.
 */

const objectIdSchema = z.string().regex(/^[a-f0-9]{24}$/i, 'Must be a valid ObjectId');

// ─── POST /tasks/:task_id/attachments/upload-url ─────────────────────────

export const uploadUrlBodySchema = z.object({
    file_name: z.string().trim().min(1).max(ATTACHMENT_FILE_NAME_MAX),
    /**
     * Must be a positive integer because Azure rejects zero-byte uploads
     * and we don't want a placeholder row pointing at an empty blob.
     * Upper bound is enforced in the service against
     * `system_settings.uploads.max_file_size_mb`.
     */
    file_size: z.number().int().positive(),
    mime_type: z.string().trim().min(1).max(ATTACHMENT_MIME_TYPE_MAX),
});
export type UploadUrlBody = z.infer<typeof uploadUrlBodySchema>;

// ─── POST /tasks/:task_id/attachments/finalize ───────────────────────────
//
// The finalize call is what *actually* creates the row. The FE supplies
// the blob_key + blob_container it received from `/upload-url` so we can
// verify the blob exists in storage before persisting. file_size +
// mime_type are re-supplied to assert the row matches what was minted —
// the server cross-checks against the live blob's `Content-Length`.

export const finalizeAttachmentBodySchema = z.object({
    blob_container: z.string().trim().min(1),
    blob_key: z.string().trim().min(1),
    file_name: z.string().trim().min(1).max(ATTACHMENT_FILE_NAME_MAX),
    file_size: z.number().int().positive(),
    mime_type: z.string().trim().min(1).max(ATTACHMENT_MIME_TYPE_MAX),
});
export type FinalizeAttachmentBody = z.infer<typeof finalizeAttachmentBodySchema>;

// ─── GET /tasks/:task_id/attachments ─────────────────────────────────────

export const listAttachmentsQuerySchema = z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(ATTACHMENT_LIST_MAX_LIMIT).default(ATTACHMENT_LIST_DEFAULT_LIMIT),
    /**
     * Mirrors the comments endpoint — admin/manager can opt into seeing
     * soft-deleted rows for moderation tooling. Default off; service
     * silently ignores for non-admin/manager.
     *
     * H4: was `z.coerce.boolean()` which coerces "false" → true.
     * `booleanish` is fail-loud on non-canonical values.
     */
    include_deleted: booleanish.optional().default(false),
}).strict();
export type ListAttachmentsQuery = z.infer<typeof listAttachmentsQuerySchema>;

// ─── Path params ─────────────────────────────────────────────────────────

export const taskIdPathSchema = z.object({ task_id: objectIdSchema });
export type TaskIdPath = z.infer<typeof taskIdPathSchema>;

export const attachmentIdPathSchema = z.object({ id: objectIdSchema });
export type AttachmentIdPath = z.infer<typeof attachmentIdPathSchema>;
