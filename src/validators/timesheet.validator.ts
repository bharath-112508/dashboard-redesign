import { z } from 'zod';

import {
    TIMESHEET_DESCRIPTION_MAX,
    TIMESHEET_ENTRY_TYPES,
    TIMESHEET_GENERAL_CATEGORY_MAX,
    TIMESHEET_HOURS_MAX,
    TIMESHEET_LIST_DEFAULT_LIMIT,
    TIMESHEET_LIST_MAX_LIMIT,
    TIMESHEET_MINUTES_MAX,
    TIMESHEET_SUMMARY_GROUP_BY,
} from '../constants/timesheet.js';

/**
 * Zod schemas for `/timesheets/*` (API_Contract.md §9.1–9.4 /
 * BUILD_PROGRESS.md Step 23).
 *
 * The shape splits along `entry_type`:
 *   - `task_linked` → `project_id` + `task_id` are required, `general_category` must be null.
 *   - `general`     → `general_category` is required, `task_id` must be null.
 *
 * We use a discriminated union so Zod gives a useful per-branch error
 * instead of a fan of "expected/forbidden" messages on every field.
 *
 * Cross-field rules that require *runtime* state (project visibility,
 * `local_date <= today`, billable+non-billable > 0) live in the service
 * — duplicating them here would couple the validator to the date module
 * and the project ACL.
 */

const objectIdSchema = z.string().regex(/^[a-f0-9]{24}$/i, 'Must be a valid ObjectId');
const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be a YYYY-MM-DD date');

// Shared duration shape — same on create and patch.
const durationSchema = z.object({
    billable_hours: z.number().int().min(0).max(TIMESHEET_HOURS_MAX),
    billable_minutes: z.number().int().min(0).max(TIMESHEET_MINUTES_MAX),
    non_billable_hours: z.number().int().min(0).max(TIMESHEET_HOURS_MAX),
    non_billable_minutes: z.number().int().min(0).max(TIMESHEET_MINUTES_MAX),
});

// ─── POST /timesheets ────────────────────────────────────────────────────

const taskLinkedCreateSchema = z
    .object({
        local_date: isoDateSchema,
        entry_type: z.literal(TIMESHEET_ENTRY_TYPES.TASK_LINKED),
        project_id: objectIdSchema,
        sprint_id: objectIdSchema.optional().nullable(),
        task_id: objectIdSchema,
        general_category: z.null().optional(),
        description: z.string().trim().max(TIMESHEET_DESCRIPTION_MAX).optional().default(''),
    })
    .extend(durationSchema.shape);

const generalCreateSchema = z
    .object({
        local_date: isoDateSchema,
        entry_type: z.literal(TIMESHEET_ENTRY_TYPES.GENERAL),
        project_id: objectIdSchema.nullable().optional(),
        sprint_id: z.null().optional(),
        task_id: z.null().optional(),
        general_category: z.string().trim().min(1).max(TIMESHEET_GENERAL_CATEGORY_MAX),
        description: z.string().trim().max(TIMESHEET_DESCRIPTION_MAX).optional().default(''),
    })
    .extend(durationSchema.shape);

export const createTimesheetBodySchema = z.discriminatedUnion('entry_type', [
    taskLinkedCreateSchema,
    generalCreateSchema,
]);
export type CreateTimesheetBody = z.infer<typeof createTimesheetBodySchema>;

// ─── PATCH /timesheets/:id ───────────────────────────────────────────────
//
// PATCH does NOT allow swapping `entry_type` — that's effectively a
// different row. Edits cover hours/minutes, description, and (for
// task_linked) sprint/task drift.

export const patchTimesheetBodySchema = z
    .object({
        billable_hours: z.number().int().min(0).max(TIMESHEET_HOURS_MAX),
        billable_minutes: z.number().int().min(0).max(TIMESHEET_MINUTES_MAX),
        non_billable_hours: z.number().int().min(0).max(TIMESHEET_HOURS_MAX),
        non_billable_minutes: z.number().int().min(0).max(TIMESHEET_MINUTES_MAX),
        description: z.string().trim().max(TIMESHEET_DESCRIPTION_MAX),
        general_category: z.string().trim().min(1).max(TIMESHEET_GENERAL_CATEGORY_MAX),
        sprint_id: objectIdSchema.nullable(),
        task_id: objectIdSchema,
    })
    .partial()
    .refine((d) => Object.keys(d).length > 0, { message: 'At least one field must be supplied' });
export type PatchTimesheetBody = z.infer<typeof patchTimesheetBodySchema>;

// ─── GET /timesheets/me & /timesheets ────────────────────────────────────
//
// Manager list adds `user_id`; self list omits it. We accept both shapes
// in one schema and let the service filter — managers see everything,
// non-managers get their own row regardless of any `user_id` they pass.

export const listTimesheetsQuerySchema = z.object({
    user_id: objectIdSchema.optional(),
    project_id: objectIdSchema.optional(),
    task_id: objectIdSchema.optional(),
    from_date: isoDateSchema.optional(),
    to_date: isoDateSchema.optional(),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(TIMESHEET_LIST_MAX_LIMIT).default(TIMESHEET_LIST_DEFAULT_LIMIT),
}).strict();
export type ListTimesheetsQuery = z.infer<typeof listTimesheetsQuerySchema>;

// ─── GET /timesheets/summary ─────────────────────────────────────────────

export const summaryQuerySchema = z.object({
    user_id: objectIdSchema.optional(),
    project_id: objectIdSchema.optional(),
    task_id: objectIdSchema.optional(),
    from_date: isoDateSchema.optional(),
    to_date: isoDateSchema.optional(),
    group_by: z.enum(TIMESHEET_SUMMARY_GROUP_BY).default('project'),
});
export type SummaryQuery = z.infer<typeof summaryQuerySchema>;

// ─── Path params ─────────────────────────────────────────────────────────

export const timesheetIdPathSchema = z.object({ id: objectIdSchema });
export type TimesheetIdPath = z.infer<typeof timesheetIdPathSchema>;

export const dayDatePathSchema = z.object({ date: isoDateSchema });
export type DayDatePath = z.infer<typeof dayDatePathSchema>;
