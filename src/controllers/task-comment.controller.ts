import { Request, Response } from 'express';
import { Types } from 'mongoose';

import * as service from '../services/task-comment.service.js';
import { created, ok, paginated } from '../utils/api-response.js';
import { projectCallerFrom } from '../utils/caller.js';
import type { CreateCommentBody, ListCommentsQuery, PatchCommentBody } from '../validators/comment.validator.js';

/**
 * Task-comment controller — thin Express adapters around
 * `services/task-comment.service`. Mirrors the `task.controller` layout:
 * caller construction extracted once, services own all behaviour.
 */

const idOf = (req: Request, key: string): Types.ObjectId => new Types.ObjectId(req.params[key] as string);

// ─── Nested under /tasks/:task_id/comments ───────────────────────────────

export const getList = async (req: Request, res: Response): Promise<Response> => {
    const { data, meta } = await service.listComments(
        idOf(req, 'task_id'),
        req.query as unknown as ListCommentsQuery,
        projectCallerFrom(req)
    );
    return paginated(res, data, meta);
};

export const postCreate = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.createComment(
        idOf(req, 'task_id'),
        req.body as CreateCommentBody,
        projectCallerFrom(req)
    );
    return created(res, data);
};

// ─── Top-level /comments/:id ─────────────────────────────────────────────

export const patchOne = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.updateComment(idOf(req, 'id'), req.body as PatchCommentBody, projectCallerFrom(req));
    return ok(res, data);
};

export const deleteOne = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.deleteComment(idOf(req, 'id'), projectCallerFrom(req));
    return ok(res, data);
};
