import { describe, expect, it, vi } from 'vitest';

import {
    authRateLimiter,
    buildUserRateLimiter,
    exportRateLimiter,
    generalRateLimiter,
    reportReadRateLimiter,
    searchRateLimiter,
} from './rate-limit.middleware.js';

/**
 * Coverage focus for the rate-limit module — pinned via observable
 * behaviour (the limiter as a black-box middleware) rather than
 * introspecting the underlying `express-rate-limit` internals, which
 * change between minor versions.
 *
 * What we lock in:
 *   1. Every exported limiter is a working middleware function.
 *   2. `buildUserRateLimiter` produces per-user buckets — two different
 *      `req.user.user_id` values get independent budgets even from the
 *      same IP (P2-9 — the whole reason this factory exists). And a
 *      single user from two different IPs shares one bucket (the
 *      mirror property — credential-rotation-evasion defence).
 *   3. The fallback to IP-based key on an unauthenticated request
 *      doesn't crash the middleware. Any route that runs the limiter
 *      before `authenticate` (a future bug) must still get a 200/429,
 *      never a 500.
 *   4. Hitting the limit returns 429 with a JSON body shaped for the
 *      FE's "rate limited" toast (`message` key).
 */

const makeRes = () => {
    const res: Record<string, unknown> & {
        statusCode: number;
        headersSent: boolean;
        setHeader: ReturnType<typeof vi.fn>;
        getHeader: ReturnType<typeof vi.fn>;
        removeHeader: ReturnType<typeof vi.fn>;
        end: ReturnType<typeof vi.fn>;
        send: ReturnType<typeof vi.fn>;
        status: ReturnType<typeof vi.fn>;
        json: ReturnType<typeof vi.fn>;
        writeHead: ReturnType<typeof vi.fn>;
    } = {
        statusCode: 200,
        headersSent: false,
        setHeader: vi.fn(),
        getHeader: vi.fn(),
        removeHeader: vi.fn(),
        end: vi.fn(),
        send: vi.fn(),
        status: vi.fn(function (this: { statusCode: number }, code: number) {
            this.statusCode = code;
            return this;
        }),
        json: vi.fn(),
        writeHead: vi.fn(),
    };
    return res;
};

const callLimiter = async (
    limiter: ReturnType<typeof buildUserRateLimiter>,
    req: Record<string, unknown>
): Promise<{ statusCode: number; nextCalled: boolean; sendArg: unknown }> => {
    const next = vi.fn();
    const res = makeRes();
    await limiter(req as never, res as never, next);
    return {
        statusCode: res.statusCode,
        nextCalled: next.mock.calls.length > 0,
        sendArg: res.send.mock.calls[0]?.[0],
    };
};

describe('exported limiters', () => {
    it('every limiter is an Express-style middleware function', () => {
        const limiters = [
            generalRateLimiter,
            authRateLimiter,
            reportReadRateLimiter,
            exportRateLimiter,
            searchRateLimiter,
        ];
        for (const lim of limiters) {
            expect(typeof lim).toBe('function');
            expect(lim.length).toBeGreaterThanOrEqual(3);
        }
    });
});

describe('buildUserRateLimiter — per-user bucketing (P2-9)', () => {
    it('two different users from the SAME IP get independent budgets', async () => {
        const limiter = buildUserRateLimiter({ windowMs: 60_000, limit: 1, messageKey: 'too many' });

        // User A — first call hits, second call 429s.
        const reqA = { user: { user_id: 'user-a' }, ip: '10.0.0.1', method: 'GET', headers: {} };
        const a1 = await callLimiter(limiter, reqA);
        const a2 = await callLimiter(limiter, reqA);
        expect(a1.nextCalled).toBe(true);
        expect(a1.statusCode).toBe(200);
        expect(a2.nextCalled).toBe(false);
        expect(a2.statusCode).toBe(429);

        // User B from THE SAME IP — must still get a fresh budget. If
        // bucketing was IP-based, B's first call would 429.
        const reqB = { user: { user_id: 'user-b' }, ip: '10.0.0.1', method: 'GET', headers: {} };
        const b1 = await callLimiter(limiter, reqB);
        expect(b1.nextCalled).toBe(true);
        expect(b1.statusCode).toBe(200);
    });

    it('the SAME user from two DIFFERENT IPs shares one bucket (proxy-rotation evasion)', async () => {
        // The mirror property — pre-P2-9 a logged-in attacker could
        // rotate residential proxies to evade the per-IP cap. Per-user
        // bucketing closes that hole.
        const limiter = buildUserRateLimiter({ windowMs: 60_000, limit: 1, messageKey: 'too many' });

        const fromIpA = { user: { user_id: 'shared-user' }, ip: '10.0.0.1', method: 'GET', headers: {} };
        const fromIpB = { user: { user_id: 'shared-user' }, ip: '10.0.0.99', method: 'GET', headers: {} };

        const r1 = await callLimiter(limiter, fromIpA);
        expect(r1.nextCalled).toBe(true);
        const r2 = await callLimiter(limiter, fromIpB);
        // Same user_id → same bucket → second call 429s regardless of IP.
        expect(r2.statusCode).toBe(429);
        expect(r2.nextCalled).toBe(false);
    });
});

describe('buildUserRateLimiter — anonymous fallback', () => {
    it('falls back to IP-keyed bucket without throwing when req.user is absent', async () => {
        // Defensive — a misconfigured route mount that runs the limiter
        // before `authenticate` must not crash. Pin that the middleware
        // resolves a key (200 or 429) and never throws / 500s.
        const limiter = buildUserRateLimiter({ windowMs: 60_000, limit: 1, messageKey: 'too many' });

        const anon = { ip: '192.168.1.1', method: 'GET', headers: {} };
        const r1 = await callLimiter(limiter, anon);
        expect(r1.nextCalled).toBe(true);
        // Second call from the same IP exhausts.
        const r2 = await callLimiter(limiter, anon);
        expect(r2.statusCode).toBe(429);
    });

    it('handles req.ip = undefined (every test framework sends this) without throwing', async () => {
        // express-rate-limit's `ipKeyGenerator` will throw on a non-string;
        // the middleware coerces `req.ip ?? ''` to dodge that. Pin it.
        const limiter = buildUserRateLimiter({ windowMs: 60_000, limit: 5, messageKey: 'too many' });
        const r = await callLimiter(limiter, { method: 'GET', headers: {} });
        // Either 200 (within budget) OR 429 (some other test added to the
        // bucket); the only failure mode we're guarding is "throws".
        expect([200, 429]).toContain(r.statusCode);
    });
});

describe('limiter 429 response shape', () => {
    it('emits a JSON `message` field on rate-limit hit (FE toast contract)', async () => {
        const limiter = buildUserRateLimiter({ windowMs: 60_000, limit: 1, messageKey: 'Too many search requests.' });
        const req = { user: { user_id: 'shape-test' }, ip: '127.0.0.1', method: 'GET', headers: {} };

        await callLimiter(limiter, req);
        const r2 = await callLimiter(limiter, req);

        expect(r2.statusCode).toBe(429);
        // express-rate-limit serialises the configured `message` object
        // through `res.send`. The FE's i18n layer keys off `.message`.
        expect(r2.sendArg).toMatchObject({ message: 'Too many search requests.' });
    });
});
