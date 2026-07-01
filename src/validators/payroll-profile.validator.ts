import { z } from 'zod';

/**
 * Zod schemas for `/payroll-profiles/*`.
 */

const objectIdSchema = z.string().regex(/^[a-f0-9]{24}$/i, 'Must be a valid ObjectId');

export const upsertPayrollProfileBodySchema = z
    .object({
        pan: z.string().max(20).optional(),
        uan: z.string().max(30).optional(),
        pf_account_number: z.string().max(40).optional(),
        esi_number: z.string().max(40).optional(),
        pran_number: z.string().max(40).optional(),
        bank_details: z.string().max(120).optional(),
        location: z.string().max(120).optional(),
        tax_regime: z.string().max(60).optional(),
    })
    .strict();
export type UpsertPayrollProfileBody = z.infer<typeof upsertPayrollProfileBodySchema>;

export const listPayrollProfilesQuerySchema = z
    .object({
        page: z.coerce.number().int().min(1).default(1),
        limit: z.coerce.number().int().min(1).max(200).default(50),
    })
    .strict();
export type ListPayrollProfilesQuery = z.infer<typeof listPayrollProfilesQuerySchema>;

export const payrollUserIdPathSchema = z.object({ user_id: objectIdSchema });
export type PayrollUserIdPath = z.infer<typeof payrollUserIdPathSchema>;
