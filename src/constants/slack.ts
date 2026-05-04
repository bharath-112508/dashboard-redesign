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
    [NOTIFICATION_TYPES.TIMESHEET_REMINDER]: SLACK_EVENT_CATEGORIES.TIMESHEET,
    [NOTIFICATION_TYPES.SYSTEM]: SLACK_EVENT_CATEGORIES.GENERAL,
};

// ─── Slack API ──────────────────────────────────────────────────────────

export const SLACK_API_BASE = 'https://slack.com/api';
export const SLACK_API_POST_MESSAGE = `${SLACK_API_BASE}/chat.postMessage`;

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
