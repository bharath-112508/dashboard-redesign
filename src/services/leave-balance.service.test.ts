import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Types } from 'mongoose';

/**
 * Unit tests for `leave-balance.service` (Step 15.1 gap-fill).
 *
 *  1. `roundHalf` — half-up rounding to 0.5 grid.
 *  2. `computeAllocation` — the pro-rata-on-join matrix:
 *       - unlimited / earned / event-based types → 0
 *       - joined before target year → full allocation
 *       - joined after target year  → 0
 *       - joined in target year → strategy applied:
 *           - by_months_remaining (CL)
 *           - sl_monthly_buckets   (SL)
 *           - none                  (no pro-rata)
 *  3. `initializeBalancesForUserYear` — uses `$setOnInsert` upserts and
 *     counts only freshly inserted rows; clients are skipped early.
 *  4. `adjustBalance` — bumps `adjusted` by `delta` and re-derives
 *     `available` via the model's `recomputeAvailable`.
 */

const {
    leaveBalanceUpdateOneMock,
    leaveBalanceFindByIdMock,
    leaveTypeFindMock,
    leaveTypeFindByIdMock,
    userFindByIdMock,
    recomputeAvailableMock,
} = vi.hoisted(() => ({
    leaveBalanceUpdateOneMock: vi.fn(),
    leaveBalanceFindByIdMock: vi.fn(),
    leaveTypeFindMock: vi.fn(),
    leaveTypeFindByIdMock: vi.fn(),
    userFindByIdMock: vi.fn(),
    recomputeAvailableMock: vi.fn(),
}));

vi.mock('../models/leave-balance.model.js', () => ({
    LeaveBalance: {
        updateOne: leaveBalanceUpdateOneMock,
        findById: leaveBalanceFindByIdMock,
        findOne: vi.fn(),
        find: vi.fn(),
    },
    recomputeAvailable: recomputeAvailableMock,
}));

vi.mock('../models/leave-type.model.js', () => ({
    LeaveType: { find: leaveTypeFindMock, findById: leaveTypeFindByIdMock },
}));

vi.mock('../models/sl-monthly-forfeiture.model.js', () => ({
    SlMonthlyForfeiture: { findOne: vi.fn() },
}));

vi.mock('../models/user.model.js', () => ({
    User: { findById: userFindByIdMock, find: vi.fn() },
}));

const svc = await import('./leave-balance.service.js');
import { ERROR_CODES } from '../constants/error-codes.js';
import { PRO_RATA_STRATEGIES } from '../constants/leave.js';
import { ROLES } from '../constants/roles.js';

const fullType = (overrides: Record<string, unknown> = {}) => ({
    _id: new Types.ObjectId(),
    code: 'CL',
    name: 'Casual Leave',
    is_active: true,
    is_unlimited: false,
    is_earned: false,
    is_event_based: false,
    default_allocation_days: 12,
    pro_rata_on_join: PRO_RATA_STRATEGIES.BY_MONTHS_REMAINING,
    monthly_cap: null,
    ...overrides,
});

beforeEach(() => {
    vi.resetAllMocks();
    leaveBalanceUpdateOneMock.mockResolvedValue({ upsertedCount: 1 });
    recomputeAvailableMock.mockImplementation(
        (b: {
            allocated: number;
            carried_forward: number;
            used: number;
            pending: number;
            adjusted: number;
            monthly_forfeited: number;
        }) => b.allocated + b.carried_forward + b.adjusted - b.used - b.pending - b.monthly_forfeited
    );
});

// ─── roundHalf ────────────────────────────────────────────────────────────

describe('roundHalf', () => {
    it('rounds to the nearest 0.5 step (half-up)', () => {
        expect(svc.roundHalf(7.4)).toBe(7.5);
        expect(svc.roundHalf(7.0)).toBe(7);
        expect(svc.roundHalf(7.25)).toBe(7.5);
        expect(svc.roundHalf(0)).toBe(0);
        expect(svc.roundHalf((15 * 6) / 12)).toBe(7.5);
    });
});

// ─── computeAllocation ────────────────────────────────────────────────────

describe('computeAllocation', () => {
    it('returns 0 for unlimited / earned / event-based types', () => {
        expect(
            svc.computeAllocation({
                leaveType: fullType({ is_unlimited: true }),
                joiningYear: 2024,
                joiningMonth: 1,
                targetYear: 2026,
            })
        ).toBe(0);
        expect(
            svc.computeAllocation({
                leaveType: fullType({ is_earned: true }),
                joiningYear: 2024,
                joiningMonth: 1,
                targetYear: 2026,
            })
        ).toBe(0);
        expect(
            svc.computeAllocation({
                leaveType: fullType({ is_event_based: true }),
                joiningYear: 2024,
                joiningMonth: 1,
                targetYear: 2026,
            })
        ).toBe(0);
    });

    it('returns 0 when default_allocation_days is 0 (e.g. WFH/Maternity)', () => {
        expect(
            svc.computeAllocation({
                leaveType: fullType({ default_allocation_days: 0 }),
                joiningYear: 2024,
                joiningMonth: 1,
                targetYear: 2026,
            })
        ).toBe(0);
    });

    it('returns full allocation when joined in a prior year', () => {
        expect(
            svc.computeAllocation({
                leaveType: fullType({ default_allocation_days: 12 }),
                joiningYear: 2024,
                joiningMonth: 6,
                targetYear: 2026,
            })
        ).toBe(12);
    });

    it('returns 0 when joining year is in the future', () => {
        expect(
            svc.computeAllocation({
                leaveType: fullType(),
                joiningYear: 2027,
                joiningMonth: 1,
                targetYear: 2026,
            })
        ).toBe(0);
    });

    it('mid-year join with BY_MONTHS_REMAINING — round_half(15 × (13−7)/12) = 7.5', () => {
        expect(
            svc.computeAllocation({
                leaveType: fullType({
                    default_allocation_days: 15,
                    pro_rata_on_join: PRO_RATA_STRATEGIES.BY_MONTHS_REMAINING,
                }),
                joiningYear: 2026,
                joiningMonth: 7,
                targetYear: 2026,
            })
        ).toBe(7.5);
    });

    it('mid-year join with SL_MONTHLY_BUCKETS — caps at one slot per remaining month (joined month 4 → 9)', () => {
        expect(
            svc.computeAllocation({
                leaveType: fullType({
                    code: 'SL',
                    default_allocation_days: 12,
                    pro_rata_on_join: PRO_RATA_STRATEGIES.SL_MONTHLY_BUCKETS,
                }),
                joiningYear: 2026,
                joiningMonth: 4,
                targetYear: 2026,
            })
        ).toBe(9);
    });

    it('mid-year join with NONE strategy keeps the full allocation', () => {
        expect(
            svc.computeAllocation({
                leaveType: fullType({
                    default_allocation_days: 5,
                    pro_rata_on_join: PRO_RATA_STRATEGIES.NONE,
                }),
                joiningYear: 2026,
                joiningMonth: 9,
                targetYear: 2026,
            })
        ).toBe(5);
    });

    it('joined in December returns the appropriate single-month sliver', () => {
        expect(
            svc.computeAllocation({
                leaveType: fullType({
                    default_allocation_days: 12,
                    pro_rata_on_join: PRO_RATA_STRATEGIES.BY_MONTHS_REMAINING,
                }),
                joiningYear: 2026,
                joiningMonth: 12,
                targetYear: 2026,
            })
        ).toBe(1);
    });
});

// ─── initializeBalancesForUserYear ────────────────────────────────────────

describe('initializeBalancesForUserYear', () => {
    it('skips clients early (no DB writes)', async () => {
        userFindByIdMock.mockReturnValueOnce({
            select: () =>
                Promise.resolve({
                    role: ROLES.CLIENT,
                    status: 'active',
                    internal_profile: null,
                }),
        });

        const inserted = await svc.initializeBalancesForUserYear({
            user_id: new Types.ObjectId(),
            year: 2026,
        });

        expect(inserted).toBe(0);
        expect(leaveTypeFindMock).not.toHaveBeenCalled();
        expect(leaveBalanceUpdateOneMock).not.toHaveBeenCalled();
    });

    it('inserts one row per active type, counting only fresh upserts', async () => {
        userFindByIdMock.mockReturnValueOnce({
            select: () =>
                Promise.resolve({
                    role: ROLES.EMPLOYEE,
                    status: 'active',
                    internal_profile: { date_of_joining: '2024-06-15' },
                }),
        });
        const types = [
            fullType({ code: 'CL', default_allocation_days: 12 }),
            fullType({
                code: 'SL',
                pro_rata_on_join: PRO_RATA_STRATEGIES.SL_MONTHLY_BUCKETS,
                default_allocation_days: 12,
            }),
            fullType({ code: 'WFH', default_allocation_days: 0 }),
        ];
        leaveTypeFindMock.mockResolvedValueOnce(types);
        leaveBalanceUpdateOneMock
            .mockResolvedValueOnce({ upsertedCount: 1 })
            .mockResolvedValueOnce({ upsertedCount: 1 })
            .mockResolvedValueOnce({ upsertedCount: 0 }); // existing row

        const inserted = await svc.initializeBalancesForUserYear({
            user_id: new Types.ObjectId(),
            year: 2026,
        });

        expect(inserted).toBe(2);
        expect(leaveBalanceUpdateOneMock).toHaveBeenCalledTimes(3);
        // CL gets full 12 since 2024 < 2026.
        expect(leaveBalanceUpdateOneMock).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({ leave_type_id: types[0]._id, year: 2026 }),
            expect.objectContaining({
                $setOnInsert: expect.objectContaining({ allocated: 12, available: 12 }),
            }),
            { upsert: true }
        );
    });

    it('returns 0 when the user has no date_of_joining (logged warning, not an error)', async () => {
        userFindByIdMock.mockReturnValueOnce({
            select: () =>
                Promise.resolve({
                    role: ROLES.EMPLOYEE,
                    status: 'active',
                    internal_profile: { date_of_joining: null },
                }),
        });

        const inserted = await svc.initializeBalancesForUserYear({
            user_id: new Types.ObjectId(),
            year: 2026,
        });

        expect(inserted).toBe(0);
        expect(leaveBalanceUpdateOneMock).not.toHaveBeenCalled();
    });

    it('returns 0 when the user is not found', async () => {
        userFindByIdMock.mockReturnValueOnce({ select: () => Promise.resolve(null) });

        const inserted = await svc.initializeBalancesForUserYear({
            user_id: new Types.ObjectId(),
            year: 2026,
        });
        expect(inserted).toBe(0);
    });

    it('uses pre-supplied joining year/month to skip the User lookup', async () => {
        leaveTypeFindMock.mockResolvedValueOnce([fullType({ code: 'CL', default_allocation_days: 12 })]);
        leaveBalanceUpdateOneMock.mockResolvedValueOnce({ upsertedCount: 1 });

        const inserted = await svc.initializeBalancesForUserYear({
            user_id: new Types.ObjectId(),
            year: 2026,
            joining_year: 2026,
            joining_month: 7,
        });

        expect(inserted).toBe(1);
        expect(userFindByIdMock).not.toHaveBeenCalled();
        // 7th-month BY_MONTHS_REMAINING → round_half(12 × 6/12) = 6.
        expect(leaveBalanceUpdateOneMock).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                $setOnInsert: expect.objectContaining({ allocated: 6, available: 6 }),
            }),
            { upsert: true }
        );
    });
});

// ─── adjustBalance ────────────────────────────────────────────────────────

describe('adjustBalance', () => {
    it('throws RESOURCE_NOT_FOUND when the row does not exist', async () => {
        leaveBalanceFindByIdMock.mockResolvedValueOnce(null);
        await expect(
            svc.adjustBalance(new Types.ObjectId(), { delta: 1, reason: 'x' }, new Types.ObjectId())
        ).rejects.toMatchObject({ code: ERROR_CODES.RESOURCE_NOT_FOUND });
    });

    it('adds delta to `adjusted`, recomputes `available`, stamps `updated_by`, and saves', async () => {
        const save = vi.fn().mockResolvedValue(undefined);
        const ltId = new Types.ObjectId();
        const row = {
            _id: new Types.ObjectId(),
            user_id: new Types.ObjectId(),
            leave_type_id: ltId,
            year: 2026,
            allocated: 12,
            carried_forward: 0,
            used: 4,
            pending: 0,
            adjusted: 0,
            monthly_forfeited: 0,
            available: 8,
            save,
        };
        leaveBalanceFindByIdMock.mockResolvedValueOnce(row);
        leaveTypeFindByIdMock.mockResolvedValueOnce(fullType({ _id: ltId, code: 'CL' }));

        const updater = new Types.ObjectId();
        const out = await svc.adjustBalance(row._id, { delta: 2, reason: 'comp-off' }, updater);

        expect(row.adjusted).toBe(2);
        expect(row.available).toBe(10); // 12 + 0 + 2 - 4 - 0 - 0
        expect((row as { updated_by?: Types.ObjectId }).updated_by).toBe(updater);
        expect(save).toHaveBeenCalledOnce();
        expect(out).toMatchObject({ id: row._id.toString(), allocated: 12, available: 10 });
    });

    it('handles a negative delta (admin clawback)', async () => {
        const save = vi.fn().mockResolvedValue(undefined);
        const ltId = new Types.ObjectId();
        const row = {
            _id: new Types.ObjectId(),
            user_id: new Types.ObjectId(),
            leave_type_id: ltId,
            year: 2026,
            allocated: 12,
            carried_forward: 0,
            used: 0,
            pending: 0,
            adjusted: 3,
            monthly_forfeited: 0,
            available: 15,
            save,
        };
        leaveBalanceFindByIdMock.mockResolvedValueOnce(row);
        leaveTypeFindByIdMock.mockResolvedValueOnce(fullType({ _id: ltId, code: 'CL' }));

        await svc.adjustBalance(row._id, { delta: -2, reason: 'correction' }, new Types.ObjectId());

        expect(row.adjusted).toBe(1);
        expect(row.available).toBe(13);
    });
});
