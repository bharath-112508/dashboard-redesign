/**
 * Notification constants (Data_Model.md §7.1, API_Contract.md §11,
 * Company_Management_Plan.md §6.2).
 *
 * Channels:
 *   - In-app: row written to `notifications` collection, read by the bell icon.
 *   - Email:  best-effort send via `mailer.ts`. Pluggable transport selected
 *             by `EMAIL_TRANSPORT` env (`stub` / `acs` / `mailjet`); the
 *             dev/test default is `stub` (logs only, no outbound), and
 *             production deployments select `acs` or `mailjet` via env.
 *   - Slack:  shipped in Step 25 — Slack-bot DM fan-out to channels +
 *             handles, gated by `system_settings.slack.enabled`.
 *
 * Dispatch failure policy (API §15.500):
 *   - Notification fan-out is "soft": the dispatcher wraps every send in a
 *     try/catch and logs `NOTIFICATION_DISPATCH_FAILED` at warn level. The
 *     primary action (apply leave / approve correction / etc.) ALWAYS still
 *     returns 2xx — never block a business write on a stuck mailbox.
 *
 * Retention:
 *   - Data_Model open-question §5: no TTL on `notifications`. Phase-3 may add
 *     a "delete read older than N days" job; for now rows live forever and the
 *     dismiss endpoint does a hard delete on the user's request.
 */

// ─── Type enum (Data_Model.md §7.1 — leave + attendance + tasks + system) ─

export const NOTIFICATION_TYPES = {
    LEAVE_REQUESTED: 'leave_requested',
    LEAVE_APPROVED: 'leave_approved',
    LEAVE_REJECTED: 'leave_rejected',
    LEAVE_CANCELLED: 'leave_cancelled',
    TASK_ASSIGNED: 'task_assigned',
    TASK_DUE_SOON: 'task_due_soon',
    TASK_OVERDUE: 'task_overdue',
    TASK_COMMENT: 'task_comment',
    ATTENDANCE_CORRECTION_REQUESTED: 'attendance_correction_requested',
    ATTENDANCE_CORRECTION_DECIDED: 'attendance_correction_decided',
    TIMESHEET_REMINDER: 'timesheet_reminder',
    // Person-affecting admin actions. Each is something done TO a user by
    // someone else, which they'd otherwise only discover by stumbling on it.
    PROJECT_MEMBER_ADDED: 'project_member_added',
    LEAVE_BALANCE_ADJUSTED: 'leave_balance_adjusted',
    COMP_OFF_ADJUSTED: 'comp_off_adjusted',
    ROLE_CHANGED: 'role_changed',
    SYSTEM: 'system',
} as const;

export type NotificationType = (typeof NOTIFICATION_TYPES)[keyof typeof NOTIFICATION_TYPES];

export const NOTIFICATION_TYPE_VALUES: readonly NotificationType[] = Object.values(NOTIFICATION_TYPES);

// ─── `related_entity.kind` whitelist ─────────────────────────────────────
//
// Free-form strings work too; this list documents the kinds the platform
// emits today so the FE can switch on a known set when rendering deep-links.

export const RELATED_ENTITY_KINDS = {
    LEAVE_REQUEST: 'leave_request',
    ATTENDANCE_CORRECTION_REQUEST: 'attendance_correction_request',
    USER: 'user',
    TASK: 'task',
    PROJECT: 'project',
    LEAVE_BALANCE: 'leave_balance',
} as const;

// Notifications are fully owner-scoped: every authenticated user can
// read / mark / dismiss their own; nobody (not even Admin) sees
// another user's bell. The route gate is just `authenticate`.

// ─── List defaults (API_Contract §1.6, max-100 contract) ─────────────────

export const NOTIFICATION_LIST_DEFAULT_LIMIT = 20;
export const NOTIFICATION_LIST_MAX_LIMIT = 100;

// ─── Field length caps ───────────────────────────────────────────────────

export const NOTIFICATION_TITLE_MAX = 200;
export const NOTIFICATION_BODY_MAX = 2000;
export const NOTIFICATION_LINK_URL_MAX = 1000;
