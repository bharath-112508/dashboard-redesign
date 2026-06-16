import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const findOneMock = vi.fn();
const findByIdAndUpdateMock = vi.fn();

vi.mock('../models/user.model.js', () => ({
    User: {
        findOne: findOneMock,
        findByIdAndUpdate: findByIdAndUpdateMock,
    },
}));

const { resolveSlackUser, resolveSlackIdByEmail } = await import('./slack-user-mapping.service.js');

/**
 * Phase 0 — Slack-user → Viljetech-user resolution.
 *
 * Strategy:
 *   1. Look up by `User.slack_user_id` (O(1), populated on prior
 *      successful resolves).
 *   2. Fall back to Slack's `users.info` for the email, match against
 *      `User.email`, and persist `slack_user_id` back so the next call
 *      short-circuits at step 1.
 *   3. Return null when no match — the controller responds ephemeral
 *      "Couldn't identify your Viljetech account."
 */

const fakeUser = (overrides: Record<string, unknown> = {}) => ({
    _id: 'u1',
    email: 'alice@example.com',
    slack_user_id: 'U123ABC',
    role: 'manager',
    ...overrides,
});

describe('resolveSlackUser', () => {
    beforeEach(() => {
        findOneMock.mockReset();
        findByIdAndUpdateMock.mockReset();
    });

    it('returns the user when slack_user_id is already mapped (no Slack API call)', async () => {
        findOneMock.mockResolvedValueOnce(fakeUser());
        const fetchUserInfo = vi.fn();

        const result = await resolveSlackUser('U123ABC', { botToken: 'xoxb', fetchUserInfo });

        expect(result?._id).toBe('u1');
        expect(fetchUserInfo).not.toHaveBeenCalled();
        expect(findByIdAndUpdateMock).not.toHaveBeenCalled();
    });

    it('falls back to users.info → email match → persists slack_user_id', async () => {
        // First findOne (by slack_user_id) returns null
        findOneMock.mockResolvedValueOnce(null);
        // Second findOne (by email) returns the user with no slack_user_id yet
        findOneMock.mockResolvedValueOnce(fakeUser({ slack_user_id: null }));
        findByIdAndUpdateMock.mockResolvedValueOnce(fakeUser());

        const fetchUserInfo = vi
            .fn()
            .mockResolvedValueOnce({ email: 'alice@example.com' });

        const result = await resolveSlackUser('U999NEW', {
            botToken: 'xoxb',
            fetchUserInfo,
        });

        expect(result?._id).toBe('u1');
        expect(fetchUserInfo).toHaveBeenCalledWith('U999NEW', 'xoxb');
        expect(findByIdAndUpdateMock).toHaveBeenCalledWith('u1', {
            slack_user_id: 'U999NEW',
        });
    });

    it('returns null when users.info returns an email with no matching user', async () => {
        findOneMock.mockResolvedValueOnce(null);
        findOneMock.mockResolvedValueOnce(null);
        const fetchUserInfo = vi
            .fn()
            .mockResolvedValueOnce({ email: 'unknown@example.com' });

        const result = await resolveSlackUser('U999NEW', { botToken: 'xoxb', fetchUserInfo });
        expect(result).toBeNull();
        expect(findByIdAndUpdateMock).not.toHaveBeenCalled();
    });

    it('returns null when users.info throws / fails', async () => {
        findOneMock.mockResolvedValueOnce(null);
        const fetchUserInfo = vi.fn().mockRejectedValueOnce(new Error('Slack API down'));

        const result = await resolveSlackUser('U999NEW', { botToken: 'xoxb', fetchUserInfo });
        expect(result).toBeNull();
    });
});

afterEach(() => vi.restoreAllMocks());

describe('resolveSlackIdByEmail', () => {
    it('returns the Slack user id on ok=true', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            new Response(JSON.stringify({ ok: true, user: { id: 'U777' } }), { status: 200 })
        );
        await expect(resolveSlackIdByEmail('a@b.com', 'xoxb-x')).resolves.toBe('U777');
    });

    it('returns null on ok=false (e.g. users_not_found)', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            new Response(JSON.stringify({ ok: false, error: 'users_not_found' }), { status: 200 })
        );
        await expect(resolveSlackIdByEmail('a@b.com', 'xoxb-x')).resolves.toBeNull();
    });

    it('returns null and never throws on network error', async () => {
        vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('boom'));
        await expect(resolveSlackIdByEmail('a@b.com', 'xoxb-x')).resolves.toBeNull();
    });
});
