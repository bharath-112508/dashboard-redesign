// node-mailjet v6 publishes types with `export default Mailjet` AND
// `export { Client }` from the same file — both refer to the same
// class. TS in our `moduleResolution=NodeNext` setup picks up the
// namespace import shape, so we grab the `Client` named export
// directly. Functionally identical to `import Mailjet from
// 'node-mailjet'; new Mailjet(...)`, just type-stable.
import { Client as MailjetClientCtor } from 'node-mailjet';

import logger from '../logger.js';
import { emailRateLimitedTotal } from '../metrics.js';

import {
    EMAIL_TRANSPORT_SEND_TIMEOUT_MS,
    EmailRateLimitedError,
    withSendTimeout,
    type EmailMessage,
    type EmailTransport,
} from './types.js';

/**
 * T12 — translate a Mailjet SDK / HTTP error into our typed
 * `EmailRateLimitedError` when the upstream returned 429. The
 * `node-mailjet` SDK throws errors with `.statusCode` (and on some
 * versions `.ErrorInfo`); duck-type to avoid a hard dep on those types.
 */
const wrapMailjet429 = (err: unknown): never => {
    if (err && typeof err === 'object' && 'statusCode' in err && (err as { statusCode: number }).statusCode === 429) {
        emailRateLimitedTotal.inc({ transport: 'mailjet' });
        throw new EmailRateLimitedError('mailjet', null, err instanceof Error ? err.message : 'rate limited');
    }
    throw err;
};

/**
 * Mailjet transport.
 *
 * Uses the official `node-mailjet` SDK against the v3.1 Send API.
 * Auth is via API key + secret (basic-auth shape) — both must be
 * present at boot or send() will throw 401.
 *
 * Sender requirements:
 *   - `MAILJET_FROM_ADDRESS` must be a verified sender (Mailjet
 *     verifies via DKIM/SPF on a custom domain or via the
 *     "Add a sender" flow for individual addresses). Unverified
 *     `from` returns 400 with `ErrorMessage: "Sender address invalid"`.
 *
 * Lazy client construction — same rationale as the ACS transport:
 *   defer SDK init to first send so boot stays fast and a
 *   misconfigured key fails at the first attempt, not at import.
 */

interface MailjetClient {
    post(
        resource: string,
        opts: { version: string }
    ): {
        request(payload: unknown): Promise<{ body: unknown }>;
    };
}

let cachedClient: MailjetClient | null = null;

const getClient = (apiKey: string, apiSecret: string): MailjetClient => {
    if (cachedClient) return cachedClient;
    // node-mailjet v6 exports the Client class as default. The
    // type-cast hop is so we can keep our `MailjetClient` interface
    // narrow + dependency-light without dragging the SDK's full
    // type tree into every consumer.
    cachedClient = new MailjetClientCtor({ apiKey, apiSecret }) as unknown as MailjetClient;
    return cachedClient;
};

export const buildMailjetTransport = (config: {
    apiKey: string;
    apiSecret: string;
    fromAddress: string;
    fromName: string;
}): EmailTransport => {
    return async (msg: EmailMessage): Promise<void> => {
        const client = getClient(config.apiKey, config.apiSecret);
        const payload = {
            Messages: [
                {
                    From: { Email: config.fromAddress, Name: config.fromName },
                    To: [{ Email: msg.to }],
                    Subject: msg.subject,
                    TextPart: msg.text,
                    HTMLPart: msg.html,
                },
            ],
        };
        try {
            // T5 — wrap the upstream request in the per-call timeout.
            const response = await withSendTimeout(
                'mailjet',
                EMAIL_TRANSPORT_SEND_TIMEOUT_MS,
                client.post('send', { version: 'v3.1' }).request(payload)
            );
            // Mailjet returns 200 + a `Messages[].Status` per recipient.
            // Anything other than `success` is a failure we should surface.
            const messages = (response.body as { Messages?: { Status?: string }[] })?.Messages ?? [];
            const failed = messages.find((m) => m.Status !== 'success');
            if (failed) {
                throw new Error(`Mailjet email rejected: status=${failed.Status}`);
            }
            logger.info(
                { transport: 'mailjet', to: msg.to, subject: msg.subject, context: msg.context ?? null },
                'Email dispatched'
            );
        } catch (err) {
            // F2 — gate the generic warn on non-429 so a throttle
            // event produces ONE operator signal (the typed error +
            // the dedicated `viljetech_email_rate_limited_total`
            // counter) rather than a confusing pair where the same
            // event looks like both a generic failure AND a 429.
            // ACS handles this asymmetrically (no pre-warn); F2
            // brings Mailjet in line.
            const is429 =
                !!err &&
                typeof err === 'object' &&
                'statusCode' in err &&
                (err as { statusCode: number }).statusCode === 429;
            if (!is429) {
                logger.warn({ err, transport: 'mailjet', to: msg.to, subject: msg.subject }, 'Mailjet email failed');
            }
            // T12 — surface a 429 separately so the dispatcher can
            // count throttle events on their own metric.
            wrapMailjet429(err);
        }
    };
};
