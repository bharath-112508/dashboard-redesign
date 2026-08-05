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

import { type RoleType } from './roles.js';

// ─── Actions whitelist (Data_Model.md §7.2 examples + Phase 1 hookups) ──

export const AUDIT_ACTIONS = {
    // User lifecycle (admin invite + role mgmt)
    USER_CREATE: 'user.create',
    USER_ROLE_CHANGE: 'user.role_change',
    USER_DEACTIVATE: 'user.deactivate',
    /**
     * Login email reassigned — used when the account is handed to a different
     * person (see `scripts/change-user-email.ts`). Distinct from a profile
     * edit because it changes WHO the account is, and it clears the cached
     * `slack_user_id` so the previous person's Slack account stops resolving
     * here.
     */
    USER_EMAIL_CHANGE: 'user.email_change',
    USER_REACTIVATE: 'user.reactivate',
    // Profile photo lifecycle (Phase 2 Step 22). `metadata.size_bytes` /
    // `metadata.mime_type` recorded on set; `metadata.previous_blob_key`
    // recorded on replace + clear so a forensic recovery of the prior
    // image is possible until the blob is GC'd.
    USER_PROFILE_PHOTO_SET: 'user.profile_photo_set',
    USER_PROFILE_PHOTO_CLEAR: 'user.profile_photo_clear',
    /** GDPR DSAR — admin generated a JSON dump of a user's data. (BACKEND_AUDIT.md P1-8) */
    USER_DATA_EXPORT: 'user.data_export',
    /** GDPR right-to-erasure — admin anonymised a user's PII. (BACKEND_AUDIT.md P1-8) */
    USER_DATA_ERASE: 'user.data_erase',

    // Auth / credentials
    AUTH_PASSWORD_CHANGE: 'auth.password_change',
    AUTH_PASSWORD_RESET: 'auth.password_reset',
    /**
     * Admin requested a password reset link for a target user
     * (`POST /users/:id/reset-password`). Distinct from `AUTH_PASSWORD_RESET`
     * which fires when the USER consumes the link — this verb captures the
     * admin-side initiation. Useful for "who triggered all these reset
     * emails" forensics.
     */
    AUTH_ADMIN_PASSWORD_RESET: 'auth.admin_password_reset',
    AUTH_MFA_ENABLE: 'auth.mfa_enable',
    AUTH_MFA_DISABLE: 'auth.mfa_disable',
    AUTH_MFA_REGENERATE_BACKUP_CODES: 'auth.mfa_regenerate_backup_codes',
    // Session revocation (Phase 3 Step 27). The actor is the user
    // themselves (this is a self-service "log out other devices" flow);
    // the audit row's `target.id` points at the revoked refresh-token
    // row so the Step-31 audit UI can render "user X revoked session Y
    // from device 'Chrome on macOS'".
    AUTH_SESSION_REVOKE: 'auth.session_revoke',

    // System config
    SETTINGS_UPDATE: 'settings.update',

    // Leave lifecycle (Company_Management_Plan §2.4 — note on negative-CL approval)
    // H4 — `LEAVE_APPLY` audits the initial submission. Pre-H4 only
    // approve/reject/cancel emitted audit rows; the row's CREATION was
    // invisible to the forensic trail, so a dispute over "did this
    // person actually apply for this leave?" couldn't be answered.
    LEAVE_APPLY: 'leave.apply',
    LEAVE_APPROVE: 'leave.approve',
    LEAVE_REJECT: 'leave.reject',
    LEAVE_CANCEL: 'leave.cancel',

    // Leave-balance manual adjust (H3). Admin-only PATCH /leave-balances/:id.
    // The validator already requires a free-text `reason` so an operator
    // adjusting balances can explain why; H3 plumbs that reason into the
    // audit row's `metadata.reason` alongside the signed `metadata.delta`
    // and a before/after snapshot of the row's counters. Pre-H3 the
    // adjust path took the `reason` and silently discarded it — the
    // sensitive action ran with no audit trail.
    LEAVE_BALANCE_ADJUST: 'leave_balance.adjust',

    // Comp-off ledger admin adjust (I1). POST /comp-off/adjust is admin /
    // manager only — they grant or consume comp-off days against a user's
    // ledger (`comp_off_balance` is rederived). Pre-I1 every grant/consume
    // ran with no audit trail; H3-style fix records the signed delta,
    // operator-supplied `remarks`, and the resulting balance.
    COMP_OFF_ADJUST: 'comp_off.adjust',
    // Automatic comp-off grant from the nightly accrual job (overtime bank
    // or weekend/holiday work). System actor; metadata carries the source
    // day + rule + days granted.
    COMP_OFF_ACCRUE: 'comp_off.accrue',

    // Holiday calendar admin CRUD (I1). Org-wide working-day calendar —
    // every user's leave-day count and attendance roll-ups depend on the
    // dates here, so a stray edit is observable platform-wide. Bulk
    // create records `metadata.{inserted_count, skipped_count}` rather
    // than emitting one row per inserted holiday so a 50-row import
    // doesn't flood the audit log; the `after` payload still carries
    // the inserted dates for forensic reconstruction.
    HOLIDAY_CREATE: 'holiday.create',
    HOLIDAY_BULK_CREATE: 'holiday.bulk_create',
    HOLIDAY_UPDATE: 'holiday.update',
    HOLIDAY_DELETE: 'holiday.delete',

    // Attendance admin direct-edit + employee correction-request lifecycle
    // (C1 / 2026-06-05 review). check_in / check_out are deliberately
    // NOT audited — they're high-volume routine events with no
    // forensic value; the admin-visible mutations below are the ones
    // worth tracking. `attendance.patch` covers PATCH /attendance/:id
    // (admin direct-edit of segments). The `correction.*` triplet
    // covers the employee-submitted correction-request flow:
    // submit (employee), approve / reject (admin). Each records a
    // before/after segments snapshot so the future Step-31 audit UI
    // can render a "who changed what" timeline. spec drift fixed:
    // API_Contract.md §6 said attendance.correct; renamed to
    // attendance.patch to keep PATCH (admin direct-edit) distinct
    // from the correction-request flow.
    ATTENDANCE_PATCH: 'attendance.patch',
    CORRECTION_SUBMIT: 'correction.submit',
    CORRECTION_APPROVE: 'correction.approve',
    CORRECTION_REJECT: 'correction.reject',
    /** M49 — owner-only withdraw of a pending correction request. Lets
     *  the employee retract a mistaken proposal so they can submit a
     *  replacement (the `CORRECTION_REQUEST_ALREADY_PENDING` guard
     *  would block them otherwise). */
    CORRECTION_CANCEL: 'correction.cancel',

    // Leave-type catalog admin CRUD (I1). The default-allocation, monthly
    // cap, and pro-rata strategy here drive every user's balance seeding,
    // so renaming or recapping a type effectively rewrites everyone's
    // entitlement going forward. Deactivate is the soft-delete path —
    // existing balance rows survive, but new years won't seed against it.
    LEAVE_TYPE_CREATE: 'leave_type.create',
    LEAVE_TYPE_UPDATE: 'leave_type.update',
    LEAVE_TYPE_DEACTIVATE: 'leave_type.deactivate',

    // Office-location admin CRUD + QR-token rotation (I1). The geofence
    // anchor + QR token drive attendance check-in eligibility; rotating
    // a QR token is security-relevant (token compromise → unauthorised
    // check-ins until the rotation lands). The rotation row deliberately
    // omits the new token from `after` — only the rotation event itself
    // is audited, never the secret value.
    OFFICE_LOCATION_CREATE: 'office_location.create',
    OFFICE_LOCATION_UPDATE: 'office_location.update',
    OFFICE_LOCATION_DEACTIVATE: 'office_location.deactivate',
    OFFICE_LOCATION_QR_ROTATE: 'office_location.qr_rotate',

    // Project lifecycle (Phase 2 Step 16 — projects + members + clients +
    // sprints + custom statuses). Each verb stores a before/after diff so the
    // future Step-31 admin UI can render a "who changed what" timeline. The
    // member/client variants log the resolved user_id list in `metadata` so
    // a viewer doesn't need to dereference the snapshots to see the delta.
    PROJECT_CREATE: 'project.create',
    PROJECT_UPDATE: 'project.update',
    PROJECT_ARCHIVE: 'project.archive',
    PROJECT_MEMBERS_UPDATE: 'project.members_update',
    PROJECT_REPRESENTATIVES_UPDATE: 'project.representatives_update',
    COMPANY_CREATE: 'company.create',
    COMPANY_UPDATE: 'company.update',
    COMPANY_ARCHIVE: 'company.archive',
    REPRESENTATIVE_CREATE: 'representative.create',
    PROJECT_CUSTOM_STATUS_CREATE: 'project.custom_status_create',
    PROJECT_CUSTOM_STATUS_UPDATE: 'project.custom_status_update',
    PROJECT_CUSTOM_STATUS_DELETE: 'project.custom_status_delete',
    /** Project's `default_status_orders` (built-in column ordering) was
     *  re-arranged by an admin / manager. */
    PROJECT_DEFAULT_STATUS_ORDERS_UPDATE: 'project.default_status_orders_update',
    SPRINT_CREATE: 'sprint.create',
    SPRINT_UPDATE: 'sprint.update',
    SPRINT_DELETE: 'sprint.delete',
    /** T11 — sprint archived (is_archived flipped to true). */
    SPRINT_ARCHIVE: 'sprint.archive',
    /** T11 — archived sprint restored (is_archived flipped to false). */
    SPRINT_UNARCHIVE: 'sprint.unarchive',
    /** Phase 2 Backlog — sprint started (planned → active). */
    SPRINT_START: 'sprint.start',
    /** Phase 2 Backlog — sprint completed (active → completed); unfinished
     *  tasks moved to backlog or a target sprint (`metadata.moved_task_count`). */
    SPRINT_COMPLETE: 'sprint.complete',

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
    /** Phase 2 Backlog — task manually re-ranked within the project order. */
    TASK_RANK: 'task.rank',
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

    // Cost-rate lifecycle (Billing Phase 2 — Cost Rates & Margin, Task 3).
    // Cost-side twin of the `billing_rate.*` verbs above; `cost_rate.create`
    // likewise records the auto-closed predecessor (when one existed) in
    // `metadata.previous_rate_id`.
    COST_RATE_CREATE: 'cost_rate.create',
    COST_RATE_UPDATE: 'cost_rate.update',
    COST_RATE_END: 'cost_rate.end',
    COST_RATE_DELETE: 'cost_rate.delete',

    // Client engagements (Phase 1 — Client Engagements & Invoicing, Task 4).
    // `engagement.end` is its own verb (not folded into `engagement.update`)
    // so the Step-31 audit UI can flag lifecycle closes distinctly from
    // ordinary field edits, mirroring `billing_rate.end`.
    ENGAGEMENT_CREATE: 'engagement.create',
    ENGAGEMENT_UPDATE: 'engagement.update',
    ENGAGEMENT_END: 'engagement.end',

    // Invoices (Phase 1 — Client Engagements & Invoicing, Task 7). `invoice.generate`
    // is the algorithmic create (engagement + period → persisted numbered draft);
    // `invoice.status` is its own verb (not folded into `invoice.update`) so the
    // Step-31 audit UI can render lifecycle moves (draft→sent→paid→void) distinctly
    // from ordinary draft field edits — metadata carries `{from, to}`.
    INVOICE_GENERATE: 'invoice.generate',
    INVOICE_UPDATE: 'invoice.update',
    INVOICE_STATUS: 'invoice.status',
    INVOICE_DELETE: 'invoice.delete',

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

    // Report exports (Phase 3 Step 30). `report_export.create` records the
    // report name, format, and filter snapshot so the Step-31 audit UI can
    // render "user X exported the billing report for project Y" without
    // re-reading the (eventually-purged) export row. `report_export.complete`
    // and `report_export.fail` are emitted by the worker as system audits
    // — operators grep `report_export.fail` to find generator / storage
    // failures.
    REPORT_EXPORT_CREATE: 'report_export.create',
    REPORT_EXPORT_COMPLETE: 'report_export.complete',
    REPORT_EXPORT_FAIL: 'report_export.fail',

    // Task templates + recurring tasks (Phase 4 Step 40). Template
    // CRUD + each manual instantiation are caller-audited.
    // System-audited variant (`task_template.recurrence_run`) fires
    // from the daily cron when a recurring template auto-creates a
    // task — `actor_role: 'system'` so the future Step-31 viewer can
    // distinguish operator-driven from cron-driven instantiations.
    TASK_TEMPLATE_CREATE: 'task_template.create',
    TASK_TEMPLATE_UPDATE: 'task_template.update',
    TASK_TEMPLATE_DELETE: 'task_template.delete',
    TASK_TEMPLATE_INSTANTIATE: 'task_template.instantiate',
    TASK_TEMPLATE_RECURRENCE_RUN: 'task_template.recurrence_run',

    // Report subscriptions (Phase 4 Step 43). CRUD verbs are caller-
    // audited; `report_subscription.send` is system-audited from the
    // weekly cron. Operators grep `report_subscription.send` rows
    // with `metadata.delivery: 'failed'` to find delivery problems.
    REPORT_SUBSCRIPTION_CREATE: 'report_subscription.create',
    REPORT_SUBSCRIPTION_UPDATE: 'report_subscription.update',
    REPORT_SUBSCRIPTION_DELETE: 'report_subscription.delete',
    REPORT_SUBSCRIPTION_SEND: 'report_subscription.send',

    // Report presets — saved filter shapes per user (H7). Pre-H7 the
    // CRUD ran without an audit trail even though
    // `report-subscription.*` (the sibling surface) was fully audited.
    REPORT_PRESET_CREATE: 'report_preset.create',
    REPORT_PRESET_UPDATE: 'report_preset.update',
    REPORT_PRESET_DELETE: 'report_preset.delete',

    // Push subscriptions — browser notification-delivery targets (H6).
    // Pre-H6 subscribe / unsubscribe ran without forensic trail; the
    // ledger row carried only `created_by` and was hard-deleted on
    // unsubscribe, leaving no record of who registered or revoked it.
    PUSH_SUBSCRIPTION_CREATE: 'push_subscription.create',
    PUSH_SUBSCRIPTION_DELETE: 'push_subscription.delete',

    // Custom roles (Phase 4 Step 47). System role mutations are
    // explicitly forbidden by the role service; only `is_system: false`
    // rows can be created / patched / deleted via API.
    ROLE_CREATE: 'role.create',
    ROLE_UPDATE: 'role.update',
    ROLE_DELETE: 'role.delete',
    USER_ROLES_ASSIGN: 'user.roles_assign',
    // Pattern B — per-user extra permission grants (Step 47 follow-up).
    USER_EXTRA_PERMISSIONS_UPDATE: 'user.extra_permissions_update',

    // Payroll & certificates (foundation). Profile upsert is a single verb
    // (create-or-update collapse, same rationale as elsewhere); salary
    // structures split create/update because they're append-only history
    // rows, not a single mutable doc. Generation verbs are their own
    // actions (not folded into a generic "download") since they're the
    // sensitive, auditable event — the document leaving the system.
    PAYROLL_PROFILE_UPSERT: 'payroll_profile.upsert',
    // No SALARY_STRUCTURE_UPDATE: structures are append-only by version
    // (`effective_from`), so a correction is a new version, not an edit —
    // `salary-structure.routes.ts` exposes GET / POST / GET :id and nothing
    // more. The constant existed and was written by nothing, which made the
    // catalog claim salary-structure edits were tracked when they cannot
    // happen. Do not re-add it without an update path to audit.
    SALARY_STRUCTURE_CREATE: 'salary_structure.create',
    PAYSLIP_GENERATE: 'payslip.generate',
    LETTER_GENERATE: 'letter.generate',
    PAYSLIP_DELETE: 'payslip.delete',
    LETTER_DELETE: 'letter.delete',
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];

// ─── target_entity.kind whitelist ────────────────────────────────────────
//
// Free-form strings work too; the whitelist documents the kinds Phase 1
// emits so the future Step-31 admin UI can switch on a known set.

export const AUDIT_TARGET_KINDS = {
    USER: 'user',
    LEAVE_REQUEST: 'leave_request',
    LEAVE_BALANCE: 'leave_balance',
    COMP_OFF_LEDGER: 'comp_off_ledger',
    HOLIDAY: 'holiday',
    LEAVE_TYPE: 'leave_type',
    OFFICE_LOCATION: 'office_location',
    COMPANY: 'company',
    ATTENDANCE_RECORD: 'attendance_record',
    CORRECTION_REQUEST: 'correction_request',
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
    COST_RATE: 'cost_rate',
    ENGAGEMENT: 'engagement',
    INVOICE: 'invoice',
    SHARE_LINK: 'project_share_link',
    SESSION: 'session',
    REPORT_EXPORT: 'report_export',
    TASK_TEMPLATE: 'task_template',
    REPORT_SUBSCRIPTION: 'report_subscription',
    REPORT_PRESET: 'report_preset',
    PUSH_SUBSCRIPTION: 'push_subscription',
    ROLE: 'role',
    PAYROLL_PROFILE: 'payroll_profile',
    SALARY_STRUCTURE: 'salary_structure',
    PAYSLIP: 'payslip',
    LETTER: 'letter',
} as const;

export type AuditTargetKind = (typeof AUDIT_TARGET_KINDS)[keyof typeof AUDIT_TARGET_KINDS];

// ─── Actor-role values stored in `actor_role` snapshot ───────────────────
//
// Authenticated calls record one of `ROLES`; unauthenticated paths (forgot /
// reset password, MFA challenge before tokens are issued) record `'system'`
// when the action is performed on behalf of a known user via a verified
// token, and `'unauthenticated'` when there is no token at all.

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

// ─── Read endpoint defaults (Phase 3 Step 31) ────────────────────────────
//
// `GET /audit-logs` paginates with the same shape API_Contract §1.6 uses
// elsewhere (`page` / `limit`, max 100). The list payload deliberately
// drops `before` / `after` snapshots — they can each be 16 KiB and a
// 100-row page would otherwise hit ~3 MB. The detail endpoint
// `GET /audit-logs/:id` returns the full row including snapshots.

export const AUDIT_LOG_LIST_DEFAULT_LIMIT = 20;
export const AUDIT_LOG_LIST_MAX_LIMIT = 100;

// Step 47: `GET /audit-logs` is gated on `audit_log.read` (admin-only).
