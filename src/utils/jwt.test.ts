import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import jwt from 'jsonwebtoken';

/**
 * Unit tests for `utils/jwt.ts` — covers the Step P0-3 multi-key
 * rotation path.
 *
 * The kid registry is populated at module load from `process.env`.
 * Each test resets `process.env`, then re-imports the modules so the
 * registry sees the test's env. `vi.resetModules()` is the
 * vitest-idiomatic way to re-evaluate the module under test with new
 * env values.
 */

const ORIGINAL_ENV = { ...process.env };

const resetEnvAndModules = (overrides: Record<string, string | undefined>): void => {
    // Wipe all JWT_* keys from the previous test, then layer overrides.
    for (const k of Object.keys(process.env)) {
        if (k.startsWith('JWT_')) delete process.env[k];
    }
    process.env.JWT_SECRET = ORIGINAL_ENV.JWT_SECRET ?? 'test-jwt-secret-legacy';
    process.env.JWT_REFRESH_SECRET = ORIGINAL_ENV.JWT_REFRESH_SECRET ?? 'test-refresh-secret-legacy';
    process.env.JWT_EXPIRES_IN = '8h';
    process.env.JWT_REFRESH_EXPIRES_IN = '5d';
    for (const [k, v] of Object.entries(overrides)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    vi.resetModules();
};

afterEach(() => {
    // Restore the original env so subsequent test files see a clean slate.
    for (const k of Object.keys(process.env)) {
        if (k.startsWith('JWT_')) delete process.env[k];
    }
    for (const [k, v] of Object.entries(ORIGINAL_ENV)) {
        if (k.startsWith('JWT_') && v !== undefined) process.env[k] = v;
    }
    vi.resetModules();
});

const samplePayload = () => ({
    user_id: '6500000000000000000000aa',
    role: 'employee' as const,
    role_keys: ['employee'],
    permissions: [],
});

// ─── Single-key mode (default / legacy) ────────────────────────────────

describe('single-key mode (no JWT_ACTIVE_KID set)', () => {
    beforeEach(() => {
        resetEnvAndModules({
            JWT_SECRET: 'legacy-secret-aaa',
            JWT_REFRESH_SECRET: 'legacy-refresh-aaa',
        });
    });

    it('issued access tokens have NO `kid` header', async () => {
        // Default deployment shape: only `JWT_SECRET` is set, no kid
        // registry, no active kid. Issued tokens must not carry a kid
        // — adding one without a configured registry would be a
        // regression that would break a future verifier that started
        // looking up kids.
        const { createAccessToken } = await import('./jwt.js');
        const { token } = createAccessToken(samplePayload());
        const decoded = jwt.decode(token, { complete: true }) as { header: { kid?: string } };
        expect(decoded.header.kid).toBeUndefined();
    });

    it('verifier accepts the legacy-signed token', async () => {
        const { createAccessToken, verifyAccessToken } = await import('./jwt.js');
        const { token } = createAccessToken(samplePayload());
        expect(() => verifyAccessToken(token)).not.toThrow();
        const out = verifyAccessToken(token);
        expect(out.user_id).toBe('6500000000000000000000aa');
    });
});

// ─── Multi-key rotation mode ───────────────────────────────────────────

describe('multi-key rotation mode (JWT_ACTIVE_KID set)', () => {
    beforeEach(() => {
        // Operator's view of mid-rotation:
        //   - `JWT_SECRET` is the legacy single-key value (kept around so
        //     pre-rotation tokens still verify).
        //   - `JWT_SECRET_v1=secret-v1` and `JWT_SECRET_v2=secret-v2` are
        //     the registered keys.
        //   - `JWT_ACTIVE_KID=v2` means new tokens are signed with v2 and
        //     carry `kid=v2` in the header.
        resetEnvAndModules({
            JWT_SECRET: 'legacy-secret-aaa',
            JWT_SECRET_v1: 'secret-v1-aaa',
            JWT_SECRET_v2: 'secret-v2-bbb',
            JWT_ACTIVE_KID: 'v2',
            JWT_REFRESH_SECRET: 'legacy-refresh-aaa',
        });
    });

    it('issued access tokens carry kid="v2" in the header', async () => {
        const { createAccessToken } = await import('./jwt.js');
        const { token } = createAccessToken(samplePayload());
        const decoded = jwt.decode(token, { complete: true }) as { header: { kid?: string } };
        expect(decoded.header.kid).toBe('v2');
    });

    it('verifier looks up kid in registry and accepts a v2-signed token', async () => {
        const { createAccessToken, verifyAccessToken } = await import('./jwt.js');
        const { token } = createAccessToken(samplePayload());
        expect(() => verifyAccessToken(token)).not.toThrow();
    });

    it('verifier accepts a v1-signed token (issued before rotation)', async () => {
        // Forge a token signed with v1 directly — simulates a JWT that
        // was issued during the previous rotation phase, where v1 was
        // active. The verifier must read the `kid` header, look up v1
        // in the registry, and accept the token.
        const { verifyAccessToken } = await import('./jwt.js');
        const oldToken = jwt.sign(samplePayload(), 'secret-v1-aaa', {
            expiresIn: '8h',
            keyid: 'v1',
        });
        expect(() => verifyAccessToken(oldToken)).not.toThrow();
    });

    it('verifier accepts a legacy token with no kid header (pre-rotation)', async () => {
        // Tokens issued before rotation started have no kid. They must
        // still verify against `JWT_SECRET` for the access-TTL window.
        const { verifyAccessToken } = await import('./jwt.js');
        const legacyToken = jwt.sign(samplePayload(), 'legacy-secret-aaa', { expiresIn: '8h' });
        expect(() => verifyAccessToken(legacyToken)).not.toThrow();
    });

    it('verifier REJECTS a token signed with the wrong secret for its declared kid', async () => {
        // Tampering attempt: forge a token with `kid=v2` but sign it
        // with the v1 secret. The verifier looks up v2 → secret-v2-bbb
        // → signature check fails → throw. The kid header alone is
        // not trusted; it's only used for the secret lookup.
        const { verifyAccessToken } = await import('./jwt.js');
        const forged = jwt.sign(samplePayload(), 'secret-v1-aaa', { expiresIn: '8h', keyid: 'v2' });
        expect(() => verifyAccessToken(forged)).toThrow();
    });

    it('verifier REJECTS an unknown kid (falls back to legacy + that fails too)', async () => {
        // A token with `kid=does-not-exist` — fall through to the
        // legacy `JWT_SECRET`, which won't match the secret used to
        // sign. Throws.
        const { verifyAccessToken } = await import('./jwt.js');
        const forged = jwt.sign(samplePayload(), 'attacker-controlled-secret', {
            expiresIn: '8h',
            keyid: 'does-not-exist',
        });
        expect(() => verifyAccessToken(forged)).toThrow();
    });
});

// ─── Boot-time validation ──────────────────────────────────────────────

describe('boot-time JWT_ACTIVE_KID validation', () => {
    it('throws when JWT_ACTIVE_KID is set but no matching JWT_SECRET_<kid> exists', async () => {
        // Operator typo'd the env: `JWT_ACTIVE_KID=v3` but no
        // `JWT_SECRET_v3`. Boot must fail loudly — silently falling
        // back to the legacy key would defeat the rotation contract.
        resetEnvAndModules({
            JWT_SECRET: 'legacy',
            JWT_SECRET_v1: 'one',
            JWT_ACTIVE_KID: 'v3',
        });
        await expect(import('../config/server.config.js')).rejects.toThrow(/JWT_ACTIVE_KID="v3"/);
    });

    it('throws when JWT_REFRESH_ACTIVE_KID is set but no matching key exists', async () => {
        resetEnvAndModules({
            JWT_SECRET: 'legacy',
            JWT_REFRESH_SECRET: 'legacy-refresh',
            JWT_REFRESH_SECRET_a: 'one',
            JWT_REFRESH_ACTIVE_KID: 'b',
        });
        await expect(import('../config/server.config.js')).rejects.toThrow(/JWT_REFRESH_ACTIVE_KID="b"/);
    });
});
