import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import jwt from 'jsonwebtoken';

/**
 * Tests for `utils/mfa-session.ts` — pins the R2 contract that
 * MFA-session JWTs go through the same `kid` registry as access tokens
 * so a key rotation is also graceful for in-flight MFA challenges.
 *
 * Pattern mirrors `jwt.test.ts`: each test resets `process.env`, then
 * re-imports the modules so the registry sees the test's env.
 */

// Mock the JTI-replay model — `vi.resetModules()` in this test would
// otherwise try to re-register the Mongoose model and crash with
// `OverwriteModelError`. The token-rotation tests don't exercise the
// JTI consume path; replay-guard behaviour has its own dedicated
// suite in `mfa-session-replay.test.ts`.
vi.mock('../models/mfa-session-used-jti.model.js', () => ({
    MfaSessionUsedJti: { create: vi.fn() },
}));

const ORIGINAL_ENV = { ...process.env };

const resetEnvAndModules = (overrides: Record<string, string | undefined>): void => {
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
    for (const k of Object.keys(process.env)) {
        if (k.startsWith('JWT_')) delete process.env[k];
    }
    for (const [k, v] of Object.entries(ORIGINAL_ENV)) {
        if (k.startsWith('JWT_') && v !== undefined) process.env[k] = v;
    }
    vi.resetModules();
});

describe('MFA-session JWT — single-key (legacy) mode', () => {
    beforeEach(() => {
        resetEnvAndModules({
            JWT_SECRET: 'legacy-secret-aaa',
        });
    });

    it('issued tokens have NO kid header (legacy mode)', async () => {
        const { issueMfaSession } = await import('./mfa-session.js');
        const { token } = issueMfaSession('user-1');
        const decoded = jwt.decode(token, { complete: true }) as { header: { kid?: string } };
        expect(decoded.header.kid).toBeUndefined();
    });

    it('verifier accepts the legacy-signed token', async () => {
        const { issueMfaSession, verifyMfaSession } = await import('./mfa-session.js');
        const { token } = issueMfaSession('user-1');
        const out = verifyMfaSession(token);
        expect(out.user_id).toBe('user-1');
        expect(out.type).toBe('mfa_session');
        expect(out.jti).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    });
});

describe('MFA-session JWT — multi-key rotation mode', () => {
    beforeEach(() => {
        resetEnvAndModules({
            JWT_SECRET: 'legacy-secret-aaa',
            JWT_SECRET_v1: 'secret-v1-aaa',
            JWT_SECRET_v2: 'secret-v2-bbb',
            JWT_ACTIVE_KID: 'v2',
        });
    });

    it('issued tokens carry kid="v2" in the header', async () => {
        const { issueMfaSession } = await import('./mfa-session.js');
        const { token } = issueMfaSession('user-1');
        const decoded = jwt.decode(token, { complete: true }) as { header: { kid?: string } };
        expect(decoded.header.kid).toBe('v2');
    });

    it('verifier accepts a v2-signed MFA token', async () => {
        const { issueMfaSession, verifyMfaSession } = await import('./mfa-session.js');
        const { token } = issueMfaSession('user-1');
        expect(() => verifyMfaSession(token)).not.toThrow();
    });

    it('verifier accepts a v1-signed MFA token (issued before rotation)', async () => {
        const { verifyMfaSession } = await import('./mfa-session.js');
        const oldToken = jwt.sign({ user_id: 'user-1', type: 'mfa_session', jti: '01HXX' }, 'secret-v1-aaa', {
            expiresIn: '5m',
            keyid: 'v1',
        });
        expect(() => verifyMfaSession(oldToken)).not.toThrow();
    });

    it('verifier accepts a legacy MFA token with no kid header (pre-rotation)', async () => {
        const { verifyMfaSession } = await import('./mfa-session.js');
        const legacyToken = jwt.sign({ user_id: 'user-1', type: 'mfa_session', jti: '01HXX' }, 'legacy-secret-aaa', {
            expiresIn: '5m',
        });
        expect(() => verifyMfaSession(legacyToken)).not.toThrow();
    });

    it('verifier REJECTS a token signed with the wrong secret for its declared kid', async () => {
        const { verifyMfaSession } = await import('./mfa-session.js');
        const forged = jwt.sign({ user_id: 'user-1', type: 'mfa_session', jti: '01HXX' }, 'secret-v1-aaa', {
            expiresIn: '5m',
            keyid: 'v2',
        });
        expect(() => verifyMfaSession(forged)).toThrow();
    });

    it('verifier REJECTS a token whose `type` claim is wrong (cross-token-type defence)', async () => {
        // Tampering: an attacker substitutes an access token's payload
        // shape into the MFA verify endpoint. The type guard catches it.
        const { verifyMfaSession } = await import('./mfa-session.js');
        const accessShaped = jwt.sign(
            { user_id: 'user-1', role: 'admin', role_keys: [], permissions: [] },
            'legacy-secret-aaa',
            { expiresIn: '5m' }
        );
        expect(() => verifyMfaSession(accessShaped)).toThrow(/Not an MFA session token/);
    });
});
