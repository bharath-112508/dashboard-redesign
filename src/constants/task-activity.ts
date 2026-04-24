/**
 * Task-activity constants (Data_Model.md §5.7, BUILD_PROGRESS.md Step 20).
 *
 * `task_activities` is the **UI-facing** task change history shown on the
 * task detail screen. It is intentionally distinct from `audit_logs`
 * (system-wide trail for sensitive actions) — same event may write to
 * both; the audit row is for compliance, the activity row is for the
 * end-user feed.
 *
 * Recording is **best-effort** (matches the audit/notification policy):
 *   - `recordActivity` swallows DB errors and logs at warn with the
 *     `ACTIVITY_WRITE_FAILED` log code.
 *   - The primary task action (status change, assign, etc.) MUST always
 *     succeed even if the activity row can't be persisted.
 *
 * Retention: no pruning in v1 (BUILD_PROGRESS Step 20). Phase 3 may add
 * a "delete activity older than N days" job; for now rows live forever.
 *
 * Activity-type naming convention:
 *   - `<noun>_<past-tense-verb>` matching the Data_Model enum.
 *   - `subtask_added` is recorded against the **parent** task (the child
 *     gets its own `created` row separately).
 *   - `story_changed` is added on top of the spec'd enum because
 *     BUILD_PROGRESS explicitly asks for "story attach/detach" hooks;
 *     the Data_Model enum predates the Story step.
 */

import { ROLES, type RoleType } from './roles.js';

// ─── Activity types (Data_Model §5.7 + Step 20 story hook) ──────────────

export const TASK_ACTIVITY_TYPES = {
    CREATED: 'created',
    STATUS_CHANGED: 'status_changed',
    PRIORITY_CHANGED: 'priority_changed',
    DUE_DATE_CHANGED: 'due_date_changed',
    ASSIGNEE_CHANGED: 'assignee_changed',
    COLLABORATOR_ADDED: 'collaborator_added',
    COLLABORATOR_REMOVED: 'collaborator_removed',
    SPRINT_CHANGED: 'sprint_changed',
    STORY_CHANGED: 'story_changed',
    DEPENDENCY_ADDED: 'dependency_added',
    DEPENDENCY_REMOVED: 'dependency_removed',
    SUBTASK_ADDED: 'subtask_added',
    ESTIMATE_CHANGED: 'estimate_changed',
    ATTACHMENT_ADDED: 'attachment_added',
    ATTACHMENT_REMOVED: 'attachment_removed',
    COMMENT_ADDED: 'comment_added',
    COMMENT_EDITED: 'comment_edited',
    COMMENT_DELETED: 'comment_deleted',
} as const;

export type TaskActivityType = (typeof TASK_ACTIVITY_TYPES)[keyof typeof TASK_ACTIVITY_TYPES];

export const TASK_ACTIVITY_TYPE_VALUES: readonly TaskActivityType[] = Object.values(TASK_ACTIVITY_TYPES);

// ─── Pagination (API §1.6 max-100 contract) ──────────────────────────────

export const ACTIVITY_LIST_DEFAULT_LIMIT = 20;
export const ACTIVITY_LIST_MAX_LIMIT = 100;

// ─── RBAC ────────────────────────────────────────────────────────────────
//
// Project visibility is the gate. Any role with read access to the parent
// task can read its activity feed; the service composes the parent
// project's visibility filter.

export const ACTIVITY_READ_ROLES: readonly RoleType[] = [ROLES.ADMIN, ROLES.MANAGER, ROLES.EMPLOYEE, ROLES.CLIENT];

// ─── Field caps ──────────────────────────────────────────────────────────
//
// `from_value`/`to_value` are stored as `Schema.Types.Mixed` so they can
// hold strings, ObjectIds, dates, numbers, etc. We don't cap at the
// model layer; service-level recorders should keep payloads small (a
// status string, a single ObjectId, etc.) — never the full task doc.

export const ACTIVITY_TYPE_MAX = 80;
