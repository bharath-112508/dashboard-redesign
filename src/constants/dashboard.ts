/**
 * Dashboard constants — Step 13 (API_Contract.md §14, Plan §6.1).
 *
 * Phase 1 scope:
 *  - `/dashboard/admin`    — gated on `dashboard.admin`. Org-wide leave + attendance metrics.
 *  - `/dashboard/manager`  — gated on `dashboard.manager`. Minimal team
 *    pending-leave counter for the internal-alpha roll-out.
 *  - `/dashboard/employee` — gated on `dashboard.employee`. Self-scoped.
 *
 * Every endpoint is read-only and never mutates state, so failures must
 * never surface as 5xx — service helpers swallow per-card errors and
 * return empty/zero cards (logged at warn) so a single broken
 * aggregation can't black out the whole landing page.
 */

// ─── Card limits ──────────────────────────────────────────────────────────

/** Recent-leave-requests list size on the employee dashboard. */
export const DASHBOARD_RECENT_LEAVES_LIMIT = 5;

/** Recent pending-approval list size on the admin dashboard. */
export const DASHBOARD_PENDING_LEAVES_PREVIEW = 5;
