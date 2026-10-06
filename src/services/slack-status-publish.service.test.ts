import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';

const cfg = vi.hoisted(() => ({ token: 'xoxp-test' as string | null }));
vi.mock('../config/server.config.js', async (orig) => ({
    ...(await orig<object>()),
    get SLACK_STATUS_ADMIN_TOKEN() {
        return cfg.token;
    },
}));

const { findById, updateOne, findOneAndUpdate } = vi.hoisted(() => ({
    findById: vi.fn(),
    updateOne: vi.fn(),
    findOneAndUpdate: vi.fn(),
}));
vi.mock('../models/user.model.js', () => ({ User: { findById, updateOne, findOneAndUpdate } }));
vi.mock('./settings.service.js', () => ({ getOrInitSettings: vi.fn(async () => ({ slack: {} })) }));
vi.mock('../utils/slack.js', () => ({ slackContextFrom: () => ({ enabled: true, botToken: 'xoxb' }) }));
vi.mock('./slack-user-mapping.service.js', () => ({ resolveSlackIdByEmail: vi.fn() }));

import {
    SLACK_STATUS_FOR_BREAK,
    breakTypeFromSlackStatus,
    clearBreakFromSlack,
    showBreakOnSlack,
} from './slack-status-publish.service.js';

const uid = new Types.ObjectId();
const status = (status_emoji: string, status_text: string, status_expiration = 0) => ({
    status_emoji,
    status_text,
    status_expiration,
});

/** Stub Slack: `users.profile.get` returns `current`; records every set. */
let current = status('', '');
const sets: unknown[] = [];
const fetchMock = vi.fn(async (url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { profile?: unknown };
    if (url.endsWith('users.profile.set')) sets.push(body.profile);
    return { json: async () => ({ ok: true, profile: current }) };
});

beforeEach(() => {
    vi.clearAllMocks();
    cfg.token = 'xoxp-test';
    sets.length = 0;
    vi.stubGlobal('fetch', fetchMock);
    findById.mockReturnValue({ select: () => ({ lean: async () => ({ slack_user_id: 'U1', email: 'a@b.c' }) }) });
});
afterEach(() => vi.unstubAllGlobals());

describe('SLACK_STATUS_FOR_BREAK', () => {
    it('each status the app sets maps back to its own break type (no echo mismatch)', () => {
        for (const [type, s] of Object.entries(SLACK_STATUS_FOR_BREAK)) {
            expect(breakTypeFromSlackStatus(s.status_emoji, s.status_text)).toBe(type);
        }
    });
});

describe('showBreakOnSlack', () => {
    it('is a no-op without the admin token', async () => {
        cfg.token = null;
        await showBreakOnSlack(uid, 'lunch');
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("saves the user's own status and puts up the break status", async () => {
        current = status(':house_with_garden:', 'Working remotely');
        await showBreakOnSlack(uid, 'lunch');
        expect(updateOne).toHaveBeenCalledWith({ _id: uid }, { $set: { slack_status_restore: current } });
        expect(sets).toEqual([{ ...SLACK_STATUS_FOR_BREAK.lunch, status_expiration: 0 }]);
    });

    it('does not save a stale break status as the one to restore', async () => {
        current = status(':hamburger:', 'Lunch break');
        await showBreakOnSlack(uid, 'tea');
        expect(updateOne).toHaveBeenCalledWith({ _id: uid }, { $set: { slack_status_restore: null } });
    });

    it('never throws when Slack is down', async () => {
        fetchMock.mockRejectedValueOnce(new Error('network'));
        await expect(showBreakOnSlack(uid, 'lunch')).resolves.toBeUndefined();
    });
});

describe('clearBreakFromSlack', () => {
    const saved = (s: unknown) => findOneAndUpdate.mockReturnValue({ lean: async () => ({ slack_status_restore: s }) });

    it('puts back the saved status while Slack still shows the break', async () => {
        const own = status(':house_with_garden:', 'Working remotely');
        saved(own);
        current = status(':coffee:', 'Tea break');
        await clearBreakFromSlack(uid);
        expect(sets).toEqual([own]);
    });

    it('clears the status when nothing was saved (break started from the Slack status)', async () => {
        saved(null);
        current = status(':hamburger:', 'Lunch');
        await clearBreakFromSlack(uid);
        expect(sets).toEqual([status('', '')]);
    });

    it('clears instead of restoring a saved status that has since expired', async () => {
        saved(status(':spiral_calendar_pad:', 'In a meeting', 1000));
        current = status(':coffee:', 'Tea break');
        await clearBreakFromSlack(uid);
        expect(sets).toEqual([status('', '')]);
    });

    it('leaves Slack alone if the user already set something else themselves', async () => {
        saved(status(':house_with_garden:', 'Working remotely'));
        current = status(':spiral_calendar_pad:', 'In a meeting');
        await clearBreakFromSlack(uid);
        expect(sets).toEqual([]);
    });
});
