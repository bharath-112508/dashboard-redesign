import { z } from 'zod';

import { REPORT_EXPORT_NAMES } from '../constants/export.js';
import {
    REPORT_SUBSCRIPTION_DEFAULT_HOUR_LOCAL,
    REPORT_SUBSCRIPTION_LIST_DEFAULT_LIMIT,
    REPORT_SUBSCRIPTION_LIST_MAX_LIMIT,
    REPORT_SUBSCRIPTION_MAX_DAY_OF_WEEK,
    REPORT_SUBSCRIPTION_MAX_HOUR_LOCAL,
    REPORT_SUBSCRIPTION_MIN_DAY_OF_WEEK,
    REPORT_SUBSCRIPTION_MIN_HOUR_LOCAL,
    REPORT_SUBSCRIPTION_NAME_MAX,
} from '../constants/report-subscription.js';

/**
 * Zod validators for `/report-subscriptions/*` (Phase 4 Step 43).
 *
 * Mirrors the Step-42 preset validator with the addition of schedule
 * fields (`day_of_week`, `hour_local`) + `is_active` flag. The
 * per-report-name filter dispatch lives in the SERVICE layer (via
 * `parsePresetFilters` reused from Step 42) — the body validator
 * only shape-checks `filters` as an object.
 */

const objectIdSchema = z.string().regex(/^[a-f0-9]{24}$/i, 'Must be a valid ObjectId');
const reportNameSchema = z.enum(REPORT_EXPORT_NAMES);
const subscriptionNameSchema = z.string().trim().min(1).max(REPORT_SUBSCRIPTION_NAME_MAX);

const dayOfWeekSchema = z
    .number()
    .int()
    .min(REPORT_SUBSCRIPTION_MIN_DAY_OF_WEEK)
    .max(REPORT_SUBSCRIPTION_MAX_DAY_OF_WEEK);
const hourLocalSchema = z
    .number()
    .int()
    .min(REPORT_SUBSCRIPTION_MIN_HOUR_LOCAL)
    .max(REPORT_SUBSCRIPTION_MAX_HOUR_LOCAL);

// ─── Create body ──────────────────────────────────────────────────────

export const createReportSubscriptionBodySchema = z
    .object({
        name: subscriptionNameSchema,
        report_name: reportNameSchema,
        filters: z.record(z.string(), z.unknown()),
        day_of_week: dayOfWeekSchema,
        hour_local: hourLocalSchema.default(REPORT_SUBSCRIPTION_DEFAULT_HOUR_LOCAL),
        is_active: z.boolean().default(true),
    })
    .strict();
export type CreateReportSubscriptionBody = z.infer<typeof createReportSubscriptionBodySchema>;

// ─── Patch body ──────────────────────────────────────────────────────

export const patchReportSubscriptionBodySchema = z
    .object({
        name: subscriptionNameSchema.optional(),
        filters: z.record(z.string(), z.unknown()).optional(),
        day_of_week: dayOfWeekSchema.optional(),
        hour_local: hourLocalSchema.optional(),
        is_active: z.boolean().optional(),
    })
    .strict()
    .refine(
        (b) =>
            b.name !== undefined ||
            b.filters !== undefined ||
            b.day_of_week !== undefined ||
            b.hour_local !== undefined ||
            b.is_active !== undefined,
        { message: 'patch must include at least one field to update' }
    );
export type PatchReportSubscriptionBody = z.infer<typeof patchReportSubscriptionBodySchema>;

// ─── List query ───────────────────────────────────────────────────────

export const listReportSubscriptionsQuerySchema = z
    .object({
        report_name: reportNameSchema.optional(),
        is_active: z
            .union([z.literal('true'), z.literal('false'), z.boolean()])
            .transform((v) => (typeof v === 'boolean' ? v : v === 'true'))
            .optional(),
        page: z.coerce.number().int().min(1).default(1),
        limit: z.coerce
            .number()
            .int()
            .min(1)
            .max(REPORT_SUBSCRIPTION_LIST_MAX_LIMIT)
            .default(REPORT_SUBSCRIPTION_LIST_DEFAULT_LIMIT),
    })
    .strict();
export type ListReportSubscriptionsQuery = z.infer<typeof listReportSubscriptionsQuerySchema>;

// ─── Path params ──────────────────────────────────────────────────────

export const reportSubscriptionIdParamSchema = z.object({ id: objectIdSchema });
export type ReportSubscriptionIdParam = z.infer<typeof reportSubscriptionIdParamSchema>;
