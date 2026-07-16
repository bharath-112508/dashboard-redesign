import { Request, Response } from 'express';
import { Types } from 'mongoose';

import * as service from '../services/project.service.js';
import { created, noContent, ok, paginated } from '../utils/api-response.js';
import { projectCallerFrom } from '../utils/caller.js';
import type {
    CreateCustomStatusBody,
    CreateProjectBody,
    ListProjectsQuery,
    PatchCustomStatusBody,
    PatchDefaultStatusOrdersBody,
    PatchProjectBody,
    ProjectClientsBulkBody,
    ProjectMembersBulkBody,
} from '../validators/project.validator.js';

const idOf = (req: Request, key = 'id'): Types.ObjectId => new Types.ObjectId(req.params[key] as string);

// ─── Projects ────────────────────────────────────────────────────────────

export const postCreate = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.createProject(req.body as CreateProjectBody, projectCallerFrom(req));
    return created(res, data);
};

export const getList = async (req: Request, res: Response): Promise<Response> => {
    const { data, meta } = await service.listProjects(
        req.query as unknown as ListProjectsQuery,
        projectCallerFrom(req)
    );
    return paginated(res, data, meta);
};

export const getOne = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.getProject(idOf(req), projectCallerFrom(req));
    return ok(res, data);
};

export const patchOne = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.updateProject(idOf(req), req.body as PatchProjectBody, projectCallerFrom(req));
    return ok(res, data);
};

export const deleteOne = async (req: Request, res: Response): Promise<Response> => {
    await service.deleteProject(idOf(req), projectCallerFrom(req));
    return noContent(res);
};

// ─── Members ─────────────────────────────────────────────────────────────

export const getMembers = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.listProjectMembers(idOf(req), projectCallerFrom(req));
    return ok(res, data);
};

export const postMembers = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.updateProjectMembers(
        idOf(req),
        req.body as ProjectMembersBulkBody,
        projectCallerFrom(req)
    );
    return ok(res, data);
};

export const deleteMember = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.removeProjectMember(idOf(req), idOf(req, 'user_id'), projectCallerFrom(req));
    return ok(res, data);
};

// ─── Clients ─────────────────────────────────────────────────────────────

export const getClients = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.listProjectClients(idOf(req), projectCallerFrom(req));
    return ok(res, data);
};

export const postClients = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.updateProjectClients(
        idOf(req),
        req.body as ProjectClientsBulkBody,
        projectCallerFrom(req)
    );
    return ok(res, data);
};

export const deleteClient = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.removeProjectClient(idOf(req), idOf(req, 'user_id'), projectCallerFrom(req));
    return ok(res, data);
};

// ─── Custom statuses (collection routes under /projects/:id) ─────────────

export const getCustomStatuses = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.listCustomStatuses(idOf(req), projectCallerFrom(req));
    return ok(res, data);
};

export const postCustomStatus = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.addCustomStatus(idOf(req), req.body as CreateCustomStatusBody, projectCallerFrom(req));
    return created(res, data);
};

export const patchDefaultStatusOrders = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.patchDefaultStatusOrders(
        idOf(req),
        req.body as PatchDefaultStatusOrdersBody,
        projectCallerFrom(req)
    );
    return ok(res, data);
};

// ─── Custom statuses (top-level item routes by sub-doc id) ───────────────

export const patchCustomStatus = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.patchCustomStatus(idOf(req), req.body as PatchCustomStatusBody, projectCallerFrom(req));
    return ok(res, data);
};

export const deleteCustomStatus = async (req: Request, res: Response): Promise<Response> => {
    await service.deleteCustomStatus(idOf(req), projectCallerFrom(req));
    return noContent(res);
};
