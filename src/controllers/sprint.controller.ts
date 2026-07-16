import { Request, Response } from 'express';
import { Types } from 'mongoose';

import * as service from '../services/sprint.service.js';
import { created, noContent, ok, paginated } from '../utils/api-response.js';
import { projectCallerFrom } from '../utils/caller.js';
import type { CreateSprintBody, ListSprintsQuery, PatchSprintBody } from '../validators/sprint.validator.js';

const idOf = (req: Request, key = 'id'): Types.ObjectId => new Types.ObjectId(req.params[key] as string);

// ─── Nested under /projects/:project_id/sprints ──────────────────────────

export const postCreate = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.createSprint(
        idOf(req, 'project_id'),
        req.body as CreateSprintBody,
        projectCallerFrom(req)
    );
    return created(res, data);
};

export const getList = async (req: Request, res: Response): Promise<Response> => {
    const { data, meta } = await service.listSprints(
        idOf(req, 'project_id'),
        req.query as unknown as ListSprintsQuery,
        projectCallerFrom(req)
    );
    return paginated(res, data, meta);
};

// ─── Top-level /sprints/:id ──────────────────────────────────────────────

export const getOne = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.getSprint(idOf(req), projectCallerFrom(req));
    return ok(res, data);
};

export const patchOne = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.updateSprint(idOf(req), req.body as PatchSprintBody, projectCallerFrom(req));
    return ok(res, data);
};

export const deleteOne = async (req: Request, res: Response): Promise<Response> => {
    await service.deleteSprint(idOf(req), projectCallerFrom(req));
    return noContent(res);
};

// T11 — archive escape hatch. POST /sprints/:id/archive flips
// `is_archived: true`, and an archived sprint can be deleted even
// with lingering tasks (R3 escape hatch).
export const postArchive = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.archiveSprint(idOf(req), projectCallerFrom(req));
    return ok(res, data);
};

export const postUnarchive = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.unarchiveSprint(idOf(req), projectCallerFrom(req));
    return ok(res, data);
};
