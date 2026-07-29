import { z } from 'zod';

/**
 * Zod schemas for `/cost-rates/*` (Billing Phase 2 — Cost Rates & Margin,
 * Task 3 builds the routes on top of these).
 *
 * Cost-side twin of `billing-rate.validator.ts` — one rate per `user_id`
 * (no project/task dimension), effective-dated. `effective_to` is normally
 * derived (left null = "current"); we accept it on create so an admin can
 * backfill a fully-historical range in one shot, guarded by a
 * `effective_to >= effective_from` refine (mirrors
 * `engagement.validator.ts`'s `end_date >= start_date` rule).
 */

const objectIdSchema = z.string().regex(/^[a-f0-9]{24}$/i, 'Must be a valid ObjectId');
const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be a YYYY-MM-DD date');
const currencySchema = z
    .string()
    .trim()
    .regex(/^[A-Za-z]{3}$/, 'Must be a 3-letter ISO currency code');

// ─── POST /cost-rates ────────────────────────────────────────────────────

export const createCostRateSchema = z
    .object({
        user_id: objectIdSchema,
        cost_per_hour: z.number().min(0),
        currency: currencySchema,
        effective_from: isoDateSchema,
        effective_to: isoDateSchema.nullable().optional().default(null),
    })
    .strict()
    .superRefine((v, ctx) => {
        if (v.effective_to && v.effective_to < v.effective_from) {
            ctx.addIssue({
                code: 'custom',
                path: ['effective_to'],
                message: 'effective_to must be on or after effective_from',
            });
        }
    });
export type CreateCostRateInput = z.infer<typeof createCostRateSchema>;

// ─── PATCH /cost-rates/:id ───────────────────────────────────────────────
//
// Only `cost_per_hour` and `effective_to` are editable. The
// `(user_id, effective_from)` tuple defines the row's identity — moving
// either means deleting + creating, not patching.

export const updateCostRateSchema = z
    .object({
        cost_per_hour: z.number().min(0),
        effective_to: isoDateSchema.nullable(),
    })
    .partial()
    .strict()
    .refine((d) => Object.keys(d).length > 0, { message: 'At least one field must be supplied' });
export type UpdateCostRateInput = z.infer<typeof updateCostRateSchema>;

// ─── GET /cost-rates ─────────────────────────────────────────────────────

export const listCostRatesQuerySchema = z
    .object({
        user_id: objectIdSchema.optional(),
        /**
         * "Active on" filter — return only rows whose effective range
         * contains this date (mirrors `billing-rate.validator.ts`).
         */
        active_on: isoDateSchema.optional(),
        page: z.coerce.number().int().min(1).default(1),
        limit: z.coerce.number().int().min(1).max(100).default(20),
    })
    .strict();
export type ListCostRatesQuery = z.infer<typeof listCostRatesQuerySchema>;

// ─── Path params ─────────────────────────────────────────────────────────

export const costRateIdPathSchema = z.object({ id: objectIdSchema });
export type CostRateIdPath = z.infer<typeof costRateIdPathSchema>;
