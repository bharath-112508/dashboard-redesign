import { ROLES, type RoleType } from './roles.js';

/**
 * Dashboard constants — Step 13 (API_Contract.md §14, Plan §6.1).
 *
 * Phase 1 scope:
 *  - `/dashboard/admin`    — admin-only. Org-wide leave + attendance metrics.
 *  - `/dashboard/manager`  — manager (and admin). Minimal team pending-leave
 *    counter for the internal-alpha roll-out; richer team metrics land in
 *    Phase 2 alongside the projects/timesheets cards.
 *  - `/dashboard/employee` — any internal role. Self-scoped: today's check-in
 *    state, current-year leave balances, recent leave requests, unread
 *    notifications.
 *
 * RBAC is enforced at the route layer with `authorize(...)`. Every endpoint
 * is read-only and never mutates state, so failures here must never surface
 * as 5xx — service helpers swallow per-card errors and return empty/zero
 * cards (logged at warn) so a single broken aggregation can't black out the
 * whole landing page.
 *
 * Project / sprint / task / timesheet / billable cards are intentionally
 * deferred to Phase 2 (Step 24+). Phase 2 will extend the same payload with
 * the `projects`, `timesheets`, etc. blocks documented in API_Contract §14.
 */

// ─── RBAC ─────────────────────────────────────────────────────────────────

export const DASHBOARD_ADMIN_ROLES: readonly RoleType[] = [ROLES.ADMIN];
export const DASHBOARD_MANAGER_ROLES: readonly RoleType[] = [ROLES.ADMIN, ROLES.MANAGER];
export const DASHBOARD_EMPLOYEE_ROLES: readonly RoleType[] = [ROLES.ADMIN, ROLES.MANAGER, ROLES.EMPLOYEE];

// ─── Card limits ──────────────────────────────────────────────────────────

/** Recent-leave-requests list size on the employee dashboard. */
export const DASHBOARD_RECENT_LEAVES_LIMIT = 5;

/** Recent pending-approval list size on the admin dashboard. */
export const DASHBOARD_PENDING_LEAVES_PREVIEW = 5;
