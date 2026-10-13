import { Request, Response } from 'express';
import { Types } from 'mongoose';

import * as service from '../services/task-template.service.js';
import { created, ok, paginated } from '../utils/api-response.js';
import { projectCallerFrom } from '../utils/caller.js';
import type {
    CreateTaskTemplateBody,
    InstantiateTaskTemplateBody,
    ListTaskTemplatesQuery,
    PatchTaskTemplateBody,
    ProjectIdParam,
    TaskTemplateIdParam,
} from '../validators/task-template.validator.js';

const callerOf = (req: Request): service.TemplateCaller => projectCallerFrom(req);

const projectIdOf = (req: Request): Types.ObjectId =>
    new Types.ObjectId((req.params as unknown as ProjectIdParam).project_id);

const templateIdOf = (req: Request): Types.ObjectId =>
    new Types.ObjectId((req.params as unknown as TaskTemplateIdParam).id);

// ─── Project-nested ─────────────────────────────────────────────────────

export const postCreate = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.createTemplate(projectIdOf(req), req.body as CreateTaskTemplateBody, callerOf(req));
    return created(res, data);
};

export const getList = async (req: Request, res: Response): Promise<Response> => {
    const { data, meta } = await service.listTemplates(
        projectIdOf(req),
        req.query as unknown as ListTaskTemplatesQuery,
        callerOf(req)
    );
    return paginated(res, data, meta);
};

// ─── Top-level by id ───────────────────────────────────────────────────

export const getOne = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.getTemplate(templateIdOf(req), callerOf(req));
    return ok(res, data);
};

export const patchOne = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.updateTemplate(templateIdOf(req), req.body as PatchTaskTemplateBody, callerOf(req));
    return ok(res, data);
};

export const deleteOne = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.deleteTemplate(templateIdOf(req), callerOf(req));
    return ok(res, data);
};

export const postInstantiate = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.instantiateTemplate(
        templateIdOf(req),
        req.body as InstantiateTaskTemplateBody,
        callerOf(req)
    );
    return created(res, data);
};
