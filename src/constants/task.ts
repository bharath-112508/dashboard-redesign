/**
 * Task constants — Data_Model.md §5.4 / API_Contract.md §8.
 *
 * Tasks are the atomic unit of project work. They live inside a project,
 * optionally inside a sprint and a story, and may be subtasks of another
 * task. The data model carries dependencies and Kanban position inline on
 * the task document — there is no separate `task_dependencies` collection
 * (the BUILD_PROGRESS bullet referencing one predates Data_Model §5.4 being
 * finalised; we follow Data_Model).
 *
 * Subtask depth is hard-capped at 1 — a top-level task may have subtasks,
 * but a subtask cannot itself have subtasks. This keeps the activity feed
 * + UI simple and matches BUILD_PROGRESS Step 18's explicit constraint.
 */

// ─── Statuses ────────────────────────────────────────────────────────────
//
// These are the IMPLICIT defaults baked into every project. A project's
// `custom_task_statuses[]` can add MORE keys, but never collide with these
// (collision rejected at validator + service in Step 16). The service
// validates the chosen status against (defaults ∪ project.customs).

export const DEFAULT_TASK_STATUSES = {
    TO_DO: 'to_do',
    IN_PROGRESS: 'in_progress',
    REVIEW: 'review',
    DONE: 'done',
} as const;

export const DEFAULT_TASK_STATUS_VALUES: readonly string[] = Object.values(DEFAULT_TASK_STATUSES);

// ─── Priorities ──────────────────────────────────────────────────────────

export const TASK_PRIORITIES = {
    HIGH: 'high',
    MEDIUM: 'medium',
    LOW: 'low',
} as const;

export type TaskPriority = (typeof TASK_PRIORITIES)[keyof typeof TASK_PRIORITIES];

export const TASK_PRIORITY_VALUES: readonly TaskPriority[] = Object.values(TASK_PRIORITIES);

// ─── Field caps ──────────────────────────────────────────────────────────

export const TASK_TITLE_MAX = 200;
export const TASK_DESCRIPTION_MAX = 20_000;
export const TASK_STATUS_KEY_MAX = 40;

// Cap collaborator + dependency arrays so a single task can't carry an
// unbounded list (defends both the index and the audit-row size). The
// numbers are generous; bump if real usage demands.
export const TASK_COLLABORATORS_MAX = 50;
export const TASK_DEPENDENCIES_MAX = 50;

// Estimated hours: bounded because we round to 15-minute granularity in
// the FE and a task above 100 h is almost always a smell that should be
// split into subtasks.
export const TASK_ESTIMATED_HOURS_MAX = 1_000;

// Subtask depth — a subtask cannot itself have subtasks (BUILD_PROGRESS
// Step 18: "subtask depth = 1").
export const TASK_MAX_SUBTASK_DEPTH = 1;

// ─── Pagination ──────────────────────────────────────────────────────────

export const TASK_LIST_DEFAULT_LIMIT = 50;
export const TASK_LIST_MAX_LIMIT = 200;

// ─── RBAC role sets ──────────────────────────────────────────────────────

// Step 47: route gates use `requirePermission(task.read | task.write)`.
// PATCH semantics (employees patch only own tasks within an allowed
// field allowlist) live in `task.service.ts` (`assertEmployeePatchScope`
// + `TASK_EMPLOYEE_PATCH_FIELDS` below).

/**
 * Fields an employee may update on a task they own (assignee or creator).
 * Anything outside this set requires manager-or-above.
 */
export const TASK_EMPLOYEE_PATCH_FIELDS: readonly string[] = ['status', 'description', 'estimated_hours'];
