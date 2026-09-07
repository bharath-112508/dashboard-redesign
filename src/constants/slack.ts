/**
 * Slack integration constants (Step 25; Plan §6.2 / API_Contract.md §11).
 *
 * v1 surface:
 *   - Bot-token-only (no incoming events). The admin pastes a bot user
 *     OAuth token (`xoxb-...`) into `system_settings.slack.bot_token`,
 *     and the dispatcher posts via `chat.postMessage` to either
 *     mapped channels (broadcast) or `slack_user_id` DMs (per-recipient).
 *   - Best-effort. Every Slack send is wrapped in a try/catch and logs
 *     `SLACK_DISPATCH_FAILED` at warn level — same dispatch policy as
 *     email so a stuck Slack workspace cannot block a business write.
 *   - Disabled by default (`slack.enabled = false`). Even with a bot
 *     token set, Slack sends only fire when the flag is on.
 *
 * Non-goals for v1:
 *   - Incoming events / slash commands (no signing-secret path).
 *   - Per-notification-type user preferences (only the global
 *     `slack_notifications_enabled` toggle on the user). Adding a
 *     `slack_notification_overrides: Record<type, bool>` map later
 *     doesn't break the storage contract.
 *   - Block-kit rich layouts. The v1 message body is plain text + a
 *     deep-link; rich blocks can be layered on later.
 */

import { NOTIFICATION_TYPES, type NotificationType } from './notification.js';

// ─── Event categories (= keys of `system_settings.slack.channels`) ──────

export const SLACK_EVENT_CATEGORIES = {
    LEAVES: 'leaves',
    ATTENDANCE: 'attendance',
    PROJECTS: 'projects',
    TIMESHEET: 'timesheet',
    GENERAL: 'general',
} as const;

export type SlackEventCategory = (typeof SLACK_EVENT_CATEGORIES)[keyof typeof SLACK_EVENT_CATEGORIES];

/**
 * Notification type → channel category mapping. The dispatcher uses
 * this to pick which channel a broadcast lands in. Anything not listed
 * falls back to `general`. Centralised here so the dispatcher (which
 * doesn't know about Slack settings shape) and any future automation
 * (Step 31 audit, manual-trigger admin tools) share one map.
 */
export const NOTIFICATION_TYPE_TO_SLACK_CATEGORY: Record<NotificationType, SlackEventCategory> = {
    [NOTIFICATION_TYPES.LEAVE_REQUESTED]: SLACK_EVENT_CATEGORIES.LEAVES,
    [NOTIFICATION_TYPES.LEAVE_APPROVED]: SLACK_EVENT_CATEGORIES.LEAVES,
    [NOTIFICATION_TYPES.LEAVE_REJECTED]: SLACK_EVENT_CATEGORIES.LEAVES,
    [NOTIFICATION_TYPES.LEAVE_CANCELLED]: SLACK_EVENT_CATEGORIES.LEAVES,
    [NOTIFICATION_TYPES.ATTENDANCE_CORRECTION_REQUESTED]: SLACK_EVENT_CATEGORIES.ATTENDANCE,
    [NOTIFICATION_TYPES.ATTENDANCE_CORRECTION_DECIDED]: SLACK_EVENT_CATEGORIES.ATTENDANCE,
    [NOTIFICATION_TYPES.TASK_ASSIGNED]: SLACK_EVENT_CATEGORIES.PROJECTS,
    [NOTIFICATION_TYPES.TASK_DUE_SOON]: SLACK_EVENT_CATEGORIES.PROJECTS,
    [NOTIFICATION_TYPES.TASK_OVERDUE]: SLACK_EVENT_CATEGORIES.PROJECTS,
    [NOTIFICATION_TYPES.TASK_COMMENT]: SLACK_EVENT_CATEGORIES.PROJECTS,
    [NOTIFICATION_TYPES.TASK_REPORTED_BY_CLIENT]: SLACK_EVENT_CATEGORIES.PROJECTS,
    [NOTIFICATION_TYPES.TIMESHEET_REMINDER]: SLACK_EVENT_CATEGORIES.TIMESHEET,
    // In-app only today (see the dispatchers) — mapped so the Record stays
    // exhaustive and a future Slack rollout has a sensible channel.
    [NOTIFICATION_TYPES.PROJECT_MEMBER_ADDED]: SLACK_EVENT_CATEGORIES.PROJECTS,
    [NOTIFICATION_TYPES.LEAVE_BALANCE_ADJUSTED]: SLACK_EVENT_CATEGORIES.LEAVES,
    [NOTIFICATION_TYPES.COMP_OFF_ADJUSTED]: SLACK_EVENT_CATEGORIES.LEAVES,
    [NOTIFICATION_TYPES.ROLE_CHANGED]: SLACK_EVENT_CATEGORIES.GENERAL,
    [NOTIFICATION_TYPES.SYSTEM]: SLACK_EVENT_CATEGORIES.GENERAL,
};

// ─── Slack API ──────────────────────────────────────────────────────────

export const SLACK_API_BASE = 'https://slack.com/api';
export const SLACK_API_POST_MESSAGE = `${SLACK_API_BASE}/chat.postMessage`;
// Phase 1 — used to edit the original leave message in-place when a
// decision lands. Same auth model as chat.postMessage.
export const SLACK_API_UPDATE_MESSAGE = `${SLACK_API_BASE}/chat.update`;
// App Home — render/refresh a user's Home tab. Same bot-token auth.
export const SLACK_API_PUBLISH_VIEW = `${SLACK_API_BASE}/views.publish`;
// Eager Slack-user mapping for the nudge crons — resolve a Slack user id
// from a Viljetech account email without an interactive payload to hand us
// the id. https://api.slack.com/methods/users.lookupByEmail
export const SLACK_API_LOOKUP_BY_EMAIL = `${SLACK_API_BASE}/users.lookupByEmail`;
// Modal — open an interactive form (Apply-for-leave). Same bot-token auth.
// https://api.slack.com/methods/views.open
export const SLACK_API_VIEWS_OPEN = `${SLACK_API_BASE}/views.open`;

/**
 * Network timeout for a single Slack API call. Slack's docs target ~3s
 * p99 for `chat.postMessage`; we cap higher so a brief degradation
 * doesn't drop messages, but tight enough that a stuck call doesn't
 * starve the dispatcher (each helper awaits the slack send so a cron
 * tick that fans out to 100 users would otherwise stall).
 */
export const SLACK_REQUEST_TIMEOUT_MS = 5_000;

// ─── Field caps ─────────────────────────────────────────────────────────
//
// `chat.postMessage` accepts up to 40 KiB of `text` but Slack itself
// truncates display at ~3 000 chars. We cap the payload here so the
// dispatcher doesn't blast a wall of debug text into a workspace.

export const SLACK_TEXT_MAX = 3_000;
export const SLACK_BOT_TOKEN_MAX = 200;

// ─── Attendance interactive action ids ───────────────────────────────────
//
// Block Kit button `action_id`s for the App Home + DM nudge buttons. The
// interactive controller branches on these. Kept as constants so the block
// builders and the handler can't drift on the string.
export const SLACK_ACTION_ATTENDANCE_CHECK_IN = 'attendance_check_in';
export const SLACK_ACTION_ATTENDANCE_CHECK_OUT = 'attendance_check_out';

// ─── Break interactive action ids ────────────────────────────────────────
//
// Block Kit button `action_id`s for the App Home break sub-UI. The
// interactive controller branches on these to call startBreak / endBreak.
export const SLACK_ACTION_BREAK_START_LUNCH = 'break_start_lunch';
export const SLACK_ACTION_BREAK_START_TEA = 'break_start_tea';
export const SLACK_ACTION_BREAK_START_OTHER = 'break_start_other';
export const SLACK_ACTION_BREAK_END = 'break_end';

// ─── Apply-for-leave modal ids ────────────────────────────────────────────
//
// `apply_leave_open` is the action_id of the App Home button AND the value the
// open-modal branch keys off. `apply_leave_submit` is the modal's callback_id
// the view_submission branch routes on. The block ids are the `state.values`
// keys read back on submit — they MUST match the ids used in the builder.
export const SLACK_ACTION_APPLY_LEAVE_OPEN = 'apply_leave_open';
export const SLACK_CALLBACK_APPLY_LEAVE = 'apply_leave_submit';
export const SLACK_BLOCK_LEAVE_TYPE = 'leave_type';
export const SLACK_BLOCK_START_DATE = 'start_date';
export const SLACK_BLOCK_END_DATE = 'end_date';
export const SLACK_BLOCK_HALF_DAY = 'half_day';
export const SLACK_BLOCK_REASON = 'reason';

// ─── Log-time modal ids ───────────────────────────────────────────────────
//
// Same convention as the apply-leave ids above: `log_time_open` is the App
// Home button's action_id AND the open-modal branch's key; `log_time_submit`
// is the modal callback_id the view_submission branch routes on. The block
// ids are the `state.values` keys read back on submit — they MUST match the
// ids the builder emits, so both sides import these constants.
export const SLACK_ACTION_LOG_TIME_OPEN = 'log_time_open';
export const SLACK_CALLBACK_LOG_TIME = 'log_time_submit';
export const SLACK_BLOCK_TS_DATE = 'ts_date';
export const SLACK_BLOCK_TS_PROJECT = 'ts_project';
export const SLACK_BLOCK_TS_BILLABLE = 'ts_billable';
export const SLACK_BLOCK_TS_NON_BILLABLE = 'ts_non_billable';
export const SLACK_BLOCK_TS_DESCRIPTION = 'ts_description';

/** Slack rejects a `static_select` with more than 100 options. */
export const SLACK_SELECT_OPTION_CAP = 100;
