import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { Types } from 'mongoose';

/**
 * Orchestration tests for the carry-over OVERTIME-BANK comp-off accrual engine
 * (`processCompOffForDay`). The pure rule maths (`overtimeBank` /
 * `weekendGrantDays`) live in `utils/comp-off-accrual.test.ts` and are left REAL
 * here — this file pins the routing + banking wiring:
 *   - gating: disabled setting, un-closed (today/future) day, ineligible user
 *   - idempotency marker already present → held, no writes
 *   - weekday overtime UNDER a step → banked (bank + pending grow, no lot)
 *   - weekday overtime that TIPS the bank → 1 day minted with both slices, bank cleared
 *   - weekend full shift → 1 day via the weekend rule (single contribution)
 */

const {
    timesheetAggregateMock,
    timesheetDistinctMock,
    userFindByIdMock,
    userUpdateOneMock,
    holidayExistsMock,
    projectFindByIdMock,
    accrualDayExistsMock,
    accrualDayCreateMock,
    notificationCreateMock,
    getSettingsMock,
    recordSystemAuditMock,
    createEarnedLotMock,
    resyncCompOffMock,
    compOffExpiryFromMock,
} = vi.hoisted(() => ({
    timesheetAggregateMock: vi.fn(),
    timesheetDistinctMock: vi.fn(),
    userFindByIdMock: vi.fn(),
    userUpdateOneMock: vi.fn(),
    holidayExistsMock: vi.fn(),
    projectFindByIdMock: vi.fn(),
    accrualDayExistsMock: vi.fn(),
    accrualDayCreateMock: vi.fn(),
    notificationCreateMock: vi.fn(),
    getSettingsMock: vi.fn(),
    recordSystemAuditMock: vi.fn(),
    createEarnedLotMock: vi.fn(),
    resyncCompOffMock: vi.fn(),
    compOffExpiryFromMock: vi.fn(),
}));

vi.mock('../models/timesheet-entry.model.js', () => ({
    TimesheetEntry: { aggregate: timesheetAggregateMock, distinct: timesheetDistinctMock },
}));
vi.mock('../models/user.model.js', () => ({ User: { findById: userFindByIdMock, updateOne: userUpdateOneMock } }));
vi.mock('../models/holiday.model.js', () => ({ Holiday: { exists: holidayExistsMock } }));
vi.mock('../models/project.model.js', () => ({ Project: { findById: projectFindByIdMock } }));
vi.mock('../models/comp-off-accrual-day.model.js', () => ({
    CompOffAccrualDay: { exists: accrualDayExistsMock, create: accrualDayCreateMock },
}));
vi.mock('../models/notification.model.js', () => ({ Notification: { create: notificationCreateMock } }));
vi.mock('./settings.service.js', () => ({ getOrInitSettings: getSettingsMock }));
vi.mock('./audit.service.js', () => ({ recordSystemAudit: recordSystemAuditMock }));
vi.mock('./comp-off.service.js', () => ({
    createEarnedLot: createEarnedLotMock,
    resyncCompOff: resyncCompOffMock,
    compOffExpiryFrom: compOffExpiryFromMock,
}));

const svc = await import('./comp-off-accrual.service.js');
import { COMP_OFF_SOURCES } from '../constants/leave.js';
import { ROLES } from '../constants/roles.js';

/** IST "today" pinned so `not_closed` / past-date logic is deterministic. */
const NOW = new Date('2026-07-23T06:30:00Z'); // 12:00 IST on 2026-07-23 (Thu)
const WEEKDAY = '2026-07-15'; // a Wednesday (working day)
const WEEKEND = '2026-07-18'; // a Saturday (non-working day)
const FUTURE = '2026-07-23'; // today in IST → not yet closed

const settings = (enabled: boolean, working_days = [1, 2, 3, 4, 5]) => ({
    work_schedule: { daily_expected_hours: 8, working_days },
    leave_policy: { comp_off_auto_accrual_enabled: enabled, comp_off_hours_per_day: 8 },
});

/** A User.findById(...).select('...') stub that awaits to `user`. */
const userQuery = (user: unknown) => ({ select: () => Promise.resolve(user) });

/** A Project.findById(...).select('name').lean() stub that awaits to the doc. */
const projectQuery = (name: string | null) => ({
    select: () => ({ lean: () => Promise.resolve(name === null ? null : { name }) }),
});

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.clearAllMocks();
    holidayExistsMock.mockResolvedValue(false);
    projectFindByIdMock.mockReturnValue(projectQuery('Aurora'));
    accrualDayExistsMock.mockResolvedValue(null);
    accrualDayCreateMock.mockResolvedValue(undefined);
    userUpdateOneMock.mockResolvedValue({ acknowledged: true });
    createEarnedLotMock.mockResolvedValue({ _id: new Types.ObjectId() });
    resyncCompOffMock.mockResolvedValue(undefined);
    compOffExpiryFromMock.mockReturnValue(new Date('2026-10-15T18:29:59Z'));
    recordSystemAuditMock.mockResolvedValue(undefined);
    notificationCreateMock.mockResolvedValue({ _id: new Types.ObjectId() });
});

afterEach(() => {
    vi.useRealTimers();
});

describe('processCompOffForDay', () => {
    it('is a no-op (reason: disabled) when auto-accrual is off — never touches the user or timesheets', async () => {
        getSettingsMock.mockResolvedValue(settings(false));

        const res = await svc.processCompOffForDay(new Types.ObjectId(), WEEKDAY);

        expect(res.reason).toBe('disabled');
        expect(res.granted_days).toBe(0);
        expect(res.banked_minutes).toBe(0);
        expect(userFindByIdMock).not.toHaveBeenCalled();
        expect(timesheetAggregateMock).not.toHaveBeenCalled();
        expect(createEarnedLotMock).not.toHaveBeenCalled();
        expect(accrualDayCreateMock).not.toHaveBeenCalled();
    });

    it('is a no-op (reason: not_closed) for today/future dates still being worked', async () => {
        getSettingsMock.mockResolvedValue(settings(true));

        const res = await svc.processCompOffForDay(new Types.ObjectId(), FUTURE);

        expect(res.reason).toBe('not_closed');
        expect(userFindByIdMock).not.toHaveBeenCalled();
        expect(timesheetAggregateMock).not.toHaveBeenCalled();
        expect(createEarnedLotMock).not.toHaveBeenCalled();
    });

    it('is ineligible for a CLIENT user (no comp-off for the client side)', async () => {
        getSettingsMock.mockResolvedValue(settings(true));
        userFindByIdMock.mockReturnValue(userQuery({ role: ROLES.CLIENT }));

        const res = await svc.processCompOffForDay(new Types.ObjectId(), WEEKDAY);

        expect(res.reason).toBe('ineligible');
        expect(res.granted_days).toBe(0);
        expect(timesheetAggregateMock).not.toHaveBeenCalled();
        expect(createEarnedLotMock).not.toHaveBeenCalled();
        expect(accrualDayCreateMock).not.toHaveBeenCalled();
    });

    it('holds a day already folded into the bank (reason: already_processed) — no reads or writes', async () => {
        getSettingsMock.mockResolvedValue(settings(true));
        userFindByIdMock.mockReturnValue(userQuery({ role: ROLES.EMPLOYEE, comp_off_overtime_bank_minutes: 0 }));
        accrualDayExistsMock.mockResolvedValue({ _id: new Types.ObjectId() }); // marker present

        const res = await svc.processCompOffForDay(new Types.ObjectId(), WEEKDAY);

        expect(res.reason).toBe('already_processed');
        expect(res.granted_days).toBe(0);
        expect(timesheetAggregateMock).not.toHaveBeenCalled();
        expect(createEarnedLotMock).not.toHaveBeenCalled();
        expect(userUpdateOneMock).not.toHaveBeenCalled();
        expect(accrualDayCreateMock).not.toHaveBeenCalled();
    });

    it('banks weekday overtime under a full step — no lot, bank + one pending slice grow', async () => {
        getSettingsMock.mockResolvedValue(settings(true));
        userFindByIdMock.mockReturnValue(
            userQuery({ role: ROLES.EMPLOYEE, comp_off_overtime_bank_minutes: 0, comp_off_pending_contributions: [] })
        );
        const projectId = new Types.ObjectId();
        // 600 billable min = 2h OT over the 480 scheduled → 120 min < halfStep 240 → banked.
        timesheetAggregateMock.mockResolvedValue([{ _id: projectId, minutes: 600 }]);
        projectFindByIdMock.mockReturnValue(projectQuery('Aurora'));

        const userId = new Types.ObjectId();
        const res = await svc.processCompOffForDay(userId, WEEKDAY);

        expect(res.reason).toBe('banked');
        expect(res.granted_days).toBe(0);
        expect(res.banked_minutes).toBe(120);
        expect(createEarnedLotMock).not.toHaveBeenCalled();
        expect(resyncCompOffMock).not.toHaveBeenCalled();

        expect(userUpdateOneMock).toHaveBeenCalledTimes(1);
        const update = userUpdateOneMock.mock.calls[0]![1] as {
            $set: { comp_off_overtime_bank_minutes: number; comp_off_pending_contributions: unknown[] };
        };
        expect(update.$set.comp_off_overtime_bank_minutes).toBe(120);
        expect(update.$set.comp_off_pending_contributions).toHaveLength(1);
        expect(update.$set.comp_off_pending_contributions[0]).toMatchObject({
            date: WEEKDAY,
            project_id: projectId,
            project_name: 'Aurora',
            minutes: 120,
        });
        // Marker still written so the day is HELD forward-only.
        expect(accrualDayCreateMock).toHaveBeenCalledTimes(1);
    });

    it('mints 1 day when today TIPS the bank over a step — both slices attached, bank cleared', async () => {
        getSettingsMock.mockResolvedValue(settings(true));
        const priorProjectId = new Types.ObjectId();
        const priorSlice = {
            date: '2026-07-14',
            project_id: priorProjectId,
            project_name: 'Aurora',
            minutes: 120,
        };
        userFindByIdMock.mockReturnValue(
            userQuery({
                role: ROLES.EMPLOYEE,
                comp_off_overtime_bank_minutes: 120,
                comp_off_pending_contributions: [priorSlice],
            })
        );
        const projectId = new Types.ObjectId();
        // 840 billable min = 6h OT over 480 → 360 min. Bank 120 + 360 = 480 → 2 half-steps → 1 day.
        timesheetAggregateMock.mockResolvedValue([{ _id: projectId, minutes: 840 }]);
        projectFindByIdMock.mockReturnValue(projectQuery('Borealis'));

        const userId = new Types.ObjectId();
        const res = await svc.processCompOffForDay(userId, WEEKDAY);

        expect(res.reason).toBe('granted');
        expect(res.granted_days).toBe(1);
        expect(res.banked_minutes).toBe(0);

        expect(createEarnedLotMock).toHaveBeenCalledTimes(1);
        const lot = createEarnedLotMock.mock.calls[0]![0] as {
            days: number;
            source_type: string;
            source_date: string;
            source_minutes: number;
            contributions: { date: string; minutes: number }[];
        };
        expect(lot).toMatchObject({
            user_id: userId,
            days: 1,
            source_type: COMP_OFF_SOURCES.TIMESHEET_BILLABLE,
            source_date: WEEKDAY,
            source_minutes: 480,
        });
        expect(lot.contributions).toHaveLength(2);
        const dates = lot.contributions.map((c) => c.date).sort();
        expect(dates).toEqual(['2026-07-14', WEEKDAY]);
        expect(lot.contributions.find((c) => c.date === '2026-07-14')!.minutes).toBe(120);
        expect(lot.contributions.find((c) => c.date === WEEKDAY)!.minutes).toBe(360);

        // Bank cleared + pending emptied on the tip.
        expect(userUpdateOneMock).toHaveBeenCalledTimes(1);
        const update = userUpdateOneMock.mock.calls[0]![1] as {
            $set: { comp_off_overtime_bank_minutes: number; comp_off_pending_contributions: unknown[] };
        };
        expect(update.$set.comp_off_overtime_bank_minutes).toBe(0);
        expect(update.$set.comp_off_pending_contributions).toEqual([]);

        expect(resyncCompOffMock).toHaveBeenCalledWith(userId, undefined);
        expect(accrualDayCreateMock).toHaveBeenCalledTimes(1);
    });

    it('grants 1 day for a full shift worked on a weekend — single contribution, bank untouched', async () => {
        getSettingsMock.mockResolvedValue(settings(true));
        userFindByIdMock.mockReturnValue(
            userQuery({ role: ROLES.EMPLOYEE, comp_off_overtime_bank_minutes: 0, comp_off_pending_contributions: [] })
        );
        const projectId = new Types.ObjectId();
        // 480 billable min on a Saturday = a full 8h shift → 1 day via the weekend rule.
        timesheetAggregateMock.mockResolvedValue([{ _id: projectId, minutes: 480 }]);

        const userId = new Types.ObjectId();
        const res = await svc.processCompOffForDay(userId, WEEKEND);

        expect(res.reason).toBe('granted');
        expect(res.granted_days).toBe(1);
        expect(res.banked_minutes).toBe(0);

        expect(createEarnedLotMock).toHaveBeenCalledTimes(1);
        const lot = createEarnedLotMock.mock.calls[0]![0] as {
            days: number;
            source_date: string;
            project_id: Types.ObjectId | null;
            contributions: unknown[];
        };
        expect(lot).toMatchObject({
            days: 1,
            source_type: COMP_OFF_SOURCES.TIMESHEET_BILLABLE,
            source_date: WEEKEND,
            project_id: projectId,
        });
        expect(lot.contributions).toHaveLength(1);
        // Weekend grant is immediate — bank is never touched.
        expect(userUpdateOneMock).not.toHaveBeenCalled();
        expect(resyncCompOffMock).toHaveBeenCalledWith(userId, undefined);
        expect(accrualDayCreateMock).toHaveBeenCalledTimes(1);
    });
});
