import type { Types } from 'mongoose';

import { listLeaveTypes } from './leave-type.service.js';
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
