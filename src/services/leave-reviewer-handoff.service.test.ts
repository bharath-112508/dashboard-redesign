import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Types } from 'mongoose';

const leaveFindMock = vi.hoisted(() => vi.fn());
const leaveTypeFindMock = vi.hoisted(() => vi.fn());
const notificationDeleteManyMock = vi.hoisted(() => vi.fn());
const userFindOneMock = vi.hoisted(() => vi.fn());
const userFindByIdMock = vi.hoisted(() => vi.fn());
const notifyReassignedMock = vi.hoisted(() => vi.fn());

vi.mock('../models/leave-request.model.js', () => ({ LeaveRequest: { find: leaveFindMock } }));
vi.mock('../models/leave-type.model.js', () => ({ LeaveType: { find: leaveTypeFindMock } }));
vi.mock('../models/notification.model.js', () => ({
    Notification: { deleteMany: notificationDeleteManyMock },
}));
vi.mock('../models/user.model.js', () => ({
    User: { findOne: userFindOneMock, findById: userFindByIdMock },
}));
vi.mock('./notification-dispatcher.service.js', () => ({
    notifyLeaveReviewReassigned: notifyReassignedMock,
}));
vi.mock('../utils/logger.js', () => ({
    default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { handOffPendingLeaveReviews } = await import('./leave-reviewer-handoff.service.js');

const userId = new Types.ObjectId();
const oldManager = new Types.ObjectId();
const newManager = new Types.ObjectId();
const requestId = new Types.ObjectId();
const typeId = new Types.ObjectId();

const chain = <T>(value: T) => {
    const c: Record<string, unknown> = {
        select: vi.fn(),
        lean: vi.fn().mockResolvedValue(value),
    };
    (c.select as ReturnType<typeof vi.fn>).mockReturnValue(c);
    return c;
};

beforeEach(() => {
    vi.clearAllMocks();
    leaveFindMock.mockReturnValue(
        chain([
            {
                _id: requestId,
                requested_leave_type_id: typeId,
                start_date: '2026-11-16',
                end_date: '2026-11-16',
                total_days: 1,
            },
        ])
    );
    leaveTypeFindMock.mockReturnValue(chain([{ _id: typeId, code: 'CL', name: 'Casual Leave' }]));
    notificationDeleteManyMock.mockResolvedValue({ deletedCount: 1 });
    userFindOneMock.mockReturnValue(chain({ _id: newManager }));
    userFindByIdMock.mockReturnValue(chain({ full_name: 'Ananya Krishnan' }));
});

describe('handOffPendingLeaveReviews', () => {
    it('does nothing when the reporting manager did not actually change', async () => {
        await handOffPendingLeaveReviews({
            userId,
            previousManagerId: oldManager,
            nextManagerId: oldManager,
        });
        expect(leaveFindMock).not.toHaveBeenCalled();
        expect(notificationDeleteManyMock).not.toHaveBeenCalled();
    });

    // The old manager can no longer act on these (`assertCanReviewScoped`
    // 403s them), so leaving the prompt in their bell is the "request still
    // comes to that manager" symptom.
    it('withdraws only the old manager UNREAD prompts for PENDING requests', async () => {
        await handOffPendingLeaveReviews({
            userId,
            previousManagerId: oldManager,
            nextManagerId: newManager,
        });

        const filter = notificationDeleteManyMock.mock.calls[0][0];
        expect(filter.user_id).toEqual(oldManager);
        expect(filter.is_read).toBe(false);
        expect(filter.type).toBe('leave_requested');
        expect(filter['related_entity.id']).toEqual({ $in: [requestId] });
        // Only pending requests were fetched to begin with.
        expect(leaveFindMock.mock.calls[0][0].status).toBe('pending');
    });

    it('notifies the incoming manager that the request is now theirs', async () => {
        await handOffPendingLeaveReviews({
            userId,
            previousManagerId: oldManager,
            nextManagerId: newManager,
        });

        expect(notifyReassignedMock).toHaveBeenCalledTimes(1);
        expect(notifyReassignedMock.mock.calls[0][0]).toMatchObject({
            request_id: requestId,
            reviewer_id: newManager,
            requester_name: 'Ananya Krishnan',
            leave_type_label: 'CL — Casual Leave',
        });
    });

    it('still withdraws the old prompt when the manager is removed outright', async () => {
        await handOffPendingLeaveReviews({
            userId,
            previousManagerId: oldManager,
            nextManagerId: null,
        });

        expect(notificationDeleteManyMock).toHaveBeenCalledTimes(1);
        // Nobody to hand to — admins already hold their own copy.
        expect(notifyReassignedMock).not.toHaveBeenCalled();
    });

    it('never throws — a profile edit must not fail on notification cleanup', async () => {
        leaveFindMock.mockImplementation(() => {
            throw new Error('mongo down');
        });
        await expect(
            handOffPendingLeaveReviews({
                userId,
                previousManagerId: oldManager,
                nextManagerId: newManager,
            })
        ).resolves.toBeUndefined();
    });
});
