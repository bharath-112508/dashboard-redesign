import { z } from 'zod';

/**
 * Zod schemas for `/salary-structures/*`.
 */

const objectIdSchema = z.string().regex(/^[a-f0-9]{24}$/i, 'Must be a valid ObjectId');
const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be a YYYY-MM-DD date');

const lineItemSchema = z
    .object({
        label: z.string().trim().min(1).max(80),
        amount: z.number().min(0),
    })
    .strict();

export const createSalaryStructureBodySchema = z
    .object({
        user_id: objectIdSchema,
        effective_from: isoDateSchema,
        earnings: z.array(lineItemSchema).default([]),
        deductions: z.array(lineItemSchema).default([]),
    })
    .strict();
export type CreateSalaryStructureBody = z.infer<typeof createSalaryStructureBodySchema>;

export const listSalaryStructuresQuerySchema = z
    .object({
        user_id: objectIdSchema,
    })
    .strict();
export type ListSalaryStructuresQuery = z.infer<typeof listSalaryStructuresQuerySchema>;

export const salaryStructureIdPathSchema = z.object({ id: objectIdSchema });
export type SalaryStructureIdPath = z.infer<typeof salaryStructureIdPathSchema>;
