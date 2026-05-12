import { Request, Response } from 'express';
import { Types } from 'mongoose';

import * as userService from '../services/user.service.js';
import * as profilePhotoService from '../services/profile-photo.service.js';
import * as gdprService from '../services/user-gdpr.service.js';
import { adminInitiatePasswordReset } from '../services/password-reset.service.js';
import { recordAudit } from '../services/audit.service.js';
import { AUDIT_ACTIONS, AUDIT_TARGET_KINDS } from '../constants/audit.js';
import { created, noContent, ok, paginated } from '../utils/api-response.js';
import { AppError } from '../utils/app-error.js';
import { ROLES } from '../constants/roles.js';
import { buildAuditContext } from '../utils/audit-context.js';
import type {
    AssignableQuery,
    ChangeRoleBody,
    CreateUserBody,
    DeactivateUserBody,
    ListUsersQuery,
    UpdateUserBody,
} from '../validators/user.validator.js';
import type { ProfilePhotoFinalizeBody, ProfilePhotoUploadUrlBody } from '../validators/profile-photo.validator.js';

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
    const user = await userService.createUser(req.body as CreateUserBody, callerId(req), buildAuditContext(req));
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
        // R4 — pass the Step-47 RBAC signal so a multi-role admin
        // whose legacy `role` cache is something else still passes
        // `isAdminLike` in the service layer.
        caller_role_keys: req.user!.role_keys,
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
        audit: buildAuditContext(req),
    });
    return ok(res, user);
};

// ─── POST /users/:id/reactivate ─────────────────────────────────────────────
export const postReactivateUser = async (req: Request, res: Response): Promise<Response> => {
    const user = await userService.reactivateUser(parseTargetId(req), buildAuditContext(req));
    return ok(res, user);
};

// ─── POST /users/:id/change-role ────────────────────────────────────────────
export const postChangeUserRole = async (req: Request, res: Response): Promise<Response> => {
    const body = req.body as ChangeRoleBody;
    const user = await userService.changeUserRole({
        target_id: parseTargetId(req),
        caller_id: callerId(req),
        new_role: body.new_role,
        audit: buildAuditContext(req),
    });
    return ok(res, user);
};

// ─── GET /users/assignable ──────────────────────────────────────────────────
export const getAssignableUsers = async (req: Request, res: Response): Promise<Response> => {
    const rows = await userService.listAssignable(req.query as unknown as AssignableQuery);
    return ok(res, rows);
};

// ─── Profile photo endpoints (Step 22) ─────────────────────────────────────
//
// Routes are `/users/me/*` only — admins do not manage other users' photos
// in v1 (the deactivate flow archives the user record, not the avatar).

const callerForPhoto = (req: Request): profilePhotoService.ProfilePhotoCaller => ({
    id: callerId(req),
    audit: buildAuditContext(req),
});

export const postProfilePhotoUploadUrl = async (req: Request, res: Response): Promise<Response> => {
    const data = await profilePhotoService.mintUploadUrl(req.body as ProfilePhotoUploadUrlBody, callerForPhoto(req));
    return ok(res, data);
};

export const postProfilePhotoFinalize = async (req: Request, res: Response): Promise<Response> => {
    const data = await profilePhotoService.finalizeProfilePhoto(
        req.body as ProfilePhotoFinalizeBody,
        callerForPhoto(req)
    );
    return ok(res, data);
};

export const deleteProfilePhoto = async (req: Request, res: Response): Promise<Response> => {
    const data = await profilePhotoService.clearProfilePhoto(callerForPhoto(req));
    return ok(res, data);
};

// ─── Admin profile-photo endpoints (per-id resource) ────────────────────
//
// Mirror the /me/* set above but accept the path-id as the SUBJECT.
// The acting admin is still `caller` (used for the audit actor); the
// service resolves blob-key namespacing + audit target to `targetUserId`.
// Gate on `USER_WRITE` at the route layer (same as `PATCH /users/:id`).

export const adminPostProfilePhotoUploadUrl = async (req: Request, res: Response): Promise<Response> => {
    const targetUserId = parseTargetId(req);
    const data = await profilePhotoService.mintUploadUrl(
        req.body as ProfilePhotoUploadUrlBody,
        callerForPhoto(req),
        targetUserId.toString()
    );
    return ok(res, data);
};

export const adminPostProfilePhotoFinalize = async (req: Request, res: Response): Promise<Response> => {
    const targetUserId = parseTargetId(req);
    const data = await profilePhotoService.finalizeProfilePhoto(
        req.body as ProfilePhotoFinalizeBody,
        callerForPhoto(req),
        targetUserId.toString()
    );
    return ok(res, data);
};

export const adminDeleteProfilePhoto = async (req: Request, res: Response): Promise<Response> => {
    const targetUserId = parseTargetId(req);
    const data = await profilePhotoService.clearProfilePhoto(callerForPhoto(req), targetUserId.toString());
    return ok(res, data);
};

// ─── GDPR DSAR + erasure (BACKEND_AUDIT.md P1-8) ────────────────────────────
//
// Both endpoints are admin-only via `USER_DATA_EXPORT` /
// `USER_DATA_ERASURE` permissions on the route. Self-export is
// intentionally NOT supported here — every DSAR flow goes through an
// admin-reviewed ticket so the request is logged and traceable, the
// same as a paper records-request.

export const getUserDataExport = async (req: Request, res: Response): Promise<Response> => {
    const target = parseTargetId(req);
    const dump = await gdprService.exportUserData(target);
    // Audit the export — the dump itself is sensitive PII, so the act
    // of generating it is recorded against the actor.
    await recordAudit(buildAuditContext(req), {
        action: AUDIT_ACTIONS.USER_DATA_EXPORT,
        target: { kind: AUDIT_TARGET_KINDS.USER, id: target },
        metadata: {
            collections_count: Object.keys(dump).length - 2, // minus `exported_at` + `user`
        },
    });
    // R8 — return the dump RAW (no `{ data: ... }` envelope). This
    // endpoint produces a file attachment that gets handed to legal /
    // the regulator / the data subject; framework artefacts in that
    // payload would force every downstream consumer to peel `.data`
    // off. The live-API envelope is for live API consumers, not
    // file attachments.
    res.setHeader('Content-Disposition', `attachment; filename="user-${target.toString()}-data-export.json"`);
    res.setHeader('Content-Type', 'application/json');
    return res.json(dump);
};

export const postUserDataErasure = async (req: Request, res: Response): Promise<Response> => {
    const target = parseTargetId(req);
    const result = await gdprService.eraseUserData(target, buildAuditContext(req));
    return ok(res, result);
};

// ─── POST /users/:id/reset-password ────────────────────────────────────────
//
// Admin-triggered password reset. Mints a one-time reset token for the
// target user and emails them a link — reuses the user-initiated
// forgot/reset infrastructure (`password-reset.service`). The link is
// NOT in the response: the admin's job is to TRIGGER the reset, not to
// see the secret. Audited as `auth.admin_password_reset` with the admin
// as actor; the downstream `auth.password_reset` row (when the user
// consumes the link) records the user as actor.
export const postAdminResetPassword = async (req: Request, res: Response): Promise<Response> => {
    await adminInitiatePasswordReset(parseTargetId(req), buildAuditContext(req));
    return noContent(res);
};
