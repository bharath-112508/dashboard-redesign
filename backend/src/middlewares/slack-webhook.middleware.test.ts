import { describe, it, expect, vi } from 'vitest';
import crypto from 'node:crypto';
import express from 'express';
import request from 'supertest';

const SECRET = 'test_signing_secret_8e15b0c8c0e7';

// Stub the env so the middleware sees a known secret. The mock has to
// be in place BEFORE the middleware module is imported below.
vi.mock('../config/server.config.js', async (orig) => {
    const real = (await orig()) as Record<string, unknown>;
    return { ...real, SLACK_SIGNING_SECRET: SECRET };
});

const { slackWebhookMiddleware } = await import('./slack-webhook.middleware.js');

/**
 * Phase 0 — the slack-webhook middleware sits between the rate
 * limiter and the controller. It:
 *   - buffers the raw body (Slack signs the bytes, not the parsed form),
 *   - verifies the signature,
 *   - re-parses `req.body` as JSON or x-www-form-urlencoded for the
 *     downstream handler.
 */

const buildApp = () => {
    const app = express();
    // Mount the middleware on /slack so it only applies there. Any other
    // route on the app gets normal body parsing.
    app.use('/slack', slackWebhookMiddleware);
    app.post('/slack/echo', (req, res) => {
        res.json({
            rawLength: (req as express.Request & { rawBody?: Buffer }).rawBody?.length ?? 0,
            parsed: req.body,
        });
    });
    return app;
};

const signed = (body: string) => {
    const ts = Math.floor(Date.now() / 1000).toString();
    const base = `v0:${ts}:${body}`;
    return {
        ts,
        sig: `v0=${crypto.createHmac('sha256', SECRET).update(base).digest('hex')}`,
    };
};

describe('slackWebhookMiddleware', () => {
    it('passes when signature is valid + populates req.rawBody + parses JSON', async () => {
        const app = buildApp();
        const body = JSON.stringify({ hi: 'there' });
        const { ts, sig } = signed(body);
        const res = await request(app)
            .post('/slack/echo')
            .set('Content-Type', 'application/json')
            .set('X-Slack-Signature', sig)
            .set('X-Slack-Request-Timestamp', ts)
            .send(body);
        expect(res.status).toBe(200);
        expect(res.body.parsed).toEqual({ hi: 'there' });
        expect(res.body.rawLength).toBeGreaterThan(0);
    });

    it('parses x-www-form-urlencoded into a plain object', async () => {
        const app = buildApp();
        const body = 'payload=%7B%22action%22%3A%22yes%22%7D&user_id=U123';
        const { ts, sig } = signed(body);
        const res = await request(app)
            .post('/slack/echo')
            .set('Content-Type', 'application/x-www-form-urlencoded')
            .set('X-Slack-Signature', sig)
            .set('X-Slack-Request-Timestamp', ts)
            .send(body);
        expect(res.status).toBe(200);
        expect(res.body.parsed).toEqual({
            payload: '{"action":"yes"}',
            user_id: 'U123',
        });
    });

    it('rejects with 401 when signature header is missing', async () => {
        const app = buildApp();
        const res = await request(app).post('/slack/echo').set('Content-Type', 'application/json').send('{}');
        expect(res.status).toBe(401);
    });

    it('rejects with 401 when signature is wrong', async () => {
        const app = buildApp();
        const body = JSON.stringify({ hi: 'there' });
        const ts = Math.floor(Date.now() / 1000).toString();
        const res = await request(app)
            .post('/slack/echo')
            .set('Content-Type', 'application/json')
            .set('X-Slack-Signature', 'v0=deadbeef')
            .set('X-Slack-Request-Timestamp', ts)
            .send(body);
        expect(res.status).toBe(401);
    });
});
