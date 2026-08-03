import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Types } from 'mongoose';

/**
 * Unit tests for `attendance.service` (Step 15.1 gap-fill).
 *
 *  1. checkIn — happy path; geofence enforced when enabled (out-of-radius =
 *     LOCATION_NOT_ALLOWED 403); duplicate insert (E11000) → ALREADY_CHECKED_IN
 *     409; existing placeholder row (absent / on_leave) is upgraded to a
 *     real `present` punch.
 *  2. checkOut — NOT_CHECKED_IN when no row, ALREADY_CHECKED_OUT when one
 *     exists, happy path computes worked + overtime minutes against
 *     `daily_expected_hours`.
 *  3. computeWorkedMinutes — exercised end-to-end via checkOut to make sure
 *     overtime math respects the configured shift length.
 */

const {
    attendanceRecordCreateMock,
    attendanceRecordFindOneMock,
    attendanceRecordFindMock,
    userFindMock,
    userCountMock,
    settingsLoadMock,
} = vi.hoisted(() => ({
    attendanceRecordCreateMock: vi.fn(),
    attendanceRecordFindOneMock: vi.fn(),
    attendanceRecordFindMock: vi.fn(),
    userFindMock: vi.fn(),
    userCountMock: vi.fn(),
    settingsLoadMock: vi.fn(),
}));

vi.mock('../models/attendance-record.model.js', () => ({
    AttendanceRecord: {
        create: attendanceRecordCreateMock,
        findOne: attendanceRecordFindOneMock,
        find: attendanceRecordFindMock,
        countDocuments: vi.fn(),
        findById: vi.fn(),
    },
}));

vi.mock('../models/user.model.js', () => ({
    User: {
        find: userFindMock,
        countDocuments: userCountMock,
    },
}));

vi.mock('../models/attendance-correction-request.model.js', () => ({
    AttendanceCorrectionRequest: {
        find: vi.fn(),
        findOne: vi.fn(),
        findById: vi.fn(),
        create: vi.fn(),
        countDocuments: vi.fn(),
    },
}));

vi.mock('../models/office-location.model.js', () => ({
    OfficeLocation: { findOne: vi.fn() },
}));

const { timesheetAggregateMock } = vi.hoisted(() => ({
    timesheetAggregateMock: vi.fn(),
}));

vi.mock('../models/timesheet-entry.model.js', () => ({
    TimesheetEntry: { aggregate: timesheetAggregateMock },
}));

vi.mock('./settings.service.js', () => ({
    getOrInitSettings: settingsLoadMock,
}));

vi.mock('./notification-dispatcher.service.js', () => ({
    notifyAttendanceCorrectionDecided: vi.fn().mockResolvedValue(undefined),
    notifyAttendanceCorrectionSubmitted: vi.fn().mockResolvedValue(undefined),
}));

const svc = await import('./attendance.service.js');
import { ERROR_CODES } from '../constants/error-codes.js';
import { haversineDistanceMeters } from '../constants/attendance.js';
import { ROLES } from '../constants/roles.js';
import { AttendanceCorrectionRequest } from '../models/attendance-correction-request.model.js';

const defaultSettings = (overrides: Record<string, unknown> = {}) => ({
    work_schedule: { working_days: [1, 2, 3, 4, 5], daily_expected_hours: 8 },
    attendance: {
        geofence: {
            enabled: false,
            center_latitude: null,
            center_longitude: null,
            radius_meters: 100,
        },
        wifi_restriction: {
            enabled: false,
            allowed_ip_ranges: [],
            allowed_ssids: [],
        },
    },
    ...overrides,
});

beforeEach(() => {
    vi.resetAllMocks();
    settingsLoadMock.mockResolvedValue(defaultSettings());
});

// ─── haversineDistanceMeters ──────────────────────────────────────────────

describe('haversineDistanceMeters', () => {
    it('is 0 for identical points', () => {
        expect(haversineDistanceMeters(12.97, 77.59, 12.97, 77.59)).toBe(0);
    });

    it('matches a known short distance (~1.11 km between 1° latitude apart)', () => {
        const km = haversineDistanceMeters(0, 0, 0.01, 0) / 1000;
        // 0.01° latitude ≈ 1.111 km.
        expect(km).toBeCloseTo(1.111, 2);
    });
});

// ─── checkIn ──────────────────────────────────────────────────────────────

describe('checkIn', () => {
    const makeBody = (overrides: Record<string, unknown> = {}) => ({
        method: 'manual' as const,
        latitude: undefined,
        longitude: undefined,
        wifi_ssid: undefined,
        notes: undefined,
        ...overrides,
    });

    it('creates a fresh record on the happy path', async () => {
        const userId = new Types.ObjectId();
        const fakeDoc = { toJSON: () => ({ id: 'a', user_id: userId.toString() }) };
        attendanceRecordCreateMock.mockResolvedValueOnce(fakeDoc);

        const out = await svc.checkIn(makeBody(), userId, '127.0.0.1');

        expect(out).toEqual({ id: 'a', user_id: userId.toString() });
        expect(attendanceRecordCreateMock).toHaveBeenCalledWith(
            expect.objectContaining({
                user_id: userId,
                check_in: expect.objectContaining({ method: 'manual', ip: '127.0.0.1' }),
                status: 'present',
            })
        );
    });

    it('rejects with LOCATION_NOT_ALLOWED when geofence is enabled and the user is outside the radius', async () => {
        settingsLoadMock.mockResolvedValueOnce(
            defaultSettings({
                attendance: {
                    geofence: {
                        enabled: true,
                        center_latitude: 12.97,
                        center_longitude: 77.59,
                        radius_meters: 50,
                    },
                    wifi_restriction: { enabled: false, allowed_ip_ranges: [], allowed_ssids: [] },
                },
            })
        );
        // ~10 km away — well outside 50 m.
        await expect(
            svc.checkIn(makeBody({ latitude: 13.07, longitude: 77.59 }), new Types.ObjectId(), '1.1.1.1')
        ).rejects.toMatchObject({ code: ERROR_CODES.LOCATION_NOT_ALLOWED });
        expect(attendanceRecordCreateMock).not.toHaveBeenCalled();
    });

    it('rejects with LOCATION_NOT_ALLOWED when geofence is enabled but body has no coords', async () => {
        settingsLoadMock.mockResolvedValueOnce(
            defaultSettings({
                attendance: {
                    geofence: {
                        enabled: true,
                        center_latitude: 12.97,
                        center_longitude: 77.59,
                        radius_meters: 50,
                    },
                    wifi_restriction: { enabled: false, allowed_ip_ranges: [], allowed_ssids: [] },
                },
            })
        );
        await expect(
            svc.checkIn(makeBody({ latitude: undefined, longitude: undefined }), new Types.ObjectId(), '1.1.1.1')
        ).rejects.toMatchObject({ code: ERROR_CODES.LOCATION_NOT_ALLOWED });
    });

    it('passes geofence when within radius (creates record)', async () => {
        settingsLoadMock.mockResolvedValueOnce(
            defaultSettings({
                attendance: {
                    geofence: {
                        enabled: true,
                        center_latitude: 12.97,
                        center_longitude: 77.59,
                        radius_meters: 100,
                    },
                    wifi_restriction: { enabled: false, allowed_ip_ranges: [], allowed_ssids: [] },
                },
            })
        );
        attendanceRecordCreateMock.mockResolvedValueOnce({ toJSON: () => ({ status: 'present' }) });

        const out = await svc.checkIn(
            makeBody({ latitude: 12.97005, longitude: 77.59005 }), // ~7 m away
            new Types.ObjectId(),
            '1.1.1.1'
        );
        expect(out).toEqual({ status: 'present' });
    });

    it('rejects with LOCATION_NOT_ALLOWED when wifi_restriction is on and IP/SSID does not match', async () => {
        settingsLoadMock.mockResolvedValueOnce(
            defaultSettings({
                attendance: {
                    geofence: { enabled: false, center_latitude: null, center_longitude: null, radius_meters: 100 },
                    wifi_restriction: {
                        enabled: true,
                        allowed_ip_ranges: ['10.0.0.0/24'],
                        allowed_ssids: ['ViljeOffice'],
                    },
                },
            })
        );
        await expect(
            svc.checkIn(makeBody({ wifi_ssid: 'CafeWiFi' }), new Types.ObjectId(), '8.8.8.8')
        ).rejects.toMatchObject({ code: ERROR_CODES.LOCATION_NOT_ALLOWED });
    });

    it('passes wifi_restriction when SSID matches even if IP does not', async () => {
        settingsLoadMock.mockResolvedValueOnce(
            defaultSettings({
                attendance: {
                    geofence: { enabled: false, center_latitude: null, center_longitude: null, radius_meters: 100 },
                    wifi_restriction: {
                        enabled: true,
                        allowed_ip_ranges: ['10.0.0.0/24'],
                        allowed_ssids: ['ViljeOffice'],
                    },
                },
            })
        );
        attendanceRecordCreateMock.mockResolvedValueOnce({ toJSON: () => ({ status: 'present' }) });

        const out = await svc.checkIn(makeBody({ wifi_ssid: 'ViljeOffice' }), new Types.ObjectId(), '8.8.8.8');
        expect(out).toEqual({ status: 'present' });
    });

    it('on E11000: existing row with an OPEN segment throws ALREADY_CHECKED_IN', async () => {
        const dup = Object.assign(new Error('dup'), { code: 11000 });
        attendanceRecordCreateMock.mockRejectedValueOnce(dup);
        // Latest segment open → user has checked in but not out yet.
        attendanceRecordFindOneMock.mockResolvedValueOnce({
            check_in: { time: new Date(), method: 'manual', location_id: null, ip: '' },
            segments: [{ check_in: { time: new Date() }, check_out: null }],
        });

        await expect(svc.checkIn(makeBody(), new Types.ObjectId(), '1.1.1.1')).rejects.toMatchObject({
            code: ERROR_CODES.ALREADY_CHECKED_IN,
        });
    });

    it('on E11000: placeholder row (no segments) is upgraded in place to status=present', async () => {
        const dup = Object.assign(new Error('dup'), { code: 11000 });
        attendanceRecordCreateMock.mockRejectedValueOnce(dup);
        const existing = {
            check_in: null,
            check_out: null,
            segments: [] as { check_in: unknown; check_out: unknown }[],
            status: 'absent',
            flagged_for_correction: true,
            markModified: vi.fn(),
            save: vi.fn().mockResolvedValue(undefined),
            toJSON: () => ({ status: 'present', upgraded: true }),
        };
        attendanceRecordFindOneMock.mockResolvedValueOnce(existing);

        const out = await svc.checkIn(makeBody(), new Types.ObjectId(), '1.1.1.1');

        expect(existing.save).toHaveBeenCalledOnce();
        expect(existing.status).toBe('present');
        expect(existing.flagged_for_correction).toBe(false);
        expect(existing.segments).toHaveLength(1);
        expect(existing.segments[0]).toMatchObject({
            check_in: expect.objectContaining({ method: 'manual', ip: '1.1.1.1' }),
            check_out: null,
        });
        expect(existing.check_in).toMatchObject({ method: 'manual', ip: '1.1.1.1' });
        expect(out).toEqual({ status: 'present', upgraded: true });
    });

    it('on E11000: row with all-closed segments appends a fresh segment for re-check-in (BUG-040)', async () => {
        const dup = Object.assign(new Error('dup'), { code: 11000 });
        attendanceRecordCreateMock.mockRejectedValueOnce(dup);
        const firstIn = new Date('2026-04-24T03:30:00Z');
        const firstOut = new Date('2026-04-24T06:30:00Z');
        const existing = {
            check_in: { time: firstIn, method: 'manual', location_id: null, ip: '' },
            check_out: { time: firstOut, method: 'manual', location_id: null, ip: '' },
            segments: [
                {
                    check_in: { time: firstIn, method: 'manual', location_id: null, ip: '' },
                    check_out: { time: firstOut, method: 'manual', location_id: null, ip: '' },
                },
            ],
            status: 'present',
            flagged_for_correction: false,
            markModified: vi.fn(),
            save: vi.fn().mockResolvedValue(undefined),
            toJSON() {
                return { segments_count: this.segments.length };
            },
        };
        attendanceRecordFindOneMock.mockResolvedValueOnce(existing);

        const out = await svc.checkIn(makeBody(), new Types.ObjectId(), '1.1.1.1');

        expect(existing.segments).toHaveLength(2);
        expect(existing.segments[1]).toMatchObject({
            check_in: expect.objectContaining({ method: 'manual', ip: '1.1.1.1' }),
            check_out: null,
        });
        // Aliases re-synced: check_in stays at the first arrival, check_out
        // flips back to null because the new last segment is open.
        expect(existing.check_in).toMatchObject({ time: firstIn });
        expect(existing.check_out).toBeNull();
        expect(out).toEqual({ segments_count: 2 });
    });

    it('non-E11000 errors propagate unchanged', async () => {
        attendanceRecordCreateMock.mockRejectedValueOnce(new Error('mongo timeout'));

        await expect(svc.checkIn(makeBody(), new Types.ObjectId(), '1.1.1.1')).rejects.toThrow('mongo timeout');
    });
});

// ─── checkOut ─────────────────────────────────────────────────────────────

describe('checkOut', () => {
    const makeBody = () => ({
        method: 'manual' as const,
        latitude: undefined,
        longitude: undefined,
        wifi_ssid: undefined,
        notes: undefined,
    });

    it('rejects with NOT_CHECKED_IN when no row exists', async () => {
        attendanceRecordFindOneMock.mockResolvedValueOnce(null);

        await expect(svc.checkOut(makeBody(), new Types.ObjectId(), '1.1.1.1')).rejects.toMatchObject({
            code: ERROR_CODES.NOT_CHECKED_IN,
        });
    });

    it('rejects with NOT_CHECKED_IN when row exists but no segments yet (EOD placeholder)', async () => {
        attendanceRecordFindOneMock.mockResolvedValueOnce({
            check_in: null,
            check_out: null,
            segments: [],
        });

        await expect(svc.checkOut(makeBody(), new Types.ObjectId(), '1.1.1.1')).rejects.toMatchObject({
            code: ERROR_CODES.NOT_CHECKED_IN,
        });
    });

    it('rejects with NOT_CHECKED_IN when every segment is already closed (BUG-040)', async () => {
        // Old behaviour returned ALREADY_CHECKED_OUT in this state. With
        // multi-segment attendance the same situation means "no open
        // segment to close" — user must check in again first.
        attendanceRecordFindOneMock.mockResolvedValueOnce({
            check_in: { time: new Date() },
            check_out: { time: new Date() },
            segments: [{ check_in: { time: new Date() }, check_out: { time: new Date() } }],
        });

        await expect(svc.checkOut(makeBody(), new Types.ObjectId(), '1.1.1.1')).rejects.toMatchObject({
            code: ERROR_CODES.NOT_CHECKED_IN,
        });
    });

    it('happy path: 9-hour shift with default 8h expected → 60 min overtime', async () => {
        const inAt = new Date('2026-04-24T03:30:00Z'); // 09:00 IST
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-04-24T12:30:00Z')); // 18:00 IST

        const openSegment = { check_in: { time: inAt }, check_out: null as unknown };
        const record = {
            check_in: { time: inAt },
            check_out: null as unknown,
            segments: [openSegment],
            total_worked_minutes: 0,
            overtime_minutes: 0,
            markModified: vi.fn(),
            save: vi.fn().mockResolvedValue(undefined),
            toJSON() {
                return {
                    total_worked_minutes: this.total_worked_minutes,
                    overtime_minutes: this.overtime_minutes,
                };
            },
        };
        attendanceRecordFindOneMock.mockResolvedValueOnce(record);

        const out = await svc.checkOut(makeBody(), new Types.ObjectId(), '1.1.1.1');

        // The check_out punch lives on the segment now; the top-level
        // alias gets re-synced from segments[last].check_out.
        expect(openSegment.check_out).toMatchObject({ method: 'manual', ip: '1.1.1.1' });
        expect(record.check_out).toMatchObject({ method: 'manual', ip: '1.1.1.1' });
        expect(record.total_worked_minutes).toBe(540); // 9h
        expect(record.overtime_minutes).toBe(60); // 9 − 8
        expect(record.save).toHaveBeenCalledOnce();
        expect(out).toMatchObject({ total_worked_minutes: 540, overtime_minutes: 60 });

        vi.useRealTimers();
    });

    it('happy path: 6-hour shift with 8h expected → 0 overtime', async () => {
        const inAt = new Date('2026-04-24T04:00:00Z');
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-04-24T10:00:00Z'));

        const openSegment = { check_in: { time: inAt }, check_out: null as unknown };
        const record = {
            check_in: { time: inAt },
            check_out: null as unknown,
            segments: [openSegment],
            total_worked_minutes: 0,
            overtime_minutes: 0,
            markModified: vi.fn(),
            save: vi.fn().mockResolvedValue(undefined),
            toJSON() {
                return {
                    total_worked_minutes: this.total_worked_minutes,
                    overtime_minutes: this.overtime_minutes,
                };
            },
        };
        attendanceRecordFindOneMock.mockResolvedValueOnce(record);

        await svc.checkOut(makeBody(), new Types.ObjectId(), '1.1.1.1');

        expect(record.total_worked_minutes).toBe(360);
        expect(record.overtime_minutes).toBe(0);

        vi.useRealTimers();
    });

    it('multi-segment day: 3h morning + 4h afternoon sums to 7h, no overtime (BUG-040)', async () => {
        // Two completed segments earlier in the day, plus a fresh open
        // segment now being closed. Total = 3h + 4h + (just-now → 1m
        // window) ≈ 420m. Overtime stays 0 since expected is 8h.
        const morningIn = new Date('2026-04-24T03:30:00Z');
        const morningOut = new Date('2026-04-24T06:30:00Z'); // 3h
        const lunchIn = new Date('2026-04-24T07:30:00Z');
        const lunchOut = new Date('2026-04-24T11:30:00Z'); // 4h
        const errandIn = new Date('2026-04-24T12:29:00Z');
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-04-24T12:30:00Z')); // closes the 1-min errand segment

        const openSegment = {
            check_in: { time: errandIn },
            check_out: null as unknown,
        };
        const record = {
            check_in: { time: morningIn },
            check_out: null as unknown,
            segments: [
                { check_in: { time: morningIn }, check_out: { time: morningOut } },
                { check_in: { time: lunchIn }, check_out: { time: lunchOut } },
                openSegment,
            ],
            total_worked_minutes: 0,
            overtime_minutes: 0,
            markModified: vi.fn(),
            save: vi.fn().mockResolvedValue(undefined),
            toJSON() {
                return {
                    total_worked_minutes: this.total_worked_minutes,
                    overtime_minutes: this.overtime_minutes,
                };
            },
        };
        attendanceRecordFindOneMock.mockResolvedValueOnce(record);

        await svc.checkOut(makeBody(), new Types.ObjectId(), '1.1.1.1');

        // 180 + 240 + 1 = 421 minutes worked across all closed segments.
        expect(record.total_worked_minutes).toBe(421);
        expect(record.overtime_minutes).toBe(0);

        vi.useRealTimers();
    });
});

// ─── getTodayAttendanceSummary ────────────────────────────────────────────

describe('getTodayAttendanceSummary', () => {
    it('counts present/incomplete and lists who is not in', async () => {
        const u1 = new Types.ObjectId(); // present
        const u2 = new Types.ObjectId(); // incomplete
        const u3 = new Types.ObjectId(); // not in (no record)

        userFindMock.mockReturnValue({
            select: vi.fn().mockReturnValue({
                lean: vi.fn().mockResolvedValue([
                    { _id: u1, full_name: 'Asha' },
                    { _id: u2, full_name: 'Ravi' },
                    { _id: u3, full_name: 'Meera' },
                ]),
            }),
        });
        attendanceRecordFindMock.mockReturnValue({
            select: vi.fn().mockReturnValue({
                lean: vi.fn().mockResolvedValue([
                    { user_id: u1, status: 'present', check_in: { time: new Date() } },
                    { user_id: u2, status: 'incomplete', check_in: { time: new Date() } },
                ]),
            }),
        });

        const summary = await svc.getTodayAttendanceSummary(10);
        expect(summary.headcount).toBe(3);
        expect(summary.present).toBe(1);
        expect(summary.incomplete).toBe(1);
        expect(summary.not_in_count).toBe(1);
        expect(summary.not_in_roster).toEqual([{ id: u3.toString(), full_name: 'Meera' }]);
    });
});

// ─── listAttendance — single-day roster (include_absent) ───────────────────

describe('listAttendance — single-day roster', () => {
    const date = '2026-06-24';
    const present = new Types.ObjectId();
    const absent = new Types.ObjectId();

    const setupRoster = () => {
        attendanceRecordFindMock.mockReturnValue({
            sort: vi.fn().mockResolvedValue([
                {
                    user_id: present,
                    toJSON: () => ({
                        id: 'rec-1',
                        user_id: present.toString(),
                        status: 'present',
                        local_date: date,
                    }),
                },
            ]),
        });
        // Both the employee roster and loadUserDisplays go through User.find().select().lean().
        userFindMock.mockReturnValue({
            select: vi.fn().mockReturnValue({
                lean: vi.fn().mockResolvedValue([
                    { _id: present, full_name: 'Present Person' },
                    { _id: absent, full_name: 'Absent Person' },
                ]),
            }),
        });
        userCountMock.mockResolvedValue(2);
        // Team timesheet join runs on every page; default to "no timesheets".
        timesheetAggregateMock.mockResolvedValue([]);
    };

    it('adds a synthetic absent row for an active employee with no record', async () => {
        setupRoster();
        const res = await svc.listAttendance(
            {
                from_date: date,
                to_date: date,
                include_absent: true,
                page: 1,
                limit: 20,
            } as never,
            { id: new Types.ObjectId(), role: ROLES.ADMIN } as never
        );

        expect(res.meta.total).toBe(2);
        expect(res.meta.total_internal_active).toBe(2);

        const absentRow = res.data.find((r) => r.user_id === absent.toString());
        expect(absentRow?.status).toBe('absent');
        expect(absentRow?.is_synthetic).toBe(true);
        const presentRow = res.data.find((r) => r.user_id === present.toString());
        expect(presentRow?.status).toBe('present');
    });

    it('roster excludes ALL client-side roles (representative too, not just client)', async () => {
        setupRoster();
        await svc.listAttendance(
            {
                from_date: date,
                to_date: date,
                include_absent: true,
                page: 1,
                limit: 20,
            } as never,
            { id: new Types.ObjectId(), role: ROLES.ADMIN } as never
        );

        // The first User.find call builds the staff roster; it must exclude both
        // client-side roles so representatives never appear as "Absent" rows.
        const rosterFilter = userFindMock.mock.calls[0][0] as {
            role?: { $nin?: string[] };
        };
        expect(rosterFilter.role?.$nin).toEqual(expect.arrayContaining([ROLES.CLIENT, ROLES.REPRESENTATIVE]));

        // The "active workforce" headcount denominator excludes them too.
        const countFilter = userCountMock.mock.calls[0][0] as {
            role?: { $nin?: string[] };
        };
        expect(countFilter.role?.$nin).toEqual(expect.arrayContaining([ROLES.CLIENT, ROLES.REPRESENTATIVE]));
    });

    it('status=present filters OUT the synthetic absent rows', async () => {
        setupRoster();
        const res = await svc.listAttendance(
            {
                from_date: date,
                to_date: date,
                include_absent: true,
                status: 'present',
                page: 1,
                limit: 20,
            } as never,
            { id: new Types.ObjectId(), role: ROLES.ADMIN } as never
        );

        expect(res.meta.total).toBe(1);
        expect(res.data.every((r) => r.status === 'present')).toBe(true);
    });

    it('joins each row to its own (user_id, local_date) timesheet totals', async () => {
        setupRoster();
        // Present person has a timesheet; the synthetic absent row does not.
        timesheetAggregateMock.mockResolvedValue([
            { _id: { u: present, d: date }, billable: 300, non_billable: 60, idle: 20 },
        ]);

        const res = await svc.listAttendance(
            {
                from_date: date,
                to_date: date,
                include_absent: true,
                page: 1,
                limit: 20,
            } as never,
            { id: new Types.ObjectId(), role: ROLES.ADMIN } as never
        );

        const presentRow = res.data.find((r) => r.user_id === present.toString());
        expect(presentRow?.timesheet_totals).toEqual({
            billable_minutes: 300,
            non_billable_minutes: 60,
            idle_minutes: 20,
        });
        const absentRow = res.data.find((r) => r.user_id === absent.toString());
        expect(absentRow?.timesheet_totals).toBeNull();
    });
});

// ─── Correction review — separation of duties ─────────────────────────────

describe('correction review — reviewer cannot action their own request', () => {
    const reviewer = new Types.ObjectId();
    const someoneElse = new Types.ObjectId();

    const mockPending = (requesterId: Types.ObjectId) => {
        vi.mocked(AttendanceCorrectionRequest.findById).mockResolvedValue({
            status: 'pending',
            user_id: requesterId,
            attendance_record_id: new Types.ObjectId(),
        } as never);
    };

    it('approveCorrection throws FORBIDDEN when the reviewer is the requester', async () => {
        mockPending(reviewer);
        await expect(
            svc.approveCorrection(new Types.ObjectId(), {} as never, {
                id: reviewer,
                role: ROLES.TEAM_LEAD,
            })
        ).rejects.toMatchObject({ code: ERROR_CODES.FORBIDDEN });
    });

    it('rejectCorrection throws FORBIDDEN when the reviewer is the requester', async () => {
        mockPending(reviewer);
        await expect(
            svc.rejectCorrection(new Types.ObjectId(), {} as never, {
                id: reviewer,
                role: ROLES.TEAM_LEAD,
            })
        ).rejects.toMatchObject({ code: ERROR_CODES.FORBIDDEN });
    });

    it("approveCorrection does NOT short-circuit on someone else's request (passes the self-guard)", async () => {
        // The underlying record is absent here, so it must fail PAST the
        // self-guard with a *different* error — proving the guard let it through.
        mockPending(someoneElse);
        vi.mocked(AttendanceCorrectionRequest.findById).mockResolvedValueOnce({
            status: 'pending',
            user_id: someoneElse,
            attendance_record_id: new Types.ObjectId(),
        } as never);
        await expect(
            svc.approveCorrection(new Types.ObjectId(), {} as never, {
                id: reviewer,
                role: ROLES.TEAM_LEAD,
            })
        ).rejects.toMatchObject({ code: ERROR_CODES.ATTENDANCE_RECORD_NOT_FOUND });
    });
});

describe('listCorrections — reviewer queue excludes self', () => {
    const reviewer = new Types.ObjectId();

    const stubEmptyQuery = () => {
        vi.mocked(AttendanceCorrectionRequest.find).mockReturnValue({
            sort: () => ({ skip: () => ({ limit: () => Promise.resolve([]) }) }),
        } as never);
        vi.mocked(AttendanceCorrectionRequest.countDocuments).mockResolvedValue(0 as never);
    };

    it('a reviewer with no user_id filter never sees their own requests', async () => {
        stubEmptyQuery();
        await svc.listCorrections({ page: 1, limit: 20 } as never, reviewer, ROLES.TEAM_LEAD);

        const filter = vi.mocked(AttendanceCorrectionRequest.find).mock.calls[0][0] as unknown as {
            user_id: { $ne: Types.ObjectId };
        };
        expect(filter.user_id.$ne.equals(reviewer)).toBe(true);
    });

    it('an employee is still scoped to only their own requests', async () => {
        stubEmptyQuery();
        await svc.listCorrections({ page: 1, limit: 20 } as never, reviewer, ROLES.EMPLOYEE);

        const filter = vi.mocked(AttendanceCorrectionRequest.find).mock.calls[0][0] as unknown as {
            user_id: Types.ObjectId;
        };
        expect(filter.user_id.equals(reviewer)).toBe(true);
    });
});

describe('listMyAttendance — timesheet_totals join', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('merges summed timesheet totals per day and null when none', async () => {
        const svc = await import('./attendance.service.js');
        const userId = new Types.ObjectId();

        attendanceRecordFindMock.mockReturnValue({
            sort: vi.fn().mockReturnValue({
                skip: vi.fn().mockReturnValue({
                    limit: vi
                        .fn()
                        .mockResolvedValue([
                            { toJSON: () => ({ id: '1', local_date: '2026-07-21', total_worked_minutes: 490 }) },
                            { toJSON: () => ({ id: '2', local_date: '2026-07-20', total_worked_minutes: 120 }) },
                        ]),
                }),
            }),
        });
        const { AttendanceRecord } = await import('../models/attendance-record.model.js');
        vi.mocked(AttendanceRecord.countDocuments).mockResolvedValue(2 as never);

        // Two entries on the 21st must be summed; the 20th has none.
        timesheetAggregateMock.mockResolvedValue([{ _id: '2026-07-21', billable: 360, non_billable: 90, idle: 40 }]);

        const res = await svc.listMyAttendance(userId, { page: 1, limit: 20 } as never);

        expect(res.data[0]).toMatchObject({
            local_date: '2026-07-21',
            timesheet_totals: { billable_minutes: 360, non_billable_minutes: 90, idle_minutes: 40 },
        });
        expect(res.data[1]).toMatchObject({ local_date: '2026-07-20', timesheet_totals: null });

        // Aggregate matched exactly the returned dates for this user.
        const matchStage = timesheetAggregateMock.mock.calls[0][0][0].$match;
        expect(matchStage.user_id).toEqual(userId);
        expect(matchStage.local_date.$in.sort()).toEqual(['2026-07-20', '2026-07-21']);
    });
});
