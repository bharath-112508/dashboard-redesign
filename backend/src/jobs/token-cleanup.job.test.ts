import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * Unit tests for `cleanupTokens` (Step 14.4).
 *
 * Coverage:
 *  1. Refresh + reset deletes are filtered by `expires_at < now` only
 *     (the TTL backstop never touches still-valid rows even if revoked).
 *  2. Counts from the two collections flow into the summary verbatim.
 *  3. Both collections are queried — even if one returns zero.
 */

const { refreshDeleteManyMock, resetDeleteManyMock } = vi.hoisted(() => ({
    refreshDeleteManyMock: vi.fn(),
    resetDeleteManyMock: vi.fn(),
}));

vi.mock('../models/refresh-token.model.js', () => ({
    RefreshToken: { deleteMany: refreshDeleteManyMock },
}));

vi.mock('../models/password-reset-token.model.js', () => ({
    PasswordResetToken: { deleteMany: resetDeleteManyMock },
}));

const { cleanupTokens } = await import('./token-cleanup.job.js');

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Parameters<typeof cleanupTokens>[1];

beforeEach(() => {
    refreshDeleteManyMock.mockReset();
    resetDeleteManyMock.mockReset();
});

describe('cleanupTokens', () => {
    it('deletes both collections by `expires_at < now` and folds counts into the summary', async () => {
        const now = new Date('2026-04-26T02:00:00Z');
        refreshDeleteManyMock.mockResolvedValueOnce({ deletedCount: 7 });
        resetDeleteManyMock.mockResolvedValueOnce({ deletedCount: 3 });

        const summary = await cleanupTokens(now, log);

        expect(refreshDeleteManyMock).toHaveBeenCalledWith({ expires_at: { $lt: now } });
        expect(resetDeleteManyMock).toHaveBeenCalledWith({ expires_at: { $lt: now } });
        expect(summary).toEqual({
            refresh_tokens_deleted: 7,
            password_reset_tokens_deleted: 3,
        });
    });

    it('returns zeros when nothing is past expiry', async () => {
        refreshDeleteManyMock.mockResolvedValueOnce({ deletedCount: 0 });
        resetDeleteManyMock.mockResolvedValueOnce({ deletedCount: 0 });

        const summary = await cleanupTokens(new Date(), log);

        expect(summary.refresh_tokens_deleted).toBe(0);
        expect(summary.password_reset_tokens_deleted).toBe(0);
    });
});
