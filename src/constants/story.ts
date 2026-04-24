/**
 * Story constants — Data_Model.md §5.3 / API_Contract.md §7.4.
 *
 * Stories are a lightweight grouping layer **above tasks**, scoped to a
 * project (no `sprint_id` of their own). Status / sprint membership /
 * progress are computed on read from child tasks; nothing is persisted.
 *
 * RBAC summary:
 *  - Reads (list / get / list-tasks)  → all authenticated roles, narrowed
 *    by project visibility (admin/manager → all; employee → member of;
 *    client → client of).
 *  - Writes (create / patch / delete / reorder) → Admin or Manager only.
 *    Employees / Clients receive `403 STORY_WRITE_FORBIDDEN`.
 */

import { ROLES } from './roles.js';

// ─── Field caps ──────────────────────────────────────────────────────────

export const STORY_TITLE_MAX = 200;
// Stories carry rich text per Data_Model §5.3. The cap is generous so a
// PM can paste a multi-paragraph brief without hitting the limit; bump if
// real-world stories exceed it.
export const STORY_DESCRIPTION_MAX = 10_000;

// ─── Pagination ──────────────────────────────────────────────────────────

export const STORY_LIST_DEFAULT_LIMIT = 20;
export const STORY_LIST_MAX_LIMIT = 100;

// ─── Derived statuses ────────────────────────────────────────────────────
//
// `derived_status` is computed at read time from the story's child tasks.
// The set is fixed (Data_Model §5.3) — projects can't add custom *story*
// statuses. The `BLOCKED_TASK_STATUS_KEY` is the literal task-status key
// that triggers the "blocked" rule; if a project adds a custom task status
// with this exact key, any task in it counts as a blocker.

export const STORY_DERIVED_STATUSES = {
    EMPTY: 'empty',
    TO_DO: 'to_do',
    IN_PROGRESS: 'in_progress',
    BLOCKED: 'blocked',
    DONE: 'done',
} as const;

export type StoryDerivedStatus = (typeof STORY_DERIVED_STATUSES)[keyof typeof STORY_DERIVED_STATUSES];

export const STORY_DERIVED_STATUS_VALUES: readonly StoryDerivedStatus[] = Object.values(STORY_DERIVED_STATUSES);

/** Task status keys that trigger the "in_progress" derived rule. */
export const IN_PROGRESS_TASK_STATUS_KEYS: readonly string[] = ['in_progress', 'review'];

/** Task status key that triggers the "blocked" derived rule. */
export const BLOCKED_TASK_STATUS_KEY = 'blocked';

/** Default task-status key considered terminal (joined with project's `is_terminal: true` customs). */
export const DEFAULT_DONE_TASK_STATUS_KEY = 'done';

// ─── RBAC role sets ──────────────────────────────────────────────────────

/** Roles allowed to write stories (create/patch/delete/reorder). */
export const STORY_WRITE_ROLES = [ROLES.ADMIN, ROLES.MANAGER] as const;

/**
 * All authenticated roles can read; service-layer project visibility (via
 * `project.service.loadProjectForCaller`) narrows further per role.
 */
export const STORY_READ_ROLES = [ROLES.ADMIN, ROLES.MANAGER, ROLES.EMPLOYEE, ROLES.CLIENT] as const;
