import type { Types } from 'mongoose';

import { PERMISSIONS } from '../constants/permissions.js';
import { callerCan } from '../utils/caller-permissions.js';
import { listLeaveTypes } from './leave-type.service.js';
import { resolvePermissionsForUser } from './role.service.js';
import { listOwnBalances } from './leave-balance.service.js';
import type { ApplyLeaveModalType } from '../utils/slack-leave-blocks.js';

/**
 * Assemble the active leave types + the caller's current-year available
 * balance for the Apply-for-leave modal. Balance is joined to type by `code`
 * (the balance row's `leave_type.code`); a type with no balance row (unlimited
 * WFH, earned comp-off) gets `available: null` so the builder shows the name
 * with no "— N left" suffix.
 *
 * Both reads are indexed and tiny — this runs inside Slack's ~3s trigger_id
 * window before `views.open`.
 */
export const loadApplyLeaveModalTypes = async (userId: Types.ObjectId): Promise<ApplyLeaveModalType[]> => {
    const [types, balances] = await Promise.all([listLeaveTypes({ is_active: true }), listOwnBalances(userId)]);

    const availableByCode = new Map<string, number | null>();
    for (const b of balances) {
        const code = (b as { leave_type?: { code?: string } }).leave_type?.code;
        if (code) availableByCode.set(code, (b as { available?: number }).available ?? null);
    }

    return types.map((t) => {
        const code = (t as { code: string }).code;
        return {
            id: (t as { id: string }).id,
            code,
            name: (t as { name: string }).name,
            available: availableByCode.has(code) ? availableByCode.get(code)! : null,
        };
    });
};

/**
 * May this caller apply for leave from Slack?
 *
 * Keyed on `leave_request.write` — the SAME permission
 * `requirePermission` enforces on `POST /leaves` — because the Slack
 * inbound path bypasses Express middleware entirely and `applyLeave` has
 * no permission check of its own. This is the only gate on that write.
 *
 * It replaced `role !== ROLES.CLIENT`, which was wrong twice over. It let a
 * **representative** through — a client-side role that holds no
 * `leave_request.write` and has no business applying for leave — and being
 * exclusion-based it also failed open for anyone assigned only custom
 * roles, whose legacy `role` field stays at its previous value (see
 * `role.service:assignRolesToUser`). Asking the permission closes both:
 * client-side bundles don't carry it, and a scoped-down custom role that
 * drops it is refused rather than waved past.
 */
export const callerCanApplyLeave = async (userId: Types.ObjectId): Promise<boolean> => {
    const { permissions } = await resolvePermissionsForUser(userId);
    return callerCan(permissions, PERMISSIONS.LEAVE_REQUEST_WRITE);
};

/**
 * May this caller approve/reject leave from Slack?
 *
 * Keyed on `leave_request.approve` — the SAME permission `requirePermission`
 * enforces on `POST /leaves/:id/approve|reject` — for the same reason
 * `callerCanApplyLeave` exists: the Slack inbound path bypasses Express
 * middleware entirely, so this IS the authorization boundary for the
 * approve/reject buttons, not a UI nicety.
 *
 * It replaces `isReviewer(user.role)` (`role === admin || manager ||
 * team_lead`), which reads the legacy `User.role` field and fails open for
 * exactly the case `callerCanApplyLeave`'s doc comment describes: a Team
 * Lead narrowed to a custom role that omits `leave_request.approve` keeps
 * `User.role === 'team_lead'` (`assignRolesToUser` never rewrites it for a
 * custom-role-only assignment), so the old check waved them through to
 * approve/reject ANY user's leave while the equivalent HTTP route correctly
 * refused them. `ensureCanReviewRequest` (leave-request.service.ts) reads
 * the same stale field and is a separate, wider fix — not touched here.
 */
export const callerCanApproveLeave = async (userId: Types.ObjectId): Promise<boolean> => {
    const { permissions } = await resolvePermissionsForUser(userId);
    return callerCan(permissions, PERMISSIONS.LEAVE_REQUEST_APPROVE);
};
