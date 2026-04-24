import { Request, Response } from 'express';
import { Types } from 'mongoose';

import * as service from '../services/sprint.service.js';
import { created, noContent, ok, paginated } from '../utils/api-response.js';
import { AppError } from '../utils/app-error.js';
import { buildAuditContext } from '../utils/audit-context.js';
import type { ProjectCaller } from '../services/project.service.js';
import type { RoleType } from '../constants/roles.js';
import type { CreateSprintBody, ListSprintsQuery, PatchSprintBody } from '../validators/sprint.validator.js';

const callerOf = (req: Request): ProjectCaller => {
    if (!req.user?.user_id) throw AppError.unauthenticated();
    return {
        id: new Types.ObjectId(req.user.user_id),
        role: req.user.role as RoleType,
        audit: buildAuditContext(req),
    };
};

const idOf = (req: Request, key = 'id'): Types.ObjectId => new Types.ObjectId(req.params[key] as string);

// ─── Nested under /projects/:project_id/sprints ──────────────────────────

export const postCreate = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.createSprint(idOf(req, 'project_id'), req.body as CreateSprintBody, callerOf(req));
    return created(res, data);
};

export const getList = async (req: Request, res: Response): Promise<Response> => {
    const { data, meta } = await service.listSprints(
        idOf(req, 'project_id'),
        req.query as unknown as ListSprintsQuery,
        callerOf(req)
    );
    return paginated(res, data, meta);
};

// ─── Top-level /sprints/:id ──────────────────────────────────────────────

export const getOne = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.getSprint(idOf(req), callerOf(req));
    return ok(res, data);
};

export const patchOne = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.updateSprint(idOf(req), req.body as PatchSprintBody, callerOf(req));
    return ok(res, data);
};

export const deleteOne = async (req: Request, res: Response): Promise<Response> => {
    await service.deleteSprint(idOf(req), callerOf(req));
    return noContent(res);
};
