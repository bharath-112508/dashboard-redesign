import { describe, expect, it, vi, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';

/**
 * Pins the contract for `crypto-aes.ts` after R16 — kid-based key
 * rotation for MFA secret-at-rest encryption.
 *
 * Pattern mirrors `jwt.test.ts` / `mfa-session.test.ts`: each test
 * resets `process.env`, then re-imports the module so the registry
 * sees the test's env.
 */

const ORIGINAL_ENV = { ...process.env };

const newKey = (): string => randomBytes(32).toString('base64');

const resetEnvAndModules = (overrides: Record<string, string | undefined>): void => {
    for (const k of Object.keys(process.env)) {
        if (k.startsWith('MFA_ENCRYPTION_')) delete process.env[k];
    }
    process.env.MFA_ENCRYPTION_KEY = ORIGINAL_ENV.MFA_ENCRYPTION_KEY ?? newKey();
    for (const [k, v] of Object.entries(overrides)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    vi.resetModules();
};

afterEach(() => {
    for (const k of Object.keys(process.env)) {
        if (k.startsWith('MFA_ENCRYPTION_')) delete process.env[k];
    }
    for (const [k, v] of Object.entries(ORIGINAL_ENV)) {
        if (k.startsWith('MFA_ENCRYPTION_') && v !== undefined) process.env[k] = v;
    }
    vi.resetModules();
});

describe('single-key (legacy) mode', () => {
    it('encrypted blob has NO kid prefix; round-trips through decrypt', async () => {
        resetEnvAndModules({});
        const { encryptSecret, decryptSecret } = await import('./crypto-aes.js');

        const blob = encryptSecret('secret-totp-seed');

        expect(blob.startsWith('kid:')).toBe(false);
        // Three base64url segments separated by dots: iv.ct.tag.
        expect(blob.split('.')).toHaveLength(3);
        expect(decryptSecret(blob)).toBe('secret-totp-seed');
    });
});

describe('multi-key rotation mode', () => {
    const v1 = newKey();
    const v2 = newKey();

    it('encrypted blob carries `kid:v2:` prefix when active kid is set', async () => {
        resetEnvAndModules({
            MFA_ENCRYPTION_KEY_v1: v1,
            MFA_ENCRYPTION_KEY_v2: v2,
            MFA_ENCRYPTION_ACTIVE_KID: 'v2',
        });
        const { encryptSecret } = await import('./crypto-aes.js');

        const blob = encryptSecret('secret');

        expect(blob.startsWith('kid:v2:')).toBe(true);
    });

    it('decrypts a v2-stamped blob via the registry lookup', async () => {
        resetEnvAndModules({
            MFA_ENCRYPTION_KEY_v1: v1,
            MFA_ENCRYPTION_KEY_v2: v2,
            MFA_ENCRYPTION_ACTIVE_KID: 'v2',
        });
        const { encryptSecret, decryptSecret } = await import('./crypto-aes.js');

        const blob = encryptSecret('round-trip-me');
        expect(decryptSecret(blob)).toBe('round-trip-me');
    });

    it('decrypts a v1-stamped blob (issued before rotation made v2 active)', async () => {
        // Encrypt with v1 active, then re-import with v2 active and decrypt the v1 blob.
        resetEnvAndModules({
            MFA_ENCRYPTION_KEY_v1: v1,
            MFA_ENCRYPTION_ACTIVE_KID: 'v1',
        });
        const { encryptSecret: encV1 } = await import('./crypto-aes.js');
        const v1Blob = encV1('pre-rotation');
        expect(v1Blob.startsWith('kid:v1:')).toBe(true);

        resetEnvAndModules({
            MFA_ENCRYPTION_KEY_v1: v1,
            MFA_ENCRYPTION_KEY_v2: v2,
            MFA_ENCRYPTION_ACTIVE_KID: 'v2',
        });
        const { decryptSecret: decV2 } = await import('./crypto-aes.js');
        expect(decV2(v1Blob)).toBe('pre-rotation');
    });

    it('decrypts a legacy (no-kid) blob via the legacy MFA_ENCRYPTION_KEY fallback', async () => {
        // Issue under legacy mode, then add rotation env and decrypt — the
        // rotation period must verify both shapes.
        const legacyKey = newKey();
        resetEnvAndModules({ MFA_ENCRYPTION_KEY: legacyKey });
        const { encryptSecret: encLegacy } = await import('./crypto-aes.js');
        const legacyBlob = encLegacy('legacy-data');
        expect(legacyBlob.startsWith('kid:')).toBe(false);

        resetEnvAndModules({
            MFA_ENCRYPTION_KEY: legacyKey,
            MFA_ENCRYPTION_KEY_v2: v2,
            MFA_ENCRYPTION_ACTIVE_KID: 'v2',
        });
        const { decryptSecret: decRot } = await import('./crypto-aes.js');
        expect(decRot(legacyBlob)).toBe('legacy-data');
    });

    it('REJECTS a blob whose kid is not in the registry', async () => {
        resetEnvAndModules({
            MFA_ENCRYPTION_KEY_v1: v1,
            MFA_ENCRYPTION_ACTIVE_KID: 'v1',
        });
        const { decryptSecret } = await import('./crypto-aes.js');

        // Synthesise a blob that claims kid=v3 but isn't registered.
        const fake = 'kid:v3:abc.def.ghi';
        expect(() => decryptSecret(fake)).toThrow(/Unknown MFA encryption kid "v3"/);
    });

    it('REJECTS a malformed kid-prefixed blob', async () => {
        resetEnvAndModules({});
        const { decryptSecret } = await import('./crypto-aes.js');

        // `kid:` followed by no separator should throw the malformed error.
        expect(() => decryptSecret('kid:noseparator')).toThrow(/Malformed encrypted blob/);
    });
});

describe('boot-time MFA_ENCRYPTION_ACTIVE_KID validation', () => {
    it('throws when MFA_ENCRYPTION_ACTIVE_KID names a kid not in the registry', async () => {
        resetEnvAndModules({
            MFA_ENCRYPTION_KEY_v1: newKey(),
            MFA_ENCRYPTION_ACTIVE_KID: 'v3',
        });
        await expect(import('../config/server.config.js')).rejects.toThrow(/MFA_ENCRYPTION_ACTIVE_KID="v3"/);
    });
});
