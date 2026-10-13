import { describe, expect, it, vi } from 'vitest';

// Token check stubbed: "good-<id>" is a valid access token for user <id>.
vi.mock('../utils/jwt.js', () => ({
    tryVerifyAccessToken: (t: string) => (t.startsWith('good-') ? { user_id: t.slice(5), role: 'employee' } : null),
}));

import { GENERAL_RATE_LIMIT_MAX, GENERAL_RATE_LIMIT_USER_MAX } from '../config/server.config.js';
import { generalRateLimiter } from './rate-limit.middleware.js';

const hit = async (ip: string, token?: string) => {
    const next = vi.fn();
    const res = {
        statusCode: 200,
        headersSent: false,
        setHeader: vi.fn(),
        getHeader: vi.fn(),
        removeHeader: vi.fn(),
        end: vi.fn(),
        send: vi.fn(),
        json: vi.fn(),
        writeHead: vi.fn(),
        status(code: number) {
            this.statusCode = code;
            return this;
        },
    };
    const req = {
        ip,
        headers: token ? { authorization: `Bearer ${token}` } : {},
        method: 'GET',
        app: { get: () => false },
    };
    await generalRateLimiter(req as never, res as never, next);
    return res.statusCode;
};

const burst = async (n: number, ip: string, token?: string) => {
    let last = 0;
    for (let i = 0; i < n; i++) last = await hit(ip, token);
    return last;
};

describe('generalRateLimiter', () => {
    it('signed-in users behind one IP each get their own (larger) budget', async () => {
        expect(GENERAL_RATE_LIMIT_USER_MAX).toBeGreaterThan(GENERAL_RATE_LIMIT_MAX);
        // Two colleagues on the same office IP, each past the per-IP cap.
        expect(await burst(GENERAL_RATE_LIMIT_MAX + 5, '10.0.0.1', 'good-alice')).toBe(200);
        expect(await burst(GENERAL_RATE_LIMIT_MAX + 5, '10.0.0.1', 'good-bob')).toBe(200);
    });

    it('a user is still capped at the per-user limit', async () => {
        expect(await burst(GENERAL_RATE_LIMIT_USER_MAX + 1, '10.0.0.2', 'good-carol')).toBe(429);
    });

    it('requests without a valid token stay on the per-IP cap (a forged token gains nothing)', async () => {
        expect(await burst(GENERAL_RATE_LIMIT_MAX + 1, '10.0.0.3')).toBe(429);
        expect(await burst(GENERAL_RATE_LIMIT_MAX + 1, '10.0.0.4', 'forged-token')).toBe(429);
    });
});
