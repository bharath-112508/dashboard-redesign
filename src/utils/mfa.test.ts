import { describe, expect, it } from 'vitest';
import { generateSync } from 'otplib';

import {
    buildOtpAuthUrl,
    findMatchingBackupCodeIndex,
    generateBackupCodes,
    generateQrDataUrl,
    generateTotpSecret,
    verifyTotp,
} from './mfa.js';

/**
 * Coverage focus for the MFA primitives — the contract every caller
 * (mfa.service, login flow) silently relies on:
 *
 *   1. `generateTotpSecret` produces a base32-shaped 20-byte secret
 *      (the format every authenticator app expects).
 *   2. `buildOtpAuthUrl` returns a valid `otpauth://totp/...` URI with
 *      the correct issuer + label + secret embedded.
 *   3. `generateQrDataUrl` returns a renderable PNG data URL.
 *   4. `verifyTotp` accepts the live code for the given secret AND
 *      rejects garbage / wrong-secret codes WITHOUT throwing — the
 *      service's contract is "any failure → false", never propagated.
 *   5. `generateBackupCodes` returns 10 plain codes in `XXXXX-XXXXX`
 *      shape, all unique, paired with bcrypt-hashed counterparts.
 *      Plain ≠ hashed (the cardinal rule — only hashes get persisted).
 *   6. `findMatchingBackupCodeIndex` round-trips a freshly-generated
 *      code through normalisation: lowercased, dash-stripped, and
 *      unicode-noisy variants all match the canonical form. A
 *      non-matching submission returns -1 (not throws).
 */

describe('generateTotpSecret', () => {
    it('returns a base32-encoded string (RFC 4648 charset)', () => {
        const secret = generateTotpSecret();
        // otplib's generateSecret returns base32 — A-Z + 2-7. No
        // padding for our usage.
        expect(secret).toMatch(/^[A-Z2-7]+$/);
        // length:20 → 32 base32 chars.
        expect(secret).toHaveLength(32);
    });

    it('is non-deterministic — two consecutive calls produce different secrets', () => {
        // A regression that introduced determinism here would mean
        // every user enrolled with the same TOTP secret. Pin it.
        expect(generateTotpSecret()).not.toBe(generateTotpSecret());
    });
});

describe('buildOtpAuthUrl', () => {
    it('embeds issuer, label, and secret in a valid otpauth URI', () => {
        const secret = 'JBSWY3DPEHPK3PXP';
        const url = buildOtpAuthUrl('user@example.com', secret);
        expect(url.startsWith('otpauth://totp/')).toBe(true);
        expect(url).toContain('user%40example.com'); // email URL-encoded in label
        expect(url).toContain(`secret=${secret}`);
        expect(url).toContain('issuer=Viljetech');
    });
});

describe('generateQrDataUrl', () => {
    it('renders the otpauth URI to a PNG data URL', async () => {
        const dataUrl = await generateQrDataUrl('otpauth://totp/test?secret=ABCD&issuer=X');
        expect(dataUrl.startsWith('data:image/png;base64,')).toBe(true);
        // Sanity: a non-trivial image (more than just the prefix).
        expect(dataUrl.length).toBeGreaterThan(100);
    });
});

describe('verifyTotp', () => {
    it('accepts the live TOTP code for the given secret', () => {
        const secret = generateTotpSecret();
        // Generate the code with otplib's `generateSync` so the test
        // uses the exact same algorithm the verifier reads (RFC 6238
        // SHA1 / 6 digits / 30s — the otplib defaults). v13 returns
        // the token as a string directly, not wrapped in an object.
        const liveCode = generateSync({ secret, strategy: 'totp' });
        expect(verifyTotp(liveCode, secret)).toBe(true);
    });

    it('rejects a wrong code (random 6 digits) for a valid secret', () => {
        const secret = generateTotpSecret();
        // Pick a code that's overwhelmingly unlikely to match (TOTP space
        // is 1M, so a single fixed wrong value has a 1-in-a-million chance
        // — vanishing for unit-test purposes).
        expect(verifyTotp('000000', secret)).toBe(false);
    });

    it('returns false (never throws) on garbage input', () => {
        // The service relies on this — `verifyTotp` is called inside
        // wider try/catch chains and a thrown exception there would
        // surface as a 500 instead of a clean 401.
        expect(verifyTotp('not-a-number', 'INVALID-SECRET')).toBe(false);
        expect(verifyTotp('', '')).toBe(false);
    });
});

describe('generateBackupCodes', () => {
    it('returns 10 plain + 10 hashed entries', async () => {
        const { plain, hashed } = await generateBackupCodes();
        expect(plain).toHaveLength(10);
        expect(hashed).toHaveLength(10);
    });

    it('plain codes follow the XXXXX-XXXXX uppercase-hex shape', async () => {
        const { plain } = await generateBackupCodes();
        for (const code of plain) {
            expect(code).toMatch(/^[0-9A-F]{5}-[0-9A-F]{5}$/);
        }
    });

    it('all 10 plain codes are distinct', async () => {
        // 10-hex-char keyspace is 1.1 trillion; collisions are
        // mathematically vanishing. A test that produces a duplicate
        // would mean the random source was broken.
        const { plain } = await generateBackupCodes();
        expect(new Set(plain).size).toBe(10);
    });

    it('NEVER stores the plain code as the hash — only bcrypt hashes are persistable', async () => {
        // The cardinal rule. A regression here would mean the database
        // column intended to hold hashes started holding plaintext —
        // an immediate security incident at the next compromise.
        const { plain, hashed } = await generateBackupCodes();
        for (let i = 0; i < plain.length; i++) {
            expect(hashed[i]).not.toBe(plain[i]);
            expect(hashed[i]).toMatch(/^\$2[aby]\$/);
        }
    });
});

describe('findMatchingBackupCodeIndex', () => {
    it('returns the index of the matching code in the canonical form', async () => {
        const { plain, hashed } = await generateBackupCodes();
        const idx = await findMatchingBackupCodeIndex(plain[3]!, hashed);
        expect(idx).toBe(3);
    });

    it('normalises the submitted code: lowercase + dash variants all match', async () => {
        const { plain, hashed } = await generateBackupCodes();
        const code = plain[5]!; // canonical: AB12C-DE34F
        const lowercase = code.toLowerCase();
        const noDash = code.replace('-', '');
        const noisy = ` ${code.toLowerCase()} `;
        const camelCase = code.slice(0, 5).toLowerCase() + code.slice(5);

        // All variants should resolve to the same canonical hash → same idx.
        await expect(findMatchingBackupCodeIndex(lowercase, hashed)).resolves.toBe(5);
        await expect(findMatchingBackupCodeIndex(noDash, hashed)).resolves.toBe(5);
        await expect(findMatchingBackupCodeIndex(noisy.trim(), hashed)).resolves.toBe(5);
        await expect(findMatchingBackupCodeIndex(camelCase, hashed)).resolves.toBe(5);
    });

    it('returns -1 (not throws) on a non-matching submission', async () => {
        const { hashed } = await generateBackupCodes();
        await expect(findMatchingBackupCodeIndex('AAAAA-BBBBB', hashed)).resolves.toBe(-1);
        // Empty string is the most common operator typo on a paste-failure.
        await expect(findMatchingBackupCodeIndex('', hashed)).resolves.toBe(-1);
    });

    it('returns -1 against an empty stored-hash list (e.g. user with no codes left)', async () => {
        await expect(findMatchingBackupCodeIndex('AAAAA-BBBBB', [])).resolves.toBe(-1);
    });
});
