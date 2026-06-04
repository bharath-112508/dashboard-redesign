import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Types } from 'mongoose';

/**
 * Unit tests for `utils/push.ts` (V2-BE-10).
 *
 * Coverage focus:
 *  1. `isPushConfigured` reads env vars on every call (no module-level
 *     caching → operators can hot-reload VAPID config without a process
 *     bounce).
 *  2. `sendPushNotification` returns true on 2xx, swallows transient
 *     errors, stamps `last_used_at` / `last_error_at`.
 *  3. 410 Gone / 404 Not Found from the push provider → row is auto-pruned
 *     (the central reason the helper exists in the first place).
 */

const { sendNotificationMock, updateOneMock, deleteOneMock, loggerWarnMock, loggerInfoMock, setVapidDetailsMock } =
    vi.hoisted(() => ({
        sendNotificationMock: vi.fn(),
        updateOneMock: vi.fn(),
        deleteOneMock: vi.fn(),
        loggerWarnMock: vi.fn(),
        loggerInfoMock: vi.fn(),
        setVapidDetailsMock: vi.fn(),
    }));

vi.mock('web-push', () => ({
    default: {
        sendNotification: sendNotificationMock,
        setVapidDetails: setVapidDetailsMock,
    },
}));

vi.mock('../models/push-subscription.model.js', () => ({
    PushSubscription: {
        updateOne: updateOneMock,
        deleteOne: deleteOneMock,
    },
}));

vi.mock('./logger.js', () => ({
    default: { warn: loggerWarnMock, info: loggerInfoMock },
}));

const push = await import('./push.js');

const makeSubscription = () => ({
    _id: new Types.ObjectId(),
    user_id: new Types.ObjectId(),
    endpoint: 'https://fcm.googleapis.com/fcm/send/test',
    keys: { p256dh: 'pkey', auth: 'akey' },
    user_agent: null,
    last_used_at: null,
    last_error_at: null,
    created_at: new Date(),
    updated_at: new Date(),
});

beforeEach(() => {
    sendNotificationMock.mockReset();
    updateOneMock.mockReset();
    deleteOneMock.mockReset();
    loggerWarnMock.mockReset();
    loggerInfoMock.mockReset();
    setVapidDetailsMock.mockReset();
    updateOneMock.mockResolvedValue({ modifiedCount: 1 });
    deleteOneMock.mockResolvedValue({ deletedCount: 1 });
    // VAPID env vars present by default
    process.env.VAPID_PUBLIC_KEY = 'pub';
    process.env.VAPID_PRIVATE_KEY = 'priv';
    process.env.VAPID_SUBJECT = 'mailto:test@viljetech.com';
});

describe('isPushConfigured', () => {
    it('returns true when all three VAPID env vars are present', () => {
        expect(push.isPushConfigured()).toBe(true);
    });

    it('returns false if any VAPID env var is missing', () => {
        delete process.env.VAPID_PUBLIC_KEY;
        expect(push.isPushConfigured()).toBe(false);
    });
});

describe('sendPushNotification', () => {
    it('returns true on a 2xx push send and stamps last_used_at', async () => {
        sendNotificationMock.mockResolvedValueOnce({ statusCode: 201 });

        const result = await push.sendPushNotification({
            subscription: makeSubscription() as unknown as Parameters<typeof push.sendPushNotification>[0]['subscription'],
            payload: { title: 'T', body: 'B', link_url: '/x', type: 'system' },
            context: 'test-event',
        });

        expect(result).toBe(true);
        expect(sendNotificationMock).toHaveBeenCalledOnce();
        expect(updateOneMock).toHaveBeenCalledWith(
            expect.objectContaining({ _id: expect.any(Object) }),
            expect.objectContaining({ $set: expect.objectContaining({ last_used_at: expect.any(Date) }) })
        );
        expect(deleteOneMock).not.toHaveBeenCalled();
    });

    it('auto-prunes the subscription row when the push provider returns 410 Gone', async () => {
        const err = Object.assign(new Error('Subscription expired'), { statusCode: 410 });
        sendNotificationMock.mockRejectedValueOnce(err);

        const result = await push.sendPushNotification({
            subscription: makeSubscription() as unknown as Parameters<typeof push.sendPushNotification>[0]['subscription'],
            payload: { title: 'T', body: 'B', link_url: '/x', type: 'system' },
            context: 'test-event',
        });

        expect(result).toBe(false);
        expect(deleteOneMock).toHaveBeenCalledOnce();
        expect(loggerInfoMock).toHaveBeenCalledWith(
            expect.objectContaining({ pruned: true, status: 410 }),
            'Push subscription expired, pruned'
        );
    });

    it('auto-prunes on 404 Not Found too', async () => {
        const err = Object.assign(new Error('Not found'), { statusCode: 404 });
        sendNotificationMock.mockRejectedValueOnce(err);

        await push.sendPushNotification({
            subscription: makeSubscription() as unknown as Parameters<typeof push.sendPushNotification>[0]['subscription'],
            payload: { title: 'T', body: 'B', link_url: '/x', type: 'system' },
            context: 'test-event',
        });

        expect(deleteOneMock).toHaveBeenCalledOnce();
    });

    it('stamps last_error_at without pruning on transient 5xx', async () => {
        const err = Object.assign(new Error('Bad gateway'), { statusCode: 502 });
        sendNotificationMock.mockRejectedValueOnce(err);

        const result = await push.sendPushNotification({
            subscription: makeSubscription() as unknown as Parameters<typeof push.sendPushNotification>[0]['subscription'],
            payload: { title: 'T', body: 'B', link_url: '/x', type: 'system' },
            context: 'test-event',
        });

        expect(result).toBe(false);
        expect(deleteOneMock).not.toHaveBeenCalled();
        expect(updateOneMock).toHaveBeenCalledWith(
            expect.objectContaining({ _id: expect.any(Object) }),
            expect.objectContaining({ $set: expect.objectContaining({ last_error_at: expect.any(Date) }) })
        );
        expect(loggerWarnMock).toHaveBeenCalledWith(
            expect.objectContaining({ status: 502 }),
            'Push send failed'
        );
    });
});
