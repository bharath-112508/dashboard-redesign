import { Request, Response } from 'express';
import { Types } from 'mongoose';

import * as service from '../services/project.service.js';
import { created, noContent, ok, paginated } from '../utils/api-response.js';
import { AppError } from '../utils/app-error.js';
import { buildAuditContext } from '../utils/audit-context.js';
import type { RoleType } from '../constants/roles.js';
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

const callerOf = (req: Request): service.ProjectCaller => {
    if (!req.user?.user_id) throw AppError.unauthenticated();
    return {
        id: new Types.ObjectId(req.user.user_id),
        role: req.user.role as RoleType,
        // R4 — Step-47 RBAC signal so a multi-role admin is recognised
        // by `isAdminLike` in the service layer.
        role_keys: req.user.role_keys,
        audit: buildAuditContext(req),
    };
};

const idOf = (req: Request, key = 'id'): Types.ObjectId => new Types.ObjectId(req.params[key] as string);

// ─── Projects ────────────────────────────────────────────────────────────

export const postCreate = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.createProject(req.body as CreateProjectBody, callerOf(req));
    return created(res, data);
};

export const getList = async (req: Request, res: Response): Promise<Response> => {
    const { data, meta } = await service.listProjects(req.query as unknown as ListProjectsQuery, callerOf(req));
    return paginated(res, data, meta);
};

export const getOne = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.getProject(idOf(req), callerOf(req));
    return ok(res, data);
};

export const patchOne = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.updateProject(idOf(req), req.body as PatchProjectBody, callerOf(req));
    return ok(res, data);
};

export const deleteOne = async (req: Request, res: Response): Promise<Response> => {
    await service.deleteProject(idOf(req), callerOf(req));
    return noContent(res);
};

// ─── Members ─────────────────────────────────────────────────────────────

export const getMembers = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.listProjectMembers(idOf(req), callerOf(req));
    return ok(res, data);
};

export const postMembers = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.updateProjectMembers(idOf(req), req.body as ProjectMembersBulkBody, callerOf(req));
    return ok(res, data);
};

export const deleteMember = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.removeProjectMember(idOf(req), idOf(req, 'user_id'), callerOf(req));
    return ok(res, data);
};

// ─── Clients ─────────────────────────────────────────────────────────────

export const getClients = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.listProjectClients(idOf(req), callerOf(req));
    return ok(res, data);
};

export const postClients = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.updateProjectClients(idOf(req), req.body as ProjectClientsBulkBody, callerOf(req));
    return ok(res, data);
};

export const deleteClient = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.removeProjectClient(idOf(req), idOf(req, 'user_id'), callerOf(req));
    return ok(res, data);
};

// ─── Custom statuses (collection routes under /projects/:id) ─────────────

export const getCustomStatuses = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.listCustomStatuses(idOf(req), callerOf(req));
    return ok(res, data);
};

export const postCustomStatus = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.addCustomStatus(idOf(req), req.body as CreateCustomStatusBody, callerOf(req));
    return created(res, data);
};

export const patchDefaultStatusOrders = async (
    req: Request,
    res: Response
): Promise<Response> => {
    const data = await service.patchDefaultStatusOrders(
        idOf(req),
        req.body as PatchDefaultStatusOrdersBody,
        callerOf(req)
    );
    return ok(res, data);
};

// ─── Custom statuses (top-level item routes by sub-doc id) ───────────────

export const patchCustomStatus = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.patchCustomStatus(idOf(req), req.body as PatchCustomStatusBody, callerOf(req));
    return ok(res, data);
};

export const deleteCustomStatus = async (req: Request, res: Response): Promise<Response> => {
    await service.deleteCustomStatus(idOf(req), callerOf(req));
    return noContent(res);
};
