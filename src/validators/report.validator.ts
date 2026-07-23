import { z } from 'zod';

import { BILLING_REPORT_GROUP_BY, REPORT_RANGE_MAX_DAYS } from '../constants/report.js';

/**
 * Zod schemas for `/reports/*` (Step 29; API_Contract §10).
 *
 * Cross-field rules (date range, year span) live here so the service
 * receives well-formed dates and can focus on aggregation. Each schema
 * runs `.refine` to ensure `from_date <= to_date` and that the window
 * doesn't exceed `REPORT_RANGE_MAX_DAYS` — bounds the worst-case scan.
 */

const objectIdSchema = z.string().regex(/^[a-f0-9]{24}$/i, 'Must be a valid ObjectId');
const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be a YYYY-MM-DD date');

/**
 * Refines a parsed schema with the `from_date <= to_date` invariant
 * + the cap on the requested range. Reused across billing /
 * utilization / attendance which all share the same date pair.
 */
const dateRangeRefine = <T extends { from_date: string; to_date: string }>(parsed: T): boolean => {
    if (parsed.from_date > parsed.to_date) return false;
    const span = (Date.parse(parsed.to_date) - Date.parse(parsed.from_date)) / 86_400_000;
    return span <= REPORT_RANGE_MAX_DAYS;
};

const dateRangeMessage = `from_date must be on or before to_date and the window cannot exceed ${REPORT_RANGE_MAX_DAYS} days`;

// ─── GET /reports/billing ───────────────────────────────────────────────

export const billingReportQuerySchema = z
    .object({
        project_id: objectIdSchema,
        from_date: isoDateSchema,
        to_date: isoDateSchema,
        company_id: objectIdSchema.optional(),
        group_by: z.enum(BILLING_REPORT_GROUP_BY).default('employee'),
    })
    .refine(dateRangeRefine, { message: dateRangeMessage });
export type BillingReportQuery = z.infer<typeof billingReportQuerySchema>;

// ─── GET /reports/utilization ───────────────────────────────────────────

/**
 * Multi-user filter. Accepts BOTH shapes so one schema serves the sync
 * GET and the async export POST:
 *   - query string  → `?user_ids=a,b,c` (comma-joined; query strings have
 *     no native array type, and the FE's `buildSearch` flattens arrays to
 *     `key=value`).
 *   - JSON body      → `"user_ids": ["a","b"]` (the export POST sends
 *     `filters` as JSON, where an array survives the round-trip).
 * Empty/omitted → `undefined` (all internal users). Malformed ids 400.
 */
const userIdsSchema = z.preprocess((val) => {
    if (val === undefined || val === null) return undefined;
    const raw = Array.isArray(val) ? val : String(val).split(',');
    const cleaned = raw.map((s) => String(s).trim()).filter(Boolean);
    return cleaned.length ? cleaned : undefined;
}, z.array(objectIdSchema).optional());

export const utilizationReportQuerySchema = z
    .object({
        from_date: isoDateSchema,
        to_date: isoDateSchema,
        // `team_id` is in the spec but no `team` collection exists in
        // v1 — accept and ignore so the FE shape stays stable. The
        // service drops it; documented in `report.service`.
        team_id: objectIdSchema.optional(),
        // Single-user filter kept for back-compat; `user_ids` is the
        // multi-select form. When both arrive the service unions them.
        user_id: objectIdSchema.optional(),
        user_ids: userIdsSchema,
        // Which hours count toward the utilization %. `billable` = classic
        // billable utilization; `non_billable` = the inverse; `all` = both.
        // "Neither" is impossible — the FE disables unchecking the last box.
        billable: z.enum(['all', 'billable', 'non_billable']).default('all'),
    })
    .refine(dateRangeRefine, { message: dateRangeMessage });
export type UtilizationReportQuery = z.infer<typeof utilizationReportQuerySchema>;

// ─── GET /reports/attendance ────────────────────────────────────────────

export const attendanceReportQuerySchema = z
    .object({
        from_date: isoDateSchema,
        to_date: isoDateSchema,
        user_id: objectIdSchema.optional(),
    })
    .refine(dateRangeRefine, { message: dateRangeMessage });
export type AttendanceReportQuery = z.infer<typeof attendanceReportQuerySchema>;

// ─── GET /reports/leave ─────────────────────────────────────────────────
//
// Leave is per-year, not per-range — the leave-balance row is keyed
// `(user_id, leave_type_id, year)` so a year is the natural unit.

export const leaveReportQuerySchema = z.object({
    year: z.coerce.number().int().min(1970).max(2100),
    user_id: objectIdSchema.optional(),
});
export type LeaveReportQuery = z.infer<typeof leaveReportQuerySchema>;
