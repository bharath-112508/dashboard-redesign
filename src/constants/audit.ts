/**
 * Audit-log constants (Data_Model.md §7.2, API_Contract.md §12,
 * Company_Management_Plan.md §7.5).
 *
 * Phase 1 is **write-only** — there is no GET endpoint until Phase 3 Step 31.
 * The collection is the durable paper trail for every "sensitive" action; the
 * dispatcher records on best-effort and never blocks the primary write.
 *
 * Action naming convention:
 *   `<resource>.<verb>` — lower snake/dot. Resource is the domain (`user`,
 *   `auth`, `leave`, `settings`); verb is past-tense or imperative depending
 *   on what reads more naturally for the audit screen ("user.deactivate" vs
 *   "user.deactivated"). We use the imperative form to match Data_Model §7.2's
 *   examples.
 *
 * Failure policy (mirrors `NOTIFICATION_DISPATCH_FAILED`):
 *   - `audit.service.recordAudit` swallows DB errors and logs at warn level
 *     with `AUDIT_WRITE_FAILED`. Operators grep for that code to find dropped
 *     events.
 */

import { ROLES, type RoleType } from './roles.js';

// ─── Actions whitelist (Data_Model.md §7.2 examples + Phase 1 hookups) ──

export const AUDIT_ACTIONS = {
    // User lifecycle (admin invite + role mgmt)
    USER_CREATE: 'user.create',
    USER_ROLE_CHANGE: 'user.role_change',
    USER_DEACTIVATE: 'user.deactivate',
    USER_REACTIVATE: 'user.reactivate',
    // Profile photo lifecycle (Phase 2 Step 22). `metadata.size_bytes` /
    // `metadata.mime_type` recorded on set; `metadata.previous_blob_key`
    // recorded on replace + clear so a forensic recovery of the prior
    // image is possible until the blob is GC'd.
    USER_PROFILE_PHOTO_SET: 'user.profile_photo_set',
    USER_PROFILE_PHOTO_CLEAR: 'user.profile_photo_clear',

    // Auth / credentials
    AUTH_PASSWORD_CHANGE: 'auth.password_change',
    AUTH_PASSWORD_RESET: 'auth.password_reset',
    AUTH_MFA_ENABLE: 'auth.mfa_enable',
    AUTH_MFA_DISABLE: 'auth.mfa_disable',
    AUTH_MFA_REGENERATE_BACKUP_CODES: 'auth.mfa_regenerate_backup_codes',

    // System config
    SETTINGS_UPDATE: 'settings.update',

    // Leave lifecycle (Company_Management_Plan §2.4 — note on negative-CL approval)
    LEAVE_APPROVE: 'leave.approve',
    LEAVE_REJECT: 'leave.reject',
    LEAVE_CANCEL: 'leave.cancel',

    // Project lifecycle (Phase 2 Step 16 — projects + members + clients +
    // sprints + custom statuses). Each verb stores a before/after diff so the
    // future Step-31 admin UI can render a "who changed what" timeline. The
    // member/client variants log the resolved user_id list in `metadata` so
    // a viewer doesn't need to dereference the snapshots to see the delta.
    PROJECT_CREATE: 'project.create',
    PROJECT_UPDATE: 'project.update',
    PROJECT_ARCHIVE: 'project.archive',
    PROJECT_MEMBERS_UPDATE: 'project.members_update',
    PROJECT_CLIENTS_UPDATE: 'project.clients_update',
    PROJECT_CUSTOM_STATUS_CREATE: 'project.custom_status_create',
    PROJECT_CUSTOM_STATUS_UPDATE: 'project.custom_status_update',
    PROJECT_CUSTOM_STATUS_DELETE: 'project.custom_status_delete',
    SPRINT_CREATE: 'sprint.create',
    SPRINT_UPDATE: 'sprint.update',
    SPRINT_DELETE: 'sprint.delete',

    // Story lifecycle (Phase 2 Step 17). `STORY_DELETE` records the list of
    // task IDs whose `story_id` was unset in `metadata.unset_task_ids` so a
    // future Step-31 audit UI can render a "what got detached" summary
    // without re-reading the tasks collection.
    STORY_CREATE: 'story.create',
    STORY_UPDATE: 'story.update',
    STORY_DELETE: 'story.delete',
    STORY_REORDER: 'story.reorder',

    // Task lifecycle (Phase 2 Step 18 — tasks + subtasks + dependencies).
    // Reorder, story-attach, sprint-move, and dependency add/remove are
    // their own verbs (rather than collapsing into TASK_UPDATE) so the
    // Step-31 audit UI can render meaningful per-event summaries without
    // diffing the full task snapshot. The dependency verbs record the
    // counterpart task id in `metadata.depends_on_task_id` so the UI can
    // link both sides of the edge.
    TASK_CREATE: 'task.create',
    TASK_UPDATE: 'task.update',
    TASK_DELETE: 'task.delete',
    TASK_REORDER: 'task.reorder',
    TASK_ASSIGN_STORY: 'task.assign_story',
    TASK_MOVE_SPRINT: 'task.move_sprint',
    TASK_DEPENDENCY_ADD: 'task.dependency_add',
    TASK_DEPENDENCY_REMOVE: 'task.dependency_remove',

    // Task comments (Phase 2 Step 19). `metadata.task_id` and
    // `metadata.mention_count` are recorded so the Step-31 audit UI can
    // surface "user X mentioned 3 people on task Y" without re-reading
    // the comment row (which may be soft-deleted by then).
    COMMENT_CREATE: 'comment.create',
    COMMENT_UPDATE: 'comment.update',
    COMMENT_DELETE: 'comment.delete',

    // Task attachments (Phase 2 Step 21). `metadata.task_id`,
    // `metadata.project_id`, `metadata.size_bytes`, and `metadata.mime_type`
    // are recorded so the Step-31 audit UI can render "user X uploaded
    // 2 MiB image/png to task Y" without dereferencing the (possibly
    // soft-deleted) attachment row. The blob_key is intentionally
    // captured in the `before/after` snapshot so an admin can correlate
    // the audit trail to the storage account if a forensic recovery is
    // ever needed.
    ATTACHMENT_CREATE: 'attachment.create',
    ATTACHMENT_DELETE: 'attachment.delete',

    // Timesheet lifecycle (Phase 2 Step 23). `timesheet.edit_out_of_window`
    // is its own verb (not collapsed into `timesheet.update`) so the
    // Step-31 audit UI can flag manager overrides without diffing the row.
    // Metadata captures `user_id` (subject of the entry, who may differ
    // from the actor on manager edits), `local_date`, and the derived
    // `total_minutes` for at-a-glance reporting.
    TIMESHEET_CREATE: 'timesheet.create',
    TIMESHEET_UPDATE: 'timesheet.update',
    TIMESHEET_EDIT_OUT_OF_WINDOW: 'timesheet.edit_out_of_window',
    TIMESHEET_DELETE: 'timesheet.delete',

    // Billing-rate lifecycle (Phase 2 Step 23). `billing_rate.create`
    // records the auto-closed predecessor (when one existed) in
    // `metadata.previous_rate_id` so the Step-31 audit UI can render a
    // chronological "rate history" for a `(user, project, task)` tuple
    // without re-deriving it from raw rows.
    BILLING_RATE_CREATE: 'billing_rate.create',
    BILLING_RATE_UPDATE: 'billing_rate.update',
    BILLING_RATE_END: 'billing_rate.end',
    BILLING_RATE_DELETE: 'billing_rate.delete',

    // Project share-link lifecycle (Phase 2 Step 24). `share_link.revoke`
    // captures `metadata.reason ∈ {manual, client_deactivated}` so the
    // Step-31 audit UI can distinguish admin-driven revokes from the
    // automatic cascade fired by `user.deactivate` for client users.
    SHARE_LINK_CREATE: 'share_link.create',
    SHARE_LINK_REVOKE: 'share_link.revoke',

    // Slack integration (Phase 2 Step 25). `settings.slack_update` is
    // its own verb (not collapsed into `settings.update`) so the
    // Step-31 audit UI can highlight bot-token rotations + channel
    // remappings without diffing the full settings document.
    // `slack.test_message` records `metadata.channel` + `metadata.delivered`
    // so an admin re-running the test can see whether the workspace
    // actually accepted the post.
    SETTINGS_SLACK_UPDATE: 'settings.slack_update',
    SLACK_TEST_MESSAGE: 'slack.test_message',

    // Scheduled jobs (Step 14). One generic "run" action; per-job detail
    // lives in `metadata.{job_name, run_key, summary}` so the action enum
    // stays small as we add jobs over time.
    SYSTEM_JOB_RUN: 'system.job_run',
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];

export const AUDIT_ACTION_VALUES: readonly AuditAction[] = Object.values(AUDIT_ACTIONS);

// ─── target_entity.kind whitelist ────────────────────────────────────────
//
// Free-form strings work too; the whitelist documents the kinds Phase 1
// emits so the future Step-31 admin UI can switch on a known set.

export const AUDIT_TARGET_KINDS = {
    USER: 'user',
    LEAVE_REQUEST: 'leave_request',
    SYSTEM_SETTINGS: 'system_settings',
    JOB: 'job',
    PROJECT: 'project',
    SPRINT: 'sprint',
    STORY: 'story',
    TASK: 'task',
    COMMENT: 'task_comment',
    ATTACHMENT: 'task_attachment',
    TIMESHEET_ENTRY: 'timesheet_entry',
    BILLING_RATE: 'billing_rate',
    SHARE_LINK: 'project_share_link',
} as const;

export type AuditTargetKind = (typeof AUDIT_TARGET_KINDS)[keyof typeof AUDIT_TARGET_KINDS];

// ─── Actor-role values stored in `actor_role` snapshot ───────────────────
//
// Authenticated calls record one of `ROLES`; unauthenticated paths (forgot /
// reset password, MFA challenge before tokens are issued) record `'system'`
// when the action is performed on behalf of a known user via a verified
// token, and `'unauthenticated'` when there is no token at all.

export const AUDIT_ACTOR_ROLES = {
    ...ROLES,
    SYSTEM: 'system',
    UNAUTHENTICATED: 'unauthenticated',
} as const;

export type AuditActorRole = RoleType | 'system' | 'unauthenticated';

// ─── Field caps ──────────────────────────────────────────────────────────
//
// Snapshots (`before` / `after`) are strictly bounded so a runaway diff
// payload (e.g. all-of-system_settings) doesn't bloat a single audit row.
// We don't truncate silently — a snapshot that exceeds the cap is dropped
// from the row and the action is recorded with `before/after = null` plus
// a `metadata.snapshot_dropped = true` flag.

export const AUDIT_ACTION_MAX = 80;
export const AUDIT_TARGET_KIND_MAX = 80;
export const AUDIT_SNAPSHOT_BYTES_MAX = 16 * 1024; // 16 KiB per snapshot
export const AUDIT_METADATA_BYTES_MAX = 4 * 1024; // 4 KiB for ip + ua + extras

// Pagination defaults are reserved for the Phase 3 read endpoint; defining
// them here keeps the constant collocated with the rest of the audit shape.
export const AUDIT_LIST_DEFAULT_LIMIT = 50;
export const AUDIT_LIST_MAX_LIMIT = 200;
