import { afterEach, describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';
import type { Request, Response } from 'express';

vi.mock('../services/settings.service.js', () => ({ getOrInitSettings: vi.fn() }));
vi.mock('../services/slack-user-mapping.service.js', () => ({
    resolveSlackCaller: vi.fn(),
    fetchSlackUserInfo: vi.fn(),
}));
vi.mock('../utils/slack.js', async (orig) => ({
    ...(await orig<typeof import('../utils/slack.js')>()),
    slackContextFrom: vi.fn(() => ({ enabled: true, botToken: 'xoxb' })),
}));

const openLogTimeModalMock = vi.fn();
const handleLogTimeSubmissionMock = vi.fn(async (_req: unknown, res: Response, _next?: unknown) => {
    res.status(200).json({});
});
vi.mock('./slack-log-time.controller.js', () => ({
    openLogTimeModal: (...args: unknown[]) => openLogTimeModalMock(...args),
    handleLogTimeSubmission: (...args: unknown[]) => handleLogTimeSubmissionMock(...(args as [unknown, Response])),
}));

import { resolveSlackCaller } from '../services/slack-user-mapping.service.js';
import { handleInteractive as handleInteractiveRaw } from './slack-interactive.controller.js';

const handleInteractive = handleInteractiveRaw as (req: Request, res: Response) => Promise<void>;

const makeRes = () => {
    const res = {} as { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> };
    res.status = vi.fn(() => res);
    res.json = vi.fn(() => res);
    return res;
};

const employee = { _id: new Types.ObjectId(), role: 'employee', full_name: 'Asha' };

afterEach(() => vi.clearAllMocks());

describe('log-time routing', () => {
    it('opens the modal when the Home button is clicked', async () => {
        vi.mocked(resolveSlackCaller).mockResolvedValue(employee as never);
        openLogTimeModalMock.mockResolvedValue(null);

        const req = {
            body: {
                payload: JSON.stringify({
                    type: 'block_actions',
                    user: { id: 'U1' },
                    trigger_id: 'trigger-1',
                    actions: [{ action_id: 'log_time_open' }],
                }),
            },
        };
        const res = makeRes();
        await handleInteractive(req as never, res as never);

        expect(openLogTimeModalMock).toHaveBeenCalledWith('trigger-1', expect.anything());
        expect(res.status).toHaveBeenCalledWith(200);
    });

    it('routes the log_time_submit callback to the log-time handler', async () => {
        const req = {
            body: {
                payload: JSON.stringify({
                    type: 'view_submission',
                    user: { id: 'U1' },
                    view: { callback_id: 'log_time_submit' },
                }),
            },
        };
        const res = makeRes();
        await handleInteractive(req as never, res as never);

        expect(handleLogTimeSubmissionMock).toHaveBeenCalledTimes(1);
    });

    it('tells an unrecognised Slack user to fix their profile, without opening the modal', async () => {
        vi.mocked(resolveSlackCaller).mockResolvedValue(null);

        const req = {
            body: {
                payload: JSON.stringify({
                    type: 'block_actions',
                    user: { id: 'U1' },
                    trigger_id: 'trigger-1',
                    actions: [{ action_id: 'log_time_open' }],
                }),
            },
        };
        const res = makeRes();
        await handleInteractive(req as never, res as never);

        expect(openLogTimeModalMock).not.toHaveBeenCalled();
        expect(res.json).toHaveBeenCalledWith(
            expect.objectContaining({
                response_type: 'ephemeral',
                text: "Couldn't identify your Viljetech account. Set your Slack email on your profile or contact an admin.",
            })
        );
    });
});
