import { Request, Response } from 'express';
import { Types } from 'mongoose';

import * as service from '../services/timesheet.service.js';
import * as importService from '../services/timesheet-import.service.js';
import { buildAuditContext } from '../utils/audit-context.js';
import { TIMESHEET_EXPORT_MAX_ROWS } from '../constants/timesheet.js';
import { generateXlsx } from '../services/report-exporters/xlsx.js';
import { toTabularTeamTimesheets, type TeamTimesheetExportRow } from '../services/report-exporters/tabular.js';
import { created, ok, paginated } from '../utils/api-response.js';
import { projectCallerFrom } from '../utils/caller.js';
import type {
    CreateTimesheetBody,
    TimesheetImportBody,
    DayDatePath,
    ListTimesheetsQuery,
    PatchTimesheetBody,
    SummaryQuery,
} from '../validators/timesheet.validator.js';

const idOf = (req: Request, key: string): Types.ObjectId => new Types.ObjectId(req.params[key] as string);

// ─── POST /timesheets ────────────────────────────────────────────────────

export const postCreate = async (req: Request, res: Response): Promise<Response> => {
    const result = await service.createEntry(req.body as CreateTimesheetBody, projectCallerFrom(req));
    return created(res, { ...result.data, warnings: result.warnings });
};

// ─── GET /timesheets/me ──────────────────────────────────────────────────

export const getMyList = async (req: Request, res: Response): Promise<Response> => {
    const { data, meta } = await service.listMyEntries(
        req.query as unknown as ListTimesheetsQuery,
        projectCallerFrom(req)
    );
    return paginated(res, data, meta);
};

// ─── GET /timesheets/me/day/:date ────────────────────────────────────────
//
// Non-paginated day breakdown with sidecar metadata
// `{ local_date, total_minutes }` — the FE renders the day's total as a
// summary chip beside the list of entries. NOT a paginated response, so
// we use `ok(res, data, meta)` rather than `paginated()`. The api.ts
// envelope-preserve rule keeps `{data, meta}` intact for the consumer.
export const getMyDay = async (req: Request, res: Response): Promise<Response> => {
    const { date } = req.params as unknown as DayDatePath;
    const { data, meta } = await service.listMyDay(date, projectCallerFrom(req));
    return ok(res, data, meta);
};

// ─── GET /timesheets ─────────────────────────────────────────────────────

export const getList = async (req: Request, res: Response): Promise<Response> => {
    const { data, meta } = await service.listAllEntries(
        req.query as unknown as ListTimesheetsQuery,
        projectCallerFrom(req)
    );
    return paginated(res, data, meta);
};

// ─── GET /timesheets/summary ─────────────────────────────────────────────

export const getSummary = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.summary(req.query as unknown as SummaryQuery, projectCallerFrom(req));
    return ok(res, data);
};

// ─── GET /timesheets/export ──────────────────────────────────────────────

/**
 * Streams the filtered team timesheet as a real .xlsx.
 *
 * Goes through `listAllEntries` rather than querying the collection so the
 * reporting-chain scoping applies unchanged — a Manager exports their direct
 * reports, not the whole company. Bypassing it here would turn an export
 * button into a permission hole.
 *
 * One call with the export ceiling as the limit: the 200-row cap lives on the
 * route validator, not the service, so paging would only add round-trips.
 */
export const getExport = async (req: Request, res: Response): Promise<void> => {
    const query = req.query as unknown as ListTimesheetsQuery;
    const { data, meta } = await service.listAllEntries(
        { ...query, page: 1, limit: TIMESHEET_EXPORT_MAX_ROWS },
        projectCallerFrom(req)
    );
    const rows = data as unknown as TeamTimesheetExportRow[];

    const table = toTabularTeamTimesheets({
        from_date: query.from_date ?? '',
        to_date: query.to_date ?? '',
        // Resolved from the rows themselves — the ids alone would be useless
        // to whoever opens the file.
        user_label: query.user_id ? (rows[0]?.user?.full_name ?? String(query.user_id)) : null,
        project_label: query.project_id ? (rows[0]?.project?.name ?? String(query.project_id)) : null,
        rows,
        truncated: meta.total > rows.length,
    });

    const buffer = await generateXlsx(table);
    const name = `team-timesheets-${query.from_date ?? 'all'}_${query.to_date ?? 'all'}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.setHeader('Content-Length', String(buffer.length));
    res.end(buffer);
};

// ─── GET /timesheets/:id ─────────────────────────────────────────────────

export const getById = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.getEntry(idOf(req, 'id'), projectCallerFrom(req));
    return ok(res, data);
};

// ─── PATCH /timesheets/:id ───────────────────────────────────────────────

export const patchOne = async (req: Request, res: Response): Promise<Response> => {
    const result = await service.patchEntry(idOf(req, 'id'), req.body as PatchTimesheetBody, projectCallerFrom(req));
    return ok(res, { ...result.data, warnings: result.warnings });
};

// ─── DELETE /timesheets/:id ──────────────────────────────────────────────

export const deleteOne = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.deleteEntry(idOf(req, 'id'), projectCallerFrom(req));
    return ok(res, data);
};

// ─── POST /timesheets/import/preview ─────────────────────────────────────

/**
 * Dry run. Resolves and validates every row and reports what WOULD happen —
 * writes nothing. Always 200, even when every row is blocked: a file full of
 * mistakes is a successful preview, not a failed request, and the per-row
 * verdicts are the payload the user needs.
 */
export const postImportPreview = async (req: Request, res: Response): Promise<Response> => {
    const body = req.body as TimesheetImportBody;
    return ok(res, await importService.previewImport(body.rows, projectCallerFrom(req)));
};

// ─── POST /timesheets/import ─────────────────────────────────────────────

export const postImport = async (req: Request, res: Response): Promise<Response> => {
    const body = req.body as TimesheetImportBody;
    const result = await importService.commitImport(body.rows, projectCallerFrom(req), buildAuditContext(req));
    return created(res, result);
};
