import { z } from 'zod';

import { BILLING_RATE_LIST_DEFAULT_LIMIT, BILLING_RATE_LIST_MAX_LIMIT } from '../constants/timesheet.js';

/**
 * Zod schemas for `/billing-rates/*` (API_Contract.md §9.5 /
 * BUILD_PROGRESS.md Step 23).
 *
 * `task_id` is nullable on POST + PATCH — null is the project-level
 * fallback rate (Data_Model §6.2). The service layer enforces the
 * effective-range invariants at write time (auto-close overlapping
 * rows; reject `effective_to < effective_from`).
 */

const objectIdSchema = z.string().regex(/^[a-f0-9]{24}$/i, 'Must be a valid ObjectId');
const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be a YYYY-MM-DD date');

// ─── POST /billing-rates ─────────────────────────────────────────────────

export const createBillingRateBodySchema = z.object({
    user_id: objectIdSchema,
    project_id: objectIdSchema,
    task_id: objectIdSchema.nullable().optional().default(null),
    hourly_rate: z.number().min(0),
    effective_from: isoDateSchema,
    /**
     * `effective_to` is normally derived (left null = "current"). We
     * accept it on POST so an admin can backfill a fully-historical
     * range in one shot — `effective_to < effective_from` is rejected
     * by the service.
     */
    effective_to: isoDateSchema.nullable().optional().default(null),
});
export type CreateBillingRateBody = z.infer<typeof createBillingRateBodySchema>;

// ─── PATCH /billing-rates/:id ────────────────────────────────────────────
//
// Only `hourly_rate` and `effective_to` are editable. The (user, project,
// task, effective_from) tuple defines the row's identity — moving any of
// those means deleting + creating, not patching.

export const patchBillingRateBodySchema = z
    .object({
        hourly_rate: z.number().min(0),
        effective_to: isoDateSchema.nullable(),
    })
    .partial()
    .refine((d) => Object.keys(d).length > 0, { message: 'At least one field must be supplied' });
export type PatchBillingRateBody = z.infer<typeof patchBillingRateBodySchema>;

// ─── GET /billing-rates ──────────────────────────────────────────────────

export const listBillingRatesQuerySchema = z
    .object({
        user_id: objectIdSchema.optional(),
        project_id: objectIdSchema.optional(),
        task_id: objectIdSchema.optional(),
        /**
         * "Active on" filter — return only rows whose effective range
         * contains this date. Useful for the FE rate-picker that wants
         * "what rate applies on 2026-05-15 for this user/project".
         */
        active_on: isoDateSchema.optional(),
        page: z.coerce.number().int().min(1).default(1),
        limit: z.coerce.number().int().min(1).max(BILLING_RATE_LIST_MAX_LIMIT).default(BILLING_RATE_LIST_DEFAULT_LIMIT),
    })
    .strict();
export type ListBillingRatesQuery = z.infer<typeof listBillingRatesQuerySchema>;

// ─── Path params ─────────────────────────────────────────────────────────

export const billingRateIdPathSchema = z.object({ id: objectIdSchema });
export type BillingRateIdPath = z.infer<typeof billingRateIdPathSchema>;
