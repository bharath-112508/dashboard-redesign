import logger from './logger.js';
import { ERROR_CODES } from '../constants/error-codes.js';
import {
    SLACK_API_POST_MESSAGE,
    SLACK_API_PUBLISH_VIEW,
    SLACK_API_UPDATE_MESSAGE,
    SLACK_API_VIEWS_OPEN,
    SLACK_REQUEST_TIMEOUT_MS,
    SLACK_TEXT_MAX,
} from '../constants/slack.js';
import { decryptSecret } from './crypto-aes.js';
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

/**
 * Input for the rich post/update helper used by Phase 1 lifecycle
 * messages. `blocks` is the Block Kit payload; the fallback `text`
 * shows in notification popups + clients that can't render blocks.
 */
export interface PostOrUpdateInput {
    channel: string;
    blocks: unknown[];
    /** Fallback notification text. Required by Slack when `blocks` is set. */
    text?: string;
    /** Pass `null` on the first post; pass `{ channel, ts }` from a prior
     *  result to `chat.update` the same message in place. */
    existing: { channel: string; ts: string } | null;
    /** Same dispatch-event tag as `PostSlackMessageInput.context`. */
    context: string;
}

export const isSlackConfigured = (settings: SlackSettings | null | undefined): boolean => {
    if (!settings) return false;
    return settings.enabled === true && Boolean(settings.bot_token);
};

/**
 * Heuristic: does this stored bot_token already look encrypted?
 *
 * Two on-the-wire formats from `crypto-aes.ts`:
 *   - Legacy:   `<b64url>.<b64url>.<b64url>`  (three dot-separated parts)
 *   - Rotation: `kid:<kid>:<b64url>.<b64url>.<b64url>`
 *
 * Slack bot tokens are `xoxb-…` / `xoxa-…` / `xapp-…` and never contain
 * the `.<b64>.<b64>` shape, so the disambiguation is unambiguous in
 * practice. False positives would only matter if a future Slack token
 * format collided with the AES envelope shape — at which point we'd
 * detect the decrypt failure and fall back to plaintext anyway.
 */
export const looksEncrypted = (token: string): boolean => {
    if (token.startsWith('kid:')) return true;
    const parts = token.split('.');
    return parts.length === 3 && parts.every((p) => p.length > 0 && /^[A-Za-z0-9_-]+$/.test(p));
};

/**
 * Resolve the live plaintext bot_token from a stored value. Pre-J1
 * tokens were plaintext; J1 encrypts on PATCH. This helper:
 *   - Detects the encrypted-envelope shape and decrypts;
 *   - Falls back to treating the value as legacy plaintext when the
 *     envelope shape doesn't match (so existing deployments keep
 *     working until the operator next PATCHes the slack settings,
 *     at which point the value is migrated to encrypted form);
 *   - Returns `null` and logs a warn if a value LOOKS encrypted but
 *     decryption fails (key mismatch, corrupted blob) — better to
 *     refuse to send than ship garbage as a Bearer header.
 */
const resolveBotTokenPlaintext = (stored: string): string | null => {
    if (!looksEncrypted(stored)) {
        // Legacy plaintext — pre-J1 deployments still in flight. The next
        // PATCH /settings/slack will migrate to encrypted form.
        return stored;
    }
    try {
        return decryptSecret(stored);
    } catch (err) {
        logger.warn(
            { err },
            'Failed to decrypt stored Slack bot_token — encryption key may be misconfigured. ' +
                'Refusing to send to avoid leaking ciphertext as a Bearer header.'
        );
        return null;
    }
};

/**
 * Build a `SlackContext` from the live settings doc. A null result
 * means "Slack isn't ready" — callers should short-circuit instead of
 * attempting a send.
 *
 * J1: the stored `bot_token` may be encrypted (post-J1) or plaintext
 * (legacy / freshly migrated DB). The helper transparently resolves
 * either form.
 */
export const slackContextFrom = (settings: SlackSettings | null | undefined): SlackContext | null => {
    if (!isSlackConfigured(settings)) return null;
    const plaintext = resolveBotTokenPlaintext(settings!.bot_token!);
    if (!plaintext) return null;
    return {
        enabled: true,
        botToken: plaintext,
    };
};

const truncateText = (text: string): string =>
    text.length > SLACK_TEXT_MAX ? `${text.slice(0, SLACK_TEXT_MAX - 1)}…` : text;

interface SlackPostResponse {
    ok: boolean;
    error?: string;
    ts?: string;
    channel?: string;
}

/**
 * Result envelope from `postSlackMessage` / `postOrUpdateSlackMessage`.
 *
 * Phase-1 prereq: callers (notably the leave dispatcher) need Slack's
 * `ts` + resolved channel ID so a later state change can `chat.update`
 * the same message in-place. The boolean-return shape (v1) discarded
 * both. The envelope is non-throwing — `success: false` covers every
 * failure mode (HTTP non-2xx, `ok=false` body, network error, timeout).
 *
 * The object is always truthy, so legacy `if (await postSlackMessage(...))`
 * call sites that just checked the boolean will silently treat both
 * success AND failure as truthy. Migrate each call site to
 * `result.success` explicitly.
 */
export interface SlackPostResult {
    success: boolean;
    /** Slack's message identifier — opaque string like `"1717573200.012345"`.
     *  Combined with `channel`, lets us `chat.update` the same message later. */
    ts?: string;
    /** Resolved channel ID (e.g. `"C012ABC"`). Slack returns this even when the
     *  caller passed a channel name like `"#leaves"` — store it so subsequent
     *  updates don't re-resolve the name. */
    channel?: string;
}

/**
 * POST to `chat.postMessage`. Returns a `SlackPostResult` envelope —
 * `{ success: true, ts, channel }` when Slack accepted the message,
 * `{ success: false }` on any failure (network, auth, rate limit,
 * malformed channel). Never throws. The non-throwing contract matches
 * `mailer.sendEmail` so the dispatcher never has to catch around it.
 *
 * Slack's API returns HTTP 200 even on logical failure (with
 * `{ok: false, error}`) — we treat both `!response.ok` and
 * `body.ok === false` as a fail-and-log.
 */
export const postSlackMessage = async (ctx: SlackContext, input: PostSlackMessageInput): Promise<SlackPostResult> => {
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
            return { success: false };
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
            return { success: false };
        }
        return { success: true, ts: body.ts, channel: body.channel };
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
        return { success: false };
    } finally {
        clearTimeout(timeoutId);
    }
};

/**
 * App Home — publish (or refresh) a user's Home tab via `views.publish`.
 * Non-throwing, same dispatch policy as `postSlackMessage`: logs
 * `SLACK_DISPATCH_FAILED` at warn and returns a boolean. `views.publish`
 * is idempotent (latest view wins) so a retry / double-tick is harmless.
 */
export const publishHomeView = async (
    ctx: SlackContext,
    slackUserId: string,
    view: unknown,
    context: string
): Promise<boolean> => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), SLACK_REQUEST_TIMEOUT_MS);
    try {
        const response = await fetch(SLACK_API_PUBLISH_VIEW, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json; charset=utf-8',
                Authorization: `Bearer ${ctx.botToken}`,
            },
            body: JSON.stringify({ user_id: slackUserId, view }),
            signal: controller.signal,
        });
        if (!response.ok) {
            logger.warn(
                { code: ERROR_CODES.SLACK_DISPATCH_FAILED, dispatch_event: context, http_status: response.status },
                'Slack views.publish returned a non-2xx status'
            );
            return false;
        }
        const body = (await response.json()) as { ok: boolean; error?: string };
        if (!body.ok) {
            logger.warn(
                { code: ERROR_CODES.SLACK_DISPATCH_FAILED, dispatch_event: context, slack_error: body.error },
                'Slack views.publish rejected the view'
            );
            return false;
        }
        return true;
    } catch (err) {
        const isAbort = (err as { name?: string })?.name === 'AbortError';
        logger.warn(
            { err, code: ERROR_CODES.SLACK_DISPATCH_FAILED, dispatch_event: context, timed_out: isAbort },
            isAbort ? 'Slack views.publish timed out' : 'Slack views.publish threw'
        );
        return false;
    } finally {
        clearTimeout(timeoutId);
    }
};

/**
 * Phase 1 — Post a NEW Slack message OR update an existing one, based
 * on `input.existing`. Same auth + timeout + non-throwing contract as
 * `postSlackMessage`.
 *
 * When `existing` is null: posts via `chat.postMessage`, Slack returns
 * a new `ts` + `channel` for the dispatcher to persist on the leave doc.
 *
 * When `existing` is set: edits the original message via `chat.update`
 * keeping the same `ts` — the channel sees one message that mutates
 * through the leave's lifecycle (pending → approved/rejected/cancelled)
 * rather than a fresh post per state change.
 *
 * `chat.update`'s common failure mode is `message_not_found` (bot was
 * kicked from the channel, message was deleted, ts mismatch). We log
 * + return `{ success: false }`; the dispatcher treats this as a soft
 * failure — the BE state change still succeeds, the channel just shows
 * the stale message. Future: surface a "Slack sync failed" indicator
 * in admin UI.
 */
export const postOrUpdateSlackMessage = async (
    ctx: SlackContext,
    input: PostOrUpdateInput
): Promise<SlackPostResult> => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), SLACK_REQUEST_TIMEOUT_MS);

    const isUpdate = Boolean(input.existing);
    const url = isUpdate ? SLACK_API_UPDATE_MESSAGE : SLACK_API_POST_MESSAGE;
    const body = isUpdate
        ? {
              channel: input.existing!.channel,
              ts: input.existing!.ts,
              blocks: input.blocks,
              text: input.text ? truncateText(input.text) : undefined,
          }
        : {
              channel: input.channel,
              blocks: input.blocks,
              text: input.text ? truncateText(input.text) : undefined,
          };

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json; charset=utf-8',
                Authorization: `Bearer ${ctx.botToken}`,
            },
            body: JSON.stringify(body),
            signal: controller.signal,
        });

        if (!response.ok) {
            logger.warn(
                {
                    code: ERROR_CODES.SLACK_DISPATCH_FAILED,
                    dispatch_event: input.context,
                    channel: input.channel,
                    is_update: isUpdate,
                    http_status: response.status,
                },
                `Slack ${isUpdate ? 'chat.update' : 'chat.postMessage'} returned a non-2xx status`
            );
            return { success: false };
        }

        const parsed = (await response.json()) as SlackPostResponse;
        if (!parsed.ok) {
            logger.warn(
                {
                    code: ERROR_CODES.SLACK_DISPATCH_FAILED,
                    dispatch_event: input.context,
                    channel: input.channel,
                    is_update: isUpdate,
                    slack_error: parsed.error,
                },
                `Slack ${isUpdate ? 'chat.update' : 'chat.postMessage'} rejected the message`
            );
            return { success: false };
        }
        return { success: true, ts: parsed.ts, channel: parsed.channel };
    } catch (err) {
        const isAbort = (err as { name?: string })?.name === 'AbortError';
        logger.warn(
            {
                err,
                code: ERROR_CODES.SLACK_DISPATCH_FAILED,
                dispatch_event: input.context,
                channel: input.channel,
                is_update: isUpdate,
                timed_out: isAbort,
            },
            isAbort
                ? `Slack ${isUpdate ? 'chat.update' : 'chat.postMessage'} timed out`
                : `Slack ${isUpdate ? 'chat.update' : 'chat.postMessage'} threw`
        );
        return { success: false };
    } finally {
        clearTimeout(timeoutId);
    }
};

/**
 * Open an interactive modal via `views.open`. Used by the Apply-for-leave
 * flow (App Home button + `/applyleave`) and the Log-time flow (App Home
 * button). Non-throwing, same dispatch policy as `publishHomeView`: logs
 * `SLACK_DISPATCH_FAILED` at warn and returns a boolean.
 *
 * `context` (same idea as `publishHomeView`'s `context` param) tags the
 * failure log with the caller's dispatch event — there are now two callers,
 * so a hard-coded label here would mislabel one of them.
 *
 * The common failure is `expired_trigger_id` — Slack `trigger_id`s are valid
 * for ~3s, so the caller must reach this with minimal upstream work. A false
 * return means the modal never opened; the caller falls back to an ephemeral
 * "please try again".
 */
export const openSlackModal = async (
    ctx: SlackContext,
    triggerId: string,
    view: unknown,
    context: string
): Promise<boolean> => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), SLACK_REQUEST_TIMEOUT_MS);
    try {
        const response = await fetch(SLACK_API_VIEWS_OPEN, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json; charset=utf-8',
                Authorization: `Bearer ${ctx.botToken}`,
            },
            body: JSON.stringify({ trigger_id: triggerId, view }),
            signal: controller.signal,
        });
        if (!response.ok) {
            logger.warn(
                {
                    code: ERROR_CODES.SLACK_DISPATCH_FAILED,
                    dispatch_event: context,
                    http_status: response.status,
                },
                'Slack views.open returned a non-2xx status'
            );
            return false;
        }
        const body = (await response.json()) as { ok: boolean; error?: string };
        if (!body.ok) {
            logger.warn(
                {
                    code: ERROR_CODES.SLACK_DISPATCH_FAILED,
                    dispatch_event: context,
                    slack_error: body.error,
                },
                'Slack views.open rejected the request'
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
                dispatch_event: context,
                timed_out: isAbort,
            },
            isAbort ? 'Slack views.open timed out' : 'Slack views.open threw'
        );
        return false;
    } finally {
        clearTimeout(timeoutId);
    }
};
