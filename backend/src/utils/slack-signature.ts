import crypto from 'node:crypto';

/**
 * Phase 0 — Slack signs every interactive / slash-command webhook with
 * HMAC-SHA256 of `v0:<timestamp>:<body>` using the app's signing
 * secret, and sends:
 *
 *   X-Slack-Signature:           v0=<hex>
 *   X-Slack-Request-Timestamp:   <unix seconds>
 *
 * We constant-time compare against `X-Slack-Signature` and reject
 * anything older than the replay window (5 minutes per Slack docs).
 *
 * Pure function — always returns boolean, never throws. The caller
 * (slack-webhook middleware) decides how to respond (typically 401 +
 * log SLACK_INTERACTIVE_REJECTED).
 *
 * https://api.slack.com/authentication/verifying-requests-from-slack
 */

const REPLAY_WINDOW_SECONDS = 5 * 60;

interface VerifyInput {
    /** App signing secret — `SLACK_SIGNING_SECRET` from env. */
    secret: string;
    /** Raw `X-Slack-Signature` header — looks like `v0=<hex>`. */
    signature: string;
    /** Raw `X-Slack-Request-Timestamp` header — Unix seconds as string. */
    timestamp: string;
    /** Exact raw request body bytes (the entire urlencoded or JSON body
     *  that Slack sent, before any parsing). */
    body: string;
}

export const verifySlackSignature = (input: VerifyInput): boolean => {
    if (!input.signature || !input.signature.startsWith('v0=')) return false;

    const tsNum = Number(input.timestamp);
    if (!Number.isFinite(tsNum)) return false;

    const ageSeconds = Math.abs(Math.floor(Date.now() / 1000) - tsNum);
    if (ageSeconds > REPLAY_WINDOW_SECONDS) return false;

    const base = `v0:${input.timestamp}:${input.body}`;
    const computed = `v0=${crypto.createHmac('sha256', input.secret).update(base).digest('hex')}`;

    try {
        // `timingSafeEqual` throws if the buffers are different lengths —
        // we treat that as "no match" so a malformed signature can never
        // crash the request handler.
        return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(input.signature));
    } catch {
        return false;
    }
};
