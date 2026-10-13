import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * Unit tests for `rolloverLeaveYear` (Step 14.3).
 *
 * The job is a thin wrapper around `initializeYearForAllUsers`, so the
 * focus here is:
 *  1. The wrapped service is called with the right `year` argument.
 *  2. The result fields are forwarded into the job summary verbatim so
 *     the audit metadata captures `processed_users` / `total_inserted`.
 */

const { initializeYearForAllUsersMock } = vi.hoisted(() => ({
    initializeYearForAllUsersMock: vi.fn(),
}));

vi.mock('../services/leave-balance.service.js', () => ({
    initializeYearForAllUsers: initializeYearForAllUsersMock,
}));

const { rolloverLeaveYear } = await import('./leave-year-rollover.job.js');

const log = { warn: vi.fn(), info: vi.fn(), error: vi.fn() } as unknown as Parameters<typeof rolloverLeaveYear>[1];

beforeEach(() => {
    initializeYearForAllUsersMock.mockReset();
});

describe('rolloverLeaveYear', () => {
    it('delegates to initializeYearForAllUsers with the target year', async () => {
        initializeYearForAllUsersMock.mockResolvedValueOnce({
            year: 2027,
            processed_users: 25,
            total_inserted: 175,
        });

        const summary = await rolloverLeaveYear(2027, log);

        expect(initializeYearForAllUsersMock).toHaveBeenCalledWith({ year: 2027 });
        expect(summary.target_year).toBe(2027);
        expect(summary.processed_users).toBe(25);
        expect(summary.total_inserted).toBe(175);
    });

    it('reports zero counts when there are no eligible users', async () => {
        initializeYearForAllUsersMock.mockResolvedValueOnce({
            year: 2027,
            processed_users: 0,
            total_inserted: 0,
        });

        const summary = await rolloverLeaveYear(2027, log);

        expect(summary.processed_users).toBe(0);
        expect(summary.total_inserted).toBe(0);
    });
});
