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

const finiteNumber = z.number().refine((n) => Number.isFinite(n), 'Must be a number');

/**
 * An adjust is stated one of two ways, never both:
 *
 *  - `{ total_days?, used_days? }` — the counters as they should read. This
 *    is how an operator reconciles against an external leave portal: that
 *    system reports "15 total, 7 used", and typing those two numbers is the
 *    whole job. The service derives everything else, including the remaining
 *    balance. Either field may be sent alone to leave the other untouched.
 *  - `{ delta }` — a signed relative move, kept because it is the original
 *    contract and reads better when the operator knows the change rather
 *    than the totals ("grant 2 days"). Zero is rejected: it says nothing.
 *
 * Totals may repeat what is already stored — reconciling a whole roster must
 * not error on the rows that already agree.
 */
export const adjustLeaveBalanceBodySchema = z
    .object({
        delta: finiteNumber.refine((n) => n !== 0, 'delta cannot be 0').optional(),
        /** Total days allowed: quota + carry-forward + manual adjustment. */
        total_days: finiteNumber.min(0, 'Cannot be negative').optional(),
        /** Days already taken this year. */
        used_days: finiteNumber.min(0, 'Cannot be negative').optional(),
        reason: z.string().trim().min(3).max(500),
    })
    .refine(
        (b) => {
            const hasTotals = b.total_days !== undefined || b.used_days !== undefined;
            return (b.delta !== undefined) !== hasTotals;
        },
        {
            message: 'Send either delta, or total_days / used_days — not both',
            path: ['delta'],
        }
    );

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
