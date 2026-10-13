import { describe, expect, it } from 'vitest';

import { subscribePushBodySchema, unsubscribePushBodySchema } from './push-subscription.validator.js';

/**
 * C8 — SSRF gate on the push subscription endpoint. Pre-C8 the
 * validator was `z.string().url()` which accepted any URL (including
 * `http://169.254.169.254/...` IMDS, `http://localhost:6379/`, etc.)
 * and the dispatcher would POST to it. Hostname allowlist now restricts
 * to the four real push providers (FCM, Mozilla autopush, Apple, MS).
 */

const validBody = (endpoint: string) => ({
    endpoint,
    keys: { p256dh: 'a'.repeat(32), auth: 'b'.repeat(16) },
});

describe('subscribePushBodySchema — C8 endpoint allowlist', () => {
    it.each([
        ['https://fcm.googleapis.com/wp/abcdef'],
        ['https://android.googleapis.com/wp/abcdef'], // subdomain of googleapis.com
        ['https://updates.push.services.mozilla.com/wpush/v2/123'],
        ['https://web.push.apple.com/aBcDeF'],
        ['https://db5p.notify.windows.com/w/?token=xyz'],
    ])('accepts %s', (endpoint) => {
        const result = subscribePushBodySchema.safeParse(validBody(endpoint));
        expect(result.success, JSON.stringify(result)).toBe(true);
    });

    it.each([
        // AWS IMDS — the textbook SSRF target.
        ['http://169.254.169.254/latest/meta-data/iam/'],
        // Internal services.
        ['http://localhost:6379/'],
        ['http://127.0.0.1:9200/_cluster/health'],
        ['http://10.0.0.1/internal/'],
        // Plain HTTP even on an allowed host — push providers never use HTTP.
        ['http://fcm.googleapis.com/wp/abcdef'],
        // Look-alike hostname (suffix-without-dot bypass attempt).
        ['https://attackergoogleapis.com/wp/abcdef'],
        // Random third-party domain.
        ['https://attacker.example.com/wp/abcdef'],
    ])('rejects %s', (endpoint) => {
        const result = subscribePushBodySchema.safeParse(validBody(endpoint));
        expect(result.success).toBe(false);
    });
});

describe('unsubscribePushBodySchema — same allowlist', () => {
    it('accepts an allowed endpoint', () => {
        const result = unsubscribePushBodySchema.safeParse({
            endpoint: 'https://fcm.googleapis.com/wp/abcdef',
        });
        expect(result.success).toBe(true);
    });

    it('rejects an SSRF target', () => {
        const result = unsubscribePushBodySchema.safeParse({
            endpoint: 'http://169.254.169.254/latest/meta-data/',
        });
        expect(result.success).toBe(false);
    });
});
