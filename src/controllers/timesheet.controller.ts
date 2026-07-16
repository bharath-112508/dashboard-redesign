import { Request, Response } from 'express';
import { Types } from 'mongoose';

import * as service from '../services/timesheet.service.js';
import { created, ok, paginated } from '../utils/api-response.js';
import { projectCallerFrom } from '../utils/caller.js';
import type {
    CreateTimesheetBody,
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
