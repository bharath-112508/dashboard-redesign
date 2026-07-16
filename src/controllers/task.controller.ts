import { Request, Response } from 'express';
import { Types } from 'mongoose';

import * as service from '../services/task.service.js';
import { created, ok, paginated } from '../utils/api-response.js';
import { projectCallerFrom } from '../utils/caller.js';
import type {
    AddDependencyBody,
    AssignStoryBody,
    CreateTaskBody,
    ListTasksQuery,
    MoveSprintBody,
    PatchTaskBody,
    ReorderTaskBody,
} from '../validators/task.validator.js';

/**
 * Task controller — thin Express adapters around `services/task.service`.
 *
 * Caller construction mirrors `story.controller`: extract the auth snapshot
 * + audit context once, pass it to every service call so the service never
 * reads `req.user` directly.
 */

const idOf = (req: Request, key = 'id'): Types.ObjectId => new Types.ObjectId(req.params[key] as string);

// ─── /tasks ──────────────────────────────────────────────────────────────

export const postCreate = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.createTask(req.body as CreateTaskBody, projectCallerFrom(req));
    return created(res, data);
};

export const getList = async (req: Request, res: Response): Promise<Response> => {
    const { data, meta } = await service.listTasks(req.query as unknown as ListTasksQuery, projectCallerFrom(req));
    return paginated(res, data, meta);
};

// ─── /tasks/:id ──────────────────────────────────────────────────────────

export const getOne = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.getTask(idOf(req), projectCallerFrom(req));
    return ok(res, data);
};

export const patchOne = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.updateTask(idOf(req), req.body as PatchTaskBody, projectCallerFrom(req));
    return ok(res, data);
};

export const deleteOne = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.deleteTask(idOf(req), projectCallerFrom(req));
    return ok(res, data);
};

// ─── /tasks/:id/* sub-actions ────────────────────────────────────────────

export const postReorder = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.reorderTask(idOf(req), req.body as ReorderTaskBody, projectCallerFrom(req));
    return ok(res, data);
};

export const postAssignStory = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.assignTaskStory(idOf(req), req.body as AssignStoryBody, projectCallerFrom(req));
    return ok(res, data);
};

export const postMoveSprint = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.moveTaskToSprint(idOf(req), req.body as MoveSprintBody, projectCallerFrom(req));
    return ok(res, data);
};

export const postAddDependency = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.addTaskDependency(idOf(req), req.body as AddDependencyBody, projectCallerFrom(req));
    return created(res, data);
};

export const deleteDependency = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.removeTaskDependency(idOf(req), idOf(req, 'dep_id'), projectCallerFrom(req));
    return ok(res, data);
};
