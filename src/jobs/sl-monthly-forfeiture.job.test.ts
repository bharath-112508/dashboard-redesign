import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Types } from 'mongoose';

/**
 * Unit tests for `forfeitSlForMonth` (Step 14.2) — the pure logic of the
 * monthly SL forfeiture job.
 *
 * Coverage:
 *  1. No active SL leave-type → graceful skip (no DB writes).
 *  2. User used 0 SL days → forfeiture row inserted + balance row decremented.
 *  3. User who already used SL this month → skipped, no insert.
 *  4. Existing forfeiture row (E11000 on insert) → counted as
 *     `already_forfeited`, balance untouched.
 *  5. Per-user errors are counted, not thrown.
 *  6. `available` is recomputed via `recomputeAvailable` so the dashboard
 *     reads the right number after the run.
 */

const { leaveTypeFindOneMock, leaveRequestFindMock, userCursorMock, forfeitureCreateMock, leaveBalanceFindOneMock } =
    vi.hoisted(() => ({
        leaveTypeFindOneMock: vi.fn(),
        leaveRequestFindMock: vi.fn(),
        userCursorMock: vi.fn(),
        forfeitureCreateMock: vi.fn(),
        leaveBalanceFindOneMock: vi.fn(),
    }));

vi.mock('../models/leave-type.model.js', () => ({
    LeaveType: { findOne: leaveTypeFindOneMock },
}));

vi.mock('../models/leave-request.model.js', () => ({
    LeaveRequest: { find: leaveRequestFindMock },
}));

vi.mock('../models/user.model.js', () => ({
    User: {
        find: () => ({
            select: () => ({
                batchSize: () => ({
                    cursor: () => userCursorMock(),
                }),
            }),
        }),
    },
}));

vi.mock('../models/sl-monthly-forfeiture.model.js', () => ({
    SlMonthlyForfeiture: { create: forfeitureCreateMock },
}));

vi.mock('../models/leave-balance.model.js', () => ({
    LeaveBalance: { findOne: leaveBalanceFindOneMock },
    recomputeAvailable: (b: { allocated: number; monthly_forfeited: number; used: number }) =>
        (b.allocated || 0) - (b.used || 0) - (b.monthly_forfeited || 0),
}));

const { forfeitSlForMonth } = await import('./sl-monthly-forfeiture.job.js');

const log = { warn: vi.fn(), info: vi.fn(), error: vi.fn() } as unknown as Parameters<typeof forfeitSlForMonth>[2];

const queryStub = (rows: unknown[]) => ({
    select: () => Promise.resolve(rows),
});

const cursorOf = (users: { _id: Types.ObjectId }[]) => ({
    async *[Symbol.asyncIterator]() {
        for (const u of users) yield u;
    },
});

const slType = (): { _id: Types.ObjectId; monthly_cap: number; code: string } => ({
    _id: new Types.ObjectId(),
    monthly_cap: 1,
    code: 'SL',
});

beforeEach(() => {
    leaveTypeFindOneMock.mockReset();
    leaveRequestFindMock.mockReset();
    userCursorMock.mockReset();
    forfeitureCreateMock.mockReset();
    leaveBalanceFindOneMock.mockReset();

    leaveRequestFindMock.mockReturnValue(queryStub([]));
    userCursorMock.mockReturnValue(cursorOf([]));
});

describe('forfeitSlForMonth', () => {
    it('skips with a warning when no eligible SL leave type is configured', async () => {
        leaveTypeFindOneMock.mockResolvedValueOnce(null);

        const summary = await forfeitSlForMonth(2026, 4, log);

        expect(summary.forfeited_users).toBe(0);
        expect(summary.users_processed).toBe(0);
        expect(forfeitureCreateMock).not.toHaveBeenCalled();
    });

    it('forfeits the monthly cap for a user who used 0 SL', async () => {
        const sl = slType();
        leaveTypeFindOneMock.mockResolvedValueOnce(sl);

        const u = { _id: new Types.ObjectId() };
        userCursorMock.mockReturnValueOnce(cursorOf([u]));
        forfeitureCreateMock.mockResolvedValueOnce({});

        const balance = {
            allocated: 12,
            used: 2,
            monthly_forfeited: 1,
            available: 9,
            save: vi.fn().mockResolvedValue(undefined),
        };
        leaveBalanceFindOneMock.mockResolvedValueOnce(balance);

        const summary = await forfeitSlForMonth(2026, 4, log);

        expect(summary.forfeited_users).toBe(1);
        expect(summary.skipped_used_sl).toBe(0);
        expect(forfeitureCreateMock).toHaveBeenCalledWith(
            expect.objectContaining({
                user_id: u._id,
                year: 2026,
                month: 4,
                forfeited_days: 1,
            })
        );
        expect(balance.monthly_forfeited).toBe(2);
        // recomputeAvailable mock = allocated - used - monthly_forfeited.
        expect(balance.available).toBe(12 - 2 - 2);
        expect(balance.save).toHaveBeenCalledOnce();
    });

    it('skips users who already used at least one SL day this month', async () => {
        const sl = slType();
        leaveTypeFindOneMock.mockResolvedValueOnce(sl);

        const u = { _id: new Types.ObjectId() };
        leaveRequestFindMock.mockReturnValueOnce(queryStub([{ user_id: u._id }]));
        userCursorMock.mockReturnValueOnce(cursorOf([u]));

        const summary = await forfeitSlForMonth(2026, 4, log);

        expect(summary.skipped_used_sl).toBe(1);
        expect(summary.forfeited_users).toBe(0);
        expect(forfeitureCreateMock).not.toHaveBeenCalled();
    });

    it('treats E11000 on the forfeiture insert as already_forfeited and skips balance update', async () => {
        const sl = slType();
        leaveTypeFindOneMock.mockResolvedValueOnce(sl);

        const u = { _id: new Types.ObjectId() };
        userCursorMock.mockReturnValueOnce(cursorOf([u]));

        const dupErr = Object.assign(new Error('dup'), { code: 11000 });
        forfeitureCreateMock.mockRejectedValueOnce(dupErr);

        const summary = await forfeitSlForMonth(2026, 4, log);

        expect(summary.already_forfeited).toBe(1);
        expect(summary.forfeited_users).toBe(0);
        expect(leaveBalanceFindOneMock).not.toHaveBeenCalled();
    });

    it('counts non-duplicate insert failures as errors and continues', async () => {
        const sl = slType();
        leaveTypeFindOneMock.mockResolvedValueOnce(sl);

        userCursorMock.mockReturnValueOnce(cursorOf([{ _id: new Types.ObjectId() }, { _id: new Types.ObjectId() }]));
        forfeitureCreateMock.mockRejectedValueOnce(new Error('mongo blip')).mockResolvedValueOnce({});
        leaveBalanceFindOneMock.mockResolvedValue(null);

        const summary = await forfeitSlForMonth(2026, 4, log);

        expect(summary.users_processed).toBe(2);
        expect(summary.errors).toBe(1);
        expect(summary.forfeited_users).toBe(1);
    });
});
