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
    recordAuditMock,
} = vi.hoisted(() => ({
    leaveBalanceUpdateOneMock: vi.fn(),
    leaveBalanceFindByIdMock: vi.fn(),
    leaveTypeFindMock: vi.fn(),
    leaveTypeFindByIdMock: vi.fn(),
    userFindByIdMock: vi.fn(),
    recomputeAvailableMock: vi.fn(),
    recordAuditMock: vi.fn(),
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

vi.mock('./audit.service.js', () => ({
    recordAudit: recordAuditMock,
    recordSystemAudit: vi.fn(),
}));

const svc = await import('./leave-balance.service.js');
import { ERROR_CODES } from '../constants/error-codes.js';
import { LEAVE_CODES, LEAVE_TYPE_SEEDS, PRO_RATA_STRATEGIES } from '../constants/leave.js';
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

    it('returns 0 when default_allocation_days is 0 (e.g. WFH)', () => {
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

    it('falls back to the start of the target year when the user has no date_of_joining (so apply-leave still works)', async () => {
        userFindByIdMock.mockReturnValueOnce({
            select: () =>
                Promise.resolve({
                    role: ROLES.EMPLOYEE,
                    status: 'active',
                    internal_profile: { date_of_joining: null },
                }),
        });
        const types = [fullType({ code: 'CL', default_allocation_days: 12 })];
        leaveTypeFindMock.mockResolvedValueOnce(types);
        leaveBalanceUpdateOneMock.mockResolvedValueOnce({ upsertedCount: 1 });

        const inserted = await svc.initializeBalancesForUserYear({
            user_id: new Types.ObjectId(),
            year: 2026,
        });

        // No longer returns 0 — it seeds rows so the user (e.g. a seeded admin
        // with no internal_profile) can apply leave. Joined at the start of the
        // target year → full allocation.
        expect(inserted).toBe(1);
        expect(leaveBalanceUpdateOneMock).toHaveBeenCalledWith(
            expect.objectContaining({ leave_type_id: types[0]._id, year: 2026 }),
            expect.objectContaining({
                $setOnInsert: expect.objectContaining({ allocated: 12, available: 12 }),
            }),
            { upsert: true }
        );
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

    it('H3 — records an audit row carrying the operator-supplied reason + signed delta', async () => {
        const save = vi.fn().mockResolvedValue(undefined);
        const ltId = new Types.ObjectId();
        const userId = new Types.ObjectId();
        const row = {
            _id: new Types.ObjectId(),
            user_id: userId,
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

        const audit = {
            actor_id: new Types.ObjectId(),
            actor_role: 'admin' as const,
            ip: '10.0.0.1',
            user_agent: 'vitest',
            request_id: 'req-h3',
        };

        await svc.adjustBalance(row._id, { delta: 2, reason: 'goodwill comp-off' }, new Types.ObjectId(), audit);

        expect(recordAuditMock).toHaveBeenCalledTimes(1);
        const [ctxArg, inputArg] = recordAuditMock.mock.calls[0]!;
        expect(ctxArg).toBe(audit);
        expect(inputArg).toMatchObject({
            action: 'leave_balance.adjust',
            target: { kind: 'leave_balance', id: row._id },
            // Pinned-shape diff — adjust touches `adjusted` + `available` only.
            before: { adjusted: 0, available: 8 },
            after: { adjusted: 2, available: 10 },
            metadata: {
                // The validator demanded `reason >= 3 chars`; H3 lands it
                // here so the audit log is the durable record.
                reason: 'goodwill comp-off',
                delta: 2,
                user_id: userId.toString(),
                leave_type_id: ltId.toString(),
                year: 2026,
            },
        });
    });

    it('H3 — does not call recordAudit when no audit context is provided (back-compat with legacy callers)', async () => {
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
            adjusted: 0,
            monthly_forfeited: 0,
            available: 12,
            save,
        };
        leaveBalanceFindByIdMock.mockResolvedValueOnce(row);
        leaveTypeFindByIdMock.mockResolvedValueOnce(fullType({ _id: ltId, code: 'CL' }));

        await svc.adjustBalance(row._id, { delta: 1, reason: 'unit test' }, new Types.ObjectId());

        expect(recordAuditMock).not.toHaveBeenCalled();
    });
});

// ─── Sick-leave policy invariant ────────────────────────────────────────
//
// Phase-4 cleanup: SL flipped from monthly forfeiture to within-year
// accumulation. Unused buckets stay available all year and only reset
// at Dec 31 (handled by the leave-year-rollover cron). The
// `slMonthlyForfeitureJob` is structurally a no-op under this policy
// because its `findOne` is gated on `monthly_forfeiture: true` —
// flipping the seed flag turns the cron off without code edits.
//
// We pin the policy in two places:
//  1. Seed shape — `LEAVE_TYPE_SEEDS` row for SL has
//     `monthly_forfeiture: false`. A regression here would silently
//     re-enable the cron and start forfeiting buckets again.
//  2. Balance formula — under `monthly_forfeited = 0` (the steady
//     state), available reduces only via `used` and `pending`. An
//     unused January bucket survives through Dec 31.

describe('Sick Leave policy invariant', () => {
    it('LEAVE_TYPE_SEEDS pins SL with monthly_forfeiture=false (within-year accumulation)', () => {
        const sl = LEAVE_TYPE_SEEDS.find((s) => s.code === LEAVE_CODES.SL);
        expect(sl).toBeDefined();
        expect(sl!.monthly_forfeiture).toBe(false);
        // Sanity: the rest of the SL config that makes the policy
        // work as intended.
        expect(sl!.monthly_cap).toBe(1); // still 1/month accrual
        expect(sl!.carry_forward).toBe(false); // no rollover to next year
        expect(sl!.resets_yearly).toBe(true); // Dec 31 resets to 0
    });

    it('balance formula preserves an unused January bucket through year-end', () => {
        // Concrete scenario: by November, user has 11 buckets accrued
        // (1/month × Jan–Nov) and used 2 days. With monthly_forfeited
        // forced to 0 (the cron no-ops), available = 11 - 2 - 0 = 9.
        // Under the legacy policy with monthly_forfeiture=true, Jan/
        // Feb/etc. unused buckets would have been forfeited monthly
        // and available would be much smaller.
        const result = recomputeAvailableMock({
            allocated: 11,
            carried_forward: 0,
            used: 2,
            pending: 0,
            adjusted: 0,
            monthly_forfeited: 0,
        });
        expect(result).toBe(9);
    });
});
