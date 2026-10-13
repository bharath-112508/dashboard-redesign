import { z } from 'zod';

import {
    TASK_TEMPLATE_DAY_OF_MONTH_MAX,
    TASK_TEMPLATE_DESCRIPTION_MAX,
    TASK_TEMPLATE_DUE_OFFSET_MAX_DAYS,
    TASK_TEMPLATE_FREQUENCIES,
    TASK_TEMPLATE_LIST_DEFAULT_LIMIT,
    TASK_TEMPLATE_LIST_MAX_LIMIT,
    TASK_TEMPLATE_NAME_MAX,
    TASK_TEMPLATE_TITLE_MAX,
} from '../constants/task-template.js';
import { TASK_PRIORITY_VALUES } from '../constants/task.js';

/**
 * Zod validators for `/projects/:id/task-templates` and
 * `/task-templates/:id` (Phase 4 Step 40).
 *
 * Recurrence cross-field rules:
 *  - frequency=weekly → weekdays must be non-empty; day_of_month null
 *  - frequency=monthly → day_of_month required; weekdays empty
 *  - frequency=daily → both empty/null
 *  - start_date <= end_date (when end_date set)
 *
 * Validating these in the schema (rather than the service) lets the
 * FE build a useful inline error path (`recurrence.weekdays` etc.) and
 * keeps the service's call sites narrow — the service trusts the
 * recurrence sub-doc shape if it survives validation.
 */

const objectIdSchema = z.string().regex(/^[a-f0-9]{24}$/i, 'Must be a valid ObjectId');
const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be a YYYY-MM-DD date');

// ─── Recurrence sub-doc ────────────────────────────────────────────────

const recurrenceSchema = z
    .object({
        enabled: z.boolean().default(true),
        frequency: z.enum(TASK_TEMPLATE_FREQUENCIES),
        weekdays: z.array(z.number().int().min(0).max(6)).default([]),
        day_of_month: z.number().int().min(1).max(TASK_TEMPLATE_DAY_OF_MONTH_MAX).nullable().default(null),
        start_date: isoDateSchema,
        end_date: isoDateSchema.nullable().default(null),
    })
    .strict()
    .refine(
        (r) => {
            if (r.frequency === 'weekly') return r.weekdays.length > 0 && r.day_of_month === null;
            if (r.frequency === 'monthly') return r.weekdays.length === 0 && r.day_of_month !== null;
            // daily
            return r.weekdays.length === 0 && r.day_of_month === null;
        },
        {
            message:
                'recurrence shape must match frequency: weekly requires non-empty weekdays + null day_of_month; ' +
                'monthly requires non-null day_of_month + empty weekdays; daily requires both empty/null',
            path: ['recurrence'],
        }
    )
    .refine((r) => !r.end_date || r.start_date <= r.end_date, {
        message: 'end_date must be on or after start_date',
        path: ['end_date'],
    })
    // Dedupe weekdays so two entries for "Monday" don't trigger twice
    // a week. Done in the validator (rather than the service) so the
    // round-trip from the FE preserves what the user actually intended.
    .transform((r) => ({ ...r, weekdays: Array.from(new Set(r.weekdays)).sort((a, b) => a - b) }));

// ─── Body schemas ──────────────────────────────────────────────────────

const baseFields = {
    name: z.string().trim().min(1).max(TASK_TEMPLATE_NAME_MAX),
    title: z.string().trim().min(1).max(TASK_TEMPLATE_TITLE_MAX),
    description: z.string().max(TASK_TEMPLATE_DESCRIPTION_MAX).default(''),
    priority: z.enum(TASK_PRIORITY_VALUES as [string, ...string[]]).default('medium'),
    default_assignee_id: objectIdSchema.nullable().default(null),
    default_collaborator_ids: z.array(objectIdSchema).default([]),
    default_story_id: objectIdSchema.nullable().default(null),
    default_sprint_id: objectIdSchema.nullable().default(null),
    default_due_offset_days: z.number().int().min(0).max(TASK_TEMPLATE_DUE_OFFSET_MAX_DAYS).nullable().default(null),
    default_estimated_hours: z.number().min(0).default(0),
    recurrence: recurrenceSchema.nullable().default(null),
};

export const createTaskTemplateBodySchema = z.object(baseFields).strict();
export type CreateTaskTemplateBody = z.infer<typeof createTaskTemplateBodySchema>;

export const patchTaskTemplateBodySchema = z
    .object({
        name: baseFields.name.optional(),
        title: baseFields.title.optional(),
        description: baseFields.description.optional(),
        priority: baseFields.priority.optional(),
        default_assignee_id: baseFields.default_assignee_id.optional(),
        default_collaborator_ids: baseFields.default_collaborator_ids.optional(),
        default_story_id: baseFields.default_story_id.optional(),
        default_sprint_id: baseFields.default_sprint_id.optional(),
        default_due_offset_days: baseFields.default_due_offset_days.optional(),
        default_estimated_hours: baseFields.default_estimated_hours.optional(),
        recurrence: baseFields.recurrence.optional(),
        is_archived: z.boolean().optional(),
    })
    .strict();
export type PatchTaskTemplateBody = z.infer<typeof patchTaskTemplateBodySchema>;

// ─── List query ────────────────────────────────────────────────────────

export const listTaskTemplatesQuerySchema = z
    .object({
        is_archived: z
            .union([z.literal('true'), z.literal('false'), z.boolean()])
            .transform((v) => (typeof v === 'boolean' ? v : v === 'true'))
            .optional(),
        recurring_only: z
            .union([z.literal('true'), z.literal('false'), z.boolean()])
            .transform((v) => (typeof v === 'boolean' ? v : v === 'true'))
            .optional(),
        page: z.coerce.number().int().min(1).default(1),
        limit: z.coerce
            .number()
            .int()
            .min(1)
            .max(TASK_TEMPLATE_LIST_MAX_LIMIT)
            .default(TASK_TEMPLATE_LIST_DEFAULT_LIMIT),
    })
    .strict();
export type ListTaskTemplatesQuery = z.infer<typeof listTaskTemplatesQuerySchema>;

// ─── Path params ───────────────────────────────────────────────────────

export const projectIdParamSchema = z.object({ project_id: objectIdSchema });
export type ProjectIdParam = z.infer<typeof projectIdParamSchema>;

export const taskTemplateIdParamSchema = z.object({ id: objectIdSchema });
export type TaskTemplateIdParam = z.infer<typeof taskTemplateIdParamSchema>;

// ─── Instantiate body (per-call overrides) ─────────────────────────────
//
// Manual instantiation may pass overrides for any default — useful for
// "Use template, but make this one assignee Jane instead of the default."
// All optional; absent fields fall back to the template's stored
// defaults at instantiation time.

export const instantiateTaskTemplateBodySchema = z
    .object({
        title: z.string().trim().min(1).max(TASK_TEMPLATE_TITLE_MAX).optional(),
        primary_assignee_id: objectIdSchema.nullable().optional(),
        collaborator_ids: z.array(objectIdSchema).optional(),
        story_id: objectIdSchema.nullable().optional(),
        sprint_id: objectIdSchema.nullable().optional(),
        due_date: isoDateSchema.optional(),
    })
    .strict();
export type InstantiateTaskTemplateBody = z.infer<typeof instantiateTaskTemplateBodySchema>;
