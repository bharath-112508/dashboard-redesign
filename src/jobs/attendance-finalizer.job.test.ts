import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Types } from 'mongoose';

/**
 * Unit tests for `finalizeAttendanceForDate` (Step 14.1) — the pure logic
 * of the attendance EOD finalizer.
 *
 * Coverage:
 *  1. Weekday in working_days → missing-row placeholder is `absent`.
 *  2. Day matches a holiday → placeholder is `holiday`.
 *  3. Weekday outside working_days → placeholder is `weekend`.
 *  4. User on approved leave that day → placeholder is `on_leave`.
 *  5. Existing checked-in/no-checkout rows get flipped to `incomplete` +
 *     `flagged_for_correction`.
 *  6. Per-user errors are counted into `summary.user_errors`, not thrown.
 */

const {
    settingsMock,
    holidayExistsMock,
    leaveFindMock,
    userCursorMock,
    attendanceUpdateManyMock,
    attendanceUpdateOneMock,
} = vi.hoisted(() => ({
    settingsMock: vi.fn(),
    holidayExistsMock: vi.fn(),
    leaveFindMock: vi.fn(),
    userCursorMock: vi.fn(),
    attendanceUpdateManyMock: vi.fn(),
    attendanceUpdateOneMock: vi.fn(),
}));

vi.mock('../services/settings.service.js', () => ({
    getOrInitSettings: settingsMock,
}));

vi.mock('../models/holiday.model.js', () => ({
    Holiday: { exists: holidayExistsMock },
}));

vi.mock('../models/leave-request.model.js', () => ({
    LeaveRequest: { find: leaveFindMock },
}));

vi.mock('../models/user.model.js', () => ({
    User: {
        find: () => ({
            select: () => ({
                batchSize: () => ({
                    cursor: () => userCursorMock(),
                }),
            }),
        }),
    },
}));

vi.mock('../models/attendance-record.model.js', () => ({
    AttendanceRecord: {
        updateMany: attendanceUpdateManyMock,
        updateOne: attendanceUpdateOneMock,
    },
}));

const { finalizeAttendanceForDate } = await import('./attendance-finalizer.job.js');

const log = { warn: vi.fn(), info: vi.fn(), error: vi.fn() } as unknown as Parameters<
    typeof finalizeAttendanceForDate
>[1];

const queryStub = (rows: unknown[]) => ({
    select: () => Promise.resolve(rows),
});

const cursorOf = (users: { _id: Types.ObjectId }[]) => {
    return {
        async *[Symbol.asyncIterator]() {
            for (const u of users) yield u;
        },
    };
};

beforeEach(() => {
    settingsMock.mockReset();
    holidayExistsMock.mockReset();
    leaveFindMock.mockReset();
    userCursorMock.mockReset();
    attendanceUpdateManyMock.mockReset();
    attendanceUpdateOneMock.mockReset();

    settingsMock.mockResolvedValue({
        work_schedule: { working_days: [1, 2, 3, 4, 5] },
    });
    holidayExistsMock.mockResolvedValue(null);
    leaveFindMock.mockReturnValue(queryStub([]));
    userCursorMock.mockReturnValue(cursorOf([]));
    attendanceUpdateManyMock.mockResolvedValue({ modifiedCount: 0 });
    attendanceUpdateOneMock.mockResolvedValue({ upsertedCount: 1 });
});

describe('finalizeAttendanceForDate', () => {
    it('marks checked-in/no-checkout rows as incomplete + flagged', async () => {
        attendanceUpdateManyMock.mockResolvedValueOnce({ modifiedCount: 4 });

        const summary = await finalizeAttendanceForDate('2026-04-23', log);

        expect(summary.incomplete_marked).toBe(4);
        expect(attendanceUpdateManyMock).toHaveBeenCalledWith(
            expect.objectContaining({
                local_date: '2026-04-23',
                check_in: { $ne: null },
                check_out: null,
            }),
            expect.objectContaining({
                $set: { status: 'incomplete', flagged_for_correction: true },
            })
        );
    });

    it('inserts an `absent` placeholder for an active user with no row on a working day', async () => {
        const u = { _id: new Types.ObjectId() };
        userCursorMock.mockReturnValueOnce(cursorOf([u]));

        // 2026-04-23 is a Thursday (working day in the default 1..5 set).
        const summary = await finalizeAttendanceForDate('2026-04-23', log);

        expect(summary.users_processed).toBe(1);
        expect(summary.placeholders_inserted).toBe(1);
        expect(summary.absent_inserts).toBe(1);
        expect(attendanceUpdateOneMock).toHaveBeenCalledWith(
            { user_id: u._id, local_date: '2026-04-23' },
            expect.objectContaining({
                $setOnInsert: expect.objectContaining({ status: 'absent' }),
            }),
            { upsert: true }
        );
    });

    it('inserts `holiday` placeholders when the date matches a holiday row', async () => {
        holidayExistsMock.mockResolvedValueOnce({ _id: new Types.ObjectId() });
        userCursorMock.mockReturnValueOnce(cursorOf([{ _id: new Types.ObjectId() }]));

        const summary = await finalizeAttendanceForDate('2026-04-23', log);

        expect(summary.holiday_inserts).toBe(1);
        expect(summary.absent_inserts).toBe(0);
    });

    it('inserts `weekend` placeholders when the weekday is outside working_days', async () => {
        // 2026-04-25 is a Saturday — not in [1..5].
        userCursorMock.mockReturnValueOnce(cursorOf([{ _id: new Types.ObjectId() }]));

        const summary = await finalizeAttendanceForDate('2026-04-25', log);

        expect(summary.weekend_inserts).toBe(1);
        expect(summary.absent_inserts).toBe(0);
    });

    it('routes users on approved leave to `on_leave` placeholders', async () => {
        const u = { _id: new Types.ObjectId() };
        leaveFindMock.mockReturnValueOnce(queryStub([{ user_id: u._id }]));
        userCursorMock.mockReturnValueOnce(cursorOf([u]));

        const summary = await finalizeAttendanceForDate('2026-04-23', log);

        expect(summary.on_leave_inserts).toBe(1);
        expect(summary.absent_inserts).toBe(0);
        expect(attendanceUpdateOneMock).toHaveBeenCalledWith(
            expect.any(Object),
            expect.objectContaining({
                $setOnInsert: expect.objectContaining({ status: 'on_leave' }),
            }),
            expect.any(Object)
        );
    });

    it('counts upsertedCount=0 (row already existed) as skipped, not inserted', async () => {
        attendanceUpdateOneMock.mockResolvedValueOnce({ upsertedCount: 0 });
        userCursorMock.mockReturnValueOnce(cursorOf([{ _id: new Types.ObjectId() }]));

        const summary = await finalizeAttendanceForDate('2026-04-23', log);

        expect(summary.placeholders_inserted).toBe(0);
        expect(summary.skipped_existing).toBe(1);
    });

    it('counts per-user failures into user_errors and continues processing', async () => {
        attendanceUpdateOneMock
            .mockRejectedValueOnce(new Error('mongo blip'))
            .mockResolvedValueOnce({ upsertedCount: 1 });
        userCursorMock.mockReturnValueOnce(cursorOf([{ _id: new Types.ObjectId() }, { _id: new Types.ObjectId() }]));

        const summary = await finalizeAttendanceForDate('2026-04-23', log);

        expect(summary.users_processed).toBe(2);
        expect(summary.user_errors).toBe(1);
        expect(summary.placeholders_inserted).toBe(1);
    });

    it('closes open breaks in checked-in records via a second updateMany with arrayFilters', async () => {
        // Step A closes incomplete rows (first updateMany), step A.1 closes open
        // breaks (second updateMany). We assert the second call targets only records
        // with an open break and uses the positional filtered operator.
        attendanceUpdateManyMock
            .mockResolvedValueOnce({ modifiedCount: 2 }) // step A — incomplete flip
            .mockResolvedValueOnce({ modifiedCount: 1 }); // step A.1 — break auto-close

        await finalizeAttendanceForDate('2026-04-23', log);

        expect(attendanceUpdateManyMock).toHaveBeenCalledTimes(2);

        const breakCloseCall = attendanceUpdateManyMock.mock.calls[1] as Parameters<typeof attendanceUpdateManyMock>[0];

        // Filter: targets checked-in records with at least one open break.
        expect(breakCloseCall[0]).toMatchObject({
            local_date: '2026-04-23',
            check_in: { $ne: null },
            'segments.breaks': { $elemMatch: { end: null } },
        });

        // Update: sets end on null-end break entries via positional filtered operator.
        const updateDoc = breakCloseCall[1] as Record<string, unknown>;
        expect(updateDoc).toHaveProperty('$set');
        const setFields = updateDoc['$set'] as Record<string, unknown>;
        const breakEndKey = 'segments.$[s].breaks.$[b].end';
        expect(setFields).toHaveProperty(breakEndKey);
        const endValue = setFields[breakEndKey] as { time: Date; source: string };
        expect(endValue.source).toBe('app');
        expect(endValue.time).toBeInstanceOf(Date);

        // Options: arrayFilters targeting open breaks — first filter must also
        // restrict to the open segment (check_out: null) so only the currently-open
        // segment has its breaks closed, not segments from earlier sessions.
        const options = breakCloseCall[2] as { arrayFilters: unknown[] };
        expect(options.arrayFilters).toHaveLength(2);
        expect(options.arrayFilters[0]).toEqual({
            's.check_out': null,
            's.breaks': { $elemMatch: { end: null } },
        });
    });
});
