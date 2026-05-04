import logger from './logger.js';
import { ERROR_CODES } from '../constants/error-codes.js';
import { SLACK_API_POST_MESSAGE, SLACK_REQUEST_TIMEOUT_MS, SLACK_TEXT_MAX } from '../constants/slack.js';
import type { SlackSettings } from '../models/system-settings.model.js';

/**
 * Slack client (Step 25).
 *
 * v1 surface is a single function: `postSlackMessage`. It calls
 * `chat.postMessage` via Node 20's built-in `fetch`, never throws, and
 * logs failures under `SLACK_DISPATCH_FAILED` at warn level — same
 * dispatch policy as the email mailer.
 *
 * Why a thin wrapper instead of `@slack/web-api`:
 *  - We use exactly one endpoint. The full SDK is ~1 MB of types and
 *    would couple our build to Slack's release cadence.
 *  - The contract we care about is "post a string to a target". `fetch`
 *    + a small response-shape check is sufficient and keeps the dep
 *    surface small.
 *
 * The dispatcher passes the resolved `bot_token` + `enabled` flag in
 * via `SlackContext` so a single settings load at the top of each
 * notify-helper covers the broadcast AND every per-recipient DM
 * (instead of N round-trips to the settings collection).
 */

export interface SlackContext {
    enabled: boolean;
    botToken: string | null;
}

export interface PostSlackMessageInput {
    /**
     * Target channel — either `#name`, a channel ID (`C…`), or a Slack
     * user ID (`U…` / `W…`). `chat.postMessage` accepts all three;
     * Slack opens an IM channel server-side for user IDs.
     */
    channel: string;
    text: string;
    /**
     * Logger context tag for grepping dispatch failures by event
     * (e.g. `'leave-submitted-broadcast'`,
     * `'task-comment-mention-dm'`).
     */
    context: string;
}

export const isSlackConfigured = (settings: SlackSettings | null | undefined): boolean => {
    if (!settings) return false;
    return settings.enabled === true && Boolean(settings.bot_token);
};

/**
 * Build a `SlackContext` from the live settings doc. A null result
 * means "Slack isn't ready" — callers should short-circuit instead of
 * attempting a send.
 */
export const slackContextFrom = (settings: SlackSettings | null | undefined): SlackContext | null => {
    if (!isSlackConfigured(settings)) return null;
    return {
        enabled: true,
        botToken: settings!.bot_token!,
    };
};

const truncateText = (text: string): string =>
    text.length > SLACK_TEXT_MAX ? `${text.slice(0, SLACK_TEXT_MAX - 1)}…` : text;

interface SlackPostResponse {
    ok: boolean;
    error?: string;
    ts?: string;
}

/**
 * POST to `chat.postMessage`. Returns `true` when Slack accepted the
 * message, `false` on any failure (network, auth, rate limit, malformed
 * channel). Never throws. The non-throwing contract matches
 * `mailer.sendEmail` so the dispatcher never has to catch around it.
 *
 * Slack's API returns HTTP 200 even on logical failure (with
 * `{ok: false, error}`) — we treat both `!response.ok` and
 * `body.ok === false` as a fail-and-log.
 */
export const postSlackMessage = async (ctx: SlackContext, input: PostSlackMessageInput): Promise<boolean> => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), SLACK_REQUEST_TIMEOUT_MS);

    try {
        const response = await fetch(SLACK_API_POST_MESSAGE, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json; charset=utf-8',
                Authorization: `Bearer ${ctx.botToken}`,
            },
            body: JSON.stringify({
                channel: input.channel,
                text: truncateText(input.text),
            }),
            signal: controller.signal,
        });

        if (!response.ok) {
            logger.warn(
                {
                    code: ERROR_CODES.SLACK_DISPATCH_FAILED,
                    dispatch_event: input.context,
                    channel: input.channel,
                    http_status: response.status,
                },
                'Slack chat.postMessage returned a non-2xx status'
            );
            return false;
        }

        const body = (await response.json()) as SlackPostResponse;
        if (!body.ok) {
            // Slack returns `error: "channel_not_found"` etc. for
            // logical failures; surface the code in logs but don't
            // leak it to the caller (callers don't differentiate).
            logger.warn(
                {
                    code: ERROR_CODES.SLACK_DISPATCH_FAILED,
                    dispatch_event: input.context,
                    channel: input.channel,
                    slack_error: body.error,
                },
                'Slack chat.postMessage rejected the message'
            );
            return false;
        }
        return true;
    } catch (err) {
        const isAbort = (err as { name?: string })?.name === 'AbortError';
        logger.warn(
            {
                err,
                code: ERROR_CODES.SLACK_DISPATCH_FAILED,
                dispatch_event: input.context,
                channel: input.channel,
                timed_out: isAbort,
            },
            isAbort ? 'Slack chat.postMessage timed out' : 'Slack chat.postMessage threw'
        );
        return false;
    } finally {
        clearTimeout(timeoutId);
    }
};
