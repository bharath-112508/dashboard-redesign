import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TIMESHEET_NO_PROJECT_LABEL } from '../constants/timesheet.js';
import { Types } from 'mongoose';

vi.mock('./attendance.service.js', () => ({
    getMyToday: vi.fn(async () => null),
    getTodayAttendanceSummary: vi.fn(async () => ({
        headcount: 1,
        working: [],
        on_break: [],
        checked_out: [],
        on_leave: [],
        not_in: [{ id: 'x', full_name: 'Meera' }],
        incomplete: [],
    })),
}));
vi.mock('./leave-balance.service.js', () => ({ listOwnBalances: vi.fn(async () => []) }));
vi.mock('./leave-request.service.js', () => ({
    listLeaves: vi.fn(async () => ({ data: [], meta: {} })),
    calendarLeaves: vi.fn(async () => []),
}));
vi.mock('./role.service.js', () => ({ resolvePermissionsForUser: vi.fn() }));
vi.mock('./user.service.js', () => ({ getSlackAvatarUrlsByIds: vi.fn(async () => new Map()) }));

// The "Your time" table resolves project names and ticket keys from ids —
// `listMyDay` returns raw ids, not populated docs.
const projectFindMock = vi.fn();
const taskFindMock = vi.fn();
vi.mock('../models/project.model.js', () => ({ Project: { find: (...a: unknown[]) => projectFindMock(...a) } }));
vi.mock('../models/task.model.js', () => ({ Task: { find: (...a: unknown[]) => taskFindMock(...a) } }));
const leanStub = (rows: unknown[]) => ({ select: () => ({ lean: async () => rows }) });
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
    it('caller with timesheet.write: fetches today, sums billable_total_minutes AND non_billable_total_minutes (not total_minutes, not a subtraction) from rows', async () => {
        (resolvePermissionsForUser as ReturnType<typeof vi.fn>).mockResolvedValue({
            permissions: ['timesheet.write'],
        });
        // Billable, non-billable and idle are all DIFFERENT and idle is
        // baked into total_minutes but excluded from both the billable and
        // non-billable sums — summing the wrong field, or deriving
        // non-billable by subtracting billable from total (which would fold
        // idle into "non-billable"), fails this test.
        // Row 1: billable 60, non-billable 20, idle 10 -> total 90.
        // Row 2: billable 30, non-billable 40, idle 5  -> total 75.
        (listMyDay as ReturnType<typeof vi.fn>).mockResolvedValue({
            data: [
                { total_minutes: 90, billable_total_minutes: 60, non_billable_total_minutes: 20 },
                { total_minutes: 75, billable_total_minutes: 30, non_billable_total_minutes: 40 },
            ],
            meta: { local_date: today, total_minutes: 165 },
        });
        const data = await buildHomeDashboardData(employee);
        expect(listMyDay).toHaveBeenCalledWith(today, { id: data.user._id, role: data.user.role });
        expect(data.can_log_time).toBe(true);
        expect(data.my_time).toMatchObject({
            total_minutes: 165,
            billable_minutes: 90,
            non_billable_minutes: 60,
        });
        // Rows carrying no project_id/task_id resolve to placeholders rather
        // than blank cells, and neither lookup is issued for them.
        expect(data.my_time?.entries).toEqual([
            { project: TIMESHEET_NO_PROJECT_LABEL, work: '', note: '', minutes: 90 },
            { project: TIMESHEET_NO_PROJECT_LABEL, work: '', note: '', minutes: 75 },
        ]);
        expect(projectFindMock).not.toHaveBeenCalled();
        expect(taskFindMock).not.toHaveBeenCalled();
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

// ─── "Your time" entry rows ──────────────────────────────────────────────

describe('buildHomeDashboardData — my_time entries', () => {
    beforeEach(() => {
        (resolvePermissionsForUser as ReturnType<typeof vi.fn>).mockResolvedValue({
            permissions: ['timesheet.write'],
        });
    });

    // 🔴 REGRESSION. `listMyDay` returns `toPublic(doc)` = `doc.toJSON()`, and
    // Mongoose leaves ObjectId fields as ObjectId INSTANCES — it does not
    // stringify them. The first version of the resolver guarded with
    // `typeof v === 'string'`, so it rejected every id, never issued a
    // lookup, and rendered "—" for every project on the live Home tab. These
    // fixtures now use real ObjectIds precisely because string fixtures are
    // what let that ship.
    it('resolves project and ticket when the ids are ObjectIds, not strings', async () => {
        const projectId = new Types.ObjectId();
        const taskId = new Types.ObjectId();
        (listMyDay as ReturnType<typeof vi.fn>).mockResolvedValue({
            data: [
                {
                    total_minutes: 150,
                    project_id: projectId,
                    task_id: taskId,
                    description: 'completed the payment integration',
                },
            ],
            meta: { local_date: today, total_minutes: 150 },
        });
        projectFindMock.mockReturnValue(leanStub([{ _id: projectId, name: 'Nordmark Fleet', code: 'NMF' }]));
        taskFindMock.mockReturnValue(leanStub([{ _id: taskId, task_number: 142, project_id: projectId }]));

        const data = await buildHomeDashboardData(employee);
        expect(data.my_time?.entries).toEqual([
            {
                project: 'Nordmark Fleet',
                work: 'NMF-142',
                note: 'completed the payment integration',
                minutes: 150,
            },
        ]);
    });

    it('still resolves when the ids arrive as strings', async () => {
        const projectId = new Types.ObjectId();
        (listMyDay as ReturnType<typeof vi.fn>).mockResolvedValue({
            data: [{ total_minutes: 30, project_id: projectId.toString(), general_category: 'Standup' }],
            meta: { local_date: today, total_minutes: 30 },
        });
        projectFindMock.mockReturnValue(leanStub([{ _id: projectId, name: 'Aurora', code: 'AUR' }]));
        taskFindMock.mockReturnValue(leanStub([]));

        const data = await buildHomeDashboardData(employee);
        expect(data.my_time?.entries[0]).toMatchObject({ project: 'Aurora', work: 'Standup' });
    });

    it('keeps the description as the note, never as the work label', async () => {
        const projectId = new Types.ObjectId();
        (listMyDay as ReturnType<typeof vi.fn>).mockResolvedValue({
            data: [{ total_minutes: 45, project_id: projectId, description: 'Paired on routing' }],
            meta: { local_date: today, total_minutes: 45 },
        });
        projectFindMock.mockReturnValue(leanStub([{ _id: projectId, name: 'Aurora', code: 'AUR' }]));
        taskFindMock.mockReturnValue(leanStub([]));

        const data = await buildHomeDashboardData(employee);
        // Printing it in both places duplicated the same sentence on one row.
        expect(data.my_time?.entries[0]).toMatchObject({ work: '', note: 'Paired on routing' });
    });

    it('labels a project-less row rather than leaving it blank', async () => {
        (listMyDay as ReturnType<typeof vi.fn>).mockResolvedValue({
            data: [{ total_minutes: 60, description: 'Internal' }],
            meta: { local_date: today, total_minutes: 60 },
        });
        const data = await buildHomeDashboardData(employee);
        // The shared constant, not a literal: the label has to match what the
        // web tables and the dashboard print for the same row.
        expect(data.my_time?.entries[0]?.project).toBe(TIMESHEET_NO_PROJECT_LABEL);
        expect(projectFindMock).not.toHaveBeenCalled();
    });

    it('looks each project up once, not once per row', async () => {
        const projectId = new Types.ObjectId();
        (listMyDay as ReturnType<typeof vi.fn>).mockResolvedValue({
            data: Array.from({ length: 5 }, () => ({
                total_minutes: 30,
                project_id: projectId,
                general_category: 'Standup',
            })),
            meta: { local_date: today, total_minutes: 150 },
        });
        projectFindMock.mockReturnValue(leanStub([{ _id: projectId, name: 'Aurora', code: 'AUR' }]));
        taskFindMock.mockReturnValue(leanStub([]));

        await buildHomeDashboardData(employee);
        expect(projectFindMock).toHaveBeenCalledTimes(1);
        const filter = projectFindMock.mock.calls[0]![0] as { _id: { $in: unknown[] } };
        expect(filter._id.$in).toHaveLength(1);
    });
});
