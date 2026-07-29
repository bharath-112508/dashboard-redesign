import { z } from 'zod';

import { BILLING_TYPES, RETAINER_PERIODS } from '../models/engagement.model.js';

/**
 * Zod schemas for `/engagements/*` (Phase 1 — Client Engagements & Invoicing
 * design spec). Mirrors `billing-rate.validator.ts`'s helper/refine style.
 *
 * Type⇒components rules (enforced via `.superRefine`):
 *  - `retainer` requires `retainer_amount` + `retainer_period`.
 *  - `fixed` requires `fixed_amount`.
 *  - `end_date` (when present) must be on or after `start_date`.
 */

const objectId = z.string().regex(/^[a-f0-9]{24}$/i, 'Must be a valid ObjectId');
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD');

const baseShape = {
    company_id: objectId,
    project_ids: z.array(objectId).optional(),
    name: z.string().trim().min(1),
    currency: z.string().trim().regex(/^[A-Za-z]{3}$/, 'Must be a 3-letter ISO currency code'),
    billing_type: z.enum(BILLING_TYPES),
    setup_fee: z.number().min(0).nullable().optional(),
    retainer_amount: z.number().min(0).nullable().optional(),
    retainer_period: z.enum(RETAINER_PERIODS).nullable().optional(),
    included_hours: z.number().min(0).nullable().optional(),
    fixed_amount: z.number().min(0).nullable().optional(),
    start_date: isoDate,
    end_date: isoDate.nullable().optional(),
    notes: z.string().optional(),
};

const applyRules = (
    v: {
        billing_type: string;
        retainer_amount?: number | null;
        retainer_period?: string | null;
        fixed_amount?: number | null;
        start_date: string;
        end_date?: string | null;
    },
    ctx: z.RefinementCtx
) => {
    if (v.billing_type === 'retainer' && (v.retainer_amount == null || v.retainer_period == null)) {
        ctx.addIssue({
            code: 'custom',
            path: ['retainer_amount'],
            message: 'retainer_amount + retainer_period are required for a retainer engagement',
        });
    }
    if (v.billing_type === 'fixed' && v.fixed_amount == null) {
        ctx.addIssue({
            code: 'custom',
            path: ['fixed_amount'],
            message: 'fixed_amount is required for a fixed engagement',
        });
    }
    if (v.end_date && v.end_date < v.start_date) {
        ctx.addIssue({ code: 'custom', path: ['end_date'], message: 'end_date must be on or after start_date' });
    }
};

export const createEngagementSchema = z.object(baseShape).strict().superRefine(applyRules);

export const updateEngagementSchema = z
    .object({
        name: z.string().trim().min(1).optional(),
        project_ids: z.array(objectId).optional(),
        setup_fee: z.number().min(0).nullable().optional(),
        retainer_amount: z.number().min(0).nullable().optional(),
        retainer_period: z.enum(RETAINER_PERIODS).nullable().optional(),
        included_hours: z.number().min(0).nullable().optional(),
        fixed_amount: z.number().min(0).nullable().optional(),
        end_date: isoDate.nullable().optional(),
        notes: z.string().optional(),
    })
    .strict()
    .refine((v) => Object.keys(v).length > 0, { message: 'At least one field required' });

export const listEngagementsQuerySchema = z
    .object({
        company_id: objectId.optional(),
        status: z.enum(['active', 'ended']).optional(),
        page: z.coerce.number().int().min(1).default(1),
        limit: z.coerce.number().int().min(1).max(100).default(20),
    })
    .strict();

export type CreateEngagementInput = z.infer<typeof createEngagementSchema>;
export type UpdateEngagementInput = z.infer<typeof updateEngagementSchema>;
export type ListEngagementsQuery = z.infer<typeof listEngagementsQuerySchema>;

// ─── Path params ─────────────────────────────────────────────────────────

export const engagementIdPathSchema = z.object({ id: objectId });
export type EngagementIdPath = z.infer<typeof engagementIdPathSchema>;
