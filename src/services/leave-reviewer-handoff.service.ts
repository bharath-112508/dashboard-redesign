import { Types } from 'mongoose';

import { LEAVE_REQUEST_STATUSES } from '../constants/leave.js';
import { NOTIFICATION_TYPES } from '../constants/notification.js';
import { LeaveRequest } from '../models/leave-request.model.js';
import { LeaveType } from '../models/leave-type.model.js';
import { Notification } from '../models/notification.model.js';
import { User } from '../models/user.model.js';
import { USER_STATUSES } from '../constants/user-statuses.js';
import logger from '../utils/logger.js';
import { notifyLeaveReviewReassigned } from './notification-dispatcher.service.js';

/**
 * Hand a user's still-PENDING leave requests over when their reporting
 * manager changes.
 *
 * The approvals queue is computed live from the reporting line, so it already
 * follows a reassignment on its own. The NOTIFICATIONS don't: they are written
 * once at apply time and never revisited. That left two halves of the same
 * bug —
 *
 *   - the OLD manager kept an unread "please review" in their bell for a
 *     request they can no longer act on (`assertCanReviewScoped` 403s them),
 *     which reads as "the request still comes to that manager"; and
 *   - the NEW manager was never told. The request simply appeared in their
 *     queue with no ping, so nobody was prompted to action it.
 *
 * Only UNREAD notifications for still-PENDING requests are withdrawn. A
 * notification the manager already opened is history and stays put, and a
 * decided request is nobody's to-do any more.
 *
 * Best-effort by design: a reporting-line edit must not fail because a
 * notification couldn't be reconciled.
 */
export const handOffPendingLeaveReviews = async (input: {
    userId: Types.ObjectId;
    previousManagerId: Types.ObjectId | null;
    nextManagerId: Types.ObjectId | null;
}): Promise<void> => {
    const { userId, previousManagerId, nextManagerId } = input;
    if (String(previousManagerId ?? '') === String(nextManagerId ?? '')) return;

    try {
        const pending = await LeaveRequest.find({
            user_id: userId,
            status: LEAVE_REQUEST_STATUSES.PENDING,
        }).lean();
        if (pending.length === 0) return;

        const requestIds = pending.map((r) => r._id);

        // 1. Withdraw the old manager's unread prompts — they can't action
        //    these any more.
        if (previousManagerId) {
            const { deletedCount } = await Notification.deleteMany({
                user_id: previousManagerId,
                type: NOTIFICATION_TYPES.LEAVE_REQUESTED,
                is_read: false,
                'related_entity.id': { $in: requestIds },
            });
            logger.info(
                {
                    code: 'LEAVE_REVIEW_HANDOFF',
                    user_id: userId.toString(),
                    from_manager_id: previousManagerId.toString(),
                    withdrawn: deletedCount,
                },
                'Withdrew stale leave-review notifications from the previous reporting manager'
            );
        }

        // 2. Tell the new manager about what just landed in their queue.
        if (!nextManagerId) return;
        const nextManager = await User.findOne({ _id: nextManagerId, status: USER_STATUSES.ACTIVE })
            .select('_id')
            .lean();
        if (!nextManager) return;

        const typeIds = [...new Set(pending.map((r) => String(r.requested_leave_type_id)))];
        const types = await LeaveType.find({ _id: { $in: typeIds } })
            .select('_id code name')
            .lean<{ _id: Types.ObjectId; code: string; name: string }[]>();
        const labelById = new Map(types.map((t) => [String(t._id), `${t.code} — ${t.name}`]));

        const requester = await User.findById(userId).select('full_name').lean<{ full_name: string }>();
        for (const req of pending) {
            await notifyLeaveReviewReassigned({
                request_id: req._id,
                reviewer_id: nextManagerId,
                requester_name: requester?.full_name ?? 'An employee',
                leave_type_label: labelById.get(String(req.requested_leave_type_id)) ?? 'Leave',
                start_date: String(req.start_date),
                end_date: String(req.end_date),
            });
        }
    } catch (err) {
        logger.warn(
            { err, code: 'LEAVE_REVIEW_HANDOFF_FAILED', user_id: userId.toString() },
            'Failed to hand off pending leave reviews after a reporting-manager change'
        );
    }
};
