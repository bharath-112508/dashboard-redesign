import { z } from 'zod';

import { REPORT_EXPORT_NAMES, type ReportExportName } from '../constants/export.js';
import {
    REPORT_PRESET_LIST_DEFAULT_LIMIT,
    REPORT_PRESET_LIST_MAX_LIMIT,
    REPORT_PRESET_NAME_MAX,
} from '../constants/report-preset.js';
import {
    attendanceReportQuerySchema,
    billingReportQuerySchema,
    leaveReportQuerySchema,
    utilizationReportQuerySchema,
} from './report.validator.js';

/**
 * Zod validators for `/report-presets/*` (Phase 4 Step 42).
 *
 * The `filters` shape is **dispatched per `report_name`** — the four
 * reports take different filter shapes, so we run a per-name parse to
 * keep the saved blob honest. Same pattern Step-30 export validation
 * uses (filter shape varies; static `validate({body})` middleware
 * can't cover it; controller catches the inner ZodError and converts
 * to `AppError.validation`).
 */

const objectIdSchema = z.string().regex(/^[a-f0-9]{24}$/i, 'Must be a valid ObjectId');

const reportNameSchema = z.enum(REPORT_EXPORT_NAMES);
const presetNameSchema = z.string().trim().min(1).max(REPORT_PRESET_NAME_MAX);

// ─── Per-report filter schemas ─────────────────────────────────────────
//
// Reuse the Step-29 GET schemas verbatim — a preset's filter must be
// something the matching report endpoint would accept. So a saved
// preset can't surface a filter shape the report itself would reject
// when the FE actually runs it.

export const parsePresetFilters = (name: ReportExportName, filters: unknown): Record<string, unknown> => {
    switch (name) {
        case 'billing':
            return billingReportQuerySchema.parse(filters) as Record<string, unknown>;
        case 'utilization':
            return utilizationReportQuerySchema.parse(filters) as Record<string, unknown>;
        case 'attendance':
            return attendanceReportQuerySchema.parse(filters) as Record<string, unknown>;
        case 'leaves':
            return leaveReportQuerySchema.parse(filters) as Record<string, unknown>;
    }
};

// ─── Create body ──────────────────────────────────────────────────────

export const createReportPresetBodySchema = z
    .object({
        name: presetNameSchema,
        report_name: reportNameSchema,
        // `filters` shape is validated at the service layer via
        // `parsePresetFilters` — the service knows the dispatched
        // schema based on `report_name`. Here we just shape-check
        // that something is present.
        filters: z.record(z.string(), z.unknown()),
    })
    .strict();
export type CreateReportPresetBody = z.infer<typeof createReportPresetBodySchema>;

// ─── Patch body ──────────────────────────────────────────────────────
//
// `report_name` is **locked at creation** — see the model's header
// comment. Allow only `name` + `filters` updates. To re-target a
// different report, the user deletes + re-creates.

export const patchReportPresetBodySchema = z
    .object({
        name: presetNameSchema.optional(),
        filters: z.record(z.string(), z.unknown()).optional(),
    })
    .strict()
    .refine((b) => b.name !== undefined || b.filters !== undefined, {
        message: 'patch must include at least one of: name, filters',
    });
export type PatchReportPresetBody = z.infer<typeof patchReportPresetBodySchema>;

// ─── List query ───────────────────────────────────────────────────────

export const listReportPresetsQuerySchema = z
    .object({
        report_name: reportNameSchema.optional(),
        page: z.coerce.number().int().min(1).default(1),
        limit: z.coerce
            .number()
            .int()
            .min(1)
            .max(REPORT_PRESET_LIST_MAX_LIMIT)
            .default(REPORT_PRESET_LIST_DEFAULT_LIMIT),
    })
    .strict();
export type ListReportPresetsQuery = z.infer<typeof listReportPresetsQuerySchema>;

// ─── Path params ──────────────────────────────────────────────────────

export const reportPresetIdParamSchema = z.object({ id: objectIdSchema });
export type ReportPresetIdParam = z.infer<typeof reportPresetIdParamSchema>;
