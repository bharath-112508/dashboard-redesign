import { Request, Response } from 'express';
import { Types } from 'mongoose';

import * as service from '../services/cost-rate.service.js';
import { created, ok, paginated } from '../utils/api-response.js';
import { AppError } from '../utils/app-error.js';
import { buildAuditContext } from '../utils/audit-context.js';
import type {
    CreateCostRateInput,
    ListCostRatesQuery,
    UpdateCostRateInput,
} from '../validators/cost-rate.validator.js';

const callerOf = (req: Request): service.CostRateCaller => {
    if (!req.user?.user_id) throw AppError.unauthenticated();
    return {
        id: new Types.ObjectId(req.user.user_id),
        audit: buildAuditContext(req),
    };
};

const idOf = (req: Request, key: string): Types.ObjectId => new Types.ObjectId(req.params[key] as string);

// ─── GET /cost-rates ──────────────────────────────────────────────────────

export const getList = async (req: Request, res: Response): Promise<Response> => {
    const { data, meta } = await service.listCostRates(req.query as unknown as ListCostRatesQuery);
    return paginated(res, data, meta);
};

// ─── POST /cost-rates ─────────────────────────────────────────────────────

export const postCreate = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.createCostRate(req.body as CreateCostRateInput, callerOf(req));
    return created(res, data);
};

// ─── PATCH /cost-rates/:id ────────────────────────────────────────────────

export const patchOne = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.updateCostRate(idOf(req, 'id'), req.body as UpdateCostRateInput, callerOf(req));
    return ok(res, data);
};

// ─── POST /cost-rates/:id/end ─────────────────────────────────────────────

export const postEnd = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.endCostRate(idOf(req, 'id'), callerOf(req));
    return ok(res, data);
};

// ─── DELETE /cost-rates/:id ───────────────────────────────────────────────

export const deleteOne = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.deleteCostRate(idOf(req, 'id'), callerOf(req));
    return ok(res, data);
};
