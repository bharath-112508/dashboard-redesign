import { describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';

vi.mock('./leave-type.service.js', () => ({ listLeaveTypes: vi.fn() }));
vi.mock('./leave-balance.service.js', () => ({ listOwnBalances: vi.fn() }));

import { listLeaveTypes } from './leave-type.service.js';
import { listOwnBalances } from './leave-balance.service.js';
import { loadApplyLeaveModalTypes } from './slack-leave.service.js';

describe('loadApplyLeaveModalTypes', () => {
    it('joins active types with current-year available balance by code; null when no balance row', async () => {
        vi.mocked(listLeaveTypes).mockResolvedValue([
            { id: 't1', code: 'CL', name: 'Casual Leave' },
            { id: 't2', code: 'WFH', name: 'Work From Home' },
        ] as never);
        vi.mocked(listOwnBalances).mockResolvedValue([{ leave_type: { code: 'CL' }, available: 8 }] as never);

        const out = await loadApplyLeaveModalTypes(new Types.ObjectId());

        expect(vi.mocked(listLeaveTypes)).toHaveBeenCalledWith({ is_active: true });
        expect(out).toEqual([
            { id: 't1', code: 'CL', name: 'Casual Leave', available: 8 },
            { id: 't2', code: 'WFH', name: 'Work From Home', available: null },
        ]);
    });

    it('treats missing available field on a balance row as null, not 0', async () => {
        vi.mocked(listLeaveTypes).mockResolvedValue([{ id: 't1', code: 'CL', name: 'Casual Leave' }] as never);
        vi.mocked(listOwnBalances).mockResolvedValue([{ leave_type: { code: 'CL' } }] as never);

        const out = await loadApplyLeaveModalTypes(new Types.ObjectId());

        expect(out).toEqual([{ id: 't1', code: 'CL', name: 'Casual Leave', available: null }]);
    });
});
