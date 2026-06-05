import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { Types } from 'mongoose';

// Stub the webhook middleware to a pass-through so tests don't need to
// sign every request. Signature verification is covered separately by
// the middleware's own test file.
vi.mock('../middlewares/slack-webhook.middleware.js', () => ({
    slackWebhookMiddleware: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}));

const approveLeaveMock = vi.fn();
const rejectLeaveMock = vi.fn();
vi.mock('../services/leave-request.service.js', () => ({
    approveLeave: (...args: unknown[]) => approveLeaveMock(...args),
    rejectLeave: (...args: unknown[]) => rejectLeaveMock(...args),
}));

const resolveSlackUserMock = vi.fn();
vi.mock('../services/slack-user-mapping.service.js', () => ({
    resolveSlackUser: (...args: unknown[]) => resolveSlackUserMock(...args),
    fetchSlackUserInfo: vi.fn(),
}));

const getOrInitSettingsMock = vi.fn();
vi.mock('../services/settings.service.js', () => ({
    getOrInitSettings: getOrInitSettingsMock,
}));

const slackContextFromMock = vi.fn();
vi.mock('../utils/slack.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../utils/slack.js')>();
    return {
        ...actual,
        slackContextFrom: (settings: unknown) => slackContextFromMock(settings),
    };
});

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

// ─── Phase 1: approve_leave_* / reject_leave_* ──────────────────────────

describe('handleInteractive — Phase 1 leave handlers', () => {
    beforeEach(() => {
        approveLeaveMock.mockReset();
        rejectLeaveMock.mockReset();
        resolveSlackUserMock.mockReset();
        getOrInitSettingsMock.mockReset();
        slackContextFromMock.mockReset();
        getOrInitSettingsMock.mockResolvedValue({
            slack: { enabled: true, bot_token: 'xoxb', channels: { leaves: '#leaves' } },
        });
        slackContextFromMock.mockReturnValue({ enabled: true, botToken: 'xoxb' });
    });

    const approvePayload = (leaveId: string) => ({
        type: 'block_actions',
        user: { id: 'U_MANAGER' },
        actions: [{ action_id: `approve_leave_${leaveId}` }],
    });

    it('responds ephemeral when resolveSlackUser returns null', async () => {
        resolveSlackUserMock.mockResolvedValueOnce(null);
        const res = await request(buildApp())
            .post('/slack/interactive')
            .send({ payload: JSON.stringify(approvePayload('L1')) });
        expect(res.body.text).toMatch(/identify your Viljetech account/i);
        expect(approveLeaveMock).not.toHaveBeenCalled();
    });

    it('rejects ephemeral 403 when caller is an employee (non-reviewer role)', async () => {
        const callerId = new Types.ObjectId();
        resolveSlackUserMock.mockResolvedValueOnce({
            _id: callerId,
            role: 'employee',
        });
        const res = await request(buildApp())
            .post('/slack/interactive')
            .send({ payload: JSON.stringify(approvePayload('L1')) });
        expect(res.body.text).toMatch(/permission/i);
        expect(approveLeaveMock).not.toHaveBeenCalled();
    });

    it('calls approveLeave with parsed leave id when caller is a manager', async () => {
        const callerId = new Types.ObjectId();
        const leaveId = new Types.ObjectId().toString();
        resolveSlackUserMock.mockResolvedValueOnce({
            _id: callerId,
            role: 'manager',
        });
        approveLeaveMock.mockResolvedValueOnce({ status: 'approved' });
        const res = await request(buildApp())
            .post('/slack/interactive')
            .send({ payload: JSON.stringify(approvePayload(leaveId)) });
        expect(res.status).toBe(200);
        expect(approveLeaveMock).toHaveBeenCalledTimes(1);
        const [id, body, caller] = approveLeaveMock.mock.calls[0];
        expect(String(id)).toBe(leaveId);
        expect(body).toEqual({});
        expect(caller).toMatchObject({ id: callerId, role: 'manager' });
    });

    it('responds ephemeral on CORRECTION_REQUEST_NOT_PENDING (idempotent re-approval / Slack retry)', async () => {
        const callerId = new Types.ObjectId();
        const leaveId = new Types.ObjectId().toString();
        resolveSlackUserMock.mockResolvedValueOnce({ _id: callerId, role: 'admin' });
        // The leave service reuses CORRECTION_REQUEST_NOT_PENDING for
        // "leave is no longer pending" — historical naming.
        approveLeaveMock.mockRejectedValueOnce({ code: 'CORRECTION_REQUEST_NOT_PENDING' });
        const res = await request(buildApp())
            .post('/slack/interactive')
            .send({ payload: JSON.stringify(approvePayload(leaveId)) });
        expect(res.status).toBe(200);
        expect(res.body.text).toMatch(/already/i);
    });

    it('reject_leave_<id> calls rejectLeave', async () => {
        const callerId = new Types.ObjectId();
        const leaveId = new Types.ObjectId().toString();
        resolveSlackUserMock.mockResolvedValueOnce({ _id: callerId, role: 'admin' });
        rejectLeaveMock.mockResolvedValueOnce({ status: 'rejected' });
        const res = await request(buildApp())
            .post('/slack/interactive')
            .send({
                payload: JSON.stringify({
                    type: 'block_actions',
                    user: { id: 'U_MGR' },
                    actions: [{ action_id: `reject_leave_${leaveId}` }],
                }),
            });
        expect(res.status).toBe(200);
        expect(rejectLeaveMock).toHaveBeenCalledTimes(1);
        const [id] = rejectLeaveMock.mock.calls[0];
        expect(String(id)).toBe(leaveId);
    });
});
