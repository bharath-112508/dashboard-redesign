import webPush from 'web-push';

import logger from './logger.js';
import { isAllowedPushEndpoint } from './push-endpoint-allowlist.js';
import { ERROR_CODES } from '../constants/error-codes.js';
import { PushSubscription, type LeanPushSubscription } from '../models/push-subscription.model.js';

/**
 * Web Push client (V2-BE-10).
 *
 * Single function: `sendPushNotification`. Calls
 * `webPush.sendNotification(...)` for one stored subscription. Never
 * throws — failures are logged under `PUSH_DISPATCH_FAILED` at warn
 * level, mirroring the email + Slack dispatch contract.
 *
 * Smart-prune semantics:
 *   - 410 Gone / 404 Not Found from the push provider means the
 *     endpoint is permanently dead (user revoked permission, browser
 *     re-installed, Chrome / Firefox / Safari recycled the key). The
 *     subscription row is auto-deleted in that case so subsequent
 *     dispatches don't keep firing at a dead endpoint.
 *   - Any other failure (rate limit, network blip, transient 5xx) just
 *     stamps `last_error_at` so an operator can spot patterns.
 *
 * VAPID configuration is set lazily on first call so unit tests can
 * mock `web-push` without the env reads blowing up.
 */

let vapidConfigured = false;

const configureVapidOnce = (): boolean => {
    if (vapidConfigured) return true;
    const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT } = process.env;
    if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY || !VAPID_SUBJECT) return false;
    webPush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
    vapidConfigured = true;
    return true;
};

/**
 * True when the three VAPID env vars are present — call before fan-out
 * so we can skip push entirely instead of catching N failed sends.
 */
export const isPushConfigured = (): boolean => {
    const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT } = process.env;
    return Boolean(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY && VAPID_SUBJECT);
};

export interface PushPayload {
    /** Becomes the OS toast title. */
    title: string;
    /** Becomes the OS toast body. */
    body: string;
    /** URL the service worker should navigate to on click. */
    link_url: string;
    /** Notification-type tag, e.g. `'leave_approved'`. The SW uses this
     *  to coalesce repeated pushes for the same event. */
    type: string;
    /** Source notification row id — lets the SW deep-link to the bell
     *  in case `link_url` is empty. */
    related_id?: string;
}

export interface SendPushInput {
    // M12 — `LeanPushSubscription` matches what `listSubscriptionsForUser`
    // actually returns (lean → no Mongoose methods); the dispatcher
    // only reads fields and deletes by `_id`, both work on the lean
    // shape.
    subscription: LeanPushSubscription;
    payload: PushPayload;
    /** Logger context tag — e.g. `'leave-approved-recipient'`. */
    context: string;
}

interface WebPushError extends Error {
    statusCode?: number;
    body?: string;
}

const isPermanentlyDead = (statusCode: number | undefined): boolean => statusCode === 404 || statusCode === 410;

/**
 * Send one push to one subscription. Returns `true` on success, `false`
 * on (logged) failure. Subscription rows are pruned automatically on
 * 410/404, stamped with `last_error_at` on transient failures, and
 * stamped with `last_used_at` on success.
 */
export const sendPushNotification = async (input: SendPushInput): Promise<boolean> => {
    if (!configureVapidOnce()) {
        // VAPID not configured — push is dormant. The dispatcher
        // guards this with `isPushConfigured()` so this branch
        // shouldn't actually fire, but defence in depth.
        return false;
    }

    const { subscription, payload, context } = input;

    // C8 follow-through — re-validate the stored endpoint before
    // dispatching. C8's validator gate closed the subscribe path, but
    // rows persisted BEFORE the deploy could still point at internal
    // targets (IMDS, localhost, RFC1918). Without this check the
    // dispatcher would keep POSTing to them forever. On a hit we
    // hard-delete the row + log it as a deliberate prune; the same
    // row is also targeted by the boot migration, but the
    // migration is a one-shot — this guard fires on the very next
    // dispatch even if the migration was skipped.
    if (!isAllowedPushEndpoint(subscription.endpoint)) {
        logger.warn(
            {
                code: ERROR_CODES.PUSH_DISPATCH_FAILED,
                subscription_id: subscription._id.toString(),
                reason: 'endpoint_not_allowlisted',
                dispatch_event: context,
            },
            'Pruning push subscription with non-allowlisted endpoint'
        );
        try {
            await PushSubscription.deleteOne({ _id: subscription._id });
        } catch {
            // swallow — the next dispatch will see it again and try again
        }
        return false;
    }

    try {
        // H18 — bound the outbound push call. `web-push` uses Node's
        // default agent with no socket timeout; a misbehaving Mozilla
        // / FCM endpoint can stall the dispatcher's per-fanout worker
        // (concurrency = 5) indefinitely. 10 s is the standard
        // web-push timeout option and well past the p99 send latency
        // of every legit provider. On timeout the library rejects
        // and the catch below handles it like any other send failure.
        await webPush.sendNotification(
            {
                endpoint: subscription.endpoint,
                keys: { p256dh: subscription.keys.p256dh, auth: subscription.keys.auth },
            },
            JSON.stringify(payload),
            { timeout: 10_000 }
        );
        // Best-effort stamp — failure to write the timestamp must not
        // mask a successful send.
        try {
            await PushSubscription.updateOne({ _id: subscription._id }, { $set: { last_used_at: new Date() } });
        } catch {
            // swallow
        }
        return true;
    } catch (err) {
        const e = err as WebPushError;
        if (isPermanentlyDead(e.statusCode)) {
            try {
                await PushSubscription.deleteOne({ _id: subscription._id });
            } catch {
                // swallow — the row will get cleaned up on next dispatch
            }
            logger.info(
                {
                    code: ERROR_CODES.PUSH_DISPATCH_FAILED,
                    dispatch_event: context,
                    subscription_id: subscription._id.toString(),
                    status: e.statusCode,
                    pruned: true,
                },
                'Push subscription expired, pruned'
            );
            return false;
        }

        // Transient failure: stamp + log, leave the row alone.
        try {
            await PushSubscription.updateOne({ _id: subscription._id }, { $set: { last_error_at: new Date() } });
        } catch {
            // swallow
        }
        logger.warn(
            {
                err,
                code: ERROR_CODES.PUSH_DISPATCH_FAILED,
                dispatch_event: context,
                subscription_id: subscription._id.toString(),
                status: e.statusCode,
            },
            'Push send failed'
        );
        return false;
    }
};
