import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Types } from 'mongoose';

/**
 * Unit tests for `push-subscription.service` (V2-BE-10).
 *
 * Coverage:
 *  - `upsertSubscription` uses `findOneAndUpdate` with the right scope
 *    keys + upsert flag (this is the idempotency primitive).
 *  - `deleteSubscriptionByEndpoint` is scoped to `(user_id, endpoint)`
 *    so one user can't accidentally clear another user's subscription.
 *  - `listSubscriptionsForUser` is owner-scoped on the find filter.
 */

const { findOneAndUpdateMock, deleteOneMock, findMock } = vi.hoisted(() => ({
    findOneAndUpdateMock: vi.fn(),
    deleteOneMock: vi.fn(),
    findMock: vi.fn(),
}));

vi.mock('../models/push-subscription.model.js', () => ({
    PushSubscription: {
        findOneAndUpdate: findOneAndUpdateMock,
        deleteOne: deleteOneMock,
        find: findMock,
    },
}));

const svc = await import('./push-subscription.service.js');

beforeEach(() => {
    findOneAndUpdateMock.mockReset();
    deleteOneMock.mockReset();
    findMock.mockReset();
});

describe('upsertSubscription', () => {
    it('queries by (user_id, endpoint) and upserts on insert', async () => {
        const userId = new Types.ObjectId();
        const endpoint = 'https://fcm.googleapis.com/fcm/send/abc';
        const created = { _id: new Types.ObjectId(), user_id: userId, endpoint };
        findOneAndUpdateMock.mockResolvedValueOnce(created);

        const out = await svc.upsertSubscription({
            user_id: userId,
            endpoint,
            keys: { p256dh: 'pkey', auth: 'akey' },
            user_agent: 'Mozilla/5.0',
        });

        expect(findOneAndUpdateMock).toHaveBeenCalledWith(
            { user_id: userId, endpoint },
            expect.objectContaining({
                $set: expect.objectContaining({
                    keys: { p256dh: 'pkey', auth: 'akey' },
                    user_agent: 'Mozilla/5.0',
                }),
                $setOnInsert: expect.objectContaining({
                    user_id: userId,
                    endpoint,
                }),
            }),
            expect.objectContaining({ upsert: true, new: true })
        );
        expect(out).toBe(created);
    });

    it('defaults user_agent to null when omitted', async () => {
        findOneAndUpdateMock.mockResolvedValueOnce({});
        await svc.upsertSubscription({
            user_id: new Types.ObjectId(),
            endpoint: 'https://x',
            keys: { p256dh: 'p', auth: 'a' },
        });
        const args = findOneAndUpdateMock.mock.calls[0]?.[1] as Record<string, unknown>;
        expect((args.$set as Record<string, unknown>).user_agent).toBeNull();
    });
});

describe('deleteSubscriptionByEndpoint', () => {
    it('scopes the delete to (user_id, endpoint) so one user cannot evict another', async () => {
        const userId = new Types.ObjectId();
        deleteOneMock.mockResolvedValueOnce({ deletedCount: 1 });

        const out = await svc.deleteSubscriptionByEndpoint(userId, 'https://e');

        expect(deleteOneMock).toHaveBeenCalledWith({ user_id: userId, endpoint: 'https://e' });
        expect(out).toEqual({ deleted: 1 });
    });

    it('reports deleted: 0 when no row matched (idempotent unsubscribe)', async () => {
        deleteOneMock.mockResolvedValueOnce({ deletedCount: 0 });
        const out = await svc.deleteSubscriptionByEndpoint(new Types.ObjectId(), 'https://e');
        expect(out).toEqual({ deleted: 0 });
    });
});

describe('listSubscriptionsForUser', () => {
    it('returns subscriptions filtered by user_id with .lean()', async () => {
        const userId = new Types.ObjectId();
        const rows = [{ _id: new Types.ObjectId(), user_id: userId }];
        const chain = { lean: () => Promise.resolve(rows) };
        findMock.mockReturnValueOnce(chain);

        const out = await svc.listSubscriptionsForUser(userId);

        expect(findMock).toHaveBeenCalledWith({ user_id: userId });
        expect(out).toEqual(rows);
    });
});
