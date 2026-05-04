import { Request, Response } from 'express';
import { Types } from 'mongoose';

import * as service from '../services/billing-rate.service.js';
import { created, ok, paginated } from '../utils/api-response.js';
import { AppError } from '../utils/app-error.js';
import { buildAuditContext } from '../utils/audit-context.js';
import type {
    CreateBillingRateBody,
    ListBillingRatesQuery,
    PatchBillingRateBody,
} from '../validators/billing-rate.validator.js';

const callerOf = (req: Request): service.BillingRateCaller => {
    if (!req.user?.user_id) throw AppError.unauthenticated();
    return {
        id: new Types.ObjectId(req.user.user_id),
        audit: buildAuditContext(req),
    };
};

const idOf = (req: Request, key: string): Types.ObjectId => new Types.ObjectId(req.params[key] as string);

// ─── GET /billing-rates ──────────────────────────────────────────────────

export const getList = async (req: Request, res: Response): Promise<Response> => {
    const { data, meta } = await service.listRates(req.query as unknown as ListBillingRatesQuery);
    return paginated(res, data, meta);
};

// ─── POST /billing-rates ─────────────────────────────────────────────────

export const postCreate = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.createRate(req.body as CreateBillingRateBody, callerOf(req));
    return created(res, data);
};

// ─── PATCH /billing-rates/:id ────────────────────────────────────────────

export const patchOne = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.patchRate(idOf(req, 'id'), req.body as PatchBillingRateBody, callerOf(req));
    return ok(res, data);
};

// ─── POST /billing-rates/:id/end ─────────────────────────────────────────

export const postEnd = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.endRate(idOf(req, 'id'), callerOf(req));
    return ok(res, data);
};

// ─── DELETE /billing-rates/:id ───────────────────────────────────────────

export const deleteOne = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.deleteRate(idOf(req, 'id'), callerOf(req));
    return ok(res, data);
};
