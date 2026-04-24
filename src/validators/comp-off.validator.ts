import { z } from 'zod';

import { COMP_OFF_TYPES } from '../constants/leave.js';

/**
 * Zod schemas for `/comp-off` (API_Contract.md §5.9).
 *
 *  - `me` is filter-less; the controller scopes to the caller automatically.
 *  - List supports `user_id`, `type`, paging.
 *  - Admin adjust posts an explicit `type` (earn/consume) and `days`. The
 *    sign of the user-visible balance is implied by `type` (we never store
 *    negative `days`).
 */

const objectIdSchema = z.string().regex(/^[a-f0-9]{24}$/i, 'Must be a valid ObjectId');

// ─── GET /comp-off/me ─────────────────────────────────────────────────────

export const myCompOffQuerySchema = z.object({
    page: z.coerce.number().int().positive().optional().default(1),
    limit: z.coerce.number().int().positive().max(200).optional().default(50),
});

export type MyCompOffQuery = z.infer<typeof myCompOffQuerySchema>;

// ─── GET /comp-off ────────────────────────────────────────────────────────

export const listCompOffQuerySchema = z.object({
    user_id: objectIdSchema.optional(),
    type: z.enum(Object.values(COMP_OFF_TYPES) as [string, ...string[]]).optional(),
    page: z.coerce.number().int().positive().optional().default(1),
    limit: z.coerce.number().int().positive().max(200).optional().default(50),
});

export type ListCompOffQuery = z.infer<typeof listCompOffQuerySchema>;

// ─── POST /comp-off/adjust ────────────────────────────────────────────────

export const adjustCompOffBodySchema = z.object({
    user_id: objectIdSchema,
    type: z.enum(Object.values(COMP_OFF_TYPES) as [string, ...string[]]),
    days: z
        .number()
        .positive('days must be > 0')
        .refine((n) => Math.round(n * 2) === n * 2, 'days must be in 0.5 increments'),
    remarks: z.string().trim().min(3).max(500),
});

export type AdjustCompOffBody = z.infer<typeof adjustCompOffBodySchema>;
