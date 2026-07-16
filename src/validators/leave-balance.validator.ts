import { z } from 'zod';

/**
 * Zod schemas for `/leave-balances` (API_Contract.md §5.2).
 *
 *  - `me` query supports an optional `year` (defaults to current year).
 *  - Manager list filters by `user_id` + `year`.
 *  - Admin adjust takes `delta` (positive or negative) and a free-text
 *    `reason` for the audit trail.
 *  - `initialize-year` is admin-only and idempotent — it iterates active
 *    users + active leave types to upsert balance rows.
 */

const objectIdSchema = z.string().regex(/^[a-f0-9]{24}$/i, 'Must be a valid ObjectId');

const yearSchema = z.coerce.number().int().gte(1970).lte(9999);

// ─── GET /leave-balances/me ───────────────────────────────────────────────

export const myBalancesQuerySchema = z.object({
    year: yearSchema.optional(),
});

export type MyBalancesQuery = z.infer<typeof myBalancesQuerySchema>;

// ─── GET /leave-balances ──────────────────────────────────────────────────

export const listLeaveBalancesQuerySchema = z
    .object({
        user_id: objectIdSchema.optional(),
        year: yearSchema.optional(),
    })
    .strict();

export type ListLeaveBalancesQuery = z.infer<typeof listLeaveBalancesQuerySchema>;

// ─── PATCH /leave-balances/:id ────────────────────────────────────────────

export const adjustLeaveBalanceBodySchema = z.object({
    delta: z
        .number()
        .refine((n) => Number.isFinite(n), 'delta must be a number')
        .refine((n) => n !== 0, 'delta cannot be 0'),
    reason: z.string().trim().min(3).max(500),
});

export type AdjustLeaveBalanceBody = z.infer<typeof adjustLeaveBalanceBodySchema>;

// ─── POST /leave-balances/initialize-year ─────────────────────────────────

export const initializeYearBodySchema = z.object({
    year: yearSchema,
});

export type InitializeYearBody = z.infer<typeof initializeYearBodySchema>;

// ─── Path params ──────────────────────────────────────────────────────────

export const leaveBalanceIdParamSchema = z.object({ id: objectIdSchema });
export type LeaveBalanceIdParam = z.infer<typeof leaveBalanceIdParamSchema>;

export const leaveBalanceUserIdParamSchema = z.object({ user_id: objectIdSchema });
export type LeaveBalanceUserIdParam = z.infer<typeof leaveBalanceUserIdParamSchema>;
