import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * Tests for the R10 replay guard — `consumeMfaSessionJti` and the
 * `MfaSessionReplayError` it throws on duplicate JTI inserts.
 */

const { createMock } = vi.hoisted(() => ({
    createMock: vi.fn(),
}));

vi.mock('../models/mfa-session-used-jti.model.js', () => ({
    MfaSessionUsedJti: { create: createMock },
}));

const { consumeMfaSessionJti, MfaSessionReplayError } = await import('./mfa-session.js');

beforeEach(() => {
    createMock.mockReset();
});

describe('consumeMfaSessionJti (R10)', () => {
    it('inserts a row with the JTI + expiry on first use', async () => {
        createMock.mockResolvedValueOnce({});
        const expiresAt = new Date('2026-05-05T11:05:00Z');

        await consumeMfaSessionJti('01HXXXX', expiresAt);

        expect(createMock).toHaveBeenCalledWith({
            jti: '01HXXXX',
            expires_at: expiresAt,
        });
    });

    it('throws MfaSessionReplayError on E11000 (duplicate JTI)', async () => {
        const dupErr = Object.assign(new Error('dup'), { code: 11000 });
        createMock.mockRejectedValueOnce(dupErr);

        await expect(consumeMfaSessionJti('01HXXXX', new Date())).rejects.toThrow(MfaSessionReplayError);
    });

    it('rethrows non-E11000 errors unchanged', async () => {
        const otherErr = new Error('mongo down');
        createMock.mockRejectedValueOnce(otherErr);

        await expect(consumeMfaSessionJti('01HXXXX', new Date())).rejects.toThrow('mongo down');
    });

    it('a real replay sequence: first call succeeds, second throws', async () => {
        createMock.mockResolvedValueOnce({});
        const dupErr = Object.assign(new Error('dup'), { code: 11000 });
        createMock.mockRejectedValueOnce(dupErr);
        const exp = new Date(Date.now() + 60_000);

        await consumeMfaSessionJti('01HXXXX', exp);
        await expect(consumeMfaSessionJti('01HXXXX', exp)).rejects.toThrow(MfaSessionReplayError);
    });
});
