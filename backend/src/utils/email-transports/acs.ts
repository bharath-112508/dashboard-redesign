import { EmailClient } from '@azure/communication-email';

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
 * T12 — translate an Azure SDK error into our typed `EmailRateLimitedError`
 * when the upstream returned 429. The Azure SDK throws a `RestError` with
 * `statusCode` on the error object; we duck-type to avoid pulling in the
 * Azure types just for this check.
 */
const wrapAcs429 = (err: unknown): never => {
    if (err && typeof err === 'object' && 'statusCode' in err && (err as { statusCode: number }).statusCode === 429) {
        emailRateLimitedTotal.inc({ transport: 'acs' });
        // ACS doesn't expose Retry-After through the SDK error reliably;
        // record null and let the operator dashboard pick it up from the
        // metric counter rather than per-call.
        throw new EmailRateLimitedError('acs', null, err instanceof Error ? err.message : 'rate limited');
    }
    throw err;
};

/**
 * Azure Communication Services Email transport.
 *
 * Uses the official `@azure/communication-email` SDK. Auth is via the
 * connection-string env (`ACS_CONNECTION_STRING`) — same shape Azure
 * Storage already uses, easy to rotate via Key Vault.
 *
 * Sender requirements:
 *   - The `from` address must belong to a domain provisioned in the
 *     ACS resource (typically `<resource>.azurecomm.net` or a
 *     custom-verified domain). Misconfigured `from` returns a 400
 *     from the API, which we surface as a thrown error so the
 *     notification dispatcher's catch-and-log fires.
 *
 * Polling:
 *   - `beginSend` returns a poller because ACS-Email is async by
 *     design (queue-and-deliver). We `pollUntilDone()` so the
 *     transport contract stays "throws on failure" — without it, a
 *     bad-recipient error would land in the operation status some
 *     time later and we'd never see it.
 *
 * Lazy client construction:
 *   - The SDK constructor parses the connection string at call
 *     time. We build the client on first use to keep boot fast +
 *     so that an empty-string `ACS_CONNECTION_STRING` fails at the
 *     first send, not at import.
 */

let cachedClient: EmailClient | null = null;

const getClient = (connectionString: string): EmailClient => {
    if (cachedClient) return cachedClient;
    cachedClient = new EmailClient(connectionString);
    return cachedClient;
};

export const buildAcsTransport = (config: { connectionString: string; fromAddress: string }): EmailTransport => {
    return async (msg: EmailMessage): Promise<void> => {
        const client = getClient(config.connectionString);
        try {
            // T5 — wrap both the begin + poll in the per-call timeout.
            const poller = await withSendTimeout(
                'acs',
                EMAIL_TRANSPORT_SEND_TIMEOUT_MS,
                client.beginSend({
                    senderAddress: config.fromAddress,
                    content: {
                        subject: msg.subject,
                        html: msg.html,
                        plainText: msg.text,
                    },
                    recipients: { to: [{ address: msg.to }] },
                    // V2-BE-13 — ACS Email accepts attachments inline in
                    // the message payload, base64-encoded. Per the SDK
                    // shape: `{ name, contentType, contentInBase64 }`.
                    attachments: msg.attachments?.map((a) => ({
                        name: a.filename,
                        contentType: a.contentType,
                        contentInBase64: a.content.toString('base64'),
                    })),
                })
            );
            const result = await withSendTimeout('acs', EMAIL_TRANSPORT_SEND_TIMEOUT_MS, poller.pollUntilDone());
            if (result.status !== 'Succeeded') {
                const err = new Error(`ACS email failed: ${result.status} (id=${result.id})`);
                logger.warn(
                    { transport: 'acs', to: msg.to, subject: msg.subject, status: result.status, id: result.id },
                    'ACS email failed'
                );
                throw err;
            }
            logger.info(
                { transport: 'acs', to: msg.to, subject: msg.subject, context: msg.context ?? null, id: result.id },
                'Email dispatched'
            );
        } catch (err) {
            // T12 — surface a 429 separately so the dispatcher can
            // count throttle events on their own metric.
            wrapAcs429(err);
        }
    };
};
