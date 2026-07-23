import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Types } from 'mongoose';

/**
 * Audit-shape pin for `adjustCompOff` (BACKEND_AUDIT.md I1).
 *
 * Comp-off adjust is admin-only and was previously written with no
 * audit trail. The two contracts we lock here:
 *
 *   1. The audit row is emitted with the right action / target / metadata
 *      shape (signed delta carries the sign convention; remarks land in
 *      metadata so a future dispute can read the operator's reason).
 *   2. The before/after diff captures the BALANCE transition, not the
 *      ledger row itself — that's what an operator actually disputes.
 *
 * We don't re-test the "happy path returns ledger + balance" surface
 * here because that's already exercised by the integration smoke tests
 * (`scripts/smoke-leaves-prep.ts`); this file is purely the I1
 * regression guard.
 */

const {
    compOffLedgerCreateMock,
    compOffLedgerAggregateMock,
    compOffLedgerFindMock,
    compOffLedgerCountMock,
    userExistsMock,
    userUpdateOneMock,
    userFindByIdMock,
    recordAuditMock,
    leaveTypeFindOneMock,
    leaveBalanceFindOneMock,
    leaveBalanceCreateMock,
} = vi.hoisted(() => ({
    compOffLedgerCreateMock: vi.fn(),
    compOffLedgerAggregateMock: vi.fn(),
    compOffLedgerFindMock: vi.fn(),
    compOffLedgerCountMock: vi.fn(),
    userExistsMock: vi.fn(),
    userUpdateOneMock: vi.fn(),
    userFindByIdMock: vi.fn(),
    recordAuditMock: vi.fn(),
    leaveTypeFindOneMock: vi.fn(),
    leaveBalanceFindOneMock: vi.fn(),
    leaveBalanceCreateMock: vi.fn(),
}));

vi.mock('../models/comp-off-ledger.model.js', () => ({
    CompOffLedger: {
        create: compOffLedgerCreateMock,
        aggregate: compOffLedgerAggregateMock,
        find: compOffLedgerFindMock,
        countDocuments: compOffLedgerCountMock,
    },
}));

vi.mock('../models/user.model.js', () => ({
    User: {
        exists: userExistsMock,
        updateOne: userUpdateOneMock,
        // `.select('role')` is chained off `findById` — model the chain
        // with a thenable shape that resolves to whatever `userFindByIdMock`
        // returns. Tests override `userFindByIdMock` per-case.
        findById: (id: unknown) => ({
            select: () => userFindByIdMock(id),
        }),
    },
}));

vi.mock('../models/leave-type.model.js', () => ({
    LeaveType: {
        findOne: leaveTypeFindOneMock,
    },
}));

vi.mock('../models/leave-balance.model.js', () => ({
    LeaveBalance: {
        findOne: leaveBalanceFindOneMock,
        create: leaveBalanceCreateMock,
    },
    recomputeAvailable: (b: {
        allocated: number;
        carried_forward: number;
        adjusted: number;
        used: number;
        pending: number;
        monthly_forfeited: number;
    }): number =>
        (b.allocated || 0) +
        (b.carried_forward || 0) +
        (b.adjusted || 0) -
        (b.used || 0) -
        (b.pending || 0) -
        (b.monthly_forfeited || 0),
}));

vi.mock('./audit.service.js', () => ({
    recordAudit: recordAuditMock,
    recordSystemAudit: vi.fn(),
}));

const svc = await import('./comp-off.service.js');
import { COMP_OFF_TYPES } from '../constants/leave.js';
import { ROLES } from '../constants/roles.js';

/**
 * LOT-based ledger test helpers.
 *
 * The service was rewritten from a single denormalized `comp_off_balance`
 * CAS to a per-lot FIFO ledger:
 *   - EARNED adjust  → `createEarnedLot` (one `CompOffLedger.create`).
 *   - CONSUMED adjust → `consumeCompOffLots` → `drawLotsFIFO`, which runs
 *     `CompOffLedger.find({...}).sort({ expires_at, created_at })`, decrements
 *     each returned lot's `remaining_days` (via `lot.save()`), then writes ONE
 *     `consumed` history row (`CompOffLedger.create`). If the live lots can't
 *     cover the request it throws `INSUFFICIENT_LEAVE_BALANCE` (409) — the new
 *     race-safe gate that replaced the `$gte` CAS.
 *   - `resyncCompOff` then runs `recomputeBalance` (ONE aggregation grouping
 *     `_id: null` → `{ balance, earned, consumed, expired }`) and
 *     `syncLeaveBalanceForCompOff` (a SECOND aggregation → `{ gross }`, only when
 *     the COMP_OFF leave type is seeded).
 *
 * `balanceBefore` reads `User.comp_off_balance`; `balanceAfter` is now the
 * `balance` returned by the `recomputeBalance` aggregation (NOT a CAS result).
 */

/** A fake earned-lot document as returned by `CompOffLedger.find().sort()`. */
const makeLot = (remaining_days: number, expiresOffsetMs = 0) => ({
    _id: new Types.ObjectId(),
    remaining_days,
    days: remaining_days,
    expires_at: new Date(Date.now() + expiresOffsetMs),
    save: vi.fn().mockResolvedValue(undefined),
});

/** Wire `CompOffLedger.find({...}).sort({...})` to resolve to `lots`. */
const stubLots = (lots: ReturnType<typeof makeLot>[]): void => {
    compOffLedgerFindMock.mockReturnValue({ sort: () => Promise.resolve(lots) });
};

/** The single-doc shape `recomputeBalance`'s aggregation returns. */
const balanceAgg = (opts: { balance: number; earned?: number; consumed?: number; expired?: number }) => [
    {
        _id: null,
        balance: opts.balance,
        earned: opts.earned ?? opts.balance,
        consumed: opts.consumed ?? 0,
        expired: opts.expired ?? 0,
    },
];

/** The single-doc shape `grossEarnedPool`'s aggregation returns. */
const grossAgg = (gross: number) => [{ _id: null, gross }];

beforeEach(() => {
    vi.resetAllMocks();
    userExistsMock.mockResolvedValue(true);
    userUpdateOneMock.mockResolvedValue({ acknowledged: true });
    // BUG-037 — default the target's role to `employee` so existing tests
    // (none of which mock the role explicitly) sail through the
    // client-target guard. The client-rejection test overrides this.
    // `comp_off_balance` is the source of the audit `balanceBefore` snapshot;
    // tests that exercise specific balance values override this.
    userFindByIdMock.mockResolvedValue({ role: 'employee', comp_off_balance: 0 });
    // BUG-036 — the COMP_OFF LeaveBalance sync is opportunistic: if the
    // leave type isn't seeded (or LeaveBalance models aren't mocked
    // explicitly in a test) it no-ops and tests stay focused on their
    // assertions. Tests that exercise the sync override these.
    leaveTypeFindOneMock.mockResolvedValue(null);
    leaveBalanceFindOneMock.mockResolvedValue(null);
    leaveBalanceCreateMock.mockResolvedValue({});
});

describe('adjustCompOff — I1 audit shape', () => {
    it('records LEAVE / COMP_OFF audit row with signed positive delta on `earned`', async () => {
        // Pre-state: balance = 4. Adjust: type=earned, days=2 → balance = 6.
        // `balanceBefore` reads `User.comp_off_balance` (4); `balanceAfter` is
        // the `balance` the `recomputeBalance` aggregation returns (6) after the
        // new earned lot lands.
        userFindByIdMock.mockResolvedValueOnce({ role: 'employee', comp_off_balance: 4 });
        compOffLedgerAggregateMock.mockResolvedValue(balanceAgg({ balance: 6, earned: 8, consumed: 2 }));
        const ledgerId = new Types.ObjectId();
        compOffLedgerCreateMock.mockResolvedValue({
            _id: ledgerId,
            user_id: new Types.ObjectId(),
            type: COMP_OFF_TYPES.EARNED,
            days: 2,
            toJSON() {
                return { id: this._id.toString() };
            },
        });

        const targetUserId = new Types.ObjectId();
        const audit = {
            actor_id: new Types.ObjectId(),
            actor_role: 'admin' as const,
            ip: '10.0.0.1',
            user_agent: 'vitest',
            request_id: 'req-i1',
        };

        const result = await svc.adjustCompOff(
            { user_id: targetUserId.toString(), type: COMP_OFF_TYPES.EARNED, days: 2, remarks: 'Q4 hackathon credit' },
            { id: new Types.ObjectId(), role: ROLES.ADMIN },
            audit
        );

        expect(result.balance).toBe(6);
        expect(recordAuditMock).toHaveBeenCalledTimes(1);
        const [ctxArg, inputArg] = recordAuditMock.mock.calls[0]!;
        expect(ctxArg).toBe(audit);
        expect(inputArg).toMatchObject({
            action: 'comp_off.adjust',
            target: { kind: 'comp_off_ledger', id: ledgerId },
            before: { balance: 4 },
            after: { balance: 6 },
            metadata: {
                user_id: targetUserId.toString(),
                type: COMP_OFF_TYPES.EARNED,
                // I1 — sign convention: earned = +days, consumed = -days.
                delta: 2,
                remarks: 'Q4 hackathon credit',
            },
        });
    });

    it('records signed NEGATIVE delta on `consumed` adjust', async () => {
        // Pre-state: balance = 5, one active 5-day lot — enough to consume 3.
        // `drawLotsFIFO` draws the lot; `recomputeBalance` then reports 2.
        userFindByIdMock.mockResolvedValueOnce({ role: 'employee', comp_off_balance: 5 });
        stubLots([makeLot(5)]);
        compOffLedgerAggregateMock.mockResolvedValue(balanceAgg({ balance: 2, earned: 5, consumed: 3 }));
        const ledgerId = new Types.ObjectId();
        compOffLedgerCreateMock.mockResolvedValue({
            _id: ledgerId,
            user_id: new Types.ObjectId(),
            type: COMP_OFF_TYPES.CONSUMED,
            days: 3,
            toJSON() {
                return { id: this._id.toString() };
            },
        });

        const audit = {
            actor_id: new Types.ObjectId(),
            actor_role: 'admin' as const,
        };

        await svc.adjustCompOff(
            { user_id: new Types.ObjectId().toString(), type: COMP_OFF_TYPES.CONSUMED, days: 3, remarks: 'bug fix' },
            { id: new Types.ObjectId(), role: ROLES.ADMIN },
            audit
        );

        const [, inputArg] = recordAuditMock.mock.calls[0]!;
        expect(inputArg).toMatchObject({
            before: { balance: 5 },
            after: { balance: 2 },
            metadata: {
                type: COMP_OFF_TYPES.CONSUMED,
                // Sign flip: consumed → negative delta.
                delta: -3,
                remarks: 'bug fix',
            },
        });
    });

    it('does NOT call recordAudit when no audit context is provided (back-compat with legacy callers)', async () => {
        compOffLedgerAggregateMock.mockResolvedValue([{ _id: COMP_OFF_TYPES.EARNED, total: 1 }]);
        compOffLedgerCreateMock.mockResolvedValue({
            _id: new Types.ObjectId(),
            user_id: new Types.ObjectId(),
            type: COMP_OFF_TYPES.EARNED,
            days: 1,
            toJSON: () => ({}),
        });

        await svc.adjustCompOff(
            { user_id: new Types.ObjectId().toString(), type: COMP_OFF_TYPES.EARNED, days: 1, remarks: 'x' },
            { id: new Types.ObjectId(), role: ROLES.ADMIN }
            // No audit ctx passed — pre-I1 behaviour preserved.
        );

        expect(recordAuditMock).not.toHaveBeenCalled();
    });

    it('does NOT emit an audit row when the consume guard rejects (insufficient balance)', async () => {
        // Live lots total 1 day, consume request = 5 → `drawLotsFIFO` can't
        // cover it and throws INSUFFICIENT_LEAVE_BALANCE before any history
        // row (or audit row) is written. This is the new race-safe gate.
        stubLots([makeLot(1)]);

        await expect(
            svc.adjustCompOff(
                {
                    user_id: new Types.ObjectId().toString(),
                    type: COMP_OFF_TYPES.CONSUMED,
                    days: 5,
                    remarks: 'should fail',
                },
                { id: new Types.ObjectId(), role: ROLES.ADMIN },
                { actor_id: new Types.ObjectId(), actor_role: 'admin' as const }
            )
        ).rejects.toMatchObject({ statusCode: 409 });

        // Ledger never created → no audit row should fire either.
        expect(compOffLedgerCreateMock).not.toHaveBeenCalled();
        expect(recordAuditMock).not.toHaveBeenCalled();
    });
});

describe('adjustCompOff — FIFO lot draw race-guard', () => {
    it('FIFO-draws active lots and writes one `consumed` history row on consume', async () => {
        // Pre-state: one active 5-day lot — enough to consume 3.
        userFindByIdMock.mockResolvedValueOnce({ role: 'employee', comp_off_balance: 5 });
        const lot = makeLot(5);
        stubLots([lot]);
        compOffLedgerAggregateMock.mockResolvedValue(balanceAgg({ balance: 2, earned: 5, consumed: 3 }));
        compOffLedgerCreateMock.mockResolvedValue({
            _id: new Types.ObjectId(),
            user_id: new Types.ObjectId(),
            type: COMP_OFF_TYPES.CONSUMED,
            days: 3,
            toJSON: () => ({}),
        });

        const targetUserId = new Types.ObjectId();
        await svc.adjustCompOff(
            { user_id: targetUserId.toString(), type: COMP_OFF_TYPES.CONSUMED, days: 3, remarks: 'spend' },
            { id: new Types.ObjectId(), role: ROLES.ADMIN }
        );

        // The FIFO draw scans only the caller's ACTIVE earned lots (the new
        // race-safe gate: concurrent consumers can't both draw the same
        // lot's remaining_days).
        expect(compOffLedgerFindMock).toHaveBeenCalledWith(
            expect.objectContaining({
                user_id: targetUserId,
                type: COMP_OFF_TYPES.EARNED,
                remaining_days: { $gt: 0 },
            })
        );
        // The drawn lot is decremented + persisted, and exactly ONE `consumed`
        // history row is written carrying the allocation.
        expect(lot.remaining_days).toBe(2);
        expect(lot.save).toHaveBeenCalledTimes(1);
        expect(compOffLedgerCreateMock).toHaveBeenCalledTimes(1);
        const [createArg] = compOffLedgerCreateMock.mock.calls[0]!;
        expect(createArg).toMatchObject({
            type: COMP_OFF_TYPES.CONSUMED,
            days: 3,
            allocations: [expect.objectContaining({ lot_id: lot._id, days: 3 })],
        });
    });

    it('creates a fresh earned lot (no FIFO draw) on grant', async () => {
        userFindByIdMock.mockResolvedValueOnce({ role: 'employee', comp_off_balance: 0 });
        compOffLedgerAggregateMock.mockResolvedValue(balanceAgg({ balance: 2 }));
        compOffLedgerCreateMock.mockResolvedValue({
            _id: new Types.ObjectId(),
            user_id: new Types.ObjectId(),
            type: COMP_OFF_TYPES.EARNED,
            days: 2,
            toJSON: () => ({}),
        });

        const targetUserId = new Types.ObjectId();
        await svc.adjustCompOff(
            { user_id: targetUserId.toString(), type: COMP_OFF_TYPES.EARNED, days: 2, remarks: 'grant' },
            { id: new Types.ObjectId(), role: ROLES.ADMIN }
        );

        // Grant NEVER queries existing lots — it just inserts a new EARNED lot
        // with `remaining_days = days`, unexpired. Verifies the asymmetric path.
        expect(compOffLedgerFindMock).not.toHaveBeenCalled();
        expect(compOffLedgerCreateMock).toHaveBeenCalledTimes(1);
        const [createArg] = compOffLedgerCreateMock.mock.calls[0]!;
        expect(createArg).toMatchObject({
            user_id: targetUserId,
            type: COMP_OFF_TYPES.EARNED,
            days: 2,
            remaining_days: 2,
            expired: false,
        });
    });

    it('throws INSUFFICIENT_LEAVE_BALANCE when live lots cannot cover the consume', async () => {
        // Pre-state: User.comp_off_balance = 5 (stale snapshot) but the live
        // lots only total 1 day — a concurrent consume already drew them down.
        // The FIFO draw is the gate: it throws before any history row lands.
        userFindByIdMock.mockResolvedValueOnce({ role: 'employee', comp_off_balance: 5 });
        stubLots([makeLot(1)]);

        await expect(
            svc.adjustCompOff(
                {
                    user_id: new Types.ObjectId().toString(),
                    type: COMP_OFF_TYPES.CONSUMED,
                    days: 3,
                    remarks: 'race-loser',
                },
                { id: new Types.ObjectId(), role: ROLES.ADMIN }
            )
        ).rejects.toMatchObject({ statusCode: 409, code: 'INSUFFICIENT_LEAVE_BALANCE' });

        // Loser must NOT insert a `consumed` history row.
        expect(compOffLedgerCreateMock).not.toHaveBeenCalled();
    });
});

describe('adjustCompOff — BUG-036 LeaveBalance sync', () => {
    it('creates a COMP_OFF leave-balance row mirroring the ledger total when none exists yet', async () => {
        // Pre-state: ledger empty (balance 0). Grant 5 → balance 5, gross 5.
        // `recomputeBalance` reports balance 5; `grossEarnedPool` (the second
        // aggregation, fired because the COMP_OFF type is seeded) reports 5.
        userFindByIdMock.mockResolvedValueOnce({ role: 'employee', comp_off_balance: 0 });
        compOffLedgerAggregateMock.mockResolvedValueOnce(balanceAgg({ balance: 5 })).mockResolvedValueOnce(grossAgg(5));
        compOffLedgerCreateMock.mockResolvedValue({
            _id: new Types.ObjectId(),
            user_id: new Types.ObjectId(),
            type: COMP_OFF_TYPES.EARNED,
            days: 5,
            toJSON: () => ({}),
        });

        const compOffTypeId = new Types.ObjectId();
        leaveTypeFindOneMock.mockResolvedValue({ _id: compOffTypeId, code: 'COMP_OFF' });
        leaveBalanceFindOneMock.mockResolvedValue(null); // no row yet

        const targetUserId = new Types.ObjectId();
        await svc.adjustCompOff(
            { user_id: targetUserId.toString(), type: COMP_OFF_TYPES.EARNED, days: 5, remarks: 'grant' },
            { id: new Types.ObjectId(), role: ROLES.ADMIN }
        );

        expect(leaveBalanceCreateMock).toHaveBeenCalledTimes(1);
        const seed = leaveBalanceCreateMock.mock.calls[0]![0];
        expect(seed).toMatchObject({
            user_id: targetUserId,
            leave_type_id: compOffTypeId,
            adjusted: 5,
            available: 5,
            used: 0,
            pending: 0,
        });
    });

    it('updates an existing COMP_OFF leave-balance row in place, preserving used/pending', async () => {
        // Pre-state: prior grant of 5 (some already used via approved leaves).
        // Grant 2 → gross pool 7. `adjusted` is mirrored from the GROSS pool
        // (Σ days over live lots), NOT the net balance, so the engine's
        // used/pending tracking doesn't double-subtract.
        userFindByIdMock.mockResolvedValueOnce({ role: 'employee', comp_off_balance: 5 });
        compOffLedgerAggregateMock
            .mockResolvedValueOnce(balanceAgg({ balance: 4, earned: 7, consumed: 3 }))
            .mockResolvedValueOnce(grossAgg(7));
        compOffLedgerCreateMock.mockResolvedValue({
            _id: new Types.ObjectId(),
            user_id: new Types.ObjectId(),
            type: COMP_OFF_TYPES.EARNED,
            days: 2,
            toJSON: () => ({}),
        });

        leaveTypeFindOneMock.mockResolvedValue({ _id: new Types.ObjectId(), code: 'COMP_OFF' });
        const saveMock = vi.fn().mockResolvedValue({});
        const existingRow = {
            adjusted: 5,
            allocated: 0,
            carried_forward: 0,
            used: 3, // user already consumed 3 days via approved leaves
            pending: 0,
            monthly_forfeited: 0,
            available: 2,
            save: saveMock,
        };
        leaveBalanceFindOneMock.mockResolvedValue(existingRow);

        await svc.adjustCompOff(
            { user_id: new Types.ObjectId().toString(), type: COMP_OFF_TYPES.EARNED, days: 2, remarks: 'top up' },
            { id: new Types.ObjectId(), role: ROLES.ADMIN }
        );

        expect(saveMock).toHaveBeenCalledTimes(1);
        // adjusted ← new ledger balance (7); available recomputed using
        // existing used/pending so prior approvals are honoured.
        expect(existingRow.adjusted).toBe(7);
        expect(existingRow.available).toBe(4); // 7 - 3 used - 0 pending
        expect(leaveBalanceCreateMock).not.toHaveBeenCalled();
    });

    it('no-ops the sync when COMP_OFF leave type is missing — never blocks the ledger write', async () => {
        // Grant 3 → balance 3. The COMP_OFF leave type isn't seeded, so
        // `syncLeaveBalanceForCompOff` returns before the second (gross)
        // aggregation and before touching LeaveBalance — only the balance
        // recompute fires.
        userFindByIdMock.mockResolvedValueOnce({ role: 'employee', comp_off_balance: 0 });
        compOffLedgerAggregateMock.mockResolvedValue(balanceAgg({ balance: 3 }));
        compOffLedgerCreateMock.mockResolvedValue({
            _id: new Types.ObjectId(),
            user_id: new Types.ObjectId(),
            type: COMP_OFF_TYPES.EARNED,
            days: 3,
            toJSON: () => ({}),
        });
        leaveTypeFindOneMock.mockResolvedValue(null); // type not seeded

        const result = await svc.adjustCompOff(
            { user_id: new Types.ObjectId().toString(), type: COMP_OFF_TYPES.EARNED, days: 3, remarks: 'grant' },
            { id: new Types.ObjectId(), role: ROLES.ADMIN }
        );

        expect(result.balance).toBe(3);
        expect(leaveBalanceFindOneMock).not.toHaveBeenCalled();
        expect(leaveBalanceCreateMock).not.toHaveBeenCalled();
    });
});

describe('adjustCompOff — BUG-037 client-target guard', () => {
    it('rejects with FORBIDDEN_ROLE_TARGET (422) when target user is a client', async () => {
        userFindByIdMock.mockResolvedValue({ role: ROLES.CLIENT });

        await expect(
            svc.adjustCompOff(
                {
                    user_id: new Types.ObjectId().toString(),
                    type: COMP_OFF_TYPES.EARNED,
                    days: 5,
                    remarks: 'should be rejected',
                },
                { id: new Types.ObjectId(), role: ROLES.ADMIN }
            )
        ).rejects.toMatchObject({ statusCode: 422, code: 'FORBIDDEN_ROLE_TARGET' });

        // Hard guarantee: no ledger row, no audit row, no LeaveBalance sync.
        expect(compOffLedgerCreateMock).not.toHaveBeenCalled();
        expect(compOffLedgerAggregateMock).not.toHaveBeenCalled();
        expect(recordAuditMock).not.toHaveBeenCalled();
        expect(leaveBalanceFindOneMock).not.toHaveBeenCalled();
        expect(leaveBalanceCreateMock).not.toHaveBeenCalled();
    });

    it('still rejects on consume against a client', async () => {
        userFindByIdMock.mockResolvedValue({ role: ROLES.CLIENT });

        await expect(
            svc.adjustCompOff(
                {
                    user_id: new Types.ObjectId().toString(),
                    type: COMP_OFF_TYPES.CONSUMED,
                    days: 1,
                    remarks: 'should be rejected',
                },
                { id: new Types.ObjectId(), role: ROLES.ADMIN }
            )
        ).rejects.toMatchObject({ statusCode: 422, code: 'FORBIDDEN_ROLE_TARGET' });

        expect(compOffLedgerCreateMock).not.toHaveBeenCalled();
    });
});

describe('listCompOff — caller scoping (org-wide leak guard)', () => {
    // Chainable find() stub: find(filter).sort().skip().limit() → rows.
    // Empty rows so `loadCompOffUserDisplays` short-circuits (no User.find).
    const stubFind = () =>
        compOffLedgerFindMock.mockReturnValue({
            sort: () => ({ skip: () => ({ limit: () => Promise.resolve([]) }) }),
        });

    beforeEach(() => {
        stubFind();
        compOffLedgerCountMock.mockResolvedValue(0);
    });

    const caller = (role: string) => ({ id: new Types.ObjectId(), role: role as never });

    it('scopes a non-reviewer (employee) to their OWN ledger', async () => {
        const me = caller(ROLES.EMPLOYEE);
        await svc.listCompOff({ page: 1, limit: 20 } as never, me);
        expect(compOffLedgerFindMock).toHaveBeenCalledWith(expect.objectContaining({ user_id: me.id }));
    });

    it('scopes a team_lead (non-reviewer) to their OWN ledger', async () => {
        const me = caller(ROLES.TEAM_LEAD);
        await svc.listCompOff({ page: 1, limit: 20 } as never, me);
        expect(compOffLedgerFindMock).toHaveBeenCalledWith(expect.objectContaining({ user_id: me.id }));
    });

    it('ignores a non-reviewer-supplied user_id (cannot read someone else)', async () => {
        const me = caller(ROLES.EMPLOYEE);
        const someoneElse = new Types.ObjectId().toString();
        await svc.listCompOff({ page: 1, limit: 20, user_id: someoneElse } as never, me);
        expect(compOffLedgerFindMock).toHaveBeenCalledWith(expect.objectContaining({ user_id: me.id }));
    });

    it('gives a reviewer (manager) the org-wide ledger (no user_id filter)', async () => {
        await svc.listCompOff({ page: 1, limit: 20 } as never, caller(ROLES.MANAGER));
        const filter = compOffLedgerFindMock.mock.calls[0]![0];
        expect(filter.user_id).toBeUndefined();
    });

    it('lets a reviewer (admin) filter by a specific user_id', async () => {
        const target = new Types.ObjectId().toString();
        await svc.listCompOff({ page: 1, limit: 20, user_id: target } as never, caller(ROLES.ADMIN));
        const filter = compOffLedgerFindMock.mock.calls[0]![0];
        expect(filter.user_id?.toString()).toBe(target);
    });
});
