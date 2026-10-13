import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Types } from 'mongoose';

/**
 * Unit tests for `salary-structure.service` (Task 5).
 *
 * Coverage focus:
 *   1. `getCurrentStructure` — throws `PAYROLL_NO_CURRENT_SALARY` when the
 *      user has no rows; returns the newest row with
 *      `effective_from <= onOrBefore` when one exists.
 *   2. `createStructure` — a newer `effective_from` supersedes prior rows
 *      (clears their `is_current`) and the new row becomes current; a
 *      back-dated `effective_from` leaves the existing latest row current
 *      and the new row is NOT current; duplicate-key (11000) surfaces as a
 *      conflict AppError.
 */

const {
    structureCreateMock,
    structureUpdateManyMock,
    structureFindMock,
    structureFindOneMock,
    userExistsMock,
    recordAuditMock,
} = vi.hoisted(() => ({
    structureCreateMock: vi.fn(),
    structureUpdateManyMock: vi.fn(),
    structureFindMock: vi.fn(),
    structureFindOneMock: vi.fn(),
    userExistsMock: vi.fn(),
    recordAuditMock: vi.fn(),
}));

vi.mock('../models/salary-structure.model.js', () => ({
    SalaryStructure: {
        create: structureCreateMock,
        updateMany: structureUpdateManyMock,
        find: structureFindMock,
        findOne: structureFindOneMock,
    },
}));

vi.mock('../models/user.model.js', () => ({
    User: { exists: userExistsMock },
}));

vi.mock('./audit.service.js', () => ({
    recordAudit: recordAuditMock,
}));

const svc = await import('./salary-structure.service.js');
import type { SalaryStructureCaller } from './salary-structure.service.js';
import { ERROR_CODES } from '../constants/error-codes.js';
import { AUDIT_ACTIONS, AUDIT_TARGET_KINDS } from '../constants/audit.js';

// ─── Helpers ─────────────────────────────────────────────────────────────

const uid = new Types.ObjectId();
const callerId = new Types.ObjectId();
const caller: SalaryStructureCaller = {
    id: callerId,
    audit: { actor_id: callerId, actor_role: 'admin' },
};

const toJSONable = <T extends Record<string, unknown>>(obj: T): T & { toJSON: () => T } => ({
    ...obj,
    toJSON: () => obj,
});

beforeEach(() => {
    vi.clearAllMocks();
    userExistsMock.mockResolvedValue(true);
});

// ─── getCurrentStructure ────────────────────────────────────────────────

describe('getCurrentStructure', () => {
    it('throws PAYROLL_NO_CURRENT_SALARY when the user has no structures', async () => {
        structureFindOneMock.mockReturnValue({
            sort: () => Promise.resolve(null),
        });

        await expect(svc.getCurrentStructure(uid, '2026-02-28')).rejects.toMatchObject({
            code: ERROR_CODES.PAYROLL_NO_CURRENT_SALARY,
        });
    });

    it('returns the newest row with effective_from <= onOrBefore', async () => {
        const doc = toJSONable({ _id: new Types.ObjectId(), user_id: uid, effective_from: '2026-01-01' });
        structureFindOneMock.mockReturnValue({
            sort: () => Promise.resolve(doc),
        });

        const result = await svc.getCurrentStructure(uid, '2026-02-28');

        expect(structureFindOneMock).toHaveBeenCalledWith({
            user_id: uid,
            effective_from: { $lte: '2026-02-28' },
        });
        expect(result).toBe(doc);
    });
});

// ─── createStructure ────────────────────────────────────────────────────

describe('createStructure', () => {
    it('supersedes prior rows and marks the new (newest) row current', async () => {
        structureFindMock.mockReturnValue({
            sort: () => ({ limit: () => Promise.resolve([{ effective_from: '2026-01-01' }]) }),
        });
        structureUpdateManyMock.mockResolvedValue({ acknowledged: true });
        const created = toJSONable({
            _id: new Types.ObjectId(),
            user_id: uid,
            effective_from: '2026-03-01',
            is_current: true,
        });
        structureCreateMock.mockResolvedValue([created]);

        const result = await svc.createStructure(
            {
                user_id: uid.toString(),
                effective_from: '2026-03-01',
                earnings: [{ label: 'Basic', amount: 50000 }],
                deductions: [{ label: 'PF', amount: 1800 }],
            } as never,
            caller
        );

        // Prior rows for this user cleared to is_current: false.
        expect(structureUpdateManyMock).toHaveBeenCalledWith(
            { user_id: uid },
            { $set: { is_current: false } },
            expect.anything()
        );
        // New row created as current.
        expect(structureCreateMock).toHaveBeenCalledWith(
            [expect.objectContaining({ is_current: true, effective_from: '2026-03-01' })],
            expect.anything()
        );
        expect(recordAuditMock).toHaveBeenCalledWith(
            caller.audit,
            expect.objectContaining({
                action: AUDIT_ACTIONS.SALARY_STRUCTURE_CREATE,
                target: { kind: AUDIT_TARGET_KINDS.SALARY_STRUCTURE, id: created._id },
            })
        );
        expect(result).toEqual(created.toJSON());
    });

    it('does not mark a back-dated row current when a newer row already exists', async () => {
        structureFindMock.mockReturnValue({
            sort: () => ({ limit: () => Promise.resolve([{ effective_from: '2026-05-01' }]) }),
        });
        const created = toJSONable({
            _id: new Types.ObjectId(),
            user_id: uid,
            effective_from: '2026-01-01',
            is_current: false,
        });
        structureCreateMock.mockResolvedValue([created]);

        await svc.createStructure(
            {
                user_id: uid.toString(),
                effective_from: '2026-01-01',
                earnings: [],
                deductions: [],
            } as never,
            caller
        );

        // Back-dated insert must not clear the existing latest row's is_current.
        expect(structureUpdateManyMock).not.toHaveBeenCalled();
        expect(structureCreateMock).toHaveBeenCalledWith(
            [expect.objectContaining({ is_current: false, effective_from: '2026-01-01' })],
            expect.anything()
        );
    });

    it('surfaces a duplicate (user_id, effective_from) as a conflict AppError', async () => {
        structureFindMock.mockReturnValue({
            sort: () => ({ limit: () => Promise.resolve([]) }),
        });
        const dupErr = Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
        structureCreateMock.mockRejectedValue(dupErr);

        await expect(
            svc.createStructure(
                {
                    user_id: uid.toString(),
                    effective_from: '2026-01-01',
                    earnings: [],
                    deductions: [],
                } as never,
                caller
            )
        ).rejects.toMatchObject({ statusCode: 409 });
    });
});
