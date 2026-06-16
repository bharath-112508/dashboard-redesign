import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { Types } from 'mongoose';

vi.mock('../services/attendance.service.js', () => ({
    checkIn: vi.fn(),
    checkOut: vi.fn(),
    getMyToday: vi.fn(),
}));
vi.mock('../services/settings.service.js', () => ({ getOrInitSettings: vi.fn() }));
vi.mock('../services/slack-user-mapping.service.js', () => ({
    resolveSlackUser: vi.fn(),
    fetchSlackUserInfo: vi.fn(),
}));
vi.mock('../utils/slack.js', async (orig) => ({
    ...(await orig<typeof import('../utils/slack.js')>()),
    slackContextFrom: vi.fn(() => ({ enabled: true, botToken: 'xoxb-x' })),
    publishHomeView: vi.fn(async () => true),
}));

import { checkIn, getMyToday } from '../services/attendance.service.js';
import { getOrInitSettings } from '../services/settings.service.js';
import { resolveSlackUser } from '../services/slack-user-mapping.service.js';
import { publishHomeView } from '../utils/slack.js';
import {
    handleSlackEvents as handleSlackEventsRaw,
    handleInteractive as handleInteractiveRaw,
} from './slack-interactive.controller.js';

// The exported handlers are Express `RequestHandler`s (req, res, next). In
// these unit tests we invoke them directly with just (req, res) — the
// handlers never touch `next`. Narrow the call signature so the 2-arg
// direct invocation type-checks without weakening the controller's
// production type.
const handleSlackEvents = handleSlackEventsRaw as (req: Request, res: Response) => Promise<void>;
const handleInteractive = handleInteractiveRaw as (req: Request, res: Response) => Promise<void>;

const mockRes = () => {
    const res = {} as Response & { body?: unknown; code?: number };
    res.status = vi.fn(function (this: typeof res, c: number) {
        this.code = c;
        return this;
    }) as unknown as Response['status'];
    res.json = vi.fn(function (this: typeof res, b: unknown) {
        this.body = b;
        return this;
    }) as unknown as Response['json'];
    return res;
};

afterEach(() => vi.clearAllMocks());

describe('handleSlackEvents', () => {
    it('echoes the url_verification challenge', async () => {
        const req = { body: { type: 'url_verification', challenge: 'abc123' } } as Request;
        const res = mockRes();
        await handleSlackEvents(req, res);
        expect(res.code).toBe(200);
        expect(res.body).toEqual({ challenge: 'abc123' });
    });

    it('acks 200 and publishes the Home view on app_home_opened', async () => {
        (getOrInitSettings as ReturnType<typeof vi.fn>).mockResolvedValue({ slack: {} });
        (resolveSlackUser as ReturnType<typeof vi.fn>).mockResolvedValue({
            _id: new Types.ObjectId(),
            full_name: 'Raj',
        });
        (getMyToday as ReturnType<typeof vi.fn>).mockResolvedValue(null);
        const req = {
            body: { type: 'event_callback', event: { type: 'app_home_opened', user: 'U1', tab: 'home' } },
        } as Request;
        const res = mockRes();
        await handleSlackEvents(req, res);
        expect(res.code).toBe(200);
        await new Promise((r) => setImmediate(r));
        expect(publishHomeView).toHaveBeenCalledOnce();
    });
});

describe('handleInteractive — attendance actions', () => {
    const homePayload = (actionId: string) =>
        ({
            body: {
                payload: JSON.stringify({
                    type: 'block_actions',
                    user: { id: 'U1' },
                    actions: [{ action_id: actionId }],
                    view: { type: 'home' },
                }),
            },
        }) as Request;

    it('checks in from the Home tab and re-publishes the view', async () => {
        (getOrInitSettings as ReturnType<typeof vi.fn>).mockResolvedValue({ slack: {} });
        (resolveSlackUser as ReturnType<typeof vi.fn>).mockResolvedValue({
            _id: new Types.ObjectId(),
            full_name: 'Raj',
        });
        (checkIn as ReturnType<typeof vi.fn>).mockResolvedValue({});
        (getMyToday as ReturnType<typeof vi.fn>).mockResolvedValue(null);
        const res = mockRes();
        await handleInteractive(homePayload('attendance_check_in'), res);
        expect(checkIn).toHaveBeenCalledOnce();
        await new Promise((r) => setImmediate(r));
        expect(publishHomeView).toHaveBeenCalled();
    });
});
