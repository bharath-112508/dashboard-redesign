import { Request, Response } from 'express';
import { Types } from 'mongoose';

import * as service from '../services/task-attachment.service.js';
import { created, ok } from '../utils/api-response.js';
import { paginated } from '../utils/api-response.js';
import { projectCallerFrom } from '../utils/caller.js';
import type {
    FinalizeAttachmentBody,
    ListAttachmentsQuery,
    UploadUrlBody,
} from '../validators/task-attachment.validator.js';

/**
 * Task-attachment controller — thin adapters around
 * `services/task-attachment.service`. Mirrors `task-comment.controller`.
 */

const idOf = (req: Request, key: string): Types.ObjectId => new Types.ObjectId(req.params[key] as string);

// ─── Nested under /tasks/:task_id/attachments ────────────────────────────

export const postUploadUrl = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.mintUploadUrl(idOf(req, 'task_id'), req.body as UploadUrlBody, projectCallerFrom(req));
    return ok(res, data);
};

export const postFinalize = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.finalizeAttachment(
        idOf(req, 'task_id'),
        req.body as FinalizeAttachmentBody,
        projectCallerFrom(req)
    );
    return created(res, data);
};

export const getList = async (req: Request, res: Response): Promise<Response> => {
    const { data, meta } = await service.listAttachments(
        idOf(req, 'task_id'),
        req.query as unknown as ListAttachmentsQuery,
        projectCallerFrom(req)
    );
    return paginated(res, data, meta);
};

// ─── Top-level /attachments/:id ──────────────────────────────────────────

export const getDownloadUrl = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.mintDownloadUrl(idOf(req, 'id'), projectCallerFrom(req));
    return ok(res, data);
};

export const deleteOne = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.deleteAttachment(idOf(req, 'id'), projectCallerFrom(req));
    return ok(res, data);
};
