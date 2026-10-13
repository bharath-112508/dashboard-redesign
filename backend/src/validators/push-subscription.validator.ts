import { z } from 'zod';

import { isAllowedPushEndpoint } from '../utils/push-endpoint-allowlist.js';

/**
 * Zod validators for the push-subscription API (V2-BE-10).
 *
 * The body shape mirrors the result of
 * `serviceWorkerRegistration.pushManager.subscribe(...).toJSON()` on
 * the browser side, with a few constraints:
 *   - `endpoint` is the push provider's URL. Bounded to 2 KB which is
 *     well past any real provider URL, must be HTTPS, and must point
 *     to a known push provider (C8 SSRF gate — see
 *     `utils/push-endpoint-allowlist.ts`).
 *   - `keys.p256dh` / `keys.auth` are base64url-encoded strings — both
 *     are short (16 + 65 bytes pre-encoding), so 256 chars max is
 *     plenty of headroom.
 *   - `user_agent` is optional and capped — never used in business
 *     logic, only for diagnostics.
 */

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
