import { describe, expect, it } from 'vitest';

import { hashPassword, verifyPassword } from './password.js';

/**
 * Sanity contract for the bcrypt wrapper. The actual key-derivation
 * security is bcrypt's job; here we only pin the wrapper-level
 * properties we rely on:
 *
 *   1. `hashPassword` produces a value distinct from the input
 *      (it's NOT the plaintext) and stable in shape (a bcrypt hash
 *      starts with `$2b$` / `$2a$`).
 *   2. `hashPassword` is non-deterministic — same input → different
 *      hashes (bcrypt embeds a per-call salt). A regression that made
 *      it deterministic would expose the database to rainbow-table
 *      attacks against duplicate passwords.
 *   3. `verifyPassword` accepts the matching plaintext.
 *   4. `verifyPassword` REJECTS non-matching plaintext + tampered
 *      hashes + the empty string. This is the primary guarantee the
 *      whole login surface depends on; pin it explicitly.
 */

describe('hashPassword', () => {
    it('returns a bcrypt-shaped hash, not the plaintext', async () => {
        const hash = await hashPassword('correct horse battery staple');
        expect(hash).not.toBe('correct horse battery staple');
        expect(hash).toMatch(/^\$2[aby]\$/);
        // bcrypt hashes are 60 chars.
        expect(hash).toHaveLength(60);
    });

    it('is non-deterministic — two hashes of the same input differ (per-call salt)', async () => {
        const a = await hashPassword('same-input');
        const b = await hashPassword('same-input');
        expect(a).not.toBe(b);
        // Both still verify against the source plaintext.
        await expect(verifyPassword('same-input', a)).resolves.toBe(true);
        await expect(verifyPassword('same-input', b)).resolves.toBe(true);
    });
});

describe('verifyPassword', () => {
    it('accepts the matching plaintext', async () => {
        const hash = await hashPassword('hunter2');
        await expect(verifyPassword('hunter2', hash)).resolves.toBe(true);
    });

    it('rejects a non-matching plaintext', async () => {
        const hash = await hashPassword('hunter2');
        await expect(verifyPassword('hunter3', hash)).resolves.toBe(false);
    });

    it('rejects the empty string against any hash', async () => {
        // Defensive — a regression that returned `true` for empty input
        // would let a "no password set" race condition blow open the
        // login flow.
        const hash = await hashPassword('hunter2');
        await expect(verifyPassword('', hash)).resolves.toBe(false);
    });

    it('rejects when the hash is tampered (e.g. truncated)', async () => {
        const hash = await hashPassword('hunter2');
        const tampered = hash.slice(0, -3) + 'AAA';
        await expect(verifyPassword('hunter2', tampered)).resolves.toBe(false);
    });

    it('is case-sensitive', async () => {
        const hash = await hashPassword('Hunter2');
        await expect(verifyPassword('hunter2', hash)).resolves.toBe(false);
        await expect(verifyPassword('Hunter2', hash)).resolves.toBe(true);
    });
});
