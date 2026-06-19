import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const findOneMock = vi.fn();
const findByIdAndUpdateMock = vi.fn();
const updateManyMock = vi.fn();

vi.mock('../models/user.model.js', () => ({
    User: {
        findOne: findOneMock,
        findByIdAndUpdate: findByIdAndUpdateMock,
        updateMany: updateManyMock,
    },
}));

const { resolveSlackUser, resolveSlackIdByEmail, fetchSlackAvatarUrl, fetchSlackUserInfo } =
    await import('./slack-user-mapping.service.js');

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
        updateManyMock.mockReset();
        updateManyMock.mockResolvedValue({ acknowledged: true, modifiedCount: 0 });
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

        const fetchUserInfo = vi.fn().mockResolvedValueOnce({ email: 'alice@example.com' });

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

    it('steals the slack_user_id from any other user before persisting (no duplicate mappings)', async () => {
        // Email match resolves to u1; another row (the old admin) still holds
        // the same slack_user_id. The resolver must null it out on the others
        // so findOne can never return the wrong user next time.
        findOneMock.mockResolvedValueOnce(null);
        findOneMock.mockResolvedValueOnce(fakeUser({ slack_user_id: null }));
        findByIdAndUpdateMock.mockResolvedValueOnce(fakeUser());
        const fetchUserInfo = vi.fn().mockResolvedValueOnce({ email: 'alice@example.com' });

        await resolveSlackUser('U999NEW', { botToken: 'xoxb', fetchUserInfo });

        expect(updateManyMock).toHaveBeenCalledWith(
            { slack_user_id: 'U999NEW', _id: { $ne: 'u1' } },
            { $set: { slack_user_id: null } }
        );
    });

    it('persists slack_avatar_url too when users.info returns an avatar', async () => {
        findOneMock.mockResolvedValueOnce(null);
        findOneMock.mockResolvedValueOnce(fakeUser({ slack_user_id: null }));
        findByIdAndUpdateMock.mockResolvedValueOnce(fakeUser());
        const fetchUserInfo = vi
            .fn()
            .mockResolvedValueOnce({ email: 'alice@example.com', avatar_url: 'https://a/av.png' });

        await resolveSlackUser('U999NEW', { botToken: 'xoxb', fetchUserInfo });

        expect(findByIdAndUpdateMock).toHaveBeenCalledWith('u1', {
            slack_user_id: 'U999NEW',
            slack_avatar_url: 'https://a/av.png',
        });
    });

    it('returns null when users.info returns an email with no matching user', async () => {
        findOneMock.mockResolvedValueOnce(null);
        findOneMock.mockResolvedValueOnce(null);
        const fetchUserInfo = vi.fn().mockResolvedValueOnce({ email: 'unknown@example.com' });

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
    it('returns {slackId, avatarUrl} on ok=true', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            new Response(JSON.stringify({ ok: true, user: { id: 'U777', profile: { image_72: 'https://a/x.png' } } }), {
                status: 200,
            })
        );
        await expect(resolveSlackIdByEmail('a@b.com', 'xoxb-x')).resolves.toEqual({
            slackId: 'U777',
            avatarUrl: 'https://a/x.png',
        });
    });
    it('returns avatarUrl null when profile has no image', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            new Response(JSON.stringify({ ok: true, user: { id: 'U777' } }), { status: 200 })
        );
        await expect(resolveSlackIdByEmail('a@b.com', 'xoxb-x')).resolves.toEqual({ slackId: 'U777', avatarUrl: null });
    });
    it('returns null on ok=false', async () => {
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

describe('fetchSlackUserInfo', () => {
    it('returns {email, avatar_url} parsing profile.image_72', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            new Response(
                JSON.stringify({ ok: true, user: { profile: { email: 'a@b.com', image_72: 'https://a/z.png' } } }),
                { status: 200 }
            )
        );
        await expect(fetchSlackUserInfo('U1', 'xoxb-x')).resolves.toEqual({
            email: 'a@b.com',
            avatar_url: 'https://a/z.png',
        });
    });
    it('returns avatar_url null when image_72 is absent', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            new Response(JSON.stringify({ ok: true, user: { profile: { email: 'a@b.com' } } }), { status: 200 })
        );
        await expect(fetchSlackUserInfo('U1', 'xoxb-x')).resolves.toEqual({ email: 'a@b.com', avatar_url: null });
    });
});

describe('fetchSlackAvatarUrl', () => {
    it('returns image_72 on ok=true', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            new Response(JSON.stringify({ ok: true, user: { profile: { image_72: 'https://a/y.png' } } }), {
                status: 200,
            })
        );
        await expect(fetchSlackAvatarUrl('U1', 'xoxb-x')).resolves.toBe('https://a/y.png');
    });
    it('returns null on ok=false', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ok: false }), { status: 200 }));
        await expect(fetchSlackAvatarUrl('U1', 'xoxb-x')).resolves.toBeNull();
    });
});
