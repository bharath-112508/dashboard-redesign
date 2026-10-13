import { Request, Response } from 'express';
import { Types } from 'mongoose';

import * as service from '../services/engagement.service.js';
import { created, ok, paginated } from '../utils/api-response.js';
import { AppError } from '../utils/app-error.js';
import { buildAuditContext } from '../utils/audit-context.js';
import type {
    CreateEngagementInput,
    ListEngagementsQuery,
    UpdateEngagementInput,
} from '../validators/engagement.validator.js';

const callerOf = (req: Request): service.EngagementCaller => {
    if (!req.user?.user_id) throw AppError.unauthenticated();
    return {
        id: new Types.ObjectId(req.user.user_id),
        audit: buildAuditContext(req),
    };
};

const idOf = (req: Request, key: string): Types.ObjectId => new Types.ObjectId(req.params[key] as string);

// ─── GET /engagements ────────────────────────────────────────────────────

export const getList = async (req: Request, res: Response): Promise<Response> => {
    const { data, meta } = await service.listEngagements(req.query as unknown as ListEngagementsQuery);
    return paginated(res, data, meta);
};

// ─── GET /engagements/:id ────────────────────────────────────────────────

export const getOne = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.getEngagement(idOf(req, 'id'));
    return ok(res, data);
};

// ─── POST /engagements ───────────────────────────────────────────────────

export const postCreate = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.createEngagement(req.body as CreateEngagementInput, callerOf(req));
    return created(res, data);
};

// ─── PATCH /engagements/:id ──────────────────────────────────────────────

export const patchOne = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.updateEngagement(idOf(req, 'id'), req.body as UpdateEngagementInput, callerOf(req));
    return ok(res, data);
};

// ─── POST /engagements/:id/end ───────────────────────────────────────────

export const postEnd = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.endEngagement(idOf(req, 'id'), callerOf(req));
    return ok(res, data);
};
