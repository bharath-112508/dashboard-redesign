import { z } from 'zod';

import {
    CUSTOM_STATUSES_PER_PROJECT_MAX,
    CUSTOM_STATUS_KEY_MAX,
    CUSTOM_STATUS_KEY_REGEX,
    CUSTOM_STATUS_LABEL_MAX,
    DEFAULT_TASK_STATUS_KEYS,
    PROJECT_CLIENTS_MAX,
    PROJECT_CODE_MAX,
    PROJECT_CODE_REGEX,
    PROJECT_DESCRIPTION_MAX,
    PROJECT_LIST_DEFAULT_LIMIT,
    PROJECT_LIST_MAX_LIMIT,
    PROJECT_MEMBERS_MAX,
    PROJECT_NAME_MAX,
    PROJECT_STATUS_VALUES,
} from '../constants/project.js';

/**
 * Zod schemas for `/projects` (API_Contract.md §7.1).
 *
 *  - Dates are wire-strings `YYYY-MM-DD` to match Data_Model.md §5.1; the
 *    service does the chronological end >= start check (Zod doesn't get to
 *    cross-field-compare gracefully without a `.refine`, which we use).
 *  - `member_ids` and `client_ids` are *whole-set replacements* on POST/PATCH;
 *    the bulk add/remove endpoint (`POST /projects/:id/members`) lives in its
 *    own schema below so the FE can do a delta without re-shipping the world.
 *  - `custom_task_statuses` keys are validated against `DEFAULT_TASK_STATUS_KEYS`
 *    here (Zod refine) AND uniqueness within the array (refine). The service
 *    re-validates against existing rows on UPDATE so deltas can't sneak past.
 */

const objectIdSchema = z.string().regex(/^[a-f0-9]{24}$/i, 'Must be a valid ObjectId');
const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD');

// ─── Custom-task-status sub-schema ────────────────────────────────────────

const customStatusKeySchema = z
    .string()
    .trim()
    .min(1)
    .max(CUSTOM_STATUS_KEY_MAX)
    .regex(CUSTOM_STATUS_KEY_REGEX, 'key must be lower_snake (a-z, 0-9, _)')
    .refine((k) => !DEFAULT_TASK_STATUS_KEYS.includes(k as (typeof DEFAULT_TASK_STATUS_KEYS)[number]), {
        message: `key collides with a default task status (${DEFAULT_TASK_STATUS_KEYS.join(', ')})`,
    });

export const createCustomStatusBodySchema = z.object({
    key: customStatusKeySchema,
    label: z.string().trim().min(1).max(CUSTOM_STATUS_LABEL_MAX),
    order: z.number().int().min(0).max(999).default(0),
    is_terminal: z.boolean().default(false),
});

export type CreateCustomStatusBody = z.infer<typeof createCustomStatusBodySchema>;

export const patchCustomStatusBodySchema = z
    .object({
        label: z.string().trim().min(1).max(CUSTOM_STATUS_LABEL_MAX),
        order: z.number().int().min(0).max(999),
        is_terminal: z.boolean(),
    })
    .partial()
    .refine((d) => Object.keys(d).length > 0, { message: 'At least one field must be supplied' });

export type PatchCustomStatusBody = z.infer<typeof patchCustomStatusBodySchema>;

// ─── POST /projects ───────────────────────────────────────────────────────

export const createProjectBodySchema = z
    .object({
        name: z.string().trim().min(1).max(PROJECT_NAME_MAX),
        code: z
            .string()
            .trim()
            .min(1)
            .max(PROJECT_CODE_MAX)
            .transform((v) => v.toUpperCase())
            .pipe(z.string().regex(PROJECT_CODE_REGEX, 'code must be A-Z, 0-9, -, _ starting with a letter')),
        description: z.string().trim().max(PROJECT_DESCRIPTION_MAX).default(''),
        start_date: isoDateSchema,
        end_date: isoDateSchema.nullable().default(null),
        status: z.enum(PROJECT_STATUS_VALUES as unknown as [string, ...string[]]).optional(),
        member_ids: z.array(objectIdSchema).max(PROJECT_MEMBERS_MAX).default([]),
        client_ids: z.array(objectIdSchema).max(PROJECT_CLIENTS_MAX).default([]),
        custom_task_statuses: z
            .array(createCustomStatusBodySchema)
            .max(CUSTOM_STATUSES_PER_PROJECT_MAX)
            .default([])
            .refine((arr) => new Set(arr.map((s) => s.key)).size === arr.length, {
                message: 'custom_task_statuses keys must be unique',
            }),
    })
    .refine((d) => d.end_date === null || d.end_date >= d.start_date, {
        path: ['end_date'],
        message: 'end_date must be on or after start_date',
    });

export type CreateProjectBody = z.infer<typeof createProjectBodySchema>;

// ─── PATCH /projects/:id ──────────────────────────────────────────────────
//
// Whole-document patch — `member_ids` / `client_ids` / `custom_task_statuses`
// are deliberately NOT included here. Use the dedicated bulk endpoints
// (members, clients, custom-statuses) so the partial update never silently
// truncates a 50-person member list to zero because the FE forgot to send it.

export const patchProjectBodySchema = z
    .object({
        name: z.string().trim().min(1).max(PROJECT_NAME_MAX),
        description: z.string().trim().max(PROJECT_DESCRIPTION_MAX),
        start_date: isoDateSchema,
        end_date: isoDateSchema.nullable(),
        status: z.enum(PROJECT_STATUS_VALUES as unknown as [string, ...string[]]),
        is_archived: z.boolean(),
    })
    .partial()
    .refine((d) => Object.keys(d).length > 0, { message: 'At least one field must be supplied' })
    .refine(
        (d) =>
            d.end_date === undefined || d.end_date === null || d.start_date === undefined || d.end_date >= d.start_date,
        {
            path: ['end_date'],
            message: 'end_date must be on or after start_date',
        }
    );

export type PatchProjectBody = z.infer<typeof patchProjectBodySchema>;

// ─── GET /projects ────────────────────────────────────────────────────────

export const listProjectsQuerySchema = z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(PROJECT_LIST_MAX_LIMIT).default(PROJECT_LIST_DEFAULT_LIMIT),
    status: z.enum(PROJECT_STATUS_VALUES as unknown as [string, ...string[]]).optional(),
    is_archived: z
        .union([z.literal('true'), z.literal('false'), z.boolean()])
        .transform((v) => (typeof v === 'boolean' ? v : v === 'true'))
        .optional(),
    member_id: objectIdSchema.optional(),
    client_id: objectIdSchema.optional(),
    q: z.string().trim().min(1).max(100).optional(),
});

export type ListProjectsQuery = z.infer<typeof listProjectsQuerySchema>;

// ─── POST /projects/:id/members  (bulk add/remove) ────────────────────────

export const projectMembersBulkBodySchema = z
    .object({
        add: z.array(objectIdSchema).max(PROJECT_MEMBERS_MAX).default([]),
        remove: z.array(objectIdSchema).max(PROJECT_MEMBERS_MAX).default([]),
    })
    .refine((d) => d.add.length + d.remove.length > 0, {
        message: 'At least one of `add` or `remove` must be non-empty',
    });

export type ProjectMembersBulkBody = z.infer<typeof projectMembersBulkBodySchema>;

// ─── POST /projects/:id/clients  (bulk add/remove) ────────────────────────

export const projectClientsBulkBodySchema = z
    .object({
        add: z.array(objectIdSchema).max(PROJECT_CLIENTS_MAX).default([]),
        remove: z.array(objectIdSchema).max(PROJECT_CLIENTS_MAX).default([]),
    })
    .refine((d) => d.add.length + d.remove.length > 0, {
        message: 'At least one of `add` or `remove` must be non-empty',
    });

export type ProjectClientsBulkBody = z.infer<typeof projectClientsBulkBodySchema>;

// ─── Path params ──────────────────────────────────────────────────────────

export const projectIdParamSchema = z.object({ id: objectIdSchema });
export type ProjectIdParam = z.infer<typeof projectIdParamSchema>;

export const projectMemberIdParamSchema = z.object({
    id: objectIdSchema,
    user_id: objectIdSchema,
});
export type ProjectMemberIdParam = z.infer<typeof projectMemberIdParamSchema>;

export const projectClientIdParamSchema = z.object({
    id: objectIdSchema,
    user_id: objectIdSchema,
});
export type ProjectClientIdParam = z.infer<typeof projectClientIdParamSchema>;

export const customStatusIdParamSchema = z.object({ id: objectIdSchema });
export type CustomStatusIdParam = z.infer<typeof customStatusIdParamSchema>;
