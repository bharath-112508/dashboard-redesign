import { z } from 'zod';

import {
    ACTIVITY_LIST_DEFAULT_LIMIT,
    ACTIVITY_LIST_MAX_LIMIT,
    TASK_ACTIVITY_TYPE_VALUES,
} from '../constants/task-activity.js';

/**
 * Zod schemas for `GET /tasks/:task_id/activity` (API_Contract.md §8.6).
 *
 * The endpoint is read-only in Phase 1 — there is no POST. Activity rows
 * are written by the task service hooks.
 *
 * `activity_type` filter accepts a single value to keep the query string
 * shape simple. CSV / array filtering can be added later if the FE
 * needs it.
 */

const objectIdSchema = z.string().regex(/^[a-f0-9]{24}$/i, 'Must be a valid ObjectId');

export const listActivitiesQuerySchema = z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(ACTIVITY_LIST_MAX_LIMIT).default(ACTIVITY_LIST_DEFAULT_LIMIT),
    activity_type: z.enum(TASK_ACTIVITY_TYPE_VALUES as unknown as [string, ...string[]]).optional(),
    actor_id: objectIdSchema.optional(),
    /**
     * When `true`, also include activities for direct subtasks of the task
     * (one level — matches the FE depth cap). Default `false` keeps the
     * historical scoping where callers only see the task's own activity.
     */
    include_subtasks: z.coerce.boolean().default(false),
}).strict();
export type ListActivitiesQuery = z.infer<typeof listActivitiesQuerySchema>;

export const taskActivityPathSchema = z.object({ task_id: objectIdSchema });
export type TaskActivityPath = z.infer<typeof taskActivityPathSchema>;
