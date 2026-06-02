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
        find: vi.fn(),
        countDocuments: vi.fn(),
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

beforeEach(() => {
    vi.resetAllMocks();
    userExistsMock.mockResolvedValue(true);
    userUpdateOneMock.mockResolvedValue({ acknowledged: true });
    // BUG-037 — default the target's role to `employee` so existing tests
    // (none of which mock the role explicitly) sail through the
    // client-target guard. The client-rejection test overrides this.
    userFindByIdMock.mockResolvedValue({ role: 'employee' });
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
        compOffLedgerAggregateMock
            .mockResolvedValueOnce([
                { _id: COMP_OFF_TYPES.EARNED, total: 5 },
                { _id: COMP_OFF_TYPES.CONSUMED, total: 1 },
            ])
            .mockResolvedValueOnce([
                { _id: COMP_OFF_TYPES.EARNED, total: 7 },
                { _id: COMP_OFF_TYPES.CONSUMED, total: 1 },
            ]);
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
        compOffLedgerAggregateMock
            .mockResolvedValueOnce([{ _id: COMP_OFF_TYPES.EARNED, total: 5 }])
            .mockResolvedValueOnce([
                { _id: COMP_OFF_TYPES.EARNED, total: 5 },
                { _id: COMP_OFF_TYPES.CONSUMED, total: 3 },
            ]);
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

describe('adjustCompOff — BUG-036 LeaveBalance sync', () => {
    it('creates a COMP_OFF leave-balance row mirroring the ledger total when none exists yet', async () => {
        // Pre-state: ledger empty (balance 0). Grant 5 → balance 5.
        compOffLedgerAggregateMock
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([{ _id: COMP_OFF_TYPES.EARNED, total: 5 }]);
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
        compOffLedgerAggregateMock
            .mockResolvedValueOnce([{ _id: COMP_OFF_TYPES.EARNED, total: 5 }])
            .mockResolvedValueOnce([{ _id: COMP_OFF_TYPES.EARNED, total: 7 }]);
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
        compOffLedgerAggregateMock
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([{ _id: COMP_OFF_TYPES.EARNED, total: 3 }]);
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
