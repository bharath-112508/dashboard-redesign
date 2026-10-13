import { z } from 'zod';

import {
    STORY_DERIVED_STATUS_VALUES,
    STORY_DESCRIPTION_MAX,
    STORY_LIST_DEFAULT_LIMIT,
    STORY_LIST_MAX_LIMIT,
    STORY_TITLE_MAX,
} from '../constants/story.js';

/**
 * Zod schemas for `/stories` and `/projects/:project_id/stories`
 * (API_Contract §7.4).
 *
 * The story endpoints are deliberately spartan — there are no member /
 * client / status sub-resources here, so the schemas are tiny.
 *
 *  - `position` is OPTIONAL on create. When omitted, the service appends
 *    the new story at the end of the project's list.
 *  - PATCH allows position changes; the service routes them through the
 *    same shift logic as the dedicated reorder endpoint so callers don't
 *    have to know which one to use.
 *  - `status` on the LIST endpoint filters the response **after** server-
 *    side derivation (the client doesn't know which custom statuses count
 *    as "blocked"; only the project does).
 */

const objectIdSchema = z.string().regex(/^[a-f0-9]{24}$/i, 'Must be a valid ObjectId');

// ─── Bodies ───────────────────────────────────────────────────────────────

const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD');
const textList = z.array(z.string().trim().max(500)).max(50);

/** Redesign: the epic document the app edits. */
const epicDocumentFields = {
    goal: z.string().trim().max(2000),
    user_story: z.string().trim().max(2000),
    criteria: textList,
    criteria_done: z.array(z.number().int().min(0)).max(50),
    target_date: isoDateSchema.nullable(),
    in_scope: textList,
    out_scope: textList,
    requirements: textList,
    risks: textList,
    open_questions: textList,
};

export const createStoryBodySchema = z.object({
    title: z.string().trim().min(1).max(STORY_TITLE_MAX),
    description: z.string().trim().max(STORY_DESCRIPTION_MAX).default(''),
    position: z.number().int().min(0).optional(),
    ...Object.fromEntries(Object.entries(epicDocumentFields).map(([k, v]) => [k, v.optional()])),
});
export type CreateStoryBody = z.infer<typeof createStoryBodySchema>;

export const patchStoryBodySchema = z
    .object({
        title: z.string().trim().min(1).max(STORY_TITLE_MAX),
        description: z.string().trim().max(STORY_DESCRIPTION_MAX),
        position: z.number().int().min(0),
        ...epicDocumentFields,
    })
    .partial()
    .refine((d) => Object.keys(d).length > 0, { message: 'At least one field must be supplied' });
export type PatchStoryBody = z.infer<typeof patchStoryBodySchema>;

export const reorderStoryBodySchema = z.object({
    position: z.number().int().min(0),
});
export type ReorderStoryBody = z.infer<typeof reorderStoryBodySchema>;

// ─── Queries ──────────────────────────────────────────────────────────────

export const listStoriesQuerySchema = z
    .object({
        page: z.coerce.number().int().min(1).default(1),
        limit: z.coerce.number().int().min(1).max(STORY_LIST_MAX_LIMIT).default(STORY_LIST_DEFAULT_LIMIT),
        status: z.enum(STORY_DERIVED_STATUS_VALUES as unknown as [string, ...string[]]).optional(),
        // R15 — minimum 2 chars to avoid full-collection regex scans on `?q=a`.
        q: z.string().trim().min(2, 'q must be at least 2 characters').max(100).optional(),
    })
    .strict();
export type ListStoriesQuery = z.infer<typeof listStoriesQuerySchema>;

export const listStoryTasksQuerySchema = z
    .object({
        page: z.coerce.number().int().min(1).default(1),
        limit: z.coerce.number().int().min(1).max(STORY_LIST_MAX_LIMIT).default(STORY_LIST_DEFAULT_LIMIT),
    })
    .strict();
export type ListStoryTasksQuery = z.infer<typeof listStoryTasksQuerySchema>;

// ─── Path params ──────────────────────────────────────────────────────────

export const storyIdParamSchema = z.object({ id: objectIdSchema });
export type StoryIdParam = z.infer<typeof storyIdParamSchema>;

export const projectStoryParamsSchema = z.object({ project_id: objectIdSchema });
export type ProjectStoryParams = z.infer<typeof projectStoryParamsSchema>;
