import { describe, expect, it } from 'vitest';
import request from 'supertest';

import { buildTestApp } from './_helpers/build-app.js';

/**
 * Smoke test: the health endpoint is the simplest possible exercise of
 * the in-process harness — boots the Express app, sends a real HTTP
 * request via supertest, asserts the response shape. If this regresses,
 * the harness wiring is broken.
 */

describe('integration: GET /health', () => {
    const app = buildTestApp();

    it('returns 200 with the canonical envelope', async () => {
        const res = await request(app).get('/health');

        expect(res.status).toBe(200);
        expect(res.body).toEqual({
            data: { status: 'ok', env: 'test' },
        });
    });

    it('emits the production CSP / X-Content-Type-Options headers', async () => {
        const res = await request(app).get('/health');

        // The CSP we tightened in P2-10 must reach the wire.
        expect(res.headers['content-security-policy']).toContain("default-src 'none'");
        expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
        // Helmet's nosniff shim — defence-in-depth on top of CSP.
        expect(res.headers['x-content-type-options']).toBe('nosniff');
    });

    it('404s on unknown routes with the canonical error shape', async () => {
        const res = await request(app).get('/this-route-does-not-exist');

        expect(res.status).toBe(404);
        expect(res.body).toMatchObject({
            error: { code: 'RESOURCE_NOT_FOUND' },
        });
    });
});
