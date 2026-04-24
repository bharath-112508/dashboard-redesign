import { Request, Response } from 'express';
import { Types } from 'mongoose';

import * as userService from '../services/user.service.js';
import { created, noContent, ok, paginated } from '../utils/api-response.js';
import { AppError } from '../utils/app-error.js';
import { ROLES } from '../constants/roles.js';
import type {
    AssignableQuery,
    ChangeRoleBody,
    CreateUserBody,
    DeactivateUserBody,
    ListUsersQuery,
    UpdateUserBody,
} from '../validators/user.validator.js';

const callerId = (req: Request): Types.ObjectId => {
    if (!req.user?.user_id) {
        throw AppError.unauthenticated();
    }
    return new Types.ObjectId(req.user.user_id);
};

const parseTargetId = (req: Request): Types.ObjectId => {
    return new Types.ObjectId(req.params.id as string);
};

// ─── POST /users ────────────────────────────────────────────────────────────
export const postCreateUser = async (req: Request, res: Response): Promise<Response> => {
    const user = await userService.createUser(req.body as CreateUserBody, callerId(req));
    return created(res, user);
};

// ─── GET /users ─────────────────────────────────────────────────────────────
export const getListUsers = async (req: Request, res: Response): Promise<Response> => {
    const query = req.query as unknown as ListUsersQuery;
    const { data, meta } = await userService.listUsers(query);
    return paginated(res, data, meta);
};

// ─── GET /users/:id ─────────────────────────────────────────────────────────
// Admin/Manager can fetch anyone; any authenticated user can fetch themself.
export const getUserById = async (req: Request, res: Response): Promise<Response> => {
    const caller = callerId(req);
    const target = parseTargetId(req);
    const isPrivileged = req.user?.role === ROLES.ADMIN || req.user?.role === ROLES.MANAGER;
    if (!isPrivileged && !caller.equals(target)) {
        throw AppError.forbidden();
    }
    const user = await userService.getUser(target);
    return ok(res, user);
};

// ─── PATCH /users/:id ───────────────────────────────────────────────────────
export const patchUser = async (req: Request, res: Response): Promise<Response> => {
    const user = await userService.updateUser({
        target_id: parseTargetId(req),
        caller_id: callerId(req),
        caller_role: req.user!.role,
        patch: req.body as UpdateUserBody,
    });
    return ok(res, user);
};

// ─── POST /users/:id/deactivate ─────────────────────────────────────────────
export const postDeactivateUser = async (req: Request, res: Response): Promise<Response> => {
    const body = (req.body ?? {}) as DeactivateUserBody;
    const user = await userService.deactivateUser({
        target_id: parseTargetId(req),
        caller_id: callerId(req),
        reason: body.reason,
    });
    return ok(res, user);
};

// ─── POST /users/:id/reactivate ─────────────────────────────────────────────
export const postReactivateUser = async (req: Request, res: Response): Promise<Response> => {
    const user = await userService.reactivateUser(parseTargetId(req));
    return ok(res, user);
};

// ─── POST /users/:id/change-role ────────────────────────────────────────────
export const postChangeUserRole = async (req: Request, res: Response): Promise<Response> => {
    const body = req.body as ChangeRoleBody;
    const user = await userService.changeUserRole({
        target_id: parseTargetId(req),
        caller_id: callerId(req),
        new_role: body.new_role,
    });
    return ok(res, user);
};

// ─── GET /users/assignable ──────────────────────────────────────────────────
export const getAssignableUsers = async (req: Request, res: Response): Promise<Response> => {
    const rows = await userService.listAssignable(req.query as unknown as AssignableQuery);
    return ok(res, rows);
};

// ─── Deferred endpoints (profile-photo, admin-reset-password) ──────────────
// These depend on Azure Blob Storage / Azure Communication Services wiring
// tracked in Build_Decisions.md. They respond with 501 for now so the route
// surface is visible without pretending to work.
export const notImplemented = async (_req: Request, res: Response): Promise<Response> => {
    return res.status(501).json({
        error: {
            code: 'NOT_IMPLEMENTED',
            message: 'Endpoint pending Azure Blob / Communication Services integration',
        },
    });
};

// Reserved for future noContent-returning endpoints.
void noContent;
