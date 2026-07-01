import { z } from 'zod';

/**
 * Zod schemas for `/payslips/*` (Task 7).
 */

const objectIdSchema = z.string().regex(/^[a-f0-9]{24}$/i, 'Must be a valid ObjectId');
const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be a YYYY-MM-DD date');

// ─── POST /payslips ──────────────────────────────────────────────────────

export const generatePayslipBodySchema = z
    .object({
        user_id: objectIdSchema,
        pay_period: z.string().min(1),
        days_present: z.number().int().min(0),
        effective_on: isoDateSchema,
    })
    .strict();
export type GeneratePayslipBody = z.infer<typeof generatePayslipBodySchema>;

// ─── GET /payslips ───────────────────────────────────────────────────────

export const listPayslipsQuerySchema = z
    .object({
        user_id: objectIdSchema.optional(),
        pay_period: z.string().min(1).optional(),
        page: z.coerce.number().int().min(1).default(1),
        limit: z.coerce.number().int().min(1).max(200).default(50),
    })
    .strict();
export type ListPayslipsQuery = z.infer<typeof listPayslipsQuerySchema>;

// ─── Path params ─────────────────────────────────────────────────────────

export const payslipIdPathSchema = z.object({ id: objectIdSchema });
export type PayslipIdPath = z.infer<typeof payslipIdPathSchema>;
