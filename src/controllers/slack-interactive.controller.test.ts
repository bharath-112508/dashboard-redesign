import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

// Stub the webhook middleware to a pass-through so tests don't need to
// sign every request. Signature verification is covered separately by
// the middleware's own test file.
vi.mock('../middlewares/slack-webhook.middleware.js', () => ({
    slackWebhookMiddleware: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}));

const { handleInteractive, handleSlashCommand } = await import('./slack-interactive.controller.js');

/**
 * Phase 0 skeleton — the controller branches by `action_id` prefix.
 * The actual Approve/Reject handlers (Phase 1, Task 14) and slash
 * commands (Phase 2, Tasks 17–19) are wired in by extending this
 * controller — the skeleton just routes unknowns to ephemeral text.
 */

const buildApp = () => {
    const app = express();
    // The middleware mock is pass-through, so we still need a parser to
    // populate `req.body` for these tests.
    app.use(express.urlencoded({ extended: false }));
    app.use(express.json());
    app.post('/slack/interactive', handleInteractive);
    app.post('/slack/commands/:command', handleSlashCommand);
    return app;
};

describe('handleInteractive — skeleton', () => {
    it('responds 200 with ephemeral text for an unknown action_id', async () => {
        const payload = {
            type: 'block_actions',
            user: { id: 'U123' },
            actions: [{ action_id: 'unknown_action_xyz' }],
        };
        const res = await request(buildApp())
            .post('/slack/interactive')
            .send({ payload: JSON.stringify(payload) });
        expect(res.status).toBe(200);
        expect(res.body.response_type).toBe('ephemeral');
        expect(res.body.text).toMatch(/unknown/i);
    });

    it('responds 200 + ephemeral when payload is missing', async () => {
        const res = await request(buildApp()).post('/slack/interactive').send({});
        expect(res.status).toBe(200);
        expect(res.body.response_type).toBe('ephemeral');
    });

    it('responds 200 + ephemeral when payload is not valid JSON', async () => {
        const res = await request(buildApp())
            .post('/slack/interactive')
            .send({ payload: '{this is not json' });
        expect(res.status).toBe(200);
        expect(res.body.response_type).toBe('ephemeral');
    });
});

describe('handleSlashCommand — skeleton', () => {
    it('responds 200 + ephemeral "not implemented" for any command', async () => {
        const res = await request(buildApp())
            .post('/slack/commands/checkin')
            .send('user_id=U_TEST');
        expect(res.status).toBe(200);
        expect(res.body.response_type).toBe('ephemeral');
    });
});
