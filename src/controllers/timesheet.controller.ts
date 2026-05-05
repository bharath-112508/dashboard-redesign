import { Request, Response } from 'express';
import { Types } from 'mongoose';

import * as service from '../services/timesheet.service.js';
import { created, ok, paginated } from '../utils/api-response.js';
import { AppError } from '../utils/app-error.js';
import { buildAuditContext } from '../utils/audit-context.js';
import type { ProjectCaller } from '../services/project.service.js';
import type { RoleType } from '../constants/roles.js';
import type {
    CreateTimesheetBody,
    DayDatePath,
    ListTimesheetsQuery,
    PatchTimesheetBody,
    SummaryQuery,
} from '../validators/timesheet.validator.js';

const callerOf = (req: Request): ProjectCaller => {
    if (!req.user?.user_id) throw AppError.unauthenticated();
    return {
        id: new Types.ObjectId(req.user.user_id),
        role: req.user.role as RoleType,
        role_keys: req.user.role_keys,
        audit: buildAuditContext(req),
    };
};

const idOf = (req: Request, key: string): Types.ObjectId => new Types.ObjectId(req.params[key] as string);

// ─── POST /timesheets ────────────────────────────────────────────────────

export const postCreate = async (req: Request, res: Response): Promise<Response> => {
    const result = await service.createEntry(req.body as CreateTimesheetBody, callerOf(req));
    return created(res, { ...result.data, warnings: result.warnings });
};

// ─── GET /timesheets/me ──────────────────────────────────────────────────

export const getMyList = async (req: Request, res: Response): Promise<Response> => {
    const { data, meta } = await service.listMyEntries(req.query as unknown as ListTimesheetsQuery, callerOf(req));
    return paginated(res, data, meta);
};

// ─── GET /timesheets/me/day/:date ────────────────────────────────────────

export const getMyDay = async (req: Request, res: Response): Promise<Response> => {
    const { date } = req.params as unknown as DayDatePath;
    const { data, meta } = await service.listMyDay(date, callerOf(req));
    return ok(res, data, meta);
};

// ─── GET /timesheets ─────────────────────────────────────────────────────

export const getList = async (req: Request, res: Response): Promise<Response> => {
    const { data, meta } = await service.listAllEntries(req.query as unknown as ListTimesheetsQuery, callerOf(req));
    return paginated(res, data, meta);
};

// ─── GET /timesheets/summary ─────────────────────────────────────────────

export const getSummary = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.summary(req.query as unknown as SummaryQuery, callerOf(req));
    return ok(res, data);
};

// ─── GET /timesheets/:id ─────────────────────────────────────────────────

export const getById = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.getEntry(idOf(req, 'id'), callerOf(req));
    return ok(res, data);
};

// ─── PATCH /timesheets/:id ───────────────────────────────────────────────

export const patchOne = async (req: Request, res: Response): Promise<Response> => {
    const result = await service.patchEntry(idOf(req, 'id'), req.body as PatchTimesheetBody, callerOf(req));
    return ok(res, { ...result.data, warnings: result.warnings });
};

// ─── DELETE /timesheets/:id ──────────────────────────────────────────────

export const deleteOne = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.deleteEntry(idOf(req, 'id'), callerOf(req));
    return ok(res, data);
};
