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
import { type RoleType } from '../constants/roles.js';
import { PERMISSIONS } from '../constants/permissions.js';
import { callerHasPermission } from '../middlewares/auth.middleware.js';
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
    // BUG-002 — `show_deleted=true` (or explicit `status=deactivated`) is
    // a privileged view of the soft-delete bucket. Only callers who can
    // write users get to see it; everyone else is forced to the active
    // bucket. We scrub silently so the front-end toggle simply does
    // nothing for non-permitted users.
    if (!callerHasPermission(req, PERMISSIONS.USER_WRITE)) {
        query.show_deleted = false;
        if (query.status === 'deactivated') delete query.status;
    }
    const { data, meta } = await userService.listUsers(query);
    return paginated(res, data, meta);
};

// ─── GET /users/:id ─────────────────────────────────────────────────────────
// Admin / Manager / Team-Lead can fetch anyone; any authenticated user can
// fetch themself. (BUG-039 — team-lead added to the privileged list so
// the user-detail page renders for them. The detail page is intentionally
// read-only for team-lead — see USER_WRITE gates in the FE Roles tab.)
//
// M1 — use the RBAC permission catalog instead of comparing `req.user.role`
// strings. A future custom-role admin (Step 47 RBAC, where role bits come
// from a per-user role bundle rather than the legacy single `role` column)
// would have `req.user.role` set to something other than `admin` even
// though they hold `USER_READ`. `callerHasPermission` resolves against
// the full permission set (legacy role + role_keys + extra_permissions),
// matching how every other privileged route in the codebase checks.
export const getUserById = async (req: Request, res: Response): Promise<Response> => {
    const caller = callerId(req);
    const target = parseTargetId(req);
    const isPrivileged = callerHasPermission(req, PERMISSIONS.USER_READ);
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
        // Resolved permission set — lets the service tell an
        // employment-only editor (user.employment_write) apart from a
        // full editor and restrict the patch accordingly.
        caller_permissions: req.user!.permissions,
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
    if (!req.user?.role) throw AppError.unauthenticated();
    const rows = await userService.listAssignable(req.query as unknown as AssignableQuery, {
        id: callerId(req),
        role: req.user.role as RoleType,
    });
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
    // M43 — stream as NDJSON so the export doesn't materialise the
    // user's full data tree in memory before responding. For a tenured
    // user this avoided pinning a worker for seconds + OOM risk on a
    // 256-MB heap. R8 (no `{data}` envelope) is preserved: the
    // response is raw JSONL, one row per line.
    res.setHeader('Content-Disposition', `attachment; filename="user-${target.toString()}-data-export.ndjson"`);
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    const { row_counts } = await gdprService.exportUserDataNdjson(target, res);
    // Audit the export — the dump itself is sensitive PII, so the act
    // of generating it is recorded against the actor.
    await recordAudit(buildAuditContext(req), {
        action: AUDIT_ACTIONS.USER_DATA_EXPORT,
        target: { kind: AUDIT_TARGET_KINDS.USER, id: target },
        metadata: {
            collections_count: Object.keys(row_counts).length,
            row_counts,
        },
    });
    res.end();
    return res;
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
