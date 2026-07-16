import { Request, Response } from 'express';
import { Types } from 'mongoose';

import * as service from '../services/story.service.js';
import { created, ok, paginated } from '../utils/api-response.js';
import { projectCallerFrom } from '../utils/caller.js';
import type {
    CreateStoryBody,
    ListStoriesQuery,
    ListStoryTasksQuery,
    PatchStoryBody,
    ReorderStoryBody,
} from '../validators/story.validator.js';

/**
 * Story controller — thin Express adapters around `services/story.service`.
 *
 * Caller construction mirrors `project.controller`: extract the auth
 * snapshot + audit context once, pass it to every service call so the
 * service never reads `req.user` directly.
 */

const idOf = (req: Request, key = 'id'): Types.ObjectId => new Types.ObjectId(req.params[key] as string);

// ─── Nested under /projects/:project_id/stories ──────────────────────────

export const postCreate = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.createStory(
        idOf(req, 'project_id'),
        req.body as CreateStoryBody,
        projectCallerFrom(req)
    );
    return created(res, data);
};

export const getList = async (req: Request, res: Response): Promise<Response> => {
    const { data, meta } = await service.listStories(
        idOf(req, 'project_id'),
        req.query as unknown as ListStoriesQuery,
        projectCallerFrom(req)
    );
    return paginated(res, data, meta);
};

// ─── Top-level /stories/:id ──────────────────────────────────────────────

export const getOne = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.getStory(idOf(req), projectCallerFrom(req));
    return ok(res, data);
};

export const patchOne = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.updateStory(idOf(req), req.body as PatchStoryBody, projectCallerFrom(req));
    return ok(res, data);
};

export const deleteOne = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.deleteStory(idOf(req), projectCallerFrom(req));
    return ok(res, data);
};

export const postReorder = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.reorderStory(idOf(req), req.body as ReorderStoryBody, projectCallerFrom(req));
    return ok(res, data);
};

export const getTasks = async (req: Request, res: Response): Promise<Response> => {
    const { data, meta } = await service.listStoryTasks(
        idOf(req),
        req.query as unknown as ListStoryTasksQuery,
        projectCallerFrom(req)
    );
    return paginated(res, data, meta);
};
