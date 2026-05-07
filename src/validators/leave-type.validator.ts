import { z } from 'zod';

import { LEAVE_CODE_VALUES, PRO_RATA_STRATEGIES } from '../constants/leave.js';

/**
 * Zod schemas for `/leave-types` (API_Contract.md §5.1, Data_Model.md §3.1).
 *
 * `code` is canonical (CL/SL/MATERNITY/PATERNITY/WFH/COMP_OFF/UNPAID by
 * default, but admin may register custom uppercase tokens). PATCH cannot
 * change `code` — only mutable policy fields are exposed.
 */

const objectIdSchema = z.string().regex(/^[a-f0-9]{24}$/i, 'Must be a valid ObjectId');

const codeSchema = z
    .string()
    .trim()
    .min(2)
    .max(32)
    .regex(/^[A-Z][A-Z0-9_]*$/, 'Must be UPPER_SNAKE_CASE');

const nameSchema = z.string().trim().min(1).max(64);

// ─── POST /leave-types ────────────────────────────────────────────────────

export const createLeaveTypeBodySchema = z.object({
    code: codeSchema,
    name: nameSchema,
    default_allocation_days: z.number().nonnegative(),
    carry_forward: z.boolean(),
    carry_forward_cap: z.number().nonnegative().nullable().optional(),
    monthly_cap: z.number().positive().nullable().optional(),
    monthly_forfeiture: z.boolean(),
    is_unlimited: z.boolean(),
    is_earned: z.boolean(),
    is_event_based: z.boolean(),
    pro_rata_on_join: z.enum(Object.values(PRO_RATA_STRATEGIES) as [string, ...string[]]),
    supports_half_day: z.boolean(),
    advance_notice_days: z.number().int().nonnegative(),
    resets_yearly: z.boolean(),
    is_active: z.boolean().optional(),
});

export type CreateLeaveTypeBody = z.infer<typeof createLeaveTypeBodySchema>;

// ─── PATCH /leave-types/:id ───────────────────────────────────────────────

export const patchLeaveTypeBodySchema = z
    .object({
        name: nameSchema,
        default_allocation_days: z.number().nonnegative(),
        carry_forward: z.boolean(),
        carry_forward_cap: z.number().nonnegative().nullable(),
        monthly_cap: z.number().positive().nullable(),
        monthly_forfeiture: z.boolean(),
        is_unlimited: z.boolean(),
        is_earned: z.boolean(),
        is_event_based: z.boolean(),
        pro_rata_on_join: z.enum(Object.values(PRO_RATA_STRATEGIES) as [string, ...string[]]),
        supports_half_day: z.boolean(),
        advance_notice_days: z.number().int().nonnegative(),
        resets_yearly: z.boolean(),
        is_active: z.boolean(),
    })
    .partial()
    .refine((data) => Object.keys(data).length > 0, {
        message: 'At least one field must be supplied',
    });

export type PatchLeaveTypeBody = z.infer<typeof patchLeaveTypeBodySchema>;

// ─── GET /leave-types ─────────────────────────────────────────────────────

export const listLeaveTypesQuerySchema = z.object({
    is_active: z
        .union([z.literal('true'), z.literal('false'), z.boolean()])
        .transform((v) => (typeof v === 'boolean' ? v : v === 'true'))
        .optional(),
}).strict();

export type ListLeaveTypesQuery = z.infer<typeof listLeaveTypesQuerySchema>;

// ─── Path params ──────────────────────────────────────────────────────────

export const leaveTypeIdParamSchema = z.object({ id: objectIdSchema });
export type LeaveTypeIdParam = z.infer<typeof leaveTypeIdParamSchema>;

void LEAVE_CODE_VALUES;
