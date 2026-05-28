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

const { attendanceRecordCreateMock, attendanceRecordFindOneMock, settingsLoadMock } = vi.hoisted(() => ({
    attendanceRecordCreateMock: vi.fn(),
    attendanceRecordFindOneMock: vi.fn(),
    settingsLoadMock: vi.fn(),
}));

vi.mock('../models/attendance-record.model.js', () => ({
    AttendanceRecord: {
        create: attendanceRecordCreateMock,
        findOne: attendanceRecordFindOneMock,
        find: vi.fn(),
        countDocuments: vi.fn(),
        findById: vi.fn(),
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
            segments: [
                { check_in: { time: new Date() }, check_out: null },
            ],
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
            segments: [
                { check_in: { time: new Date() }, check_out: { time: new Date() } },
            ],
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
