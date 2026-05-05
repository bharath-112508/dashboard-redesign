/**
 * Service-layer role checks (BACKEND_AUDIT.md R4).
 *
 * Step 47 introduced `role_ids[]` + `role_keys[]` so a single user can
 * hold multiple system roles (e.g. an admin who is also a manager).
 * The legacy `users.role` field is a denormalised cache of the FIRST
 * system-role key — it does NOT necessarily contain `'admin'` for a
 * user who's an admin via `role_keys`.
 *
 * Auth-middleware's `isCallerAdmin(payload)` correctly checks BOTH
 * signals against the JWT payload. Pre-R4, service-layer code only
 * compared `caller.role === ROLES.ADMIN`, so a multi-role admin whose
 * legacy cache happened to be `'manager'` would pass the route gate
 * (which uses the proper RBAC check) but be DENIED at the service
 * layer.
 *
 * This module exports the equivalent helper for service layers.
 * Service `Caller` types now optionally carry `role_keys?` (passed
 * down from `req.user.role_keys`); the helper accepts either shape.
 */
import { ROLES } from '../constants/roles.js';
import { SYSTEM_ROLE_KEYS } from '../constants/role-keys.js';

export interface AdminCheckable {
    /** Legacy single role string from `users.role` (denormalised cache of first system-role key). */
    role?: string | null;
    /** Step-47 role keys. Pre-R4 callers may not populate this; the helper falls back to `role` only. */
    role_keys?: readonly string[];
}

/**
 * True when the caller has the admin role through ANY signal:
 *   - the legacy `role === 'admin'` cache, OR
 *   - `role_keys.includes('admin')` (post-Step-47 RBAC).
 *
 * Mirrors `auth.middleware.isCallerAdmin` exactly so the route gate
 * and the service gate agree on what "admin" means.
 */
export const isAdminLike = (caller: AdminCheckable): boolean => {
    if (caller.role === ROLES.ADMIN) return true;
    return (caller.role_keys ?? []).includes(SYSTEM_ROLE_KEYS.ADMIN);
};

/**
 * H2 — defence-in-depth role check for project-author writes (sprints,
 * stories, task templates, etc.). Admin / Manager / Team Lead all hold
 * `sprint.write` / `story.write` / `task_template.write` per the
 * Step-47 system-role bundle (`system-role-definitions.ts`), and the
 * route layer's `requirePermission(...)` gate is the authoritative
 * coarse check. The service layer mirrors that gate for defence-in-
 * depth and to give honest 4xx codes when callers bypass the route
 * (e.g. tests, internal callers).
 *
 * Pre-H2 the service gate was `caller.role !== ADMIN && caller.role
 * !== MANAGER` — Team Lead held the permission per the bundle but
 * was rejected at the service, contradicting the bundle's intent.
 */
export const isProjectAuthor = (caller: AdminCheckable): boolean => {
    if (caller.role === ROLES.ADMIN || caller.role === ROLES.MANAGER || caller.role === ROLES.TEAM_LEAD) return true;
    const keys = caller.role_keys ?? [];
    return (
        keys.includes(SYSTEM_ROLE_KEYS.ADMIN) ||
        keys.includes(SYSTEM_ROLE_KEYS.MANAGER) ||
        keys.includes(SYSTEM_ROLE_KEYS.TEAM_LEAD)
    );
};
