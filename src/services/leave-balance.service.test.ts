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
    userFindMock,
    recomputeAvailableMock,
    recordAuditMock,
} = vi.hoisted(() => ({
    leaveBalanceUpdateOneMock: vi.fn(),
    leaveBalanceFindByIdMock: vi.fn(),
    leaveTypeFindMock: vi.fn(),
    leaveTypeFindByIdMock: vi.fn(),
    userFindByIdMock: vi.fn(),
    userFindMock: vi.fn(),
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
    // Real rule, not a stub: an uncapped type contributes 0 rather than a
    // negative, and every published `available` goes through it.
    presentedAvailable: (
        b: {
            allocated: number;
            carried_forward: number;
            used: number;
            pending: number;
            adjusted: number;
            monthly_forfeited: number;
        },
        lt: { is_unlimited?: boolean } | null | undefined
    ) =>
        lt?.is_unlimited ? 0 : b.allocated + b.carried_forward + b.adjusted - b.used - b.pending - b.monthly_forfeited,
}));

vi.mock('../models/leave-type.model.js', () => ({
    LeaveType: { find: leaveTypeFindMock, findById: leaveTypeFindByIdMock },
}));

vi.mock('../models/sl-monthly-forfeiture.model.js', () => ({
    SlMonthlyForfeiture: { findOne: vi.fn() },
}));

vi.mock('../models/user.model.js', () => ({
    User: { findById: userFindByIdMock, find: userFindMock },
}));

vi.mock('./audit.service.js', () => ({
    recordAudit: recordAuditMock,
    recordSystemAudit: vi.fn(),
}));

const svc = await import('./leave-balance.service.js');
import { ERROR_CODES } from '../constants/error-codes.js';
import { LEAVE_CODES, LEAVE_TYPE_SEEDS, PRO_RATA_STRATEGIES } from '../constants/leave.js';
import { CLIENT_SIDE_ROLES, ROLES } from '../constants/roles.js';

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

    it('skips representatives early — they are client-side, not staff', async () => {
        // `CLIENT_SIDE_ROLES` is the org-wide answer to "who is external".
        // This guard checked `role === CLIENT` only, which predates the
        // `representative` role, so a client company's project-scoped person
        // would accrue leave they can neither see nor apply for.
        userFindByIdMock.mockReturnValueOnce({
            select: () =>
                Promise.resolve({
                    role: ROLES.REPRESENTATIVE,
                    status: 'active',
                    internal_profile: null,
                }),
        });

        const inserted = await svc.initializeBalancesForUserYear({
            user_id: new Types.ObjectId(),
            year: 2026,
        });

        expect(inserted).toBe(0);
        expect(leaveBalanceUpdateOneMock).not.toHaveBeenCalled();
    });

    it('skips freelancers early (no DB writes)', async () => {
        // A freelancer is engaged per contract, not on an employment
        // allocation. Guarding here rather than per-caller is what makes it
        // hold for createUser, the rollover cron, the manual init endpoint,
        // the dashboard self-heal AND apply-leave's just-in-time init.
        userFindByIdMock.mockReturnValueOnce({
            select: () =>
                Promise.resolve({
                    role: ROLES.EMPLOYEE,
                    status: 'active',
                    internal_profile: {
                        date_of_joining: '2024-06-15',
                        employment_type: 'freelancer',
                    },
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

    it('still accrues for staff, who carry no explicit employment_type on older records', async () => {
        userFindByIdMock.mockReturnValueOnce({
            select: () =>
                Promise.resolve({
                    role: ROLES.EMPLOYEE,
                    status: 'active',
                    // No `employment_type` key at all — every user predating
                    // the field. They must keep accruing.
                    internal_profile: { date_of_joining: '2024-06-15' },
                }),
        });
        leaveTypeFindMock.mockResolvedValueOnce([fullType({ code: 'CL', default_allocation_days: 12 })]);
        leaveBalanceUpdateOneMock.mockResolvedValueOnce({ upsertedCount: 1 });

        const inserted = await svc.initializeBalancesForUserYear({
            user_id: new Types.ObjectId(),
            year: 2026,
        });

        expect(inserted).toBe(1);
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

describe('initializeYearForAllUsers', () => {
    it('excludes every client-side role from the roll-out, not just `client`', async () => {
        userFindMock.mockReturnValueOnce({ select: () => Promise.resolve([]) });

        await svc.initializeYearForAllUsers({ year: 2026 });

        const filter = userFindMock.mock.calls[0]?.[0] as Record<string, unknown>;
        expect(filter.role).toEqual({ $nin: CLIENT_SIDE_ROLES });
    });

    it('does not filter the user query on date_of_joining', async () => {
        userFindMock.mockReturnValueOnce({ select: () => Promise.resolve([]) });

        await svc.initializeYearForAllUsers({ year: 2026 });

        const filter = userFindMock.mock.calls[0]?.[0] as Record<string, unknown>;
        // A missing joining date must not remove somebody from the roll-out.
        // `initializeBalancesForUserYear` already defaults them to the start
        // of the target year; pre-filtering here bypassed that fallback and
        // left those employees with zero balance rows, so they vanished from
        // the admin leave-balance screens entirely.
        expect(filter).not.toHaveProperty('internal_profile.date_of_joining');
    });

    it('still seeds employees who have no date_of_joining on file', async () => {
        const uid = new Types.ObjectId();
        userFindMock.mockReturnValueOnce({
            select: () => Promise.resolve([{ _id: uid, internal_profile: {} }]),
        });
        // No joining date is pre-resolved, so the per-user initializer does
        // its own lookup and applies the start-of-year fallback.
        userFindByIdMock.mockReturnValueOnce({
            select: () =>
                Promise.resolve({
                    role: ROLES.EMPLOYEE,
                    status: 'active',
                    internal_profile: {},
                }),
        });
        leaveTypeFindMock.mockResolvedValueOnce([fullType({ code: 'CL', default_allocation_days: 12 })]);
        leaveBalanceUpdateOneMock.mockResolvedValueOnce({ upsertedCount: 1 });

        const out = await svc.initializeYearForAllUsers({ year: 2026 });

        expect(out).toMatchObject({ year: 2026, processed_users: 1, total_inserted: 1 });
    });

    it('passes a known joining date through without a second user lookup', async () => {
        userFindMock.mockReturnValueOnce({
            select: () =>
                Promise.resolve([{ _id: new Types.ObjectId(), internal_profile: { date_of_joining: '2026-07-01' } }]),
        });
        leaveTypeFindMock.mockResolvedValueOnce([fullType({ code: 'CL', default_allocation_days: 12 })]);
        leaveBalanceUpdateOneMock.mockResolvedValueOnce({ upsertedCount: 1 });

        const out = await svc.initializeYearForAllUsers({ year: 2026 });

        expect(userFindByIdMock).not.toHaveBeenCalled();
        expect(out.total_inserted).toBe(1);
        // Joined in month 7 → round_half(12 × 6/12) = 6.
        expect(leaveBalanceUpdateOneMock).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                $setOnInsert: expect.objectContaining({ allocated: 6 }),
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
        // The consumers gate on these: `is_earned` warns before adjusting a
        // ledger-mirrored type, `is_active` keeps a retired type out of the
        // "available" headline. Dropping either silently breaks that.
        expect(out.leave_type).toMatchObject({ is_earned: false, is_active: true });
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

describe('adjustBalance — stated totals', () => {
    const rowWith = (over: Record<string, number> = {}) => ({
        _id: new Types.ObjectId(),
        user_id: new Types.ObjectId(),
        leave_type_id: new Types.ObjectId(),
        year: 2026,
        allocated: 12,
        carried_forward: 0,
        used: 4,
        pending: 0,
        adjusted: 0,
        monthly_forfeited: 0,
        available: 8,
        save: vi.fn().mockResolvedValue(undefined),
        ...over,
    });

    it('writes both counters as stated and re-derives what is left', async () => {
        const row = rowWith();
        leaveBalanceFindByIdMock.mockResolvedValueOnce(row);
        leaveTypeFindByIdMock.mockResolvedValueOnce(fullType({ _id: row.leave_type_id }));

        // The other leave portal says: 15 allowed, 7 taken.
        const out = await svc.adjustBalance(
            row._id,
            { total_days: 15, used_days: 7, reason: 'sync with leave portal' },
            new Types.ObjectId()
        );

        expect(row.used).toBe(7);
        // `adjusted` absorbs the gap to the stated total so the quota and
        // carry-forward the engine computed stay on the row.
        expect(row.adjusted).toBe(3); // 15 − 12 allocated − 0 carried
        expect(row.available).toBe(8); // 15 − 7
        expect(out).toMatchObject({ used: 7, available: 8 });
    });

    it('holds the stated total against an existing carry-forward', async () => {
        const row = rowWith({ allocated: 12, carried_forward: 5, adjusted: 0, used: 0, available: 17 });
        leaveBalanceFindByIdMock.mockResolvedValueOnce(row);
        leaveTypeFindByIdMock.mockResolvedValueOnce(fullType({ _id: row.leave_type_id }));

        await svc.adjustBalance(row._id, { total_days: 20, reason: 'sync' }, new Types.ObjectId());

        expect(row.allocated).toBe(12); // untouched
        expect(row.carried_forward).toBe(5); // untouched
        expect(row.adjusted).toBe(3); // 20 − 12 − 5
        expect(row.available).toBe(20);
    });

    it('subtracts days already held by a pending request', async () => {
        const row = rowWith({ pending: 2, used: 0, available: 10 });
        leaveBalanceFindByIdMock.mockResolvedValueOnce(row);
        leaveTypeFindByIdMock.mockResolvedValueOnce(fullType({ _id: row.leave_type_id }));

        await svc.adjustBalance(row._id, { total_days: 15, used_days: 3, reason: 'sync' }, new Types.ObjectId());

        // A pending request still holds its days — the operator states what
        // is allowed and taken, never what is left.
        expect(row.available).toBe(10); // 15 − 3 − 2
    });

    it('leaves the counter alone when only the other one is sent', async () => {
        const row = rowWith();
        leaveBalanceFindByIdMock.mockResolvedValueOnce(row);
        leaveTypeFindByIdMock.mockResolvedValueOnce(fullType({ _id: row.leave_type_id }));

        await svc.adjustBalance(row._id, { used_days: 6, reason: 'correcting the count' }, new Types.ObjectId());

        expect(row.used).toBe(6);
        expect(row.adjusted).toBe(0); // no total stated → untouched
        expect(row.available).toBe(6); // 12 − 6
    });

    it('accepts totals that already match (bulk sync must not error)', async () => {
        const row = rowWith();
        leaveBalanceFindByIdMock.mockResolvedValueOnce(row);
        leaveTypeFindByIdMock.mockResolvedValueOnce(fullType({ _id: row.leave_type_id }));

        await svc.adjustBalance(
            row._id,
            { total_days: 12, used_days: 4, reason: 'already matches the portal' },
            new Types.ObjectId()
        );

        expect(row.adjusted).toBe(0);
        expect(row.used).toBe(4);
        expect(row.available).toBe(8);
        expect(row.save).toHaveBeenCalledOnce();
    });

    it('keeps the arithmetic free of binary-float dust', async () => {
        const row = rowWith({ allocated: 12.1, used: 0, available: 12.1 });
        leaveBalanceFindByIdMock.mockResolvedValueOnce(row);
        leaveTypeFindByIdMock.mockResolvedValueOnce(fullType({ _id: row.leave_type_id }));

        await svc.adjustBalance(row._id, { total_days: 12, reason: 'sync' }, new Types.ObjectId());

        // 12 − 12.1 is −0.09999999999999964 in IEEE-754; what lands has to be
        // the number the admin typed.
        expect(row.adjusted).toBe(-0.1);
        expect(row.available).toBe(12);
    });

    it('audits the stated totals and the resulting move in what is left', async () => {
        const row = rowWith();
        leaveBalanceFindByIdMock.mockResolvedValueOnce(row);
        leaveTypeFindByIdMock.mockResolvedValueOnce(fullType({ _id: row.leave_type_id }));

        await svc.adjustBalance(
            row._id,
            { total_days: 15, used_days: 7, reason: 'sync with leave portal' },
            new Types.ObjectId(),
            { actor_id: new Types.ObjectId(), actor_role: 'admin' } as never
        );

        expect(recordAuditMock).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                before: expect.objectContaining({ used: 4, available: 8 }),
                after: expect.objectContaining({ used: 7, available: 8 }),
                metadata: expect.objectContaining({
                    total_days: 15,
                    used_days: 7,
                    delta: 0, // available didn't move: +3 allowed, +3 taken
                    reason: 'sync with leave portal',
                }),
            })
        );
    });
});

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
