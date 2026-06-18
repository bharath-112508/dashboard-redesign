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

const checkInMock = vi.fn();
const checkOutMock = vi.fn();
const getMyTodayMock = vi.fn();
const startBreakMock = vi.fn();
const endBreakMock = vi.fn();
vi.mock('../services/attendance.service.js', () => ({
    checkIn: (...args: unknown[]) => checkInMock(...args),
    checkOut: (...args: unknown[]) => checkOutMock(...args),
    getMyToday: (...args: unknown[]) => getMyTodayMock(...args),
    startBreak: (...args: unknown[]) => startBreakMock(...args),
    endBreak: (...args: unknown[]) => endBreakMock(...args),
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
        const res = await request(buildApp()).post('/slack/interactive').send({ payload: '{this is not json' });
        expect(res.status).toBe(200);
        expect(res.body.response_type).toBe('ephemeral');
    });
});

describe('handleSlashCommand — skeleton', () => {
    it('responds ephemeral "not implemented" for an unknown command', async () => {
        // Pre-Task-17 every command was a skeleton; now /checkin (Task 17)
        // does real work. Use a still-unimplemented command name to keep
        // the skeleton contract under test.
        resolveSlackUserMock.mockReset();
        getOrInitSettingsMock.mockReset();
        slackContextFromMock.mockReset();
        getOrInitSettingsMock.mockResolvedValue({
            slack: { enabled: true, bot_token: 'xoxb', channels: { leaves: '#leaves' } },
        });
        slackContextFromMock.mockReturnValue({ enabled: true, botToken: 'xoxb' });
        resolveSlackUserMock.mockResolvedValueOnce({
            _id: new Types.ObjectId(),
            role: 'employee',
        });

        const res = await request(buildApp()).post('/slack/commands/unknown_cmd').send('user_id=U_TEST');
        expect(res.status).toBe(200);
        expect(res.body.response_type).toBe('ephemeral');
        expect(res.body.text).toMatch(/not implemented/i);
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

    it('responds with a self-review message when the service throws FORBIDDEN (author clicked their own request)', async () => {
        const callerId = new Types.ObjectId();
        const leaveId = new Types.ObjectId().toString();
        resolveSlackUserMock.mockResolvedValueOnce({ _id: callerId, role: 'admin' });
        // ensureCanReviewRequest throws FORBIDDEN when caller === author;
        // the role gate already passed, so FORBIDDEN here means self-review.
        rejectLeaveMock.mockRejectedValueOnce({ code: 'FORBIDDEN' });
        const res = await request(buildApp())
            .post('/slack/interactive')
            .send({
                payload: JSON.stringify({
                    type: 'block_actions',
                    user: { id: 'U_ADMIN' },
                    actions: [{ action_id: `reject_leave_${leaveId}` }],
                }),
            });
        expect(res.status).toBe(200);
        expect(res.body.text).toMatch(/own leave request/i);
    });

    it('POSTs error feedback to payload.response_url (block_actions ignore the ack body)', async () => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('ok'));
        try {
            const callerId = new Types.ObjectId();
            const leaveId = new Types.ObjectId().toString();
            resolveSlackUserMock.mockResolvedValueOnce({ _id: callerId, role: 'admin' });
            rejectLeaveMock.mockRejectedValueOnce({ code: 'FORBIDDEN' });
            await request(buildApp())
                .post('/slack/interactive')
                .send({
                    payload: JSON.stringify({
                        type: 'block_actions',
                        user: { id: 'U_ADMIN' },
                        actions: [{ action_id: `reject_leave_${leaveId}` }],
                        response_url: 'https://hooks.slack.com/actions/T1/123/abc',
                    }),
                });
            expect(fetchSpy).toHaveBeenCalledTimes(1);
            const [url, init] = fetchSpy.mock.calls[0];
            expect(url).toBe('https://hooks.slack.com/actions/T1/123/abc');
            const body = JSON.parse((init as RequestInit).body as string);
            expect(body.response_type).toBe('ephemeral');
            expect(body.replace_original).toBe(false);
            expect(body.text).toMatch(/own leave request/i);
        } finally {
            fetchSpy.mockRestore();
        }
    });
});

// ─── Phase 2: /checkin /checkout /status ────────────────────────────────

describe('handleSlashCommand — Phase 2', () => {
    beforeEach(() => {
        resolveSlackUserMock.mockReset();
        getOrInitSettingsMock.mockReset();
        slackContextFromMock.mockReset();
        checkInMock.mockReset();
        checkOutMock.mockReset();
        getMyTodayMock.mockReset();
        getOrInitSettingsMock.mockResolvedValue({
            slack: { enabled: true, bot_token: 'xoxb', channels: { leaves: '#leaves' } },
        });
        slackContextFromMock.mockReturnValue({ enabled: true, botToken: 'xoxb' });
    });

    it('/checkin: rejects ephemeral when caller is unidentified', async () => {
        resolveSlackUserMock.mockResolvedValueOnce(null);
        const res = await request(buildApp()).post('/slack/commands/checkin').send('user_id=U_TEST');
        expect(res.body.response_type).toBe('ephemeral');
        expect(res.body.text).toMatch(/identify your Viljetech account/i);
        expect(checkInMock).not.toHaveBeenCalled();
    });

    it('/checkin: checks in + reports the time on success', async () => {
        const userId = new Types.ObjectId();
        resolveSlackUserMock.mockResolvedValueOnce({
            _id: userId,
            role: 'employee',
        });
        const inAt = new Date('2026-06-05T04:12:00.000Z'); // 09:42 IST
        checkInMock.mockResolvedValueOnce({
            check_in: { time: inAt, method: 'manual', location_id: null, ip: '' },
            segments: [{ check_in: { time: inAt }, check_out: null }],
        });
        const res = await request(buildApp()).post('/slack/commands/checkin').send('user_id=U_TEST');
        expect(res.status).toBe(200);
        expect(res.body.response_type).toBe('ephemeral');
        expect(res.body.text).toMatch(/Checked in at 09:42/);
        // Service called with body { method: 'manual' } + the resolved user id.
        expect(checkInMock).toHaveBeenCalledWith({ method: 'manual' }, userId, '');
    });

    it('/checkin: ALREADY_CHECKED_IN → ephemeral "already checked in"', async () => {
        resolveSlackUserMock.mockResolvedValueOnce({
            _id: new Types.ObjectId(),
            role: 'employee',
        });
        checkInMock.mockRejectedValueOnce({ code: 'ALREADY_CHECKED_IN' });
        const res = await request(buildApp()).post('/slack/commands/checkin').send('user_id=U_TEST');
        expect(res.body.text).toMatch(/already checked in/i);
    });

    it('/checkout: checks out + reports worked time', async () => {
        const userId = new Types.ObjectId();
        resolveSlackUserMock.mockResolvedValueOnce({
            _id: userId,
            role: 'employee',
        });
        // 09:00 → 17:33 IST = 8h 33m worked
        const outAt = new Date('2026-06-05T12:03:00.000Z'); // 17:33 IST
        checkOutMock.mockResolvedValueOnce({
            segments: [
                {
                    check_in: { time: new Date('2026-06-05T03:30:00.000Z') }, // 09:00 IST
                    check_out: { time: outAt },
                },
            ],
            total_worked_minutes: 8 * 60 + 33,
        });
        const res = await request(buildApp()).post('/slack/commands/checkout').send('user_id=U_TEST');
        expect(res.status).toBe(200);
        expect(res.body.text).toMatch(/Checked out at 17:33/);
        expect(res.body.text).toMatch(/8h 33m/);
        expect(checkOutMock).toHaveBeenCalledWith({ method: 'manual' }, userId, '');
    });

    it('/checkout: NOT_CHECKED_IN → ephemeral hint to /checkin first', async () => {
        resolveSlackUserMock.mockResolvedValueOnce({
            _id: new Types.ObjectId(),
            role: 'employee',
        });
        checkOutMock.mockRejectedValueOnce({ code: 'NOT_CHECKED_IN' });
        const res = await request(buildApp()).post('/slack/commands/checkout').send('user_id=U_TEST');
        expect(res.body.text).toMatch(/not currently checked in/i);
    });

    it("/status: lists today's segments + total worked", async () => {
        resolveSlackUserMock.mockResolvedValueOnce({
            _id: new Types.ObjectId(),
            role: 'employee',
        });
        // Two closed segments + one open (in → "now"). Times in UTC,
        // formatter outputs IST.
        getMyTodayMock.mockResolvedValueOnce({
            segments: [
                {
                    check_in: { time: new Date('2026-06-05T03:30:00.000Z') }, // 09:00 IST
                    check_out: { time: new Date('2026-06-05T07:30:00.000Z') }, // 13:00 IST
                },
                {
                    check_in: { time: new Date('2026-06-05T08:30:00.000Z') }, // 14:00 IST
                    check_out: null,
                },
            ],
            total_worked_minutes: 4 * 60,
        });
        const res = await request(buildApp()).post('/slack/commands/status').send('user_id=U_TEST');
        expect(res.status).toBe(200);
        expect(res.body.text).toMatch(/09:00.*13:00/);
        expect(res.body.text).toMatch(/14:00.*now/);
        expect(res.body.text).toMatch(/4h 0m/);
    });

    it('/status: no record today → ephemeral "No segments today"', async () => {
        resolveSlackUserMock.mockResolvedValueOnce({
            _id: new Types.ObjectId(),
            role: 'employee',
        });
        getMyTodayMock.mockResolvedValueOnce(null);
        const res = await request(buildApp()).post('/slack/commands/status').send('user_id=U_TEST');
        expect(res.body.text).toMatch(/no segments today/i);
    });

    it('/mystatus: aliases /status (Slack reserves /status)', async () => {
        resolveSlackUserMock.mockResolvedValueOnce({
            _id: new Types.ObjectId(),
            role: 'employee',
        });
        getMyTodayMock.mockResolvedValueOnce({
            segments: [
                {
                    check_in: { time: new Date('2026-06-05T03:30:00.000Z') }, // 09:00 IST
                    check_out: { time: new Date('2026-06-05T07:30:00.000Z') }, // 13:00 IST
                },
            ],
            total_worked_minutes: 4 * 60,
        });
        const res = await request(buildApp()).post('/slack/commands/mystatus').send('user_id=U_TEST');
        expect(res.status).toBe(200);
        expect(res.body.text).toMatch(/09:00.*13:00/);
        expect(res.body.text).toMatch(/4h 0m/);
    });
});

// ─── Phase 3: break_start_* / break_end ─────────────────────────────────

describe('handleInteractive — break actions', () => {
    beforeEach(() => {
        startBreakMock.mockReset();
        endBreakMock.mockReset();
        resolveSlackUserMock.mockReset();
        getOrInitSettingsMock.mockReset();
        slackContextFromMock.mockReset();
        getOrInitSettingsMock.mockResolvedValue({
            slack: { enabled: true, bot_token: 'xoxb', channels: {} },
        });
        slackContextFromMock.mockReturnValue({ enabled: true, botToken: 'xoxb' });
    });

    const breakPayload = (action_id: string, fromHome = true) => ({
        type: 'block_actions',
        user: { id: 'U_EMP' },
        actions: [{ action_id }],
        ...(fromHome ? { view: { type: 'home' } } : {}),
    });

    it('break_start_lunch from home calls startBreak(user._id, "lunch", "slack")', async () => {
        const userId = new Types.ObjectId();
        resolveSlackUserMock.mockResolvedValueOnce({ _id: userId, role: 'employee' });
        startBreakMock.mockResolvedValueOnce({});
        const res = await request(buildApp())
            .post('/slack/interactive')
            .send({ payload: JSON.stringify(breakPayload('break_start_lunch')) });
        expect(res.status).toBe(200);
        expect(startBreakMock).toHaveBeenCalledTimes(1);
        const [id, type, source] = startBreakMock.mock.calls[0];
        expect(String(id)).toBe(String(userId));
        expect(type).toBe('lunch');
        expect(source).toBe('slack');
    });

    it('break_end from home calls endBreak(user._id, "slack")', async () => {
        const userId = new Types.ObjectId();
        resolveSlackUserMock.mockResolvedValueOnce({ _id: userId, role: 'employee' });
        endBreakMock.mockResolvedValueOnce({});
        const res = await request(buildApp())
            .post('/slack/interactive')
            .send({ payload: JSON.stringify(breakPayload('break_end')) });
        expect(res.status).toBe(200);
        expect(endBreakMock).toHaveBeenCalledTimes(1);
        const [id, source] = endBreakMock.mock.calls[0];
        expect(String(id)).toBe(String(userId));
        expect(source).toBe('slack');
    });

    it('break_start_tea: ALREADY_ON_BREAK → ephemeral "already on a break"', async () => {
        const userId = new Types.ObjectId();
        resolveSlackUserMock.mockResolvedValueOnce({ _id: userId, role: 'employee' });
        startBreakMock.mockRejectedValueOnce({ code: 'ALREADY_ON_BREAK' });
        const res = await request(buildApp())
            .post('/slack/interactive')
            .send({ payload: JSON.stringify(breakPayload('break_start_tea')) });
        expect(res.status).toBe(200);
        expect(res.body.text).toMatch(/already on a break/i);
    });

    it('break_start_other: NOT_CHECKED_IN → ephemeral hint', async () => {
        const userId = new Types.ObjectId();
        resolveSlackUserMock.mockResolvedValueOnce({ _id: userId, role: 'employee' });
        startBreakMock.mockRejectedValueOnce({ code: 'NOT_CHECKED_IN' });
        const res = await request(buildApp())
            .post('/slack/interactive')
            .send({ payload: JSON.stringify(breakPayload('break_start_other')) });
        expect(res.status).toBe(200);
        expect(res.body.text).toMatch(/check in before/i);
    });

    it('break_end: NOT_ON_BREAK → ephemeral hint', async () => {
        const userId = new Types.ObjectId();
        resolveSlackUserMock.mockResolvedValueOnce({ _id: userId, role: 'employee' });
        endBreakMock.mockRejectedValueOnce({ code: 'NOT_ON_BREAK' });
        const res = await request(buildApp())
            .post('/slack/interactive')
            .send({ payload: JSON.stringify(breakPayload('break_end')) });
        expect(res.status).toBe(200);
        expect(res.body.text).toMatch(/not on a break/i);
    });

    it('break_start_lunch: unidentified caller → ephemeral error', async () => {
        resolveSlackUserMock.mockResolvedValueOnce(null);
        const res = await request(buildApp())
            .post('/slack/interactive')
            .send({ payload: JSON.stringify(breakPayload('break_start_lunch')) });
        expect(res.status).toBe(200);
        expect(res.body.text).toMatch(/identify your Viljetech account/i);
        expect(startBreakMock).not.toHaveBeenCalled();
    });
});
