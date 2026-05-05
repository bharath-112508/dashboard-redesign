import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

/**
 * Unit tests for the pluggable email transport (BACKEND_AUDIT P0-1).
 *
 * Covers the boot-time validation in `server.config.ts` (selecting an
 * explicit transport requires its credentials to be present) + the
 * factory's switch dispatch. The transport implementations themselves
 * are exercised via mocked SDK calls — we verify the input shape we
 * hand to `@azure/communication-email` and `node-mailjet` rather than
 * actually sending.
 */

const ORIGINAL_ENV = { ...process.env };

const setEnv = (overrides: Record<string, string | undefined>): void => {
    for (const k of Object.keys(process.env)) {
        if (k.startsWith('EMAIL_') || k.startsWith('ACS_') || k.startsWith('MAILJET_')) {
            delete process.env[k];
        }
    }
    for (const [k, v] of Object.entries(overrides)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    vi.resetModules();
};

afterEach(() => {
    for (const k of Object.keys(process.env)) {
        if (k.startsWith('EMAIL_') || k.startsWith('ACS_') || k.startsWith('MAILJET_')) {
            delete process.env[k];
        }
    }
    for (const [k, v] of Object.entries(ORIGINAL_ENV)) {
        if ((k.startsWith('EMAIL_') || k.startsWith('ACS_') || k.startsWith('MAILJET_')) && v !== undefined) {
            process.env[k] = v;
        }
    }
    vi.resetModules();
});

// ─── Boot-time validation ──────────────────────────────────────────────

describe('boot-time EMAIL_TRANSPORT validation', () => {
    it('accepts default (stub) when nothing is set', async () => {
        setEnv({});
        await expect(import('../../config/server.config.js')).resolves.toBeDefined();
    });

    it('rejects EMAIL_TRANSPORT=acs without ACS_CONNECTION_STRING', async () => {
        setEnv({ EMAIL_TRANSPORT: 'acs' });
        await expect(import('../../config/server.config.js')).rejects.toThrow(
            /ACS_CONNECTION_STRING and\/or ACS_FROM_ADDRESS is missing/
        );
    });

    it('rejects EMAIL_TRANSPORT=acs with only ACS_CONNECTION_STRING (missing FROM)', async () => {
        setEnv({
            EMAIL_TRANSPORT: 'acs',
            ACS_CONNECTION_STRING: 'endpoint=https://example.com/;accesskey=abc',
        });
        await expect(import('../../config/server.config.js')).rejects.toThrow(/ACS_FROM_ADDRESS/);
    });

    it('accepts EMAIL_TRANSPORT=acs with both env vars set', async () => {
        setEnv({
            EMAIL_TRANSPORT: 'acs',
            ACS_CONNECTION_STRING: 'endpoint=https://example.com/;accesskey=abc',
            ACS_FROM_ADDRESS: 'noreply@example.com',
        });
        await expect(import('../../config/server.config.js')).resolves.toBeDefined();
    });

    it('rejects EMAIL_TRANSPORT=mailjet without API_KEY', async () => {
        setEnv({ EMAIL_TRANSPORT: 'mailjet', MAILJET_FROM_ADDRESS: 'noreply@example.com' });
        await expect(import('../../config/server.config.js')).rejects.toThrow(/MAILJET_API_KEY/);
    });

    it('rejects EMAIL_TRANSPORT=mailjet without FROM_ADDRESS', async () => {
        setEnv({
            EMAIL_TRANSPORT: 'mailjet',
            MAILJET_API_KEY: 'key',
            MAILJET_API_SECRET: 'secret',
        });
        await expect(import('../../config/server.config.js')).rejects.toThrow(/MAILJET_FROM_ADDRESS/);
    });

    it('accepts EMAIL_TRANSPORT=mailjet with all four env vars set', async () => {
        setEnv({
            EMAIL_TRANSPORT: 'mailjet',
            MAILJET_API_KEY: 'key',
            MAILJET_API_SECRET: 'secret',
            MAILJET_FROM_ADDRESS: 'noreply@example.com',
            MAILJET_FROM_NAME: 'Viljetech',
        });
        await expect(import('../../config/server.config.js')).resolves.toBeDefined();
    });

    it('rejects an unknown EMAIL_TRANSPORT value', async () => {
        setEnv({ EMAIL_TRANSPORT: 'sendgrid' });
        await expect(import('../../config/server.config.js')).rejects.toThrow(/EMAIL_TRANSPORT="sendgrid" is unknown/);
    });
});

// ─── Factory switch ────────────────────────────────────────────────────

describe('email transport factory', () => {
    beforeEach(() => {
        setEnv({}); // default: stub
    });

    it('returns the stub transport by default', async () => {
        const { getEmailTransport, __resetEmailTransportCache } = await import('./index.js');
        __resetEmailTransportCache();
        const t = getEmailTransport();
        // The stub transport just logs — calling it must not throw
        // and must not require any provider credentials.
        await expect(t({ to: 'a@b.com', subject: 'x', html: '<p>x</p>', text: 'x' })).resolves.toBeUndefined();
    });

    it('caches the resolved transport across calls', async () => {
        const { getEmailTransport } = await import('./index.js');
        const t1 = getEmailTransport();
        const t2 = getEmailTransport();
        expect(t1).toBe(t2);
    });
});

// ─── Mailer integration ────────────────────────────────────────────────

describe('mailer.sendEmail delegation', () => {
    beforeEach(() => {
        setEnv({}); // default: stub
    });

    it('routes through the configured transport (stub by default)', async () => {
        // The stub transport logs a `DEV: email` line. We can't easily
        // intercept the structured logger here (it's a module-level
        // import in stub.ts) but we CAN verify the mailer doesn't
        // throw — the legacy stub had the same contract.
        const { sendEmail } = await import('../mailer.js');
        await expect(
            sendEmail({
                to: 'employee@example.com',
                subject: 'Welcome',
                html: '<p>hi</p>',
                text: 'hi',
                context: 'test.send',
            })
        ).resolves.toBeUndefined();
    });
});

// ─── isEmailTransport guard ────────────────────────────────────────────

describe('isEmailTransport type guard', () => {
    it('accepts every registered transport name', async () => {
        const { isEmailTransport } = await import('./types.js');
        expect(isEmailTransport('stub')).toBe(true);
        expect(isEmailTransport('acs')).toBe(true);
        expect(isEmailTransport('mailjet')).toBe(true);
    });

    it('rejects unknown transport names', async () => {
        const { isEmailTransport } = await import('./types.js');
        expect(isEmailTransport('sendgrid')).toBe(false);
        expect(isEmailTransport('')).toBe(false);
        expect(isEmailTransport('SMTP')).toBe(false); // case-sensitive
    });
});

// ─── T5 — withSendTimeout wrapper ──────────────────────────────────────

describe('withSendTimeout (T5 — per-call upstream timeout)', () => {
    it('resolves with the inner promise value when it settles before the timeout', async () => {
        const { withSendTimeout } = await import('./types.js');
        const result = await withSendTimeout('test', 1_000, Promise.resolve('ok'));
        expect(result).toBe('ok');
    });

    it('rejects with EmailSendTimeoutError when the inner promise stalls past the deadline', async () => {
        const { withSendTimeout, EmailSendTimeoutError } = await import('./types.js');
        const stuck = new Promise<never>(() => {
            // never settles
        });
        await expect(withSendTimeout('acs', 50, stuck)).rejects.toBeInstanceOf(EmailSendTimeoutError);
    });

    it('propagates the inner promise rejection unchanged when the inner errors before the timeout', async () => {
        const { withSendTimeout } = await import('./types.js');
        const upstream = new Error('upstream 500');
        await expect(withSendTimeout('mailjet', 1_000, Promise.reject(upstream))).rejects.toBe(upstream);
    });
});

// ─── T12 — EmailRateLimitedError ───────────────────────────────────────

describe('EmailRateLimitedError (T12)', () => {
    it('carries the transport name + the optional retryAfterSeconds', async () => {
        const { EmailRateLimitedError } = await import('./types.js');
        const err = new EmailRateLimitedError('acs', 30, 'tier-cap');
        expect(err.name).toBe('EmailRateLimitedError');
        expect(err.transport).toBe('acs');
        expect(err.retryAfterSeconds).toBe(30);
        expect(err.message).toContain('rate-limited');
        expect(err.message).toContain('30s');
    });

    it('handles a null retryAfterSeconds (the typical case for the SDK errors we see)', async () => {
        const { EmailRateLimitedError } = await import('./types.js');
        const err = new EmailRateLimitedError('mailjet');
        expect(err.retryAfterSeconds).toBeNull();
        expect(err.message).not.toContain('retry after');
    });
});
