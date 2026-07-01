import { Request, Response } from 'express';
import { Types } from 'mongoose';

import * as service from '../services/payroll-profile.service.js';
import { ok, paginated } from '../utils/api-response.js';
import { AppError } from '../utils/app-error.js';
import { buildAuditContext } from '../utils/audit-context.js';
import type { UpsertPayrollProfileBody, ListPayrollProfilesQuery } from '../validators/payroll-profile.validator.js';

const callerOf = (req: Request): service.PayrollCaller => {
    if (!req.user?.user_id) throw AppError.unauthenticated();
    return { id: new Types.ObjectId(req.user.user_id), audit: buildAuditContext(req) };
};

const idOf = (req: Request, key: string): Types.ObjectId => new Types.ObjectId(req.params[key] as string);

export const getList = async (req: Request, res: Response): Promise<Response> => {
    const { data, meta } = await service.listProfiles(req.query as unknown as ListPayrollProfilesQuery);
    return paginated(res, data, meta);
};

export const getOne = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.getProfile(idOf(req, 'user_id'));
    return ok(res, data);
};

export const putUpsert = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.upsertProfile(idOf(req, 'user_id'), req.body as UpsertPayrollProfileBody, callerOf(req));
    return ok(res, data);
};
