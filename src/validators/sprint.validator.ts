import { z } from 'zod';

import {
    SPRINT_GOAL_MAX,
    SPRINT_LIST_DEFAULT_LIMIT,
    SPRINT_LIST_MAX_LIMIT,
    SPRINT_NAME_MAX,
    SPRINT_STATUS_VALUES,
} from '../constants/project.js';

/**
 * Zod schemas for `/sprints` (API_Contract.md §7.3).
 *
 * Sprints are nested under a project on create + list (so the route prefix
 * carries the `project_id` param) but addressable directly on get/patch/delete
 * via their own ObjectId.
 *
 * The `start_date <= end_date` cross-field check happens here for fail-fast;
 * the *project-window* check (sprint must fit in the project's start/end
 * window) lives in the service since it needs the project doc.
 */

const objectIdSchema = z.string().regex(/^[a-f0-9]{24}$/i, 'Must be a valid ObjectId');
const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD');

// ─── POST /projects/:project_id/sprints ───────────────────────────────────

export const createSprintBodySchema = z
    .object({
        name: z.string().trim().min(1).max(SPRINT_NAME_MAX),
        goal: z.string().trim().max(SPRINT_GOAL_MAX).default(''),
        start_date: isoDateSchema,
        end_date: isoDateSchema,
        status: z.enum(SPRINT_STATUS_VALUES as unknown as [string, ...string[]]).optional(),
    })
    .refine((d) => d.end_date >= d.start_date, {
        path: ['end_date'],
        message: 'end_date must be on or after start_date',
    });

export type CreateSprintBody = z.infer<typeof createSprintBodySchema>;

// ─── PATCH /sprints/:id ───────────────────────────────────────────────────

export const patchSprintBodySchema = z
    .object({
        name: z.string().trim().min(1).max(SPRINT_NAME_MAX),
        goal: z.string().trim().max(SPRINT_GOAL_MAX),
        start_date: isoDateSchema,
        end_date: isoDateSchema,
        status: z.enum(SPRINT_STATUS_VALUES as unknown as [string, ...string[]]),
    })
    .partial()
    .refine((d) => Object.keys(d).length > 0, { message: 'At least one field must be supplied' })
    .refine((d) => d.start_date === undefined || d.end_date === undefined || d.end_date >= d.start_date, {
        path: ['end_date'],
        message: 'end_date must be on or after start_date',
    });

export type PatchSprintBody = z.infer<typeof patchSprintBodySchema>;

// ─── GET /projects/:project_id/sprints ────────────────────────────────────

export const listSprintsQuerySchema = z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(SPRINT_LIST_MAX_LIMIT).default(SPRINT_LIST_DEFAULT_LIMIT),
    status: z.enum(SPRINT_STATUS_VALUES as unknown as [string, ...string[]]).optional(),
    /**
     * F1 — archived-sprint filter (mirrors the project pattern).
     * Default behaviour (param absent): only ACTIVE sprints (`is_archived: false`).
     * Pass `?is_archived=true` to see archived ones; pass `?is_archived=false`
     * for symmetry. The string-or-bool union handles both URL query
     * (`?is_archived=true` arrives as a string) and any future
     * direct-call shape.
     */
    is_archived: z
        .union([z.literal('true'), z.literal('false'), z.boolean()])
        .transform((v) => (typeof v === 'boolean' ? v : v === 'true'))
        .optional(),
});

export type ListSprintsQuery = z.infer<typeof listSprintsQuerySchema>;

// ─── Path params ──────────────────────────────────────────────────────────

export const sprintIdParamSchema = z.object({ id: objectIdSchema });
export type SprintIdParam = z.infer<typeof sprintIdParamSchema>;

export const projectSprintParamsSchema = z.object({ project_id: objectIdSchema });
export type ProjectSprintParams = z.infer<typeof projectSprintParamsSchema>;
