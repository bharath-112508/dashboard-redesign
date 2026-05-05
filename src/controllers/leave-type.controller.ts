import { Request, Response } from 'express';
import { Types } from 'mongoose';

import * as service from '../services/leave-type.service.js';
import { buildAuditContext } from '../utils/audit-context.js';
import { created, ok } from '../utils/api-response.js';
import type {
    CreateLeaveTypeBody,
    ListLeaveTypesQuery,
    PatchLeaveTypeBody,
} from '../validators/leave-type.validator.js';

const parseId = (req: Request): Types.ObjectId => new Types.ObjectId(req.params.id as string);

export const getList = async (req: Request, res: Response): Promise<Response> => {
    const q = req.query as unknown as ListLeaveTypesQuery;
    const data = await service.listLeaveTypes({ is_active: q.is_active });
    return ok(res, data);
};

export const postCreate = async (req: Request, res: Response): Promise<Response> => {
    // I1 — admin leave-type CRUD audited so changes to allocation / cap /
    // pro-rata strategy are traceable.
    const data = await service.createLeaveType(req.body as CreateLeaveTypeBody, buildAuditContext(req));
    return created(res, data);
};

export const patchOne = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.updateLeaveType(parseId(req), req.body as PatchLeaveTypeBody, buildAuditContext(req));
    return ok(res, data);
};

export const deactivate = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.deactivateLeaveType(parseId(req), buildAuditContext(req));
    return ok(res, data);
};
