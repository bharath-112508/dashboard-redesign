// src/services/dashboard-analytics.service.test.ts
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Types } from 'mongoose';

vi.mock('../models/attendance-record.model.js', () => ({ AttendanceRecord: { aggregate: vi.fn() } }));
vi.mock('../models/leave-request.model.js', () => ({
    LeaveRequest: { aggregate: vi.fn(), find: vi.fn(), countDocuments: vi.fn() },
}));
vi.mock('../models/leave-type.model.js', () => ({ LeaveType: { find: vi.fn() } }));
vi.mock('../models/timesheet-entry.model.js', () => ({ TimesheetEntry: { aggregate: vi.fn() } }));
vi.mock('../models/holiday.model.js', () => ({ Holiday: { find: vi.fn(), countDocuments: vi.fn() } }));
vi.mock('../models/user.model.js', () => ({ User: { find: vi.fn(), countDocuments: vi.fn(), aggregate: vi.fn() } }));
vi.mock('../models/project.model.js', () => ({ Project: { find: vi.fn() } }));
vi.mock('../models/task.model.js', () => ({ Task: { aggregate: vi.fn(), find: vi.fn(), countDocuments: vi.fn() } }));
vi.mock('../models/billing-rate.model.js', () => ({ BillingRate: { find: vi.fn() } }));

import { AttendanceRecord } from '../models/attendance-record.model.js';
import { Holiday } from '../models/holiday.model.js';
import { TimesheetEntry } from '../models/timesheet-entry.model.js';
import { computeAttendanceTrend, computeHoursByProject, countWorkingDays } from './dashboard-analytics.service.js';

const RANGE = {
    key: 'month' as const,
    label: 'This month',
    prev_label: 'last month',
    from: '2026-06-01',
    to: '2026-06-03',
    prev_from: '2026-05-01',
    prev_to: '2026-05-31',
};

// Chainable .find() stub: find().select().lean() etc resolve to `rows`.
const queryStub = (rows: unknown) => {
    const q: Record<string, unknown> = {};
    for (const m of ['select', 'sort', 'limit', 'lean']) {
        q[m] = vi.fn().mockReturnValue(q);
    }
    (q as { then: unknown }).then = (resolve: (v: unknown) => void) => resolve(rows);
    return q;
};

beforeEach(() => {
    vi.clearAllMocks();
    // Default Holiday.find stub (returns no holidays) for tests that indirectly
    // call countWorkingDays (e.g. single-user attendance branch).
    vi.mocked(Holiday.find).mockReturnValue(queryStub([]) as never);
});

describe('computeAttendanceTrend', () => {
    it('pivots per-day status counts into a series', async () => {
        vi.mocked(AttendanceRecord.aggregate).mockResolvedValue([
            { _id: { date: '2026-06-01', status: 'present' }, count: 30 },
            { _id: { date: '2026-06-01', status: 'on_leave' }, count: 4 },
            { _id: { date: '2026-06-02', status: 'present' }, count: 36 },
        ] as never);

        const out = await computeAttendanceTrend(null, RANGE, 40);
        expect(out.data).toEqual([
            { date: '2026-06-01', present: 30, on_leave: 4 },
            { date: '2026-06-02', present: 36, on_leave: 0 },
            { date: '2026-06-03', present: 0, on_leave: 0 },
        ]);
        expect(out.insight).toContain('of 40 people');
    });

    it('scopes by user ids when provided', async () => {
        vi.mocked(AttendanceRecord.aggregate).mockResolvedValue([] as never);
        const ids = [new Types.ObjectId()];
        await computeAttendanceTrend(ids, RANGE, 1);
        const pipeline = vi.mocked(AttendanceRecord.aggregate).mock.calls[0][0] as unknown as Record<string, unknown>[];
        expect(pipeline[0]).toEqual({
            $match: {
                local_date: { $gte: '2026-06-01', $lte: '2026-06-03' },
                user_id: { $in: ids },
            },
        });
    });
});

describe('countWorkingDays', () => {
    it('excludes weekends and holidays', async () => {
        // 2026-06-01..07: Mon..Sun. Holiday on Wed 03.
        vi.mocked(Holiday.find).mockReturnValue(queryStub([{ date: '2026-06-03' }]) as never);
        // Mon,Tue,Thu,Fri = 4 working days
        await expect(countWorkingDays('2026-06-01', '2026-06-07')).resolves.toBe(4);
    });
});

describe('computeHoursByProject', () => {
    it('sums minutes per project with names, top-share insight, delta', async () => {
        const p1 = new Types.ObjectId();
        const p2 = new Types.ObjectId();
        vi.mocked(TimesheetEntry.aggregate)
            .mockResolvedValueOnce([
                { _id: p1, minutes: 412 * 60 },
                { _id: p2, minutes: 290 * 60 },
            ] as never)
            .mockResolvedValueOnce([{ _id: null, minutes: 600 * 60 }] as never); // prev total
        const { Project } = await import('../models/project.model.js');
        vi.mocked(Project.find).mockReturnValue(
            queryStub([
                { _id: p1, name: 'Platform', code: 'PLT' },
                { _id: p2, name: 'Mobile', code: 'MOB' },
            ]) as never
        );

        const out = await computeHoursByProject(null, RANGE);
        expect(out.data[0]).toMatchObject({ project_name: 'Platform', minutes: 412 * 60 });
        expect(out.insight).toContain('Platform took the most time');
        expect(out.delta?.label).toContain('vs last month');
    });
});
