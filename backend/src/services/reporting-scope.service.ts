import { Types } from 'mongoose';

import { User } from '../models/user.model.js';
import { Project } from '../models/project.model.js';
import { CLIENT_SIDE_ROLES, ROLES, type RoleType } from '../constants/roles.js';
import { USER_STATUSES } from '../constants/user-statuses.js';

/**
 * Team scoping — the single source of truth for "which people may this
 * reviewer SEE on a team-facing list": team attendance, team timesheets,
 * comp-off ledger, team leave balances and the Slack App Home.
 *
 * A non-admin reviewer's team is their direct reports **plus everyone who
 * shares a project with them**. Reports alone was too narrow in practice: a
 * Team Lead running a project could see nothing at all until somebody filled
 * in a `reporting_manager_id` they had no way to know was missing, while their
 * own dashboard — which has always counted project members — told them they
 * had a team of eight. The two now answer the same question the same way.
 *
 *   - "Direct report" = an active internal user whose
 *     `internal_profile.reporting_manager_id` points at the reviewer.
 *   - "Project peer"  = a member of a project the reviewer is a member of.
 *     `member_ids` is the internal roster, so no client-side person is ever
 *     pulled in; the reviewer themselves is a member, hence part of their own
 *     scope, which is what makes a roster count agree with the dashboard tile.
 *
 * SEEING is not APPROVING. Leave review stays on the reporting chain
 * (`directReportIdsOf` in leave-request.service + the `isDirectReportOf`
 * guard): sharing a project must not let two leads both act on one person's
 * leave. Widen this and you widen the lists, not the authority.
 */

/** Everyone on a project `userId` is a member of, `userId` included. */
const projectPeerIdsOf = async (userId: Types.ObjectId): Promise<Types.ObjectId[]> => {
    const projects = await Project.find({ member_ids: userId })
        .select('member_ids')
        .lean<{ member_ids: Types.ObjectId[] }[]>();
    const seen = new Map<string, Types.ObjectId>();
    for (const p of projects) for (const m of p.member_ids ?? []) seen.set(m.toString(), m);
    return [...seen.values()];
};

/**
 * The people a non-admin reviewer may see: direct reports ∪ project peers,
 * narrowed to active internal users (a deactivated member or a client-side
 * person on some roster must never leak onto a team list).
 */
export const teamScopeIdsOf = async (userId: Types.ObjectId): Promise<Types.ObjectId[]> => {
    const peerIds = await projectPeerIdsOf(userId);
    return (await User.find({
        status: USER_STATUSES.ACTIVE,
        role: { $nin: CLIENT_SIDE_ROLES },
        $or: [{ 'internal_profile.reporting_manager_id': userId }, { _id: { $in: peerIds } }],
    }).distinct('_id')) as Types.ObjectId[];
};

/** Active users who report to `managerId`. Approval authority — see the note above. */
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
 *   - Admin → `null` (no restriction; the caller keeps its own base filter
 *     such as date range / exclude-self).
 *   - Manager / Team-Lead → their team (reports ∪ project peers; may be empty
 *     → sees none).
 *
 * Callers that already resolved a role should pass it; non-reviewers must be
 * filtered out upstream (this returns their empty report set defensively).
 */
export const visibleUserIdsForReviewer = async (caller: {
    id: Types.ObjectId;
    role: RoleType;
}): Promise<Types.ObjectId[] | null> => {
    if (caller.role === ROLES.ADMIN) return null;
    return teamScopeIdsOf(caller.id);
};

/**
 * Fold team scoping into an existing `user_id` filter fragment for a team
 * list. `requestedUserId` is an optional caller-supplied filter (drill into
 * one person). Returns the value to assign to `filter.user_id`.
 *   - Admin → the requested id, or `undefined` (meaning "no user_id restriction
 *     — leave whatever the caller already set, e.g. `{ $ne: self }`").
 *   - Manager/TL → `{ $in: team }`, or the requested id only if it's in their
 *     team (else `{ $in: [] }` → nothing).
 */
export const scopedUserIdFilter = async (
    caller: { id: Types.ObjectId; role: RoleType },
    requestedUserId?: string
): Promise<unknown | undefined> => {
    if (caller.role === ROLES.ADMIN) {
        return requestedUserId ? new Types.ObjectId(requestedUserId) : undefined;
    }
    const teamIds = await teamScopeIdsOf(caller.id);
    if (requestedUserId) {
        const wanted = new Types.ObjectId(requestedUserId);
        return teamIds.some((id) => id.equals(wanted)) ? wanted : { $in: [] };
    }
    return { $in: teamIds };
};
