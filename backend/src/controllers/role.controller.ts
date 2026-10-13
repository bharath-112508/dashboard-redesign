import { Request, Response } from 'express';
import { Types } from 'mongoose';

import * as service from '../services/role.service.js';
import { buildAuditContext } from '../utils/audit-context.js';
import { created, noContent, ok } from '../utils/api-response.js';
import { AppError } from '../utils/app-error.js';
import type {
    AssignRolesBody,
    CreateRoleBody,
    ListRolesQuery,
    PatchRoleBody,
    UpdateExtraPermissionsBody,
} from '../validators/role.validator.js';

/**
 * Role-CRUD controllers (Step 47 Phase C).
 *
 * Auth + permission gating happens at the route layer
 * (`requirePermission(ROLE_READ / ROLE_WRITE / ROLE_DELETE)`); the
 * controller stays role-agnostic and just threads the request
 * through to the service.
 */

const callerId = (req: Request): Types.ObjectId => {
    if (!req.user?.user_id) throw AppError.unauthenticated();
    return new Types.ObjectId(req.user.user_id);
};

const parseRoleId = (req: Request): Types.ObjectId => new Types.ObjectId(req.params.id as string);

const parseUserId = (req: Request): Types.ObjectId => new Types.ObjectId(req.params.user_id as string);

// ─── /roles ─────────────────────────────────────────────────────────────

export const postCreate = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.createCustomRole(req.body as CreateRoleBody, callerId(req), buildAuditContext(req));
    return created(res, data);
};

export const getList = async (req: Request, res: Response): Promise<Response> => {
    const { data } = await service.listRoles(req.query as unknown as ListRolesQuery);
    return ok(res, data);
};

export const getOne = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.getRole(parseRoleId(req));
    return ok(res, data);
};

export const patchOne = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.updateRole(
        parseRoleId(req),
        req.body as PatchRoleBody,
        callerId(req),
        buildAuditContext(req)
    );
    return ok(res, data);
};

export const deleteOne = async (req: Request, res: Response): Promise<Response> => {
    await service.deleteRole(parseRoleId(req), buildAuditContext(req));
    return noContent(res);
};

// ─── /users/:user_id/roles ──────────────────────────────────────────────

export const patchUserRoles = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.assignRolesToUser(
        parseUserId(req),
        req.body as AssignRolesBody,
        callerId(req),
        buildAuditContext(req)
    );
    return ok(res, data);
};

// ─── /users/:user_id/extra-permissions (Pattern B) ──────────────────────

export const patchUserExtraPermissions = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.updateUserExtraPermissions(
        parseUserId(req),
        req.body as UpdateExtraPermissionsBody,
        callerId(req),
        buildAuditContext(req)
    );
    return ok(res, data);
};
