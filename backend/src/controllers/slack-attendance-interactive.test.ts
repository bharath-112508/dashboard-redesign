import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { Types } from 'mongoose';

vi.mock('../services/attendance.service.js', () => ({
    checkIn: vi.fn(),
    checkOut: vi.fn(),
    getMyToday: vi.fn(),
    getTodayAttendanceSummary: vi.fn(),
}));
vi.mock('../services/slack-home.service.js', () => ({
    buildHomeDashboardData: vi.fn(async () => ({ user: {}, my_today: null })),
    ATT_ROSTER_CAP: 10,
    PENDING_CAP: 10,
    WHOSOUT_CAP: 15,
}));
vi.mock('../utils/slack-home-blocks.js', () => ({
    buildHomeDashboardView: vi.fn(() => ({ type: 'home', blocks: [] })),
    SLACK_ACTION_HOME_REFRESH: 'home_refresh',
}));
vi.mock('../services/settings.service.js', () => ({ getOrInitSettings: vi.fn() }));
vi.mock('../services/slack-user-mapping.service.js', () => ({
    resolveSlackCaller: vi.fn(),
    fetchSlackUserInfo: vi.fn(),
}));
// `callerCanCheckInOut` resolves the caller's real permissions
// (role.service.js → User.findById) — mocked here so these routing tests
// don't touch Mongo. Defaults to `true`.
vi.mock('../services/slack-attendance.service.js', () => ({
    callerCanCheckInOut: vi.fn(async () => true),
}));
vi.mock('../utils/slack.js', async (orig) => ({
    ...(await orig<typeof import('../utils/slack.js')>()),
    slackContextFrom: vi.fn(() => ({ enabled: true, botToken: 'xoxb-x' })),
    publishHomeView: vi.fn(async () => true),
}));
const publishMock = vi.fn();
vi.mock('../services/realtime.service.js', () => ({ publish: (t: string[]) => publishMock(t) }));

import { REALTIME_TOPICS } from '../constants/realtime.js';
import { checkIn, getMyToday } from '../services/attendance.service.js';
import { getOrInitSettings } from '../services/settings.service.js';
import { resolveSlackCaller } from '../services/slack-user-mapping.service.js';
import { publishHomeView } from '../utils/slack.js';
import { buildHomeDashboardData } from '../services/slack-home.service.js';
import { buildHomeDashboardView } from '../utils/slack-home-blocks.js';
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
        (resolveSlackCaller as ReturnType<typeof vi.fn>).mockResolvedValue({
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

    it('does NOT publish when a non-Home tab is opened', async () => {
        const req = {
            body: { type: 'event_callback', event: { type: 'app_home_opened', user: 'U1', tab: 'messages' } },
        } as Request;
        const res = mockRes();
        await handleSlackEvents(req, res);
        expect(res.code).toBe(200);
        await new Promise((r) => setImmediate(r));
        expect(publishHomeView).not.toHaveBeenCalled();
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
        (resolveSlackCaller as ReturnType<typeof vi.fn>).mockResolvedValue({
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

    it('publishes an attendance realtime event after a Slack check-in', async () => {
        (getOrInitSettings as ReturnType<typeof vi.fn>).mockResolvedValue({ slack: {} });
        (resolveSlackCaller as ReturnType<typeof vi.fn>).mockResolvedValue({
            _id: new Types.ObjectId(),
            full_name: 'Raj',
            role: 'employee',
        });
        (checkIn as ReturnType<typeof vi.fn>).mockResolvedValue({});
        (getMyToday as ReturnType<typeof vi.fn>).mockResolvedValue(null);
        publishMock.mockReset();
        const res = mockRes();
        await handleInteractive(homePayload('attendance_check_in'), res);
        await new Promise((r) => setImmediate(r));
        expect(publishMock).toHaveBeenCalledWith([REALTIME_TOPICS.ATTENDANCE]);
    });
});

describe('Home dashboard wiring', () => {
    it('app_home_opened publishes the DASHBOARD view', async () => {
        (getOrInitSettings as ReturnType<typeof vi.fn>).mockResolvedValue({ slack: {} });
        (resolveSlackCaller as ReturnType<typeof vi.fn>).mockResolvedValue({
            _id: new Types.ObjectId(),
            role: 'employee',
            full_name: 'Raj',
        });
        const req = {
            body: { type: 'event_callback', event: { type: 'app_home_opened', user: 'U1', tab: 'home' } },
        } as never;
        const res = mockRes();
        await handleSlackEvents(req, res);
        await new Promise((r) => setImmediate(r));
        expect(buildHomeDashboardData).toHaveBeenCalled();
        expect(buildHomeDashboardView).toHaveBeenCalled();
        expect(publishHomeView).toHaveBeenCalled();
    });

    it('home_refresh action re-publishes the dashboard', async () => {
        (getOrInitSettings as ReturnType<typeof vi.fn>).mockResolvedValue({ slack: {} });
        (resolveSlackCaller as ReturnType<typeof vi.fn>).mockResolvedValue({
            _id: new Types.ObjectId(),
            role: 'employee',
            full_name: 'Raj',
        });
        const req = {
            body: {
                payload: JSON.stringify({
                    type: 'block_actions',
                    user: { id: 'U1' },
                    actions: [{ action_id: 'home_refresh' }],
                    view: { type: 'home' },
                }),
            },
        } as never;
        const res = mockRes();
        await handleInteractive(req, res);
        await new Promise((r) => setImmediate(r));
        expect(buildHomeDashboardView).toHaveBeenCalled();
        expect(publishHomeView).toHaveBeenCalled();
    });
});
