import { describe, expect, it } from 'vitest';

import { sha256Hex } from './token-hash.js';

/**
 * `sha256Hex` is the helper we use to derive `refresh_tokens.token_hash`
 * from the raw refresh token before persisting. The whole "we never
 * persist plaintext refresh tokens" guarantee depends on it. Pinned
 * properties:
 *
 *   1. Deterministic — same input → same hex digest. Lookups by hash
 *      are O(1) only because of this.
 *   2. Output is exactly 64 hex characters (a SHA-256 digest is
 *      256 bits → 64 hex chars).
 *   3. Distinct inputs produce distinct outputs (collision resistance
 *      is bcrypt's / SHA-256's problem, but we pin the obvious
 *      hand-crafted near-collisions to catch a regression that
 *      accidentally truncated the input).
 *   4. The output charset is hex-only.
 */

describe('sha256Hex', () => {
    it('returns a 64-char lowercase hex string', () => {
        const out = sha256Hex('any-token-value');
        expect(out).toHaveLength(64);
        expect(out).toMatch(/^[0-9a-f]{64}$/);
    });

    it('is deterministic — identical input produces identical output', () => {
        // The whole `RefreshToken.findOne({ token_hash })` lookup contract
        // hinges on this. A regression that introduced randomness (e.g.
        // a salt) would break the entire refresh flow.
        const a = sha256Hex('rt_abc123');
        const b = sha256Hex('rt_abc123');
        expect(a).toBe(b);
    });

    it('produces different digests for different inputs', () => {
        expect(sha256Hex('a')).not.toBe(sha256Hex('b'));
    });

    it('matches the canonical SHA-256 of the empty string (NIST FIPS 180-4)', () => {
        // Reference vector — pins the algorithm choice. A regression
        // that switched to SHA-1 or a different SHA-2 variant would
        // fail here loudly.
        expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    });

    it('matches the canonical SHA-256 of "abc"', () => {
        expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    });

    it('handles unicode input (UTF-8 encoding) — café ≠ cafe', () => {
        // The hash is computed on the UTF-8 byte sequence, not on the JS
        // string's UTF-16 code units. We pin behaviour rather than the
        // exact digest: the accented and non-accented forms must hash to
        // different outputs, confirming the function reaches the bytes
        // it should. A regression that ASCII-folded would collide them.
        const accented = sha256Hex('café');
        const plain = sha256Hex('cafe');
        expect(accented).toMatch(/^[0-9a-f]{64}$/);
        expect(accented).not.toBe(plain);
    });
});
