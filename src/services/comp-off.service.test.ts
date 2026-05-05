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

const { compOffLedgerCreateMock, compOffLedgerAggregateMock, userExistsMock, userUpdateOneMock, recordAuditMock } =
    vi.hoisted(() => ({
        compOffLedgerCreateMock: vi.fn(),
        compOffLedgerAggregateMock: vi.fn(),
        userExistsMock: vi.fn(),
        userUpdateOneMock: vi.fn(),
        recordAuditMock: vi.fn(),
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
    },
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
