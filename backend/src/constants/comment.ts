/**
 * Task-comment constants (Data_Model.md §5.5, API_Contract.md §8.4,
 * BUILD_PROGRESS.md Step 19).
 *
 * Comments are *project-scoped* — anyone with project read access can post,
 * the author can edit, the author OR an admin/manager can soft-delete.
 *
 * Mention scoping (server-enforced):
 *   - Mentioned users must be members or clients of the parent project.
 *   - Clients are not further restricted (they can mention any project
 *     member or other client). The point of the rule is to prevent a
 *     client from spraying notifications at unrelated internal users.
 *   - The check runs in the service layer — anything stricter (e.g.
 *     "clients can only mention managers") would belong in the service
 *     too, not the validator.
 *
 * Field caps mirror the spirit of `task` caps but are tuned for chat-like
 * usage:
 *   - `body` up to ~5 KiB (covers a long paragraph + small markdown
 *     formatting; bigger writeups belong in the task description).
 *   - `mentioned_user_ids` capped at 25 to bound per-comment notification
 *     fan-out.
 */

// ─── Field caps ──────────────────────────────────────────────────────────

export const COMMENT_BODY_MAX = 5_000;
export const COMMENT_MENTIONS_MAX = 25;

// ─── Pagination ──────────────────────────────────────────────────────────

export const COMMENT_LIST_DEFAULT_LIMIT = 20;
export const COMMENT_LIST_MAX_LIMIT = 100;

// Step 47: route gates use `requirePermission(task.read)` for list and
// `requirePermission(task_comment.write)` for create/patch/delete.
// Project visibility is enforced inside the service via
// `loadProjectForCaller`. Edit/delete authorisation is per-row (author
// or admin/manager/team-lead) — see `task-comment.service.ts`.
