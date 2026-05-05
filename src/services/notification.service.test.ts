import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Types } from 'mongoose';

/**
 * Coverage focus for `notification.service` — the bell endpoint that
 * every employee hits multiple times per session:
 *
 *   1. **Owner-scoped reads.** Every query is filtered by `user_id =
 *      caller.id`. A regression that dropped the filter would let
 *      User A list User B's notifications.
 *   2. **`markRead` is atomic + idempotent.** First call flips the
 *      flag and stamps `read_at`; second call on an already-read row
 *      returns the existing row (200, not a 4xx). A 404 is reserved
 *      for the "not yours OR doesn't exist" case (we don't differentiate
 *      so the bell can't be used as an existence probe).
 *   3. **`markAllRead` returns a count of actually-flipped rows** —
 *      the FE uses this to know whether to update the badge.
 *   4. **`dismissNotification` is owner-scoped** — same 404-as-existence-
 *      probe defence as markRead.
 *   5. **`unreadCount` filters by `is_read: false`** — used by the
 *      employee dashboard's badge count.
 */

const {
    notificationFindMock,
    notificationCountDocumentsMock,
    notificationFindOneMock,
    notificationFindOneAndUpdateMock,
    notificationFindOneAndDeleteMock,
    notificationUpdateManyMock,
} = vi.hoisted(() => ({
    notificationFindMock: vi.fn(),
    notificationCountDocumentsMock: vi.fn(),
    notificationFindOneMock: vi.fn(),
    notificationFindOneAndUpdateMock: vi.fn(),
    notificationFindOneAndDeleteMock: vi.fn(),
    notificationUpdateManyMock: vi.fn(),
}));

vi.mock('../models/notification.model.js', () => ({
    Notification: {
        find: notificationFindMock,
        countDocuments: notificationCountDocumentsMock,
        findOne: notificationFindOneMock,
        findOneAndUpdate: notificationFindOneAndUpdateMock,
        findOneAndDelete: notificationFindOneAndDeleteMock,
        updateMany: notificationUpdateManyMock,
    },
}));

const svc = await import('./notification.service.js');
import { ERROR_CODES } from '../constants/error-codes.js';

const makeNotification = (overrides: Record<string, unknown> = {}) => ({
    _id: new Types.ObjectId(),
    user_id: new Types.ObjectId(),
    type: 'leave.submitted',
    title: 'Leave submitted',
    body: 'Your leave was submitted',
    is_read: false,
    read_at: null as Date | null,
    toJSON() {
        return {
            id: this._id.toString(),
            user_id: this.user_id.toString(),
            type: this.type,
            is_read: this.is_read,
            read_at: this.read_at,
        };
    },
    ...overrides,
});

beforeEach(() => {
    vi.resetAllMocks();
});

// ─── listNotifications ───────────────────────────────────────────────────

describe('listNotifications', () => {
    it('owner-scoping — every query filters by `user_id = caller.id`', async () => {
        // The cardinal property: Notification.find / countDocuments must
        // BOTH see the caller's user_id in the filter. A regression that
        // dropped the filter would let one user list another's bell feed.
        const callerId = new Types.ObjectId();
        notificationFindMock.mockReturnValueOnce({
            sort: () => ({
                skip: () => ({
                    limit: () => Promise.resolve([]),
                }),
            }),
        });
        notificationCountDocumentsMock.mockResolvedValueOnce(0);

        await svc.listNotifications({ page: 1, limit: 20 }, callerId);

        // Both calls' filters carry the caller_id.
        expect(notificationFindMock).toHaveBeenCalledWith(expect.objectContaining({ user_id: callerId }));
        expect(notificationCountDocumentsMock).toHaveBeenCalledWith(expect.objectContaining({ user_id: callerId }));
    });

    it('threads `is_read` and `type` filters into the query when provided', async () => {
        const callerId = new Types.ObjectId();
        notificationFindMock.mockReturnValueOnce({
            sort: () => ({ skip: () => ({ limit: () => Promise.resolve([]) }) }),
        });
        notificationCountDocumentsMock.mockResolvedValueOnce(0);

        await svc.listNotifications({ page: 1, limit: 20, is_read: false, type: 'leave.submitted' }, callerId);

        expect(notificationFindMock).toHaveBeenCalledWith(
            expect.objectContaining({ user_id: callerId, is_read: false, type: 'leave.submitted' })
        );
    });

    it('paginates with skip = (page-1) * limit and total_pages from countDocuments', async () => {
        const callerId = new Types.ObjectId();
        const skipMock = vi.fn().mockReturnValue({ limit: () => Promise.resolve([]) });
        notificationFindMock.mockReturnValueOnce({
            sort: () => ({ skip: skipMock }),
        });
        notificationCountDocumentsMock.mockResolvedValueOnce(137);

        const result = await svc.listNotifications({ page: 3, limit: 50 }, callerId);

        // page=3, limit=50 → skip 100.
        expect(skipMock).toHaveBeenCalledWith(100);
        expect(result.meta).toMatchObject({
            page: 3,
            limit: 50,
            total: 137,
            total_pages: 3, // ceil(137/50)
        });
    });
});

// ─── unreadCount ─────────────────────────────────────────────────────────

describe('unreadCount', () => {
    it('counts only unread for the caller', async () => {
        const callerId = new Types.ObjectId();
        notificationCountDocumentsMock.mockResolvedValueOnce(7);

        const count = await svc.unreadCount(callerId);

        expect(count).toBe(7);
        expect(notificationCountDocumentsMock).toHaveBeenCalledWith({ user_id: callerId, is_read: false });
    });
});

// ─── markRead ────────────────────────────────────────────────────────────

describe('markRead', () => {
    it('atomically flips is_read=true + stamps read_at on the transition', async () => {
        // The atomic conditional is the whole point — `findOneAndUpdate`
        // with `is_read: false` in the filter ensures `read_at` is only
        // stamped on the first read, not on subsequent re-marks.
        const callerId = new Types.ObjectId();
        const id = new Types.ObjectId();
        const updated = makeNotification({ _id: id, user_id: callerId, is_read: true, read_at: new Date() });
        notificationFindOneAndUpdateMock.mockResolvedValueOnce(updated);

        const result = await svc.markRead(id, callerId);

        expect(notificationFindOneAndUpdateMock).toHaveBeenCalledWith(
            { _id: id, user_id: callerId, is_read: false },
            { $set: { is_read: true, read_at: expect.any(Date) } },
            { new: true }
        );
        expect(result).toMatchObject({ is_read: true });
    });

    it('idempotent — re-marking an already-read row returns the current row (200, no error)', async () => {
        // Pre-existing contract: the FE fires markRead optimistically;
        // a second call from another tab must NOT 4xx.
        const callerId = new Types.ObjectId();
        const id = new Types.ObjectId();
        // First conditional update finds nothing (already read).
        notificationFindOneAndUpdateMock.mockResolvedValueOnce(null);
        // Fallback findOne returns the already-read row.
        const existing = makeNotification({
            _id: id,
            user_id: callerId,
            is_read: true,
            read_at: new Date(2026, 0, 1),
        });
        notificationFindOneMock.mockResolvedValueOnce(existing);

        const result = await svc.markRead(id, callerId);
        expect(result).toMatchObject({ is_read: true });
    });

    it('returns 404 RESOURCE_NOT_FOUND when the row does not exist OR belongs to another user', async () => {
        // The defence: we don't differentiate "doesn't exist" from "not
        // yours" — same 404 either way so the bell can't be used as an
        // existence probe across users.
        const callerId = new Types.ObjectId();
        notificationFindOneAndUpdateMock.mockResolvedValueOnce(null);
        notificationFindOneMock.mockResolvedValueOnce(null);

        await expect(svc.markRead(new Types.ObjectId(), callerId)).rejects.toMatchObject({
            code: ERROR_CODES.RESOURCE_NOT_FOUND,
            statusCode: 404,
        });
    });
});

// ─── markAllRead ─────────────────────────────────────────────────────────

describe('markAllRead', () => {
    it('flips every unread row for the caller and returns the modified count', async () => {
        const callerId = new Types.ObjectId();
        notificationUpdateManyMock.mockResolvedValueOnce({ acknowledged: true, modifiedCount: 5 });

        const result = await svc.markAllRead(callerId);

        expect(result).toEqual({ updated: 5 });
        expect(notificationUpdateManyMock).toHaveBeenCalledWith(
            { user_id: callerId, is_read: false },
            { $set: { is_read: true, read_at: expect.any(Date) } }
        );
    });

    it('returns updated:0 when there are no unread rows (no error)', async () => {
        // The FE fires this on tab focus; "nothing to do" is the most
        // common case and must NOT throw.
        notificationUpdateManyMock.mockResolvedValueOnce({ acknowledged: true, modifiedCount: 0 });
        await expect(svc.markAllRead(new Types.ObjectId())).resolves.toEqual({ updated: 0 });
    });
});

// ─── dismissNotification ─────────────────────────────────────────────────

describe('dismissNotification', () => {
    it('owner-scoped delete — passes user_id in the filter', async () => {
        const callerId = new Types.ObjectId();
        const id = new Types.ObjectId();
        notificationFindOneAndDeleteMock.mockResolvedValueOnce(makeNotification({ _id: id, user_id: callerId }));

        await svc.dismissNotification(id, callerId);

        expect(notificationFindOneAndDeleteMock).toHaveBeenCalledWith({ _id: id, user_id: callerId });
    });

    it('returns 404 when the row does not exist OR belongs to another user (no existence-probe leak)', async () => {
        notificationFindOneAndDeleteMock.mockResolvedValueOnce(null);

        await expect(svc.dismissNotification(new Types.ObjectId(), new Types.ObjectId())).rejects.toMatchObject({
            code: ERROR_CODES.RESOURCE_NOT_FOUND,
            statusCode: 404,
        });
    });
});
