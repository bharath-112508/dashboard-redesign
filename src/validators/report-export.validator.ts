import { z } from 'zod';

import { EXPORT_FORMATS, REPORT_EXPORT_NAMES } from '../constants/export.js';
import {
    attendanceReportQuerySchema,
    billingReportQuerySchema,
    leaveReportQuerySchema,
    utilizationReportQuerySchema,
} from './report.validator.js';

/**
 * Zod schemas for the export endpoints (Step 30; API_Contract §10.3).
 *
 * `POST /reports/:name/export` carries `{ format, filters }`. The `name`
 * comes from the path; the `filters` shape is **dispatched per name**
 * because the four reports take different filter shapes (project_id is
 * required for billing, year is required for leaves, etc.).
 *
 * The dispatch happens in two passes:
 *   1. `exportRequestPathSchema` validates the `:name` URL segment.
 *   2. `parseExportBody(name, body)` returns a per-report parsed body.
 *
 * Splitting the dispatch out of the validator middleware (rather than
 * using a single discriminated-union) keeps the controller readable AND
 * lets us re-use the existing `*ReportQuerySchema`s verbatim — the same
 * shapes the synchronous GET endpoints already validate. So an export
 * for a query the GET endpoint would reject can never be enqueued.
 */

// ─── Path: `/reports/:name/export` ──────────────────────────────────────

export const exportRequestPathSchema = z.object({
    name: z.enum(REPORT_EXPORT_NAMES),
});
export type ExportRequestPath = z.infer<typeof exportRequestPathSchema>;

// ─── Body: per-report dispatched ────────────────────────────────────────

const exportFormatSchema = z.enum(EXPORT_FORMATS);

const wrap = <T extends z.ZodTypeAny>(filterSchema: T) =>
    z
        .object({
            format: exportFormatSchema,
            filters: filterSchema,
        })
        .strict();

export const billingExportBodySchema = wrap(billingReportQuerySchema);
export const utilizationExportBodySchema = wrap(utilizationReportQuerySchema);
export const attendanceExportBodySchema = wrap(attendanceReportQuerySchema);
export const leavesExportBodySchema = wrap(leaveReportQuerySchema);

export type BillingExportBody = z.infer<typeof billingExportBodySchema>;
export type UtilizationExportBody = z.infer<typeof utilizationExportBodySchema>;
export type AttendanceExportBody = z.infer<typeof attendanceExportBodySchema>;
export type LeavesExportBody = z.infer<typeof leavesExportBodySchema>;

export type ExportBody = BillingExportBody | UtilizationExportBody | AttendanceExportBody | LeavesExportBody;

/**
 * Parse the body against the schema for a given report name. Throws the
 * underlying `ZodError` — the controller catches and converts to
 * `AppError.validation` so the response matches the canonical
 * VALIDATION_ERROR shape.
 *
 * Why not use the `validate({ body })` middleware? It only supports a
 * single static schema; this validator picks the schema based on
 * `req.params.name`, which the middleware can't see. The controller
 * does the dispatch + the conversion; the global error handler does
 * not handle raw ZodErrors (it'd return 500 INTERNAL_ERROR).
 */
export const parseExportBody = (
    name: ExportRequestPath['name'],
    body: unknown
): { format: ExportBody['format']; filters: ExportBody['filters'] } => {
    switch (name) {
        case 'billing':
            return billingExportBodySchema.parse(body);
        case 'utilization':
            return utilizationExportBodySchema.parse(body);
        case 'attendance':
            return attendanceExportBodySchema.parse(body);
        case 'leaves':
            return leavesExportBodySchema.parse(body);
    }
};

// ─── Path: `/reports/exports/:id` ───────────────────────────────────────

export const exportIdPathSchema = z.object({
    id: z.string().regex(/^[a-f0-9]{24}$/i, 'Must be a valid ObjectId'),
});
export type ExportIdPath = z.infer<typeof exportIdPathSchema>;
