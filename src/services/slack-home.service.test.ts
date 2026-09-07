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
vi.mock('./user.service.js', () => ({ getSlackAvatarUrlsByIds: vi.fn(async () => new Map()) }));
vi.mock('./timesheet.service.js', () => ({
    listMyDay: vi.fn(async () => ({ data: [], meta: { local_date: '2026-01-01', total_minutes: 0 } })),
}));

import { getTodayAttendanceSummary } from './attendance.service.js';
import { listLeaves } from './leave-request.service.js';
import { resolvePermissionsForUser } from './role.service.js';
import { getSlackAvatarUrlsByIds } from './user.service.js';
import { listMyDay } from './timesheet.service.js';
import { buildHomeDashboardData } from './slack-home.service.js';
import dayjs, { DEFAULT_TIMEZONE, DATE_FORMAT } from '../utils/date.js';

const employee = { _id: new Types.ObjectId(), role: 'employee', full_name: 'Raj' } as never;
const adminId = new Types.ObjectId();
const admin = { _id: adminId, role: 'admin', full_name: 'Boss' } as never;
const today = dayjs().tz(DEFAULT_TIMEZONE).format(DATE_FORMAT);

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
            meta: { total: 7 },
        });
        const data = await buildHomeDashboardData(admin);
        expect(data.team_attendance).not.toBeNull();
        expect(data.pending_leaves).toEqual([{ id: 'L1', status: 'pending' }]);
        // True backlog total comes from meta, not the capped array length.
        expect(data.pending_total).toBe(7);
        // The reviewer's own request is excluded from their approvals queue —
        // a reviewer can't self-approve, so it must not show with Approve/Reject.
        expect(listLeaves).toHaveBeenCalledWith(
            expect.objectContaining({ status: 'pending', exclude_user_id: adminId.toString() }),
            expect.objectContaining({ id: adminId, role: 'admin' })
        );
    });

    it("attaches avatar_url onto who's-out and pending rows", async () => {
        (resolvePermissionsForUser as ReturnType<typeof vi.fn>).mockResolvedValue({
            permissions: ['attendance.read_team'],
        });
        const { calendarLeaves } = await import('./leave-request.service.js');
        (calendarLeaves as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
            { user_id: 'u1', user: { id: 'u1', full_name: 'Asha' } },
        ]);
        (listLeaves as ReturnType<typeof vi.fn>).mockResolvedValue({
            data: [{ id: 'L1', user_id: 'u2', user: { id: 'u2' } }],
            meta: { total: 1 },
        });
        (getSlackAvatarUrlsByIds as ReturnType<typeof vi.fn>).mockResolvedValue(
            new Map([
                ['u1', 'https://a/1.png'],
                ['u2', null],
            ])
        );
        const data = await buildHomeDashboardData(admin);
        expect((data.whos_out![0] as { avatar_url?: string }).avatar_url).toBe('https://a/1.png');
        expect((data.pending_leaves![0] as { avatar_url?: string | null }).avatar_url).toBeNull();
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

describe('buildHomeDashboardData — my_time', () => {
    it('caller with timesheet.write: fetches today, sums billable_total_minutes (not total_minutes) from rows', async () => {
        (resolvePermissionsForUser as ReturnType<typeof vi.fn>).mockResolvedValue({
            permissions: ['timesheet.write'],
        });
        // Rows where the row-level total and the billable split differ, so
        // summing the wrong field (or the wrong total) fails this test.
        (listMyDay as ReturnType<typeof vi.fn>).mockResolvedValue({
            data: [
                { total_minutes: 120, billable_total_minutes: 90 },
                { total_minutes: 90, billable_total_minutes: 60 },
            ],
            meta: { local_date: today, total_minutes: 210 },
        });
        const data = await buildHomeDashboardData(employee);
        expect(listMyDay).toHaveBeenCalledWith(today, { id: data.user._id, role: data.user.role });
        expect(data.can_log_time).toBe(true);
        expect(data.my_time).toEqual({ total_minutes: 210, billable_minutes: 150 });
    });

    it('caller without timesheet.write: can_log_time is false and listMyDay is never called', async () => {
        (resolvePermissionsForUser as ReturnType<typeof vi.fn>).mockResolvedValue({ permissions: [] });
        const data = await buildHomeDashboardData(employee);
        expect(data.can_log_time).toBe(false);
        expect(data.my_time).toBeNull();
        expect(listMyDay).not.toHaveBeenCalled();
    });

    it('caller with the system.admin wildcard: can_log_time is true', async () => {
        (resolvePermissionsForUser as ReturnType<typeof vi.fn>).mockResolvedValue({
            permissions: ['system.admin'],
        });
        const data = await buildHomeDashboardData(admin);
        expect(data.can_log_time).toBe(true);
        expect(listMyDay).toHaveBeenCalled();
    });

    it('listMyDay throwing degrades my_time to null without breaking the rest of the Home data', async () => {
        (resolvePermissionsForUser as ReturnType<typeof vi.fn>).mockResolvedValue({
            permissions: ['timesheet.write'],
        });
        (listMyDay as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('db down'));
        const data = await buildHomeDashboardData(employee);
        expect(data.my_time).toBeNull();
        expect(data.can_log_time).toBe(true);
        expect(data.whos_out).toEqual([]);
    });
});
