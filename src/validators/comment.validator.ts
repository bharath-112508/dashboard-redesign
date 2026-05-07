import { z } from 'zod';

import {
    COMMENT_BODY_MAX,
    COMMENT_LIST_DEFAULT_LIMIT,
    COMMENT_LIST_MAX_LIMIT,
    COMMENT_MENTIONS_MAX,
} from '../constants/comment.js';
import { booleanish } from './_shared.js';

/**
 * Zod schemas for `/tasks/:task_id/comments` + `/comments/:id`
 * (API_Contract.md §8.4).
 *
 * The `body` length cap matches `COMMENT_BODY_MAX`. Sanitisation runs in
 * the service layer (post-validate) so the raw input length is what the
 * cap applies to — that way a 4 999-char body that drops to 4 800 chars
 * after `<script>` removal still passes, instead of failing twice for
 * the same tag.
 *
 * `mentioned_user_ids` is required-but-defaulted to `[]` so the FE can
 * post a body-only comment without the array; that mirrors the
 * `task.collaborator_ids` ergonomic.
 */

const objectIdSchema = z.string().regex(/^[a-f0-9]{24}$/i, 'Must be a valid ObjectId');

// ─── POST /tasks/:task_id/comments ────────────────────────────────────────

export const createCommentBodySchema = z.object({
    body: z.string().trim().min(1, 'Comment body is required').max(COMMENT_BODY_MAX),
    mentioned_user_ids: z.array(objectIdSchema).max(COMMENT_MENTIONS_MAX).optional().default([]),
});
export type CreateCommentBody = z.infer<typeof createCommentBodySchema>;

// ─── PATCH /comments/:id ──────────────────────────────────────────────────
//
// Only `body` and `mentioned_user_ids` are editable. Mentions on edit are
// re-validated in the service exactly the same way as on create — adding
// a mention to a non-member is rejected; removing a mention does NOT
// retract the previous notification (those are write-only).

export const patchCommentBodySchema = z
    .object({
        body: z.string().trim().min(1).max(COMMENT_BODY_MAX),
        mentioned_user_ids: z.array(objectIdSchema).max(COMMENT_MENTIONS_MAX),
    })
    .partial()
    .refine((d) => Object.keys(d).length > 0, { message: 'At least one field must be supplied' });
export type PatchCommentBody = z.infer<typeof patchCommentBodySchema>;

// ─── GET /tasks/:task_id/comments ─────────────────────────────────────────

export const listCommentsQuerySchema = z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(COMMENT_LIST_MAX_LIMIT).default(COMMENT_LIST_DEFAULT_LIMIT),
    /**
     * `include_deleted` is admin/manager-only; the service silently
     * ignores it for any other role. Default off so the bell + UI never
     * accidentally render tombstones.
     *
     * H4: was `z.coerce.boolean()` which coerces "false" → true.
     * `booleanish` is fail-loud on non-canonical values.
     */
    include_deleted: booleanish.optional().default(false),
}).strict();
export type ListCommentsQuery = z.infer<typeof listCommentsQuerySchema>;

// ─── Path params ──────────────────────────────────────────────────────────

export const taskIdPathSchema = z.object({ task_id: objectIdSchema });
export type TaskIdPath = z.infer<typeof taskIdPathSchema>;

export const commentIdPathSchema = z.object({ id: objectIdSchema });
export type CommentIdPath = z.infer<typeof commentIdPathSchema>;
