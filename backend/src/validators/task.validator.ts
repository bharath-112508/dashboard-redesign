import { z } from 'zod';

import { booleanish } from './_shared.js';

import {
    DEFAULT_TASK_STATUSES,
    TASK_COLLABORATORS_MAX,
    TASK_DEPENDENCIES_MAX,
    TASK_DESCRIPTION_MAX,
    TASK_ESTIMATED_HOURS_MAX,
    TASK_ISSUE_TYPE_VALUES,
    TASK_LABELS_MAX,
    TASK_LABEL_MAX_LEN,
    TASK_LIST_DEFAULT_LIMIT,
    TASK_LIST_MAX_LIMIT,
    TASK_MAX_ASSIGNEES,
    TASK_PRIORITY_VALUES,
    TASK_REPORT_KIND_VALUES,
    TASK_REPORT_PRIORITY_VALUES,
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
/**
 * A due date is REQUIRED on every task — the model says so, and the product
 * rule is that every piece of work carries a deadline.
 *
 * The message matters because this is the one field people meet it on. A
 * missing or empty value used to come back as "Must be YYYY-MM-DD", which
 * reads as "you formatted it wrong" when in fact nothing was sent at all —
 * exactly the confusion behind the subtask reports.
 */
const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be a YYYY-MM-DD date');

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

const enforceNoFutureDoneDate = <T extends { status?: string | undefined; due_date?: string | null | undefined }>(
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

// Freeform Jira-style labels (Phase 3c). Each label is trimmed and length-
// capped at the element level (so an over-long tag is a clean 400), then the
// array-level transform drops empty/whitespace-only entries and dedupes
// case-insensitively — the FIRST spelling of a label wins (so `["Bug", "bug"]`
// collapses to `["Bug"]`). The raw-array `.max` cap rejects an over-stuffed
// payload before the transform runs. `.min(1)` is intentionally NOT applied to
// the element so empties are DROPPED (per contract) rather than rejected.
export const labelsSchema = z
    .array(z.string().trim().max(TASK_LABEL_MAX_LEN))
    .max(TASK_LABELS_MAX)
    .transform((labels) => {
        const out: string[] = [];
        const seen = new Set<string>();
        for (const raw of labels) {
            const label = raw.trim();
            if (label.length === 0) continue;
            const key = label.toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            out.push(label);
        }
        return out;
    });

// ─── POST /tasks ──────────────────────────────────────────────────────────

/**
 * Client-side issue report OR feature request. `.strict()` matters here: a
 * client sending `assignee_ids` or `sprint_id` gets a 400 rather than having it
 * quietly dropped, so nobody is left believing they set something they did not.
 * Everything not listed is decided server-side — see `createTaskReport`.
 *
 * `kind` is the client-facing vocabulary, deliberately NOT the internal
 * `issue_type` enum: the two are mapped in the service. A customer should not
 * have to know that our word for "feature request" is `improvement`, and
 * pinning the wire contract to the internal enum would make renaming that enum
 * a breaking API change.
 */
export const createTaskReportBodySchema = z
    .object({
        project_id: objectIdSchema,
        kind: z.enum(TASK_REPORT_KIND_VALUES as unknown as [string, ...string[]]).default('issue'),
        title: z.string().trim().min(1).max(TASK_TITLE_MAX),
        description: z.string().trim().max(TASK_DESCRIPTION_MAX).default(''),
        // A suggestion the team may override during triage.
        priority: z.enum(TASK_REPORT_PRIORITY_VALUES).optional(),
    })
    .strict();

export type CreateTaskReportBody = z.infer<typeof createTaskReportBodySchema>;

const ONE_ASSIGNEE_MSG = 'A ticket has one assignee — add others as contributors.';

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
        labels: labelsSchema.optional(),
        // Optional: `null`/omitted = no due date.
        due_date: isoDateSchema.nullable().optional(),
        /** Redesign: when work on the ticket starts (the timeline bar's left end). */
        start_date: isoDateSchema.nullable().optional(),
        estimated_hours: z.number().min(0).max(TASK_ESTIMATED_HOURS_MAX).optional(),
        // At most one assignee (TASK_MAX_ASSIGNEES). `primary_assignee_id` is still
        // accepted for older clients; the service keeps the two in sync.
        assignee_ids: z.array(objectIdSchema).max(TASK_MAX_ASSIGNEES, ONE_ASSIGNEE_MSG).optional(),
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
        labels: labelsSchema,
        // `null` clears the due date.
        due_date: isoDateSchema.nullable(),
        start_date: isoDateSchema.nullable(),
        estimated_hours: z.number().min(0).max(TASK_ESTIMATED_HOURS_MAX),
        is_flagged: z.boolean(),
        assignee_ids: z.array(objectIdSchema).max(TASK_MAX_ASSIGNEES, ONE_ASSIGNEE_MSG),
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

// ─── POST /tasks/:id/rank ─────────────────────────────────────────────────
//
// Phase 2 Backlog — reorder a task within the per-project `backlog_rank`
// ordering. The body names the neighbour the task should land AFTER or
// BEFORE. Both omitted / null ⇒ move to the top. At most one may be set —
// providing both is contradictory.

export const rankTaskBodySchema = z
    .object({
        after_task_id: optionalNullableObjectId,
        before_task_id: optionalNullableObjectId,
    })
    .refine((d) => !(d.after_task_id && d.before_task_id), {
        message: 'Provide at most one of after_task_id or before_task_id',
        path: ['before_task_id'],
    });
export type RankTaskBody = z.infer<typeof rankTaskBodySchema>;

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
        /**
         * `assignee_id=null` literal sentinel selects UNASSIGNED tasks — the
         * triage queue. Same shape as `story_id` / `parent_task_id` below.
         */
        assignee_id: z.union([objectIdSchema, z.literal('null')]).optional(),
        status: z.string().trim().min(1).max(TASK_STATUS_KEY_MAX).optional(),
        /** `client` = raised from the client side (the client Board's "Raised by you"). */
        source: z.enum(['client']).optional(),
        priority: z.enum(TASK_PRIORITY_VALUES as unknown as [string, ...string[]]).optional(),
        due_before: isoDateSchema.optional(),
        parent_task_id: z.union([objectIdSchema, z.literal('null')]).optional(),
        // R15 — minimum 2 chars to avoid full-collection regex scans on `?q=a`.
        q: z.string().trim().min(2, 'q must be at least 2 characters').max(100).optional(),
        /** Board only: add `cover_url` (newest image attachment, signed). */
        include_cover: booleanish.optional(),
    })
    .strict();
export type ListTasksQuery = z.infer<typeof listTasksQuerySchema>;

// ─── Path params ──────────────────────────────────────────────────────────

export const taskIdParamSchema = z.object({ id: objectIdSchema });
export type TaskIdParam = z.infer<typeof taskIdParamSchema>;

export const taskDependencyParamsSchema = z.object({ id: objectIdSchema, dep_id: objectIdSchema });
export type TaskDependencyParams = z.infer<typeof taskDependencyParamsSchema>;
