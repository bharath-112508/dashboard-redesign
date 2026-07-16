import { afterEach, describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';
import type { Request, Response } from 'express';

vi.mock('../services/settings.service.js', () => ({ getOrInitSettings: vi.fn() }));
vi.mock('../services/slack-user-mapping.service.js', () => ({
    resolveSlackUser: vi.fn(),
    fetchSlackUserInfo: vi.fn(),
}));
vi.mock('../services/slack-leave.service.js', () => ({ loadApplyLeaveModalTypes: vi.fn() }));
vi.mock('../utils/slack.js', async (orig) => ({
    ...(await orig<typeof import('../utils/slack.js')>()),
    slackContextFrom: vi.fn(() => ({ enabled: true, botToken: 'xoxb' })),
    openSlackModal: vi.fn(() => Promise.resolve(true)),
}));

import { getOrInitSettings } from '../services/settings.service.js';
import { resolveSlackUser } from '../services/slack-user-mapping.service.js';
import { loadApplyLeaveModalTypes } from '../services/slack-leave.service.js';
import { openSlackModal } from '../utils/slack.js';
import {
    handleInteractive as handleInteractiveRaw,
    handleSlashCommand as handleSlashCommandRaw,
} from './slack-interactive.controller.js';

const handleInteractive = handleInteractiveRaw as (req: Request, res: Response) => Promise<void>;
const handleSlashCommand = handleSlashCommandRaw as (req: Request, res: Response) => Promise<void>;

const makeRes = () => {
    const res = {} as { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> };
    res.status = vi.fn(() => res);
    res.json = vi.fn(() => res);
    return res;
};

const employee = { _id: new Types.ObjectId(), role: 'employee', full_name: 'Asha' };

afterEach(() => vi.clearAllMocks());

describe('apply-leave modal open', () => {
    it('button click opens the modal with the built view', async () => {
        vi.mocked(getOrInitSettings).mockResolvedValue({ slack: { enabled: true, bot_token: 'x' } } as never);
        vi.mocked(resolveSlackUser).mockResolvedValue(employee as never);
        vi.mocked(loadApplyLeaveModalTypes).mockResolvedValue([{ id: 't1', code: 'CL', name: 'Casual', available: 8 }]);

        const req = {
            body: {
                payload: JSON.stringify({
                    type: 'block_actions',
                    user: { id: 'U1' },
                    trigger_id: 'trig-1',
                    actions: [{ action_id: 'apply_leave_open' }],
                }),
            },
        };
        const res = makeRes();
        await handleInteractive(req as never, res as never);

        expect(vi.mocked(openSlackModal)).toHaveBeenCalledTimes(1);
        const [, triggerId, view] = vi.mocked(openSlackModal).mock.calls[0]!;
        expect(triggerId).toBe('trig-1');
        expect((view as { callback_id: string }).callback_id).toBe('apply_leave_submit');
        expect(res.status).toHaveBeenCalledWith(200);
    });

    it('/applyleave slash command opens the modal', async () => {
        vi.mocked(getOrInitSettings).mockResolvedValue({ slack: { enabled: true, bot_token: 'x' } } as never);
        vi.mocked(resolveSlackUser).mockResolvedValue(employee as never);
        vi.mocked(loadApplyLeaveModalTypes).mockResolvedValue([{ id: 't1', code: 'CL', name: 'Casual', available: 8 }]);

        const req = { params: { command: 'applyleave' }, body: { user_id: 'U1', trigger_id: 'trig-2' } };
        const res = makeRes();
        await handleSlashCommand(req as never, res as never);

        expect(vi.mocked(openSlackModal)).toHaveBeenCalledTimes(1);
        expect(vi.mocked(openSlackModal).mock.calls[0]![1]).toBe('trig-2');
    });

    it('refuses a client role with an ephemeral and never opens a modal', async () => {
        vi.mocked(getOrInitSettings).mockResolvedValue({ slack: { enabled: true, bot_token: 'x' } } as never);
        vi.mocked(resolveSlackUser).mockResolvedValue({ ...employee, role: 'client' } as never);

        const req = { params: { command: 'applyleave' }, body: { user_id: 'U1', trigger_id: 'trig-3' } };
        const res = makeRes();
        await handleSlashCommand(req as never, res as never);

        expect(vi.mocked(openSlackModal)).not.toHaveBeenCalled();
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ response_type: 'ephemeral' }));
    });

    it('button click refuses a client role with an ephemeral and never opens the modal', async () => {
        vi.mocked(getOrInitSettings).mockResolvedValue({ slack: { enabled: true, bot_token: 'x' } } as never);
        vi.mocked(resolveSlackUser).mockResolvedValue({
            _id: new Types.ObjectId(),
            role: 'client',
            full_name: 'Cli',
        } as never);

        const req = {
            body: {
                payload: JSON.stringify({
                    type: 'block_actions',
                    user: { id: 'U1' },
                    trigger_id: 'trig-x',
                    actions: [{ action_id: 'apply_leave_open' }],
                }),
            },
        };
        const res = makeRes();
        await handleInteractive(req as never, res as never);

        expect(vi.mocked(openSlackModal)).not.toHaveBeenCalled();
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ response_type: 'ephemeral' }));
    });
});
