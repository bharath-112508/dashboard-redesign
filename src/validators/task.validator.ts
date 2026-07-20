import { z } from 'zod';

import {
    DEFAULT_TASK_STATUSES,
    TASK_COLLABORATORS_MAX,
    TASK_DEPENDENCIES_MAX,
    TASK_DESCRIPTION_MAX,
    TASK_ESTIMATED_HOURS_MAX,
    TASK_ISSUE_TYPE_VALUES,
    TASK_LIST_DEFAULT_LIMIT,
    TASK_LIST_MAX_LIMIT,
    TASK_PRIORITY_VALUES,
    TASK_STATUS_KEY_MAX,
    TASK_STORY_POINT_VALUES,
    TASK_TITLE_MAX,
} from '../constants/task.js';

/**
 * Zod schemas for `/tasks` (API_Contract.md §8).
 *
 * Validation strategy:
 *  - Schema-level: shape, types, length caps, enum membership for `priority`,
 *    YYYY-MM-DD date format. Anything that's checkable without DB access.
 *  - Service-level: cross-document checks — project membership for assignee /
 *    collaborators, project match for sprint/story/parent, status against the
 *    project's defaults+customs, dependency cycle detection.
 *
 * The `q.story_id` query parameter accepts the **literal string `"null"`** as
 * a sentinel for "no story" — without it there's no way to query for tasks
 * sitting outside any story (you can't pass `null` in a query string). The
 * service translates that sentinel to a Mongo `{ story_id: null }` filter.
 */

const objectIdSchema = z.string().regex(/^[a-f0-9]{24}$/i, 'Must be a valid ObjectId');
const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD');

/**
 * BUG-041 — Done tasks can't have a future due date. The user picks the
 * status BEFORE the due date in the form, and once they've said it's
 * already finished, a future due date is nonsensical. The rule fires only
 * when both `status` and `due_date` are present in the payload (PATCH may
 * omit either independently).
 *
 * "Today" is server-local YYYY-MM-DD. We compare strings — ISO 8601 dates
 * are lexicographically sortable so `due_date <= todayIso` is equivalent
 * to a calendar comparison without needing a timezone library here.
 */
const todayIso = (): string => {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

const enforceNoFutureDoneDate = <T extends { status?: string | undefined; due_date?: string | undefined }>(
    data: T,
    ctx: z.RefinementCtx
): void => {
    if (data.status !== DEFAULT_TASK_STATUSES.DONE) return;
    if (!data.due_date) return;
    if (data.due_date <= todayIso()) return;
    ctx.addIssue({
        code: 'custom',
        path: ['due_date'],
        message: "Tasks marked Done can't have a future due date — pick today or an earlier date.",
    });
};

// Shared sub-shape for create/patch optional ID fields. `null` is meaningful
// for `sprint_id` (backlog) / `story_id` (no story) / `parent_task_id` (top-
// level) — coercing to `undefined` would lose the user's intent to detach.
const optionalNullableObjectId = z.union([objectIdSchema, z.null()]).optional();

// Issue type + story points. `story_points` accepts `null` (unestimated) or a
// value from the Fibonacci set — a free number is rejected so board sums stay
// meaningful. `task_number` is intentionally absent from every schema: it is
// server-assigned and would be stripped from any client payload.
const issueTypeSchema = z.enum(TASK_ISSUE_TYPE_VALUES as unknown as [string, ...string[]]);
const storyPointsSchema = z.union([
    z.number().refine((v) => TASK_STORY_POINT_VALUES.includes(v), {
        message: `story_points must be one of ${TASK_STORY_POINT_VALUES.join(', ')}`,
    }),
    z.null(),
]);

// ─── POST /tasks ──────────────────────────────────────────────────────────

export const createTaskBodySchema = z
    .object({
        project_id: objectIdSchema,
        sprint_id: optionalNullableObjectId,
        story_id: optionalNullableObjectId,
        parent_task_id: optionalNullableObjectId,
        title: z.string().trim().min(1).max(TASK_TITLE_MAX),
        description: z.string().trim().max(TASK_DESCRIPTION_MAX).default(''),
        status: z.string().trim().min(1).max(TASK_STATUS_KEY_MAX).optional(),
        priority: z.enum(TASK_PRIORITY_VALUES as unknown as [string, ...string[]]).optional(),
        issue_type: issueTypeSchema.optional(),
        story_points: storyPointsSchema.optional(),
        due_date: isoDateSchema,
        estimated_hours: z.number().min(0).max(TASK_ESTIMATED_HOURS_MAX).optional(),
        primary_assignee_id: optionalNullableObjectId,
        collaborator_ids: z.array(objectIdSchema).max(TASK_COLLABORATORS_MAX).optional(),
        depends_on_task_ids: z.array(objectIdSchema).max(TASK_DEPENDENCIES_MAX).optional(),
        position: z.number().int().min(0).optional(),
    })
    .superRefine(enforceNoFutureDoneDate);
export type CreateTaskBody = z.infer<typeof createTaskBodySchema>;

// ─── PATCH /tasks/:id ─────────────────────────────────────────────────────
//
// All fields optional but at least one required. `project_id` is intentionally
// NOT patchable — moving a task between projects is a different (multi-step)
// operation that doesn't ship in v1.

export const patchTaskBodySchema = z
    .object({
        sprint_id: optionalNullableObjectId,
        story_id: optionalNullableObjectId,
        title: z.string().trim().min(1).max(TASK_TITLE_MAX),
        description: z.string().trim().max(TASK_DESCRIPTION_MAX),
        status: z.string().trim().min(1).max(TASK_STATUS_KEY_MAX),
        priority: z.enum(TASK_PRIORITY_VALUES as unknown as [string, ...string[]]),
        issue_type: issueTypeSchema,
        story_points: storyPointsSchema,
        due_date: isoDateSchema,
        estimated_hours: z.number().min(0).max(TASK_ESTIMATED_HOURS_MAX),
        primary_assignee_id: optionalNullableObjectId,
        collaborator_ids: z.array(objectIdSchema).max(TASK_COLLABORATORS_MAX),
        position: z.number().int().min(0),
    })
    .partial()
    .refine((d) => Object.keys(d).length > 0, { message: 'At least one field must be supplied' })
    // BUG-041 — same Done/future-date rule as createTaskBodySchema. Note
    // the patch path may carry only one of {status, due_date}: the
    // refinement no-ops in that case (the service layer applies the
    // patch then revalidates the resulting state if needed).
    .superRefine(enforceNoFutureDoneDate);
export type PatchTaskBody = z.infer<typeof patchTaskBodySchema>;

// ─── POST /tasks/:id/reorder ──────────────────────────────────────────────

export const reorderTaskBodySchema = z.object({
    position: z.number().int().min(0),
    /**
     * Optional — when present, the task moves to this column AND the new
     * position is interpreted within that column. When omitted, the task
     * stays in its current `status` column. This matches Kanban DnD where
     * dropping into a different column implies a status change.
     */
    status: z.string().trim().min(1).max(TASK_STATUS_KEY_MAX).optional(),
});
export type ReorderTaskBody = z.infer<typeof reorderTaskBodySchema>;

// ─── POST /tasks/:id/assign-story ─────────────────────────────────────────

export const assignStoryBodySchema = z.object({
    story_id: z.union([objectIdSchema, z.null()]),
});
export type AssignStoryBody = z.infer<typeof assignStoryBodySchema>;

// ─── POST /tasks/:id/move-sprint ──────────────────────────────────────────

export const moveSprintBodySchema = z.object({
    sprint_id: z.union([objectIdSchema, z.null()]),
});
export type MoveSprintBody = z.infer<typeof moveSprintBodySchema>;

// ─── POST /tasks/:id/dependencies ─────────────────────────────────────────

export const addDependencyBodySchema = z.object({
    depends_on_task_id: objectIdSchema,
});
export type AddDependencyBody = z.infer<typeof addDependencyBodySchema>;

// ─── GET /tasks (filters) ─────────────────────────────────────────────────

export const listTasksQuerySchema = z
    .object({
        page: z.coerce.number().int().min(1).default(1),
        limit: z.coerce.number().int().min(1).max(TASK_LIST_MAX_LIMIT).default(TASK_LIST_DEFAULT_LIMIT),
        project_id: objectIdSchema.optional(),
        sprint_id: objectIdSchema.optional(),
        /**
         * `story_id=null` literal sentinel selects tasks with no story. Without
         * the literal, `story_id=<ObjectId>` filters to that story. Without the
         * param at all, no story filter is applied.
         */
        story_id: z.union([objectIdSchema, z.literal('null')]).optional(),
        assignee_id: objectIdSchema.optional(),
        status: z.string().trim().min(1).max(TASK_STATUS_KEY_MAX).optional(),
        priority: z.enum(TASK_PRIORITY_VALUES as unknown as [string, ...string[]]).optional(),
        due_before: isoDateSchema.optional(),
        parent_task_id: z.union([objectIdSchema, z.literal('null')]).optional(),
        // R15 — minimum 2 chars to avoid full-collection regex scans on `?q=a`.
        q: z.string().trim().min(2, 'q must be at least 2 characters').max(100).optional(),
    })
    .strict();
export type ListTasksQuery = z.infer<typeof listTasksQuerySchema>;

// ─── Path params ──────────────────────────────────────────────────────────

export const taskIdParamSchema = z.object({ id: objectIdSchema });
export type TaskIdParam = z.infer<typeof taskIdParamSchema>;

export const taskDependencyParamsSchema = z.object({ id: objectIdSchema, dep_id: objectIdSchema });
export type TaskDependencyParams = z.infer<typeof taskDependencyParamsSchema>;
