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
    userFindOneAndUpdateMock,
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
    userFindOneAndUpdateMock: vi.fn(),
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
        // C3 — atomic CAS gate. Tests that drive `adjustCompOff` must
        // configure this per-case (resolve to a truthy `User` doc on
        // grant / sufficient consume, `null` on insufficient consume).
        findOneAndUpdate: userFindOneAndUpdateMock,
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

beforeEach(() => {
    vi.resetAllMocks();
    userExistsMock.mockResolvedValue(true);
    userUpdateOneMock.mockResolvedValue({ acknowledged: true });
    // BUG-037 — default the target's role to `employee` so existing tests
    // (none of which mock the role explicitly) sail through the
    // client-target guard. The client-rejection test overrides this.
    // M42 — `comp_off_balance` is now the source of the audit
    // `balanceBefore` snapshot (was: an aggregation of the ledger).
    // Tests that exercise specific balance values override this.
    userFindByIdMock.mockResolvedValue({ role: 'employee', comp_off_balance: 0 });
    // C3 — default the CAS gate to "winner" so existing tests (which
    // all describe grant or sufficient-balance consumes) keep working.
    // The "insufficient balance" test overrides to `null` to simulate
    // the loser-of-race / under-balance branch.
    // M42 — the CAS result's `comp_off_balance` is now the audit
    // `balanceAfter` value; tests that assert on it override this.
    userFindOneAndUpdateMock.mockResolvedValue({ comp_off_balance: 0 });
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
        // Pre-state: balance = 4 (5 earned - 1 consumed).
        // Adjust: type=earned, days=2 → balance = 6.
        // M42 — `balanceBefore` now reads `User.comp_off_balance` directly
        // (no ledger aggregation on the hot path); `balanceAfter` is the
        // CAS's returned doc post-`$inc`. The aggregation mock stays
        // wired only so the reconciliation cron's tests can use it.
        userFindByIdMock.mockResolvedValueOnce({ role: 'employee', comp_off_balance: 4 });
        userFindOneAndUpdateMock.mockResolvedValueOnce({ comp_off_balance: 6 });
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
        // Pre-state: balance = 5 (5 earned - 0 consumed) — enough to consume 3.
        // M42 — see the earned-path test for the rationale on the
        // new mock shape.
        userFindByIdMock.mockResolvedValueOnce({ role: 'employee', comp_off_balance: 5 });
        userFindOneAndUpdateMock.mockResolvedValueOnce({ comp_off_balance: 2 });
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
        // Balance = 1, consume request = 5 → reject.
        compOffLedgerAggregateMock.mockResolvedValueOnce([{ _id: COMP_OFF_TYPES.EARNED, total: 1 }]);
        // C3 — CAS predicate `comp_off_balance: { $gte: 5 }` against
        // balance=1 fails the gate → findOneAndUpdate returns null,
        // service throws INSUFFICIENT_LEAVE_BALANCE.
        userFindOneAndUpdateMock.mockResolvedValueOnce(null);

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

describe('adjustCompOff — C3 atomic CAS race-guard', () => {
    it('passes `comp_off_balance: { $gte: days }` predicate on consume', async () => {
        // Pre-state: balance = 5 (load-then-check would also pass).
        compOffLedgerAggregateMock
            .mockResolvedValueOnce([{ _id: COMP_OFF_TYPES.EARNED, total: 5 }])
            .mockResolvedValueOnce([
                { _id: COMP_OFF_TYPES.EARNED, total: 5 },
                { _id: COMP_OFF_TYPES.CONSUMED, total: 3 },
            ]);
        userFindOneAndUpdateMock.mockResolvedValue({ comp_off_balance: 2 });
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

        // The CAS predicate MUST carry the `$gte: days` guard so two
        // concurrent consumes can't both pass under race.
        expect(userFindOneAndUpdateMock).toHaveBeenCalledWith(
            expect.objectContaining({
                _id: targetUserId,
                comp_off_balance: { $gte: 3 },
            }),
            { $inc: { comp_off_balance: -3 } },
            { new: true }
        );
    });

    it('omits the `$gte` predicate on grant (always succeeds, no lower bound)', async () => {
        compOffLedgerAggregateMock
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([{ _id: COMP_OFF_TYPES.EARNED, total: 2 }]);
        userFindOneAndUpdateMock.mockResolvedValue({ comp_off_balance: 2 });
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

        // Grant path has NO `comp_off_balance` predicate — just the
        // `_id` match. Verifies the asymmetric guard.
        const [predicate, , opts] = userFindOneAndUpdateMock.mock.calls[0]!;
        expect(predicate).toEqual({ _id: targetUserId });
        expect(predicate).not.toHaveProperty('comp_off_balance');
        expect(userFindOneAndUpdateMock.mock.calls[0]![1]).toEqual({ $inc: { comp_off_balance: 2 } });
        expect(opts).toEqual({ new: true });
    });

    it('throws INSUFFICIENT_LEAVE_BALANCE when the CAS gate returns null (loser of race)', async () => {
        // Pre-state: User.comp_off_balance = 5 (stale snapshot) but a
        // concurrent consume already committed; the CAS gate fails
        // because the actual row now has comp_off_balance < days.
        // M42 — balanceBefore now comes from the User row pre-CAS,
        // not from a ledger aggregation.
        userFindByIdMock.mockResolvedValueOnce({ role: 'employee', comp_off_balance: 5 });
        userFindOneAndUpdateMock.mockResolvedValueOnce(null);

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

        // Loser must NOT insert a ledger row.
        expect(compOffLedgerCreateMock).not.toHaveBeenCalled();
    });
});

describe('adjustCompOff — BUG-036 LeaveBalance sync', () => {
    it('creates a COMP_OFF leave-balance row mirroring the ledger total when none exists yet', async () => {
        // Pre-state: ledger empty (balance 0). Grant 5 → balance 5.
        // M42 — balanceBefore/After come from the User row + CAS result.
        userFindByIdMock.mockResolvedValueOnce({ role: 'employee', comp_off_balance: 0 });
        userFindOneAndUpdateMock.mockResolvedValueOnce({ comp_off_balance: 5 });
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
        // M42 — User row carries pre-CAS balance; CAS returns post.
        userFindByIdMock.mockResolvedValueOnce({ role: 'employee', comp_off_balance: 5 });
        userFindOneAndUpdateMock.mockResolvedValueOnce({ comp_off_balance: 7 });
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
        // M42 — User pre/post; aggregation no longer fires on the hot path.
        userFindByIdMock.mockResolvedValueOnce({ role: 'employee', comp_off_balance: 0 });
        userFindOneAndUpdateMock.mockResolvedValueOnce({ comp_off_balance: 3 });
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
