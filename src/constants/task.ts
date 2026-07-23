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

// ─── Issue types ─────────────────────────────────────────────────────────
//
// A lightweight classification on the task (Jira "issue type"). Deliberately
// NOT Epic/Story — those would collide with the separate `stories` entity and
// the `parent_task_id` subtask hierarchy. Keeping three flat types (task /
// bug / improvement) gives the Jira "typed issue" feel without touching the
// hierarchy. Default `task`.

export const TASK_ISSUE_TYPES = {
    TASK: 'task',
    BUG: 'bug',
    IMPROVEMENT: 'improvement',
} as const;

export type TaskIssueType = (typeof TASK_ISSUE_TYPES)[keyof typeof TASK_ISSUE_TYPES];

export const TASK_ISSUE_TYPE_VALUES: readonly TaskIssueType[] = Object.values(TASK_ISSUE_TYPES);

// ─── Story points ────────────────────────────────────────────────────────
//
// The classic Fibonacci-ish estimation scale. Stored as a plain number (one
// of these values) or `null` for "unestimated". Constrained to the set at
// the validator + schema so the board's per-column / per-sprint sums stay
// meaningful and free-typed junk can't leak in.

export const TASK_STORY_POINT_VALUES: readonly number[] = [1, 2, 3, 5, 8, 13, 21];

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

// ─── Labels (Phase 3c — Jira-style freeform tags) ────────────────────────
//
// Freeform string labels on a task, exactly like Jira. A single label is
// capped to keep the chip readable and the multikey index entries small; the
// per-task count is capped so one task can't carry an unbounded tag list
// (defends the `{project_id, labels}` index + audit-row size).
export const TASK_LABEL_MAX_LEN = 40;
export const TASK_LABELS_MAX = 20;

// ─── Pagination ──────────────────────────────────────────────────────────

export const TASK_LIST_DEFAULT_LIMIT = 50;
export const TASK_LIST_MAX_LIMIT = 200;

// ─── RBAC role sets ──────────────────────────────────────────────────────

// Step 47: route gates use `requirePermission(task.read | task.write)`.
// PATCH semantics (employees patch only own tasks within an allowed
// field allowlist) live in `task.service.ts` (`assertEmployeePatchScope`
// + `TASK_EMPLOYEE_PATCH_FIELDS` below).

/**
 * Fields an employee may update on a task. Anything outside this set requires
 * manager-or-above. Who may set each, enforced in `assertEmployeePatchScope`:
 *   - the CREATOR may edit all of these AND assign/unassign any project member;
 *   - a non-creator ASSIGNEE may edit status/description/estimate (their work);
 *   - any member may ADD themselves to `assignee_ids` (grab the task) but only
 *     the creator/managers may REMOVE anyone — so a non-creator can't leave or
 *     unassign teammates on their own.
 */
export const TASK_EMPLOYEE_PATCH_FIELDS: readonly string[] = [
    'status',
    'description',
    'estimated_hours',
    'assignee_ids',
];

/** Max people a single task can be assigned to. */
export const TASK_MAX_ASSIGNEES = 20;
