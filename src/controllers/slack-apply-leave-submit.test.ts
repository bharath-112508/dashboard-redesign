import { afterEach, describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';
import { ERROR_CODES } from '../constants/error-codes.js';
import { AppError } from '../utils/app-error.js';

vi.mock('../services/settings.service.js', () => ({ getOrInitSettings: vi.fn() }));
vi.mock('../services/slack-user-mapping.service.js', () => ({
    resolveSlackUser: vi.fn(),
    fetchSlackUserInfo: vi.fn(),
}));
vi.mock('../services/leave-request.service.js', () => ({
    applyLeave: vi.fn(),
    approveLeave: vi.fn(),
    rejectLeave: vi.fn(),
}));
vi.mock('../services/slack-home.service.js', () => ({
    buildHomeDashboardData: vi.fn(async () => ({ user: {}, my_today: null })),
}));
vi.mock('../utils/slack-home-blocks.js', () => ({
    buildHomeDashboardView: vi.fn(() => ({ type: 'home', blocks: [] })),
    SLACK_ACTION_HOME_REFRESH: 'home_refresh',
}));
vi.mock('../utils/slack.js', async (orig) => ({
    ...(await orig<typeof import('../utils/slack.js')>()),
    slackContextFrom: vi.fn(() => ({ enabled: true, botToken: 'xoxb' })),
    postSlackMessage: vi.fn(() => Promise.resolve({ success: true })),
    publishHomeView: vi.fn(() => Promise.resolve(true)),
}));

import { getOrInitSettings } from '../services/settings.service.js';
import { resolveSlackUser } from '../services/slack-user-mapping.service.js';
import { applyLeave } from '../services/leave-request.service.js';
import { postSlackMessage } from '../utils/slack.js';
import { handleInteractive } from './slack-interactive.controller.js';

const makeRes = () => {
    const res = {} as { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> };
    res.status = vi.fn(() => res);
    res.json = vi.fn(() => res);
    return res;
};

const submissionPayload = () => ({
    type: 'view_submission',
    user: { id: 'U1' },
    view: {
        callback_id: 'apply_leave_submit',
        state: {
            values: {
                leave_type: { leave_type: { selected_option: { value: '64b2f0000000000000000001' } } },
                start_date: { start_date: { selected_date: '2026-07-01' } },
                end_date: { end_date: { selected_date: '2026-07-02' } },
                half_day: { half_day: { selected_option: { value: 'none' } } },
                reason: { reason: { value: 'Trip' } },
            },
        },
    },
});

afterEach(() => vi.clearAllMocks());

describe('apply-leave view_submission', () => {
    it('acks the modal immediately, then applies async and DMs success', async () => {
        const submitUser = { _id: new Types.ObjectId(), role: 'employee', full_name: 'Asha' };
        vi.mocked(getOrInitSettings).mockResolvedValue({ slack: { enabled: true, bot_token: 'x' } } as never);
        vi.mocked(resolveSlackUser).mockResolvedValue(submitUser as never);
        vi.mocked(applyLeave).mockResolvedValue({ id: 'leave1' } as never);

        const req = { body: { payload: JSON.stringify(submissionPayload()) }, headers: {} };
        const res = makeRes();
        await handleInteractive(req as never, res as never, () => undefined);

        // The modal is acked closed synchronously — within Slack's 3s window —
        // BEFORE the slow applyLeave runs.
        expect(res.json).toHaveBeenCalledWith({});

        // applyLeave runs in the fire-and-forget frame; wait for it.
        await vi.waitFor(() => expect(vi.mocked(applyLeave)).toHaveBeenCalledTimes(1));
        const [body, caller] = vi.mocked(applyLeave).mock.calls[0]!;
        expect(body).toMatchObject({
            leave_type_id: '64b2f0000000000000000001',
            start_date: '2026-07-01',
            end_date: '2026-07-02',
            is_half_day: false,
            reason: 'Trip',
        });
        expect(caller).toMatchObject({ id: submitUser._id, role: 'employee' });
        expect((caller as { audit?: unknown }).audit).toBeDefined();

        // Success is reported via a DM (the modal is already closed).
        await vi.waitFor(() =>
            expect(vi.mocked(postSlackMessage)).toHaveBeenCalledWith(
                expect.anything(),
                expect.objectContaining({ channel: 'U1', context: 'apply-leave-confirm-dm' })
            )
        );
    });

    it('acks the modal and DMs the error when applyLeave throws a business error', async () => {
        vi.mocked(getOrInitSettings).mockResolvedValue({ slack: { enabled: true, bot_token: 'x' } } as never);
        vi.mocked(resolveSlackUser).mockResolvedValue({ _id: new Types.ObjectId(), role: 'employee' } as never);
        vi.mocked(applyLeave).mockRejectedValue(
            AppError.conflict('overlaps with an existing leave', ERROR_CODES.LEAVE_OVERLAP)
        );

        const req = { body: { payload: JSON.stringify(submissionPayload()) }, headers: {} };
        const res = makeRes();
        await handleInteractive(req as never, res as never, () => undefined);

        // Still a clean ack (NOT response_action errors — the modal is closed).
        expect(res.json).toHaveBeenCalledWith({});

        await vi.waitFor(() =>
            expect(vi.mocked(postSlackMessage)).toHaveBeenCalledWith(
                expect.anything(),
                expect.objectContaining({
                    channel: 'U1',
                    context: 'apply-leave-error-dm',
                    text: expect.stringContaining('overlaps with an existing leave'),
                })
            )
        );
    });

    it('returns inline field errors (no ack-close) when Zod validation fails — never calls applyLeave', async () => {
        vi.mocked(getOrInitSettings).mockResolvedValue({ slack: { enabled: true, bot_token: 'x' } } as never);
        vi.mocked(resolveSlackUser).mockResolvedValue({ _id: new Types.ObjectId(), role: 'employee' } as never);

        // start_date after end_date — Zod (instant) rejects before any ack.
        const bad = submissionPayload();
        bad.view.state.values.start_date.start_date.selected_date = '2026-07-09';
        bad.view.state.values.end_date.end_date.selected_date = '2026-07-01';

        const req = { body: { payload: JSON.stringify(bad) }, headers: {} };
        const res = makeRes();
        await handleInteractive(req as never, res as never, () => undefined);

        expect(res.json).toHaveBeenCalledWith(
            expect.objectContaining({
                response_action: 'errors',
                errors: expect.objectContaining({ start_date: expect.any(String) }),
            })
        );
        expect(vi.mocked(applyLeave)).not.toHaveBeenCalled();
    });
});
