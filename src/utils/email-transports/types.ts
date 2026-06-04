/**
 * Email transport strategy interface.
 *
 * Every transport (`stub`, `acs`, `mailjet`) implements this single
 * async function. Inputs are the same shape `mailer.sendEmail`
 * already promises; outputs are void on success and throw on
 * provider-side failure (the dispatcher in `notification-dispatcher.
 * service.ts` wraps every send in a try/catch so a stuck mailbox
 * doesn't block the primary write — the per-send failure is logged
 * at warn with `NOTIFICATION_DISPATCH_FAILED`).
 */
export interface EmailAttachment {
    /** Display filename — e.g. `"leaves-report-2026-06-03.xlsx"`. */
    filename: string;
    /** MIME type — e.g. `"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"`. */
    contentType: string;
    /** Raw binary content. Transports convert to base64 as required. */
    content: Buffer;
}

export interface EmailMessage {
    to: string;
    subject: string;
    html: string;
    text: string;
    /** Free-form correlation tag — surfaced in transport logs. */
    context?: string;
    /** Optional attachments (V2-BE-13). Each transport encodes per its API. */
    attachments?: EmailAttachment[];
}

export type EmailTransport = (msg: EmailMessage) => Promise<void>;

/**
 * Selectable transport flavours.
 *
 *  - `stub`    — dev-only console logger. No outbound delivery.
 *                Default in `NODE_ENV=development|test`.
 *  - `acs`     — Azure Communication Services Email REST via the
 *                official `@azure/communication-email` SDK. Auth via
 *                `ACS_CONNECTION_STRING`. Sender domain must be
 *                provisioned + verified in the ACS resource.
 *  - `mailjet` — Mailjet Send API via the official `node-mailjet`
 *                SDK. Auth via `MAILJET_API_KEY` + `MAILJET_API_SECRET`.
 *                Sender address must be a verified domain or address.
 */
export const EMAIL_TRANSPORTS = ['stub', 'acs', 'mailjet'] as const;
export type EmailTransportName = (typeof EMAIL_TRANSPORTS)[number];

export const isEmailTransport = (value: string): value is EmailTransportName =>
    (EMAIL_TRANSPORTS as readonly string[]).includes(value);

/**
 * Per-call upstream timeout for email send operations (T5). ACS's
 * `pollUntilDone` and Mailjet's `request(...)` both have unbounded
 * default timeouts; under tier rate-limiting they can stall for tens
 * of seconds, pinning the notification dispatcher's R11 concurrency
 * workers. 30s is enough for a healthy round-trip plus SDK-internal
 * retries; longer than that and we'd rather fail and let the
 * dispatcher's catch-and-log fire than back up the queue.
 */
export const EMAIL_TRANSPORT_SEND_TIMEOUT_MS = 30_000;

/** Raised when a send call exceeds `EMAIL_TRANSPORT_SEND_TIMEOUT_MS`. */
export class EmailSendTimeoutError extends Error {
    constructor(transport: string, ms: number) {
        super(`${transport} email send timed out after ${ms}ms`);
        this.name = 'EmailSendTimeoutError';
    }
}

/**
 * Raised when an email transport gets a 429 from upstream (T12).
 * Distinguishing this from a generic send failure lets the dispatcher
 * count throttle events separately — operators can tell "downstream
 * is throttling us" apart from "this one recipient bounced".
 */
export class EmailRateLimitedError extends Error {
    /** The transport that observed the 429 (`acs` / `mailjet`). */
    readonly transport: string;
    /** Optional `Retry-After` value in seconds, if upstream provided one. */
    readonly retryAfterSeconds: number | null;

    constructor(transport: string, retryAfterSeconds: number | null = null, detail?: string) {
        super(
            `${transport} rate-limited (HTTP 429)${
                retryAfterSeconds !== null ? `, retry after ${retryAfterSeconds}s` : ''
            }${detail ? `: ${detail}` : ''}`
        );
        this.name = 'EmailRateLimitedError';
        this.transport = transport;
        this.retryAfterSeconds = retryAfterSeconds;
    }
}

/**
 * Wrap a send promise in a hard timeout. Resolves with the inner
 * promise's value, or rejects with `EmailSendTimeoutError` if the
 * timeout fires first. The inner promise is NOT cancelled (Node has
 * no cancellation primitive for HTTP-in-flight) but the caller is
 * unblocked and downstream cleanup happens via the SDK's own
 * connection-pool timeout.
 */
export const withSendTimeout = async <T>(transport: string, ms: number, inner: Promise<T>): Promise<T> => {
    let timer: NodeJS.Timeout | null = null;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new EmailSendTimeoutError(transport, ms)), ms);
    });
    try {
        return await Promise.race([inner, timeout]);
    } finally {
        if (timer) clearTimeout(timer);
    }
};
