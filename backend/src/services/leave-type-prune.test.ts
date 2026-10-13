import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Types } from 'mongoose';

/**
 * `pruneRetiredLeaveTypes` — the self-healing removal that runs on every boot
 * so retired leave types (Maternity/Paternity/Unpaid) can't survive a stale
 * process or old branch re-seeding them. A retired type WITH leave requests is
 * kept (history must resolve), one without is deleted along with its balances.
 */

const { leaveTypeFindMock, leaveTypeDeleteOneMock, leaveRequestExistsMock, leaveBalanceDeleteManyMock } = vi.hoisted(
    () => ({
        leaveTypeFindMock: vi.fn(),
        leaveTypeDeleteOneMock: vi.fn(),
        leaveRequestExistsMock: vi.fn(),
        leaveBalanceDeleteManyMock: vi.fn(),
    })
);

vi.mock('../models/leave-type.model.js', () => ({
    LeaveType: {
        find: leaveTypeFindMock,
        deleteOne: leaveTypeDeleteOneMock,
        updateOne: vi.fn(),
        create: vi.fn(),
        findById: vi.fn(),
        findOne: vi.fn(),
    },
}));
vi.mock('../models/leave-request.model.js', () => ({ LeaveRequest: { exists: leaveRequestExistsMock } }));
vi.mock('../models/leave-balance.model.js', () => ({ LeaveBalance: { deleteMany: leaveBalanceDeleteManyMock } }));
vi.mock('./audit.service.js', () => ({ recordAudit: vi.fn(), recordSystemAudit: vi.fn() }));

const svc = await import('./leave-type.service.js');

// find(...).select(...) → resolves to the array
const findReturns = (docs: unknown[]) => leaveTypeFindMock.mockReturnValue({ select: () => Promise.resolve(docs) });

beforeEach(() => {
    vi.clearAllMocks();
    leaveBalanceDeleteManyMock.mockResolvedValue({ deletedCount: 0 });
    leaveTypeDeleteOneMock.mockResolvedValue({ deletedCount: 1 });
});

describe('pruneRetiredLeaveTypes', () => {
    it('deletes a retired type (and its balances) when it has no requests', async () => {
        const id = new Types.ObjectId();
        findReturns([{ _id: id, code: 'MATERNITY' }]);
        leaveRequestExistsMock.mockResolvedValue(null); // not in use

        const res = await svc.pruneRetiredLeaveTypes();

        expect(res.removed).toEqual(['MATERNITY']);
        expect(res.kept).toEqual([]);
        expect(leaveBalanceDeleteManyMock).toHaveBeenCalledWith({ leave_type_id: id });
        expect(leaveTypeDeleteOneMock).toHaveBeenCalledWith({ _id: id });
    });

    it('keeps a retired type that has leave requests (never deletes history)', async () => {
        const id = new Types.ObjectId();
        findReturns([{ _id: id, code: 'PATERNITY' }]);
        leaveRequestExistsMock.mockResolvedValue({ _id: new Types.ObjectId() }); // in use

        const res = await svc.pruneRetiredLeaveTypes();

        expect(res.kept).toEqual(['PATERNITY']);
        expect(res.removed).toEqual([]);
        expect(leaveTypeDeleteOneMock).not.toHaveBeenCalled();
        expect(leaveBalanceDeleteManyMock).not.toHaveBeenCalled();
    });

    it('is a no-op when nothing matches', async () => {
        findReturns([]);
        const res = await svc.pruneRetiredLeaveTypes();
        expect(res).toEqual({ removed: [], kept: [] });
        expect(leaveTypeDeleteOneMock).not.toHaveBeenCalled();
    });
});
