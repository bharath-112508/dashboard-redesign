import { afterEach, describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';

vi.mock('./attendance.service.js', () => ({
    getMyToday: vi.fn(async () => null),
    getTodayAttendanceSummary: vi.fn(async () => ({
        headcount: 3,
        present: 1,
        incomplete: 0,
        on_leave: 0,
        not_in_count: 2,
        not_in_roster: [{ id: 'x', full_name: 'Meera' }],
    })),
}));
vi.mock('./leave-balance.service.js', () => ({ listOwnBalances: vi.fn(async () => []) }));
vi.mock('./leave-request.service.js', () => ({
    listLeaves: vi.fn(async () => ({ data: [], meta: {} })),
    calendarLeaves: vi.fn(async () => []),
}));
vi.mock('./role.service.js', () => ({ resolvePermissionsForUser: vi.fn() }));

import { getTodayAttendanceSummary } from './attendance.service.js';
import { listLeaves } from './leave-request.service.js';
import { resolvePermissionsForUser } from './role.service.js';
import { buildHomeDashboardData } from './slack-home.service.js';

const employee = { _id: new Types.ObjectId(), role: 'employee', full_name: 'Raj' } as never;
const admin = { _id: new Types.ObjectId(), role: 'admin', full_name: 'Boss' } as never;

afterEach(() => vi.clearAllMocks());

describe('buildHomeDashboardData', () => {
    it('employee: no team_attendance, no pending_leaves; has whos_out', async () => {
        (resolvePermissionsForUser as ReturnType<typeof vi.fn>).mockResolvedValue({ permissions: [] });
        const data = await buildHomeDashboardData(employee);
        expect(data.team_attendance).toBeNull();
        expect(data.pending_leaves).toBeNull();
        expect(data.whos_out).toEqual([]);
        expect(getTodayAttendanceSummary).not.toHaveBeenCalled();
    });

    it('admin: includes team_attendance + pending_leaves', async () => {
        (resolvePermissionsForUser as ReturnType<typeof vi.fn>).mockResolvedValue({
            permissions: ['attendance.read_team'],
        });
        (listLeaves as ReturnType<typeof vi.fn>).mockResolvedValue({
            data: [{ id: 'L1', status: 'pending' }],
            meta: {},
        });
        const data = await buildHomeDashboardData(admin);
        expect(data.team_attendance).not.toBeNull();
        expect(data.pending_leaves).toEqual([{ id: 'L1', status: 'pending' }]);
    });

    it('a failing section degrades to null, others still populate', async () => {
        (resolvePermissionsForUser as ReturnType<typeof vi.fn>).mockResolvedValue({ permissions: [] });
        const { listOwnBalances } = await import('./leave-balance.service.js');
        (listOwnBalances as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('db down'));
        const data = await buildHomeDashboardData(employee);
        expect(data.my_balances).toBeNull();
        expect(data.whos_out).toEqual([]);
    });
});
