import { describe, expect, it } from 'vitest';

import { buildCheckInUrl, generateQrToken, renderCheckInQrDataUrl } from './office-location-qr.js';

/**
 * Coverage focus for the QR primitives — the security-relevant pieces
 * driving attendance check-in eligibility:
 *
 *   1. `generateQrToken` produces a base64url string of expected
 *      entropy (24 raw bytes → 32 chars). The token is the secret
 *      that authorises check-in; pin its shape so a regression that
 *      shrunk it to 8 chars (3.4 trillion → 3 billion guesses) would
 *      surface immediately.
 *   2. Tokens are non-deterministic — two consecutive calls produce
 *      different values. A regression to a deterministic source
 *      would trivially break the rotation contract.
 *   3. `buildCheckInUrl` URL-encodes the token (defence: a token
 *      containing `&` or `=` would otherwise inject query parameters).
 *   4. `renderCheckInQrDataUrl` produces a renderable PNG data URL.
 */

describe('generateQrToken', () => {
    it('returns a 32-char base64url string (24 raw bytes → 192 bits of entropy)', () => {
        const token = generateQrToken();
        expect(typeof token).toBe('string');
        expect(token).toHaveLength(32);
        // base64url charset: A-Z, a-z, 0-9, -, _ (NO padding `=`).
        expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    });

    it('is non-deterministic — two consecutive calls produce different tokens', () => {
        // 192 bits of entropy → collision probability vanishing. A regression
        // that wired this to a counter or a constant would trivially make
        // the rotation contract break (every QR rotation would mint the
        // same value).
        const a = generateQrToken();
        const b = generateQrToken();
        expect(a).not.toBe(b);
    });
});

describe('buildCheckInUrl', () => {
    it('embeds the token in a `?token=` query param', () => {
        const url = buildCheckInUrl('SAFE-TOKEN-1234567890');
        expect(url).toContain('?token=SAFE-TOKEN-1234567890');
    });

    it('URL-encodes special characters in the token (defence against query-string injection)', () => {
        // A token containing `&` or `=` could otherwise inject a second
        // query param — the encoder takes that off the table. Pin it so
        // a regression that switched to raw concatenation surfaces.
        const url = buildCheckInUrl('foo&bar=baz');
        expect(url).toContain('foo%26bar%3Dbaz');
        expect(url).not.toContain('foo&bar=baz');
    });
});

describe('renderCheckInQrDataUrl', () => {
    it('renders the URL as a PNG data URL', async () => {
        const dataUrl = await renderCheckInQrDataUrl('AnyTokenValue123');
        expect(dataUrl.startsWith('data:image/png;base64,')).toBe(true);
        // Sanity: the image is non-trivial (more than just the prefix).
        expect(dataUrl.length).toBeGreaterThan(100);
    });
});
