import { Types } from 'mongoose';

import { User } from '../models/user.model.js';
import { ROLES, type RoleType } from '../constants/roles.js';
import { USER_STATUSES } from '../constants/user-statuses.js';

/**
 * Reporting-chain scoping — the single source of truth for "which people does
 * this reviewer manage". Every team-facing surface (leave approvals, team
 * attendance, team timesheets, comp-off ledger, team leave balances, and the
 * Slack App Home) narrows a non-admin reviewer to their own direct reports so
 * a Manager / Team-Lead only ever sees the people who report to them.
 *
 * "Direct report" = an active internal user whose
 * `internal_profile.reporting_manager_id` points at the reviewer.
 */

/** Active users who report to `managerId`. */
export const directReportIdsOf = async (managerId: Types.ObjectId): Promise<Types.ObjectId[]> =>
    (await User.find({
        'internal_profile.reporting_manager_id': managerId,
        status: USER_STATUSES.ACTIVE,
    }).distinct('_id')) as Types.ObjectId[];

/** True when `userId`'s reporting manager is `managerId`. */
export const isDirectReportOf = async (userId: Types.ObjectId, managerId: Types.ObjectId): Promise<boolean> => {
    const u = await User.findById(userId)
        .select('internal_profile.reporting_manager_id')
        .lean<{ internal_profile?: { reporting_manager_id?: Types.ObjectId | null } }>();
    const rm = u?.internal_profile?.reporting_manager_id ?? null;
    return rm != null && managerId.equals(rm);
};

/**
 * The set of user_ids a reviewer may see on a team-facing list:
 *   - Admin → `null` (no reporting-chain restriction; the caller keeps its own
 *     base filter such as date range / exclude-self).
 *   - Manager / Team-Lead → their direct report ids (may be empty → sees none).
 *
 * Callers that already resolved a role should pass it; non-reviewers must be
 * filtered out upstream (this returns their empty report set defensively).
 */
export const visibleUserIdsForReviewer = async (caller: {
    id: Types.ObjectId;
    role: RoleType;
}): Promise<Types.ObjectId[] | null> => {
    if (caller.role === ROLES.ADMIN) return null;
    return directReportIdsOf(caller.id);
};

/**
 * Fold reporting-chain scoping into an existing `user_id` filter fragment for
 * a team list. `requestedUserId` is an optional caller-supplied filter (drill
 * into one person). Returns the value to assign to `filter.user_id`.
 *   - Admin → the requested id, or `undefined` (meaning "no user_id restriction
 *     — leave whatever the caller already set, e.g. `{ $ne: self }`").
 *   - Manager/TL → `{ $in: reports }`, or the requested id only if it's one of
 *     their reports (else `{ $in: [] }` → nothing).
 */
export const scopedUserIdFilter = async (
    caller: { id: Types.ObjectId; role: RoleType },
    requestedUserId?: string
): Promise<unknown | undefined> => {
    if (caller.role === ROLES.ADMIN) {
        return requestedUserId ? new Types.ObjectId(requestedUserId) : undefined;
    }
    const reportIds = await directReportIdsOf(caller.id);
    if (requestedUserId) {
        const wanted = new Types.ObjectId(requestedUserId);
        return reportIds.some((id) => id.equals(wanted)) ? wanted : { $in: [] };
    }
    return { $in: reportIds };
};
