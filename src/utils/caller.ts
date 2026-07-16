import { Request } from 'express';
import { Types } from 'mongoose';

import type { RoleType } from '../constants/roles.js';
import type { ProjectCaller } from '../services/project.service.js';
import { AppError } from './app-error.js';
import { buildAuditContext } from './audit-context.js';

/**
 * Build a `ProjectCaller` from an Express request.
 *
 * Every project-scoped controller used to define its own near-identical
 * `callerOf(req)` local. They all built the same shape, which meant any
 * new field on the caller had to be threaded through ~11 copies — and a
 * copy that got missed would silently scope a request wrong rather than
 * fail to compile. This is the single construction site instead.
 *
 * `role_keys` is the R4 / Step-47 RBAC signal: it lets `isAdminLike` in
 * the service layer recognise a multi-role admin even when the legacy
 * denormalized `role` cache says otherwise. Eight of the old locals
 * passed it; `timeline`, `search` and `task-template` didn't. Unifying
 * on "always pass it" is inert today — none of those three services
 * calls `isAdminLike` — and matches what the R4 note on `ProjectCaller`
 * asks controllers to do.
 *
 * The `role` guard matches the strictest of the old locals (`timeline` /
 * `search` checked it; the rest only checked `user_id`). Taking the
 * stricter one keeps this refactor from loosening any check.
 */
export const projectCallerFrom = (req: Request): ProjectCaller => {
    if (!req.user?.user_id || !req.user?.role) throw AppError.unauthenticated();
    return {
        id: new Types.ObjectId(req.user.user_id),
        role: req.user.role as RoleType,
        role_keys: req.user.role_keys,
        // Set by `authenticate` from the DB row; undefined for staff roles.
        // This is the whole reason the eleven callerOf locals were collapsed
        // into one — otherwise a copy that missed this field would silently
        // scope a client's request to "no company" rather than fail to build.
        company_id: req.caller_company_id,
        audit: buildAuditContext(req),
    };
};
