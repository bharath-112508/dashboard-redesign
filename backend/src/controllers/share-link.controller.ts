import { Request, Response } from 'express';
import { Types } from 'mongoose';

import * as service from '../services/share-link.service.js';
import { created, ok, paginated } from '../utils/api-response.js';
import { AppError } from '../utils/app-error.js';
import { buildAuditContext } from '../utils/audit-context.js';
import type {
    CreateShareLinkBody,
    ListShareLinksQuery,
    ShareLinkTokenPath,
} from '../validators/share-link.validator.js';

const callerOf = (req: Request): service.ShareLinkCaller => {
    if (!req.user?.user_id) throw AppError.unauthenticated();
    return {
        id: new Types.ObjectId(req.user.user_id),
        audit: buildAuditContext(req),
    };
};

const idOf = (req: Request, key: string): Types.ObjectId => new Types.ObjectId(req.params[key] as string);

// ─── Nested under /projects/:project_id/share-links ─────────────────────

export const getList = async (req: Request, res: Response): Promise<Response> => {
    const { data, meta } = await service.listLinks(
        idOf(req, 'project_id'),
        req.query as unknown as ListShareLinksQuery
    );
    return paginated(res, data, meta);
};

export const postCreate = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.createLink(idOf(req, 'project_id'), req.body as CreateShareLinkBody, callerOf(req));
    return created(res, data);
};

// ─── Top-level /share-links/:id/revoke ──────────────────────────────────

export const postRevoke = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.revokeLink(idOf(req, 'id'), callerOf(req));
    return ok(res, data);
};

// ─── Public /share-links/resolve/:token ─────────────────────────────────

export const getResolve = async (req: Request, res: Response): Promise<Response> => {
    const { token } = req.params as unknown as ShareLinkTokenPath;
    const data = await service.resolveLink(token);
    return ok(res, data);
};
