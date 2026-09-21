import { User } from '../models/user.model.js';
import { SLACK_API_LOOKUP_BY_EMAIL, SLACK_REQUEST_TIMEOUT_MS } from '../constants/slack.js';
import { USER_STATUSES } from '../constants/user-statuses.js';
import logger from '../utils/logger.js';
import { getOrInitSettings } from './settings.service.js';
import { slackContextFrom } from '../utils/slack.js';

/**
 * Phase 0 — map a Slack user → Viljetech user for interactive
 * webhook handlers (Approve / Reject leave, slash commands).
 *
 * Strategy:
 *   1. Look up by `User.slack_user_id` (O(1) once populated).
 *   2. Fall back to Slack's `users.info` for the email, match against
 *      `User.email`, persist `slack_user_id` back so the next call
 *      short-circuits at step 1.
 *   3. Return `null` when no match — caller responds ephemeral
 *      "Couldn't identify your Viljetech account."
 *
 * The Slack API call is injected via `ctx.fetchUserInfo` so tests can
 * stub it without monkey-patching global fetch.
 */

export interface SlackUserInfo {
    email: string;
    avatar_url: string | null;
}

export interface ResolverContext {
    botToken: string;
    /** Fetch hook. Production wires this to `fetchSlackUserInfo`; tests
     *  pass a vi.fn() stub. */
    fetchUserInfo: (slackUserId: string, botToken: string) => Promise<SlackUserInfo | null>;
    /** Warn when the Slack email matches no account. Default true. */
    warnUnmatched?: boolean;
}

export const resolveSlackUser = async (slackUserId: string, ctx: ResolverContext) => {
    // 1. Fast path — already mapped. Filtered to `active` — mirrors the T1
    // gate in `middlewares/auth.middleware.ts` ("deactivated → 403
    // ACCOUNT_DEACTIVATED. Closes the JWT-outlives-deactivate window").
    // Slack has no token to expire, so without this a deactivated user
    // keeps every Slack write (approve leave, check in/out, log time)
    // indefinitely — this one filter closes that for every caller path at
    // once, since both lookups below funnel through it.
    const byMapped = await User.findOne({ slack_user_id: slackUserId, status: USER_STATUSES.ACTIVE });
    if (byMapped) return byMapped;

    // 2. Fall back to Slack — never throw to the caller, log + return null.
    const info = await ctx.fetchUserInfo(slackUserId, ctx.botToken).catch((err) => {
        logger.warn(
            { err, slack_user_id: slackUserId, code: 'SLACK_USERS_INFO_FAILED' },
            'Slack users.info call failed'
        );
        return null;
    });
    if (!info?.email) return null;

    const byEmail = await User.findOne({ email: info.email.toLowerCase(), status: USER_STATUSES.ACTIVE });
    if (!byEmail) {
        if (ctx.warnUnmatched === false) return null;
        logger.warn(
            {
                slack_user_id: slackUserId,
                slack_email: info.email,
                code: 'SLACK_USER_UNMATCHED',
            },
            'Slack user has no matching Viljetech account'
        );
        return null;
    }

    // Steal the mapping from any OTHER user that still holds this Slack id
    // before claiming it. A Slack id identifies exactly one human, so it must
    // map to exactly one Viljetech user — otherwise the fast-path
    // `findOne({ slack_user_id })` can return the wrong account (the bug where
    // a team lead opened the App Home and saw the admin's data because both
    // rows carried his Slack id). Clearing first also avoids a duplicate-key
    // write conflict against the partial-unique index on `slack_user_id`.
    await User.updateMany({ slack_user_id: slackUserId, _id: { $ne: byEmail._id } }, { $set: { slack_user_id: null } });

    // Persist back so step 1 catches it next time (+ cache the avatar).
    await User.findByIdAndUpdate(byEmail._id, {
        slack_user_id: slackUserId,
        ...(info.avatar_url ? { slack_avatar_url: info.avatar_url } : {}),
    });
    return byEmail;
};

/**
 * Slack user id → platform user, with the bot token and fetch hook supplied
 * from settings.
 *
 * Lifted out of `slack-interactive.controller.ts`, where it was a private
 * const. Two controllers need it now, and having the second import it from
 * the first would be circular — that controller imports the second one to
 * route to it.
 */
export const resolveSlackCaller = async (slackUserId: string) => {
    const settings = await getOrInitSettings();
    const ctx = slackContextFrom(settings.slack);
    if (!ctx) return null;
    return resolveSlackUser(slackUserId, {
        botToken: ctx.botToken!,
        fetchUserInfo: fetchSlackUserInfo,
    });
};

/**
 * Slack user → platform user for `user_change` events. The payload already
 * carries the profile email (`users:read.email`), so this never calls
 * users.info, and an unmatched user (a guest, a Slack Connect member) is
 * skipped without a warning — the event fires for every workspace member.
 */
export const resolveSlackStatusUser = async (slackUserId: string, email: string | undefined) => {
    const settings = await getOrInitSettings();
    if (!slackContextFrom(settings.slack)) return null;
    return resolveSlackUser(slackUserId, {
        botToken: '',
        fetchUserInfo: async () => (email ? { email, avatar_url: null } : null),
        warnUnmatched: false,
    });
};

/**
 * Production `users.info` impl — wraps Slack's REST endpoint. Used as
 * the `fetchUserInfo` hook in the resolver context. Tests stub the
 * hook directly via `ResolverContext.fetchUserInfo`.
 *
 * https://api.slack.com/methods/users.info
 */
export const fetchSlackUserInfo = async (slackUserId: string, botToken: string): Promise<SlackUserInfo | null> => {
    // Slack interactive has a 3-second response window. Bound the
    // outbound `users.info` so a Slack-side stall doesn't blow past it
    // and leave the user with no feedback.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SLACK_REQUEST_TIMEOUT_MS);
    try {
        const res = await fetch(`https://slack.com/api/users.info?user=${encodeURIComponent(slackUserId)}`, {
            headers: { Authorization: `Bearer ${botToken}` },
            signal: controller.signal,
        });
        if (!res.ok) return null;
        const body = (await res.json()) as {
            ok: boolean;
            user?: { profile?: { email?: string; image_72?: string } };
        };
        if (!body.ok) return null;
        const email = body.user?.profile?.email;
        return email ? { email, avatar_url: body.user?.profile?.image_72 ?? null } : null;
    } catch (err) {
        if ((err as { name?: string })?.name === 'AbortError') {
            logger.warn({ slack_user_id: slackUserId, code: 'SLACK_USERS_INFO_TIMEOUT' }, 'Slack users.info timed out');
        }
        return null;
    } finally {
        clearTimeout(timer);
    }
};

/**
 * Eager mapping for the attendance nudge crons. The cron has no
 * interactive payload to hand us a Slack user id, so resolve it from the
 * account email via `users.lookupByEmail`. Non-throwing — returns null on
 * any failure (not found, bad token, network) so one unresolved user
 * never aborts the nudge batch.
 *
 * https://api.slack.com/methods/users.lookupByEmail
 */
export const resolveSlackIdByEmail = async (
    email: string,
    botToken: string
): Promise<{ slackId: string; avatarUrl: string | null } | null> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SLACK_REQUEST_TIMEOUT_MS);
    try {
        const res = await fetch(`${SLACK_API_LOOKUP_BY_EMAIL}?email=${encodeURIComponent(email)}`, {
            headers: { Authorization: `Bearer ${botToken}` },
            signal: controller.signal,
        });
        if (!res.ok) return null;
        const body = (await res.json()) as { ok: boolean; user?: { id?: string; profile?: { image_72?: string } } };
        if (!body.ok || !body.user?.id) return null;
        return { slackId: body.user.id, avatarUrl: body.user.profile?.image_72 ?? null };
    } catch (err) {
        if ((err as { name?: string })?.name === 'AbortError') {
            logger.warn({ code: 'SLACK_LOOKUP_BY_EMAIL_TIMEOUT' }, 'Slack users.lookupByEmail timed out');
        }
        return null;
    } finally {
        clearTimeout(timer);
    }
};

/**
 * Backfill helper — fetch just the avatar (`profile.image_72`) for an
 * already-mapped Slack user via `users.info`. Non-throwing; null on any
 * failure. Used by the nudge cron to warm avatars for users mapped before
 * the avatar cache existed.
 */
export const fetchSlackAvatarUrl = async (slackUserId: string, botToken: string): Promise<string | null> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SLACK_REQUEST_TIMEOUT_MS);
    try {
        const res = await fetch(`https://slack.com/api/users.info?user=${encodeURIComponent(slackUserId)}`, {
            headers: { Authorization: `Bearer ${botToken}` },
            signal: controller.signal,
        });
        if (!res.ok) return null;
        const body = (await res.json()) as { ok: boolean; user?: { profile?: { image_72?: string } } };
        if (!body.ok) return null;
        return body.user?.profile?.image_72 ?? null;
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
};
