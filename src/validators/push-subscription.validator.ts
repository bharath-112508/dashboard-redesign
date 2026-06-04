import { z } from 'zod';

/**
 * Zod validators for the push-subscription API (V2-BE-10).
 *
 * The body shape mirrors the result of
 * `serviceWorkerRegistration.pushManager.subscribe(...).toJSON()` on
 * the browser side, with a few constraints:
 *   - `endpoint` is the push provider's URL. Bounded to 2 KB which is
 *     well past any real provider URL.
 *   - `keys.p256dh` / `keys.auth` are base64url-encoded strings — both
 *     are short (16 + 65 bytes pre-encoding), so 256 chars max is
 *     plenty of headroom.
 *   - `user_agent` is optional and capped — never used in business
 *     logic, only for diagnostics.
 */

export const subscribePushBodySchema = z.object({
    endpoint: z.string().url('endpoint must be a valid URL').max(2048),
    keys: z.object({
        p256dh: z.string().min(1).max(256),
        auth: z.string().min(1).max(64),
    }),
    user_agent: z.string().max(512).optional().nullable(),
});

export type SubscribePushBody = z.infer<typeof subscribePushBodySchema>;

export const unsubscribePushBodySchema = z.object({
    endpoint: z.string().url('endpoint must be a valid URL').max(2048),
});

export type UnsubscribePushBody = z.infer<typeof unsubscribePushBodySchema>;
