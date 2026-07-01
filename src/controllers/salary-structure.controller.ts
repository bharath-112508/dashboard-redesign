import { Request, Response } from 'express';
import { Types } from 'mongoose';

import * as service from '../services/salary-structure.service.js';
import { created, ok } from '../utils/api-response.js';
import { AppError } from '../utils/app-error.js';
import { buildAuditContext } from '../utils/audit-context.js';
import type { CreateSalaryStructureBody, ListSalaryStructuresQuery } from '../validators/salary-structure.validator.js';

const callerOf = (req: Request): service.SalaryStructureCaller => {
    if (!req.user?.user_id) throw AppError.unauthenticated();
    return { id: new Types.ObjectId(req.user.user_id), audit: buildAuditContext(req) };
};

const idOf = (req: Request, key: string): Types.ObjectId => new Types.ObjectId(req.params[key] as string);

// ─── GET /salary-structures?user_id= ─────────────────────────────────────

export const getList = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.listStructures(req.query as unknown as ListSalaryStructuresQuery);
    return ok(res, data);
};

// ─── POST /salary-structures ─────────────────────────────────────────────

export const postCreate = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.createStructure(req.body as CreateSalaryStructureBody, callerOf(req));
    return created(res, data);
};

// ─── GET /salary-structures/:id ──────────────────────────────────────────

export const getOne = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.getStructureById(idOf(req, 'id'));
    return ok(res, data);
};
