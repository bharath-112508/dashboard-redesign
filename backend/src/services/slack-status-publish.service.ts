import type { Types } from 'mongoose';

import type { BreakType } from '../constants/attendance.js';
import { SLACK_REQUEST_TIMEOUT_MS } from '../constants/slack.js';
import { SLACK_STATUS_ADMIN_TOKEN } from '../config/server.config.js';
import { User } from '../models/user.model.js';
import logger from '../utils/logger.js';
import { slackContextFrom } from '../utils/slack.js';
import { getOrInitSettings } from './settings.service.js';
import { resolveSlackIdByEmail } from './slack-user-mapping.service.js';

/**
 * App → Slack: mirror a break onto the user's Slack status.
 *
 * Needs `SLACK_STATUS_ADMIN_TOKEN` — a USER token (`users.profile:read` +
 * `users.profile:write`) from a workspace admin on a paid plan, because a bot
 * token can't set anyone's status and only an admin may pass `user=` to
 * `users.profile.set`. Use the Primary Owner's: Slack refuses an admin's
 * profile to anyone else (`cannot_update_admin_user`). Unset → a no-op.
 *
 * Fire-and-forget, never throws — a Slack failure must not fail a break.
 */

/**
 * Map a Slack profile status to a break type: 🍔 / "lunch" → lunch,
 * ☕ / "tea" → tea, any other status mentioning "break" / "brb" / "be right
 * back" → other. Anything else (incl. a cleared status) → null.
 */
export const breakTypeFromSlackStatus = (emoji: string | undefined, text: string | undefined): BreakType | null => {
    const t = (text ?? '').toLowerCase();
    if (emoji === ':hamburger:' || /\blunch\b/.test(t)) return 'lunch';
    if (emoji === ':coffee:' || /\btea\b/.test(t)) return 'tea';
    if (/\bbreak\b|\bbrb\b|be right back/.test(t)) return 'other';
    return null;
};

/** What the app sets. Each maps back to the same type via breakTypeFromSlackStatus. */
export const SLACK_STATUS_FOR_BREAK: Record<BreakType, { status_emoji: string; status_text: string }> = {
    lunch: { status_emoji: ':hamburger:', status_text: 'Lunch break' },
    tea: { status_emoji: ':coffee:', status_text: 'Tea break' },
    other: { status_emoji: ':double_vertical_bar:', status_text: 'On a break' },
};

interface SlackStatus {
    status_text: string;
    status_emoji: string;
    status_expiration: number;
}

const slackApi = async (method: string, body: Record<string, unknown>): Promise<Record<string, unknown> | null> => {
    const res = await fetch(`https://slack.com/api/${method}`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${SLACK_STATUS_ADMIN_TOKEN}`,
            'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(SLACK_REQUEST_TIMEOUT_MS),
    });
    const json = (await res.json()) as Record<string, unknown>;
    if (!json.ok) {
        logger.warn({ method, error: json.error, code: 'SLACK_STATUS_SYNC_FAILED' }, 'Slack status update failed');
        return null;
    }
    return json;
};

const getStatus = async (slackId: string): Promise<SlackStatus | null> => {
    const json = await slackApi('users.profile.get', { user: slackId });
    const p = json?.profile as Partial<SlackStatus> | undefined;
    if (!p) return null;
    return {
        status_text: p.status_text ?? '',
        status_emoji: p.status_emoji ?? '',
        status_expiration: p.status_expiration ?? 0,
    };
};

const setStatus = (slackId: string, status: SlackStatus) =>
    slackApi('users.profile.set', { user: slackId, profile: status });

/** Slack id for a platform user — cached `slack_user_id`, else looked up by email (and cached). */
const slackIdFor = async (userId: Types.ObjectId): Promise<string | null> => {
    const user = await User.findById(userId).select('slack_user_id email').lean();
    if (!user) return null;
    if (user.slack_user_id) return user.slack_user_id;
    const ctx = slackContextFrom((await getOrInitSettings()).slack);
    if (!ctx?.botToken) return null;
    const found = await resolveSlackIdByEmail(user.email, ctx.botToken);
    if (!found) return null;
    await User.updateOne({ _id: userId, slack_user_id: null }, { $set: { slack_user_id: found.slackId } });
    return found.slackId;
};

const guarded = async (what: string, fn: () => Promise<void>): Promise<void> => {
    if (!SLACK_STATUS_ADMIN_TOKEN) return;
    try {
        if (!slackContextFrom((await getOrInitSettings()).slack)) return; // Slack switched off
        await fn();
    } catch (err) {
        logger.warn({ err, what, code: 'SLACK_STATUS_SYNC_FAILED' }, 'Slack status sync failed');
    }
};

/** A break started in the app / from a Slack button: save the current status, show the break. */
export const showBreakOnSlack = (userId: Types.ObjectId, breakType: BreakType): Promise<void> =>
    guarded('show', async () => {
        const slackId = await slackIdFor(userId);
        if (!slackId) return;
        const current = await getStatus(slackId);
        if (!current) return;
        // Don't save a break status as the one to restore (e.g. a second
        // break while a stale "Lunch" is still up) — restoring would re-show it.
        const restore = breakTypeFromSlackStatus(current.status_emoji, current.status_text) ? null : current;
        await User.updateOne({ _id: userId }, { $set: { slack_status_restore: restore } });
        await setStatus(slackId, { ...SLACK_STATUS_FOR_BREAK[breakType], status_expiration: 0 });
    });

/**
 * A break ended in the app (end button, Slack button, check-out): put back the
 * status saved at break start, or clear it. Only while Slack still shows a
 * break — if the user has since set something else themselves, leave it.
 */
export const clearBreakFromSlack = (userId: Types.ObjectId): Promise<void> =>
    guarded('clear', async () => {
        const slackId = await slackIdFor(userId);
        if (!slackId) return;
        // Returns the pre-update doc: read the saved status and consume it in one step.
        const user = await User.findOneAndUpdate(
            { _id: userId },
            { $set: { slack_status_restore: null } },
            { projection: { slack_status_restore: 1 } }
        ).lean();
        const current = await getStatus(slackId);
        if (!current || !breakTypeFromSlackStatus(current.status_emoji, current.status_text)) return;
        const saved = user?.slack_status_restore;
        const stillValid = saved && (saved.status_expiration === 0 || saved.status_expiration > Date.now() / 1000);
        await setStatus(slackId, stillValid ? saved : { status_text: '', status_emoji: '', status_expiration: 0 });
    });
