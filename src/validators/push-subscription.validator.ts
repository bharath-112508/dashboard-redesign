import { z } from 'zod';

/**
 * Zod validators for the push-subscription API (V2-BE-10).
 *
 * The body shape mirrors the result of
 * `serviceWorkerRegistration.pushManager.subscribe(...).toJSON()` on
 * the browser side, with a few constraints:
 *   - `endpoint` is the push provider's URL. Bounded to 2 KB which is
 *     well past any real provider URL, must be HTTPS, and must point
 *     to a known push provider (C8 SSRF gate — see below).
 *   - `keys.p256dh` / `keys.auth` are base64url-encoded strings — both
 *     are short (16 + 65 bytes pre-encoding), so 256 chars max is
 *     plenty of headroom.
 *   - `user_agent` is optional and capped — never used in business
 *     logic, only for diagnostics.
 */

/**
 * C8 — known push-service hosts. Pre-C8 the `endpoint` validator was
 * just `z.string().url()` — any logged-in user could submit
 * `http://169.254.169.254/latest/meta-data/iam/` (AWS IMDS),
 * `http://localhost:6379/`, or any other internal target, and the
 * dispatcher's `webPush.sendNotification` would POST to it. The body
 * is encrypted, but the REQUEST itself lands on the internal target
 * — a usable callback / port-scan / OAST primitive. Hostname must
 * exactly match or be a subdomain of one of the entries below.
 */
const PUSH_ENDPOINT_ALLOWED_HOSTS = [
    'googleapis.com', // covers `fcm.googleapis.com`, `android.googleapis.com`
    'push.services.mozilla.com', // Firefox autopush
    'push.apple.com', // Safari (`web.push.apple.com`)
    'notify.windows.com', // Edge / WNS
] as const;

const isAllowedPushEndpoint = (url: string): boolean => {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return false;
    }
    // HTTPS only — push providers never use plain HTTP, and an HTTP
    // endpoint that resolves to a private IP is the classic SSRF vector.
    if (parsed.protocol !== 'https:') return false;
    const host = parsed.hostname.toLowerCase();
    return PUSH_ENDPOINT_ALLOWED_HOSTS.some((d) => host === d || host.endsWith(`.${d}`));
};

const endpointField = z.string().url('endpoint must be a valid URL').max(2048).refine(isAllowedPushEndpoint, {
    message: 'endpoint hostname is not on the push-provider allowlist (FCM / Mozilla / Apple / Windows)',
});

export const subscribePushBodySchema = z.object({
    endpoint: endpointField,
    keys: z.object({
        p256dh: z.string().min(1).max(256),
        auth: z.string().min(1).max(64),
    }),
    user_agent: z.string().max(512).optional().nullable(),
});

export type SubscribePushBody = z.infer<typeof subscribePushBodySchema>;

export const unsubscribePushBodySchema = z.object({
    endpoint: endpointField,
});

export type UnsubscribePushBody = z.infer<typeof unsubscribePushBodySchema>;
