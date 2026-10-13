import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Types } from 'mongoose';

/**
 * Coverage focus for `leave-type.service` — admin-only catalog mutations
 * that drive every active user's allocation seeding:
 *
 *   1. `createLeaveType` — happy path persists, E11000 on the unique
 *      `code` index surfaces as 409 DUPLICATE_RESOURCE, and the I1
 *      audit row carries the new doc in `after`.
 *   2. `updateLeaveType` — applies partial fields, returns 404 on
 *      unknown id, and the audit row records the full before/after
 *      diff (so an operator disputing "who changed the SL monthly cap"
 *      has the trail).
 *   3. `deactivateLeaveType` — flips `is_active` only when currently
 *      true (idempotent re-deactivate is silent), audit row records
 *      the transition. Pre-I1 these mutations had no audit trail.
 *   4. The audit hook is OPTIONAL — every entry point still works
 *      without an AuditContext.
 */

const { leaveTypeCreateMock, leaveTypeFindByIdMock, recordAuditMock } = vi.hoisted(() => ({
    leaveTypeCreateMock: vi.fn(),
    leaveTypeFindByIdMock: vi.fn(),
    recordAuditMock: vi.fn(),
}));

vi.mock('../models/leave-type.model.js', () => ({
    LeaveType: {
        create: leaveTypeCreateMock,
        findById: leaveTypeFindByIdMock,
        findOne: vi.fn(),
        find: vi.fn(),
        updateOne: vi.fn(),
    },
}));

vi.mock('./audit.service.js', () => ({
    recordAudit: recordAuditMock,
    recordSystemAudit: vi.fn(),
}));

const svc = await import('./leave-type.service.js');
import { ERROR_CODES } from '../constants/error-codes.js';
import { PRO_RATA_STRATEGIES } from '../constants/leave.js';

const makeAudit = () => ({ actor_id: new Types.ObjectId(), actor_role: 'admin' as const });

const makeLeaveTypeDoc = (overrides: Record<string, unknown> = {}) => {
    const doc = {
        _id: new Types.ObjectId(),
        code: 'CL',
        name: 'Casual Leave',
        default_allocation_days: 12,
        carry_forward: false,
        carry_forward_cap: null as number | null,
        monthly_cap: null as number | null,
        monthly_forfeiture: false,
        is_unlimited: false,
        is_earned: false,
        is_event_based: false,
        pro_rata_on_join: PRO_RATA_STRATEGIES.BY_MONTHS_REMAINING,
        supports_half_day: true,
        advance_notice_days: 0,
        resets_yearly: true,
        is_active: true,
        save: vi.fn(),
        toJSON() {
            return {
                id: this._id.toString(),
                code: this.code,
                name: this.name,
                default_allocation_days: this.default_allocation_days,
                monthly_cap: this.monthly_cap,
                is_active: this.is_active,
            };
        },
        ...overrides,
    };
    doc.save.mockImplementation(async () => doc);
    return doc;
};

const validCreateBody = {
    code: 'CL',
    name: 'Casual Leave',
    default_allocation_days: 12,
    carry_forward: false,
    monthly_forfeiture: false,
    is_unlimited: false,
    is_earned: false,
    is_event_based: false,
    pro_rata_on_join: PRO_RATA_STRATEGIES.BY_MONTHS_REMAINING,
    supports_half_day: true,
    advance_notice_days: 0,
    resets_yearly: true,
};

beforeEach(() => {
    vi.resetAllMocks();
});

// ─── createLeaveType ──────────────────────────────────────────────────────

describe('createLeaveType', () => {
    it('persists with the given fields and returns the public projection', async () => {
        const doc = makeLeaveTypeDoc();
        leaveTypeCreateMock.mockResolvedValueOnce(doc);

        const result = await svc.createLeaveType(validCreateBody);

        expect(result).toMatchObject({ code: 'CL', name: 'Casual Leave' });
        expect(leaveTypeCreateMock).toHaveBeenCalledTimes(1);
    });

    it('translates Mongo E11000 on `code` collision into 409 DUPLICATE_RESOURCE', async () => {
        leaveTypeCreateMock.mockRejectedValueOnce({ code: 11000, keyValue: { code: 'CL' } });

        await expect(svc.createLeaveType(validCreateBody)).rejects.toMatchObject({
            code: ERROR_CODES.DUPLICATE_RESOURCE,
            statusCode: 409,
            details: { code: 'CL' },
        });
    });

    it('I1 — emits audit row with the new doc in `after` when audit ctx is provided', async () => {
        const doc = makeLeaveTypeDoc();
        leaveTypeCreateMock.mockResolvedValueOnce(doc);
        const audit = makeAudit();

        await svc.createLeaveType(validCreateBody, audit);

        expect(recordAuditMock).toHaveBeenCalledTimes(1);
        const [, payload] = recordAuditMock.mock.calls[0]!;
        expect(payload).toMatchObject({
            action: 'leave_type.create',
            target: { kind: 'leave_type', id: doc._id },
            after: expect.objectContaining({ code: 'CL' }),
        });
    });

    it('does NOT emit an audit row when no ctx is provided (legacy callers)', async () => {
        leaveTypeCreateMock.mockResolvedValueOnce(makeLeaveTypeDoc());
        await svc.createLeaveType(validCreateBody);
        expect(recordAuditMock).not.toHaveBeenCalled();
    });
});

// ─── updateLeaveType ──────────────────────────────────────────────────────

describe('updateLeaveType', () => {
    it('returns 404 when the id is unknown', async () => {
        leaveTypeFindByIdMock.mockResolvedValueOnce(null);
        await expect(svc.updateLeaveType(new Types.ObjectId(), { name: 'Renamed' })).rejects.toMatchObject({
            code: ERROR_CODES.RESOURCE_NOT_FOUND,
            statusCode: 404,
        });
    });

    it('applies fields and saves', async () => {
        const doc = makeLeaveTypeDoc({ name: 'Old', monthly_cap: null });
        leaveTypeFindByIdMock.mockResolvedValueOnce(doc);

        await svc.updateLeaveType(doc._id, { name: 'New', monthly_cap: 1 });

        expect(doc.name).toBe('New');
        expect(doc.monthly_cap).toBe(1);
        expect(doc.save).toHaveBeenCalledTimes(1);
    });

    it('I1 — audit row records before/after diff (e.g. monthly_cap rename forensics)', async () => {
        // The realistic forensic scenario: an admin changes the SL
        // monthly_cap from 1 to 2. Six months later employees complain
        // their SL accrual changed. The audit trail must show the
        // before:1 → after:2 transition with the actor + timestamp.
        const doc = makeLeaveTypeDoc({ code: 'SL', monthly_cap: 1 });
        leaveTypeFindByIdMock.mockResolvedValueOnce(doc);
        const audit = makeAudit();

        await svc.updateLeaveType(doc._id, { monthly_cap: 2 }, audit);

        const [, payload] = recordAuditMock.mock.calls[0]!;
        expect(payload).toMatchObject({
            action: 'leave_type.update',
            target: { kind: 'leave_type', id: doc._id },
            before: expect.objectContaining({ monthly_cap: 1 }),
            after: expect.objectContaining({ monthly_cap: 2 }),
        });
    });
});

// ─── deactivateLeaveType ──────────────────────────────────────────────────

describe('deactivateLeaveType', () => {
    it('returns 404 when the id is unknown', async () => {
        leaveTypeFindByIdMock.mockResolvedValueOnce(null);
        await expect(svc.deactivateLeaveType(new Types.ObjectId())).rejects.toMatchObject({
            code: ERROR_CODES.RESOURCE_NOT_FOUND,
        });
    });

    it('flips is_active false and saves on first deactivation', async () => {
        const doc = makeLeaveTypeDoc({ is_active: true });
        leaveTypeFindByIdMock.mockResolvedValueOnce(doc);

        await svc.deactivateLeaveType(doc._id);

        expect(doc.is_active).toBe(false);
        expect(doc.save).toHaveBeenCalledTimes(1);
    });

    it('idempotent — re-deactivating an already-inactive type is a no-op (no save, no audit)', async () => {
        const doc = makeLeaveTypeDoc({ is_active: false });
        leaveTypeFindByIdMock.mockResolvedValueOnce(doc);
        const audit = makeAudit();

        await svc.deactivateLeaveType(doc._id, audit);

        expect(doc.save).not.toHaveBeenCalled();
        // I1 — the audit row only fires on an actual transition. A
        // regression that emitted on every call would flood the audit
        // log with no-ops.
        expect(recordAuditMock).not.toHaveBeenCalled();
    });

    it('I1 — audit row pins the {is_active: true → false} transition', async () => {
        const doc = makeLeaveTypeDoc({ is_active: true });
        leaveTypeFindByIdMock.mockResolvedValueOnce(doc);
        const audit = makeAudit();

        await svc.deactivateLeaveType(doc._id, audit);

        const [, payload] = recordAuditMock.mock.calls[0]!;
        expect(payload).toMatchObject({
            action: 'leave_type.deactivate',
            target: { kind: 'leave_type', id: doc._id },
            before: { is_active: true },
            after: { is_active: false },
        });
    });
});
