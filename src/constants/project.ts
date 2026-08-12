/**
 * Project + sprint constants — Data_Model.md §5.1 / §5.2 and
 * API_Contract.md §7.1 / §7.3.
 *
 * Custom task statuses (Data_Model §5.1 `custom_task_statuses`) are stored
 * **embedded** on the project document. The four DEFAULT_TASK_STATUSES below
 * are implicit — they are always available on every project and MUST NOT
 * collide with a custom status `key`. Listing them here lets the project
 * service reject collisions when an admin tries to add `{ key: "to_do" }`
 * as a custom status, and lets the task service validate that any chosen
 * status is either a default OR a configured custom one.
 *
 * RBAC role sets:
 *   - Reads (list/get/sub-resource gets) are role-checked here as
 *     "everyone authenticated" then narrowed to project visibility in the
 *     service (admin/manager → all; employee → member of; client → client of).
 *   - Writes (create/patch/members/clients/custom-statuses/sprints) are
 *     manager-or-above per API_Contract §7.1.
 *   - `archive` is admin-only (reserved for v1+).
 */

import { ROLES } from './roles.js';

// ─── Project status ──────────────────────────────────────────────────────

export const PROJECT_STATUSES = {
    ACTIVE: 'active',
    COMPLETED: 'completed',
    ON_HOLD: 'on_hold',
} as const;

export type ProjectStatus = (typeof PROJECT_STATUSES)[keyof typeof PROJECT_STATUSES];

export const PROJECT_STATUS_VALUES: readonly ProjectStatus[] = Object.values(PROJECT_STATUSES);

// ─── Sprint status ───────────────────────────────────────────────────────

/**
 * Cap on the cross-project sprint picker (`GET /sprints`). It is a dropdown,
 * not a browsable list — past this many options a filter stops being usable
 * and wants a search box instead.
 */
export const SPRINT_PICKER_MAX = 200;

export const SPRINT_STATUSES = {
    PLANNED: 'planned',
    ACTIVE: 'active',
    COMPLETED: 'completed',
} as const;

export type SprintStatus = (typeof SPRINT_STATUSES)[keyof typeof SPRINT_STATUSES];

export const SPRINT_STATUS_VALUES: readonly SprintStatus[] = Object.values(SPRINT_STATUSES);

// ─── Default task statuses (implicit on every project) ───────────────────
//
// These keys are reserved — a project's `custom_task_statuses[].key` MUST NOT
// equal any of them. The implicit-default contract means tasks created without
// a `status` get `"to_do"` and the four are always selectable in the FE
// dropdown without server roundtrips.

export const DEFAULT_TASK_STATUS_KEYS = ['to_do', 'in_progress', 'review', 'done'] as const;

// Canonical board ordering of the four built-in statuses. Project create
// seeds `default_status_orders[]` with these values; admins can re-arrange
// per project via `PATCH /projects/:id/default-status-orders`. Values are
// spaced by 100 so customs can be interleaved without renumbering.
export const DEFAULT_STATUS_ORDER_VALUES: Record<(typeof DEFAULT_TASK_STATUS_KEYS)[number], number> = {
    to_do: 100,
    in_progress: 200,
    review: 300,
    done: 400,
};

export const buildCanonicalDefaultOrders = (): Array<{
    key: string;
    order: number;
    is_active: boolean;
}> =>
    DEFAULT_TASK_STATUS_KEYS.map((k) => ({
        key: k,
        order: DEFAULT_STATUS_ORDER_VALUES[k],
        is_active: true,
    }));

// ─── Custom-task-status caps ─────────────────────────────────────────────

export const CUSTOM_STATUS_KEY_MAX = 40;
export const CUSTOM_STATUS_LABEL_MAX = 60;
// Generous but bounded so the FE can render every custom column comfortably.
// 12 leaves room for the 4 defaults + 12 custom on a Kanban board without
// horizontal scroll on a 13" laptop. Bump if real-world projects exceed it.
export const CUSTOM_STATUSES_PER_PROJECT_MAX = 12;
// `key` must be lower-snake — matches our snake_case wire convention so the
// FE can use it as a stable identifier without a label-translation step.
export const CUSTOM_STATUS_KEY_REGEX = /^[a-z][a-z0-9_]{0,39}$/;

// ─── Project-level field caps ────────────────────────────────────────────

export const PROJECT_NAME_MAX = 200;
// `code` is unique across the company so we keep it small + uppercase. The
// regex matches `PRJ-001`, `ACME-WEBSITE-2026`, etc.
export const PROJECT_CODE_MAX = 40;
export const PROJECT_CODE_REGEX = /^[A-Z][A-Z0-9_-]{0,39}$/;
export const PROJECT_DESCRIPTION_MAX = 5_000;
export const PROJECT_MEMBERS_MAX = 200;
export const PROJECT_CLIENTS_MAX = 50;

// ─── Sprint-level field caps ─────────────────────────────────────────────

export const SPRINT_NAME_MAX = 120;
export const SPRINT_GOAL_MAX = 1_000;

// ─── Pagination defaults ─────────────────────────────────────────────────

export const PROJECT_LIST_DEFAULT_LIMIT = 20;
export const PROJECT_LIST_MAX_LIMIT = 100;
export const SPRINT_LIST_DEFAULT_LIMIT = 50;
export const SPRINT_LIST_MAX_LIMIT = 200;

// ─── Visibility scoping ──────────────────────────────────────────────────
//
// Step 47: route-level gates use `requirePermission(project.read|write|
// archive|members_write|clients_write)`; the route allowlist constants
// are gone. The two SCOPED_ROLES exports below remain because they
// drive per-row visibility filtering at the service layer (Team Lead +
// Employee see only projects they're members of; Client sees only
// projects they're clients on). That logic is role-string-based, not
// permission-based, and lives in `project.service.ts`.

/**
 * Roles whose project access is restricted to `member_ids` containment.
 * Step 47: Team Lead joins Employee here — they see + author projects
 * they're members of, just with broader permissions on those projects.
 */
export const PROJECT_MEMBER_SCOPED_ROLES: readonly string[] = [ROLES.TEAM_LEAD, ROLES.EMPLOYEE];

/**
 * Roles scoped to their COMPANY's projects (`company_id` match) — i.e. the
 * `client` role, which represents the client company itself.
 *
 * A Client sees every project of their company, not just the ones they're
 * rostered on. That's required, not generous: a Client's job is to assign
 * representatives to their company's projects, and they can't staff a project
 * they can't see. Roster-scoping them would deadlock a brand-new project.
 */
export const PROJECT_COMPANY_SCOPED_ROLES: readonly string[] = [ROLES.CLIENT];

/**
 * Roles restricted to `representative_ids` containment — the `representative`
 * role, a client company's project-scoped person.
 */
export const PROJECT_REPRESENTATIVE_SCOPED_ROLES: readonly string[] = [ROLES.REPRESENTATIVE];

/**
 * @deprecated Superseded by PROJECT_COMPANY_SCOPED_ROLES +
 * PROJECT_REPRESENTATIVE_SCOPED_ROLES. Kept only so the Company/Representative
 * work can land in reviewable steps; removed when project.service switches to
 * company_id scoping.
 */
export const PROJECT_CLIENT_SCOPED_ROLES: readonly string[] = [ROLES.CLIENT];

/** Every client-side role — used where the two are treated alike (e.g. a project's client-side roster). */
export const PROJECT_CLIENT_SIDE_ROLES: readonly string[] = [ROLES.CLIENT, ROLES.REPRESENTATIVE];
