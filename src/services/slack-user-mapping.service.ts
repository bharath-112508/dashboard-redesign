import { User } from '../models/user.model.js';
import { SLACK_REQUEST_TIMEOUT_MS } from '../constants/slack.js';
import logger from '../utils/logger.js';

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
}

export interface ResolverContext {
    botToken: string;
    /** Fetch hook. Production wires this to `fetchSlackUserInfo`; tests
     *  pass a vi.fn() stub. */
    fetchUserInfo: (slackUserId: string, botToken: string) => Promise<SlackUserInfo | null>;
}

export const resolveSlackUser = async (slackUserId: string, ctx: ResolverContext) => {
    // 1. Fast path — already mapped.
    const byMapped = await User.findOne({ slack_user_id: slackUserId });
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

    const byEmail = await User.findOne({ email: info.email.toLowerCase() });
    if (!byEmail) {
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

    // Persist back so step 1 catches it next time.
    await User.findByIdAndUpdate(byEmail._id, { slack_user_id: slackUserId });
    return byEmail;
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
            user?: { profile?: { email?: string } };
        };
        if (!body.ok) return null;
        const email = body.user?.profile?.email;
        return email ? { email } : null;
    } catch (err) {
        if ((err as { name?: string })?.name === 'AbortError') {
            logger.warn({ slack_user_id: slackUserId, code: 'SLACK_USERS_INFO_TIMEOUT' }, 'Slack users.info timed out');
        }
        return null;
    } finally {
        clearTimeout(timer);
    }
};
