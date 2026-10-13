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
 * H2 — defence-in-depth role check for **lead-tier** project authoring:
 * task templates, and anything else Employees deliberately don't get. The
 * route layer's `requirePermission(...)` gate is the authoritative coarse
 * check; the service layer mirrors it for defence-in-depth and to give
 * honest 4xx codes when callers bypass the route (e.g. tests, internal
 * callers).
 *
 * Pre-H2 the service gate was `caller.role !== ADMIN && caller.role
 * !== MANAGER` — Team Lead held the permission per the bundle but
 * was rejected at the service, contradicting the bundle's intent.
 *
 * Employee is NOT included: `task_template.write` stays team-lead-and-up.
 * For sprints and stories — which every internal role may now author on a
 * project they belong to — use `isProjectWorkAuthor` below instead.
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

/**
 * Defence-in-depth check for authoring the WORK inside a project — sprints
 * and stories/epics. Every internal role holds `sprint.write` /
 * `story.write`, because anyone on a project should be able to plan it.
 *
 * Separate from `isProjectAuthor` because the two policies genuinely differ
 * now: templates stay team-lead-and-up, sprints and epics do not. Folding
 * Employee into `isProjectAuthor` instead would have silently widened the
 * template guard as well.
 *
 * This does NOT decide WHICH project: every call site resolves the project
 * through `loadProjectForCaller` first, which scopes an Employee to
 * `member_ids ∋ them`. What's left for this function is keeping the client
 * side out — `client` and `representative` can see a project's board and
 * must never restructure it — so don't "simplify" it to `true`.
 */
export const isProjectWorkAuthor = (caller: AdminCheckable): boolean => {
    if (isProjectAuthor(caller)) return true;
    return caller.role === ROLES.EMPLOYEE || (caller.role_keys ?? []).includes(SYSTEM_ROLE_KEYS.EMPLOYEE);
};
