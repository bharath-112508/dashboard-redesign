import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { Types } from 'mongoose';

/**
 * Orchestration tests for the BILLABLE-TIMESHEET comp-off accrual engine
 * (`settleCompOffForDay` + `accrueCompOffForDay`). The pure rule maths live in
 * `utils/comp-off-accrual.test.ts`; here we pin the routing + convergence wiring:
 *   - gating: disabled setting, un-closed (today/future) day, ineligible user
 *   - weekday overtime over threshold → creates an earned lot for the top project
 *   - weekend full shift → 1 day via the weekend rule
 *   - idempotent re-settle (delta 0, no new lot)
 *   - decrease capped by the already-consumed portion (never claws back)
 */

const {
    timesheetAggregateMock,
    timesheetDistinctMock,
    userFindByIdMock,
    ledgerFindOneMock,
    ledgerCreateMock,
    holidayExistsMock,
    projectFindByIdMock,
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
    ledgerFindOneMock: vi.fn(),
    ledgerCreateMock: vi.fn(),
    holidayExistsMock: vi.fn(),
    projectFindByIdMock: vi.fn(),
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
vi.mock('../models/user.model.js', () => ({ User: { findById: userFindByIdMock } }));
vi.mock('../models/comp-off-ledger.model.js', () => ({
    CompOffLedger: { findOne: ledgerFindOneMock, create: ledgerCreateMock },
}));
vi.mock('../models/holiday.model.js', () => ({ Holiday: { exists: holidayExistsMock } }));
vi.mock('../models/project.model.js', () => ({ Project: { findById: projectFindByIdMock } }));
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

/** A User.findById(...).select('role') stub that awaits to `user`. */
const userQuery = (user: unknown) => ({ select: () => Promise.resolve(user) });

/** A Project.findById(...).select('name').lean() stub that awaits to the doc. */
const projectQuery = (name: string | null) => ({
    select: () => ({ lean: () => Promise.resolve(name === null ? null : { name }) }),
});

/** An existing per-day billable lot doc with the fields the service converges. */
const existingLot = (over: { days: number; remaining_days: number; expired?: boolean }) => ({
    days: over.days,
    remaining_days: over.remaining_days,
    expired: over.expired ?? false,
    project_id: null,
    project_name: null,
    source_minutes: 0,
    remarks: '',
    expires_at: null,
    save: vi.fn().mockResolvedValue(undefined),
    deleteOne: vi.fn().mockResolvedValue(undefined),
});

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.clearAllMocks();
    holidayExistsMock.mockResolvedValue(false);
    projectFindByIdMock.mockReturnValue(projectQuery('Aurora'));
    ledgerFindOneMock.mockResolvedValue(null);
    createEarnedLotMock.mockResolvedValue({ _id: new Types.ObjectId() });
    resyncCompOffMock.mockResolvedValue(undefined);
    compOffExpiryFromMock.mockReturnValue(new Date('2026-10-15T18:29:59Z'));
    recordSystemAuditMock.mockResolvedValue(undefined);
    notificationCreateMock.mockResolvedValue({ _id: new Types.ObjectId() });
});

afterEach(() => {
    vi.useRealTimers();
});

describe('settleCompOffForDay', () => {
    it('is a no-op (reason: disabled) when auto-accrual is off — never touches timesheets', async () => {
        getSettingsMock.mockResolvedValue(settings(false));

        const res = await svc.settleCompOffForDay(new Types.ObjectId(), WEEKDAY);

        expect(res.reason).toBe('disabled');
        expect(res.days).toBe(0);
        expect(res.delta).toBe(0);
        expect(timesheetAggregateMock).not.toHaveBeenCalled();
        expect(ledgerFindOneMock).not.toHaveBeenCalled();
        expect(createEarnedLotMock).not.toHaveBeenCalled();
    });

    it('is a no-op (reason: not_closed) for today/future dates still being worked', async () => {
        getSettingsMock.mockResolvedValue(settings(true));

        const res = await svc.settleCompOffForDay(new Types.ObjectId(), FUTURE);

        expect(res.reason).toBe('not_closed');
        expect(userFindByIdMock).not.toHaveBeenCalled();
        expect(timesheetAggregateMock).not.toHaveBeenCalled();
        expect(createEarnedLotMock).not.toHaveBeenCalled();
    });

    it('is ineligible for a CLIENT user (no comp-off for the client side)', async () => {
        getSettingsMock.mockResolvedValue(settings(true));
        userFindByIdMock.mockReturnValue(userQuery({ role: ROLES.CLIENT }));

        const res = await svc.settleCompOffForDay(new Types.ObjectId(), WEEKDAY);

        expect(res.reason).toBe('ineligible');
        expect(res.days).toBe(0);
        expect(timesheetAggregateMock).not.toHaveBeenCalled();
        expect(createEarnedLotMock).not.toHaveBeenCalled();
    });

    it('grants a weekday overtime lot for the top billable project', async () => {
        getSettingsMock.mockResolvedValue(settings(true));
        userFindByIdMock.mockReturnValue(userQuery({ role: ROLES.EMPLOYEE }));
        const projectId = new Types.ObjectId();
        // 960 billable min = 8h OT over the 480 scheduled → threshold 480 → 1.0 day.
        timesheetAggregateMock.mockResolvedValue([{ _id: projectId, minutes: 960 }]);
        projectFindByIdMock.mockReturnValue(projectQuery('Aurora'));

        const userId = new Types.ObjectId();
        const res = await svc.settleCompOffForDay(userId, WEEKDAY);

        expect(res.reason).toBe('granted');
        expect(res.days).toBe(1);
        expect(res.delta).toBe(1);
        expect(res.project_name).toBe('Aurora');
        expect(createEarnedLotMock).toHaveBeenCalledTimes(1);
        expect(createEarnedLotMock.mock.calls[0]![0]).toMatchObject({
            user_id: userId,
            days: 1,
            source_type: COMP_OFF_SOURCES.TIMESHEET_BILLABLE,
            source_date: WEEKDAY,
            project_id: projectId,
            project_name: 'Aurora',
            source_minutes: 960,
        });
        expect(resyncCompOffMock).toHaveBeenCalledWith(userId, undefined);
    });

    it('grants 1 day for a full shift worked on a weekend', async () => {
        getSettingsMock.mockResolvedValue(settings(true));
        userFindByIdMock.mockReturnValue(userQuery({ role: ROLES.EMPLOYEE }));
        const projectId = new Types.ObjectId();
        // 480 billable min on a Saturday = a full 8h shift → 1 day via weekend rule.
        timesheetAggregateMock.mockResolvedValue([{ _id: projectId, minutes: 480 }]);

        const res = await svc.settleCompOffForDay(new Types.ObjectId(), WEEKEND);

        expect(res.reason).toBe('granted');
        expect(res.days).toBe(1);
        expect(res.delta).toBe(1);
        expect(createEarnedLotMock).toHaveBeenCalledTimes(1);
        expect(createEarnedLotMock.mock.calls[0]![0]).toMatchObject({
            days: 1,
            source_type: COMP_OFF_SOURCES.TIMESHEET_BILLABLE,
            source_date: WEEKEND,
            project_id: projectId,
        });
    });

    it('is idempotent — a lot already at target settles to delta 0 with no new lot', async () => {
        getSettingsMock.mockResolvedValue(settings(true));
        userFindByIdMock.mockReturnValue(userQuery({ role: ROLES.EMPLOYEE }));
        timesheetAggregateMock.mockResolvedValue([{ _id: new Types.ObjectId(), minutes: 480 }]); // weekend full shift → 1
        const lot = existingLot({ days: 1, remaining_days: 1 });
        ledgerFindOneMock.mockResolvedValue(lot);

        const res = await svc.settleCompOffForDay(new Types.ObjectId(), WEEKEND);

        expect(res.reason).toBe('unchanged');
        expect(res.delta).toBe(0);
        expect(createEarnedLotMock).not.toHaveBeenCalled();
        expect(ledgerCreateMock).not.toHaveBeenCalled();
        expect(lot.deleteOne).not.toHaveBeenCalled();
    });

    it('caps a decrease at the consumed portion — never claws back used days', async () => {
        getSettingsMock.mockResolvedValue(settings(true));
        userFindByIdMock.mockReturnValue(userQuery({ role: ROLES.EMPLOYEE }));
        timesheetAggregateMock.mockResolvedValue([]); // no billable minutes → target 0
        // Existing lot: 1 day granted, 0.5 still remaining → 0.5 already consumed.
        const lot = existingLot({ days: 1, remaining_days: 0.5 });
        ledgerFindOneMock.mockResolvedValue(lot);

        const res = await svc.settleCompOffForDay(new Types.ObjectId(), WEEKDAY);

        expect(res.reason).toBe('granted'); // delta !== 0
        expect(res.delta).toBe(-0.5);
        // Converges DOWN to the consumed floor (0.5), not deleted.
        expect(lot.days).toBe(0.5);
        expect(lot.remaining_days).toBe(0);
        expect(lot.deleteOne).not.toHaveBeenCalled();
        expect(lot.save).toHaveBeenCalledTimes(1);
    });
});

describe('accrueCompOffForDay', () => {
    it('is a no-op when the setting is disabled', async () => {
        getSettingsMock.mockResolvedValue(settings(false));

        const res = await svc.accrueCompOffForDay(WEEKEND);

        expect(res.enabled).toBe(false);
        expect(res.processed).toBe(0);
        expect(timesheetDistinctMock).not.toHaveBeenCalled();
    });

    it('settles every user who logged a timesheet on the day', async () => {
        getSettingsMock.mockResolvedValue(settings(true));
        const uid = new Types.ObjectId();
        timesheetDistinctMock.mockResolvedValue([uid]);
        userFindByIdMock.mockReturnValue(userQuery({ role: ROLES.EMPLOYEE }));
        timesheetAggregateMock.mockResolvedValue([{ _id: new Types.ObjectId(), minutes: 480 }]); // weekend full shift → 1

        const res = await svc.accrueCompOffForDay(WEEKEND);

        expect(timesheetDistinctMock).toHaveBeenCalledWith('user_id', { local_date: WEEKEND });
        expect(res.enabled).toBe(true);
        expect(res.processed).toBe(1);
        expect(res.granted_users).toBe(1);
        expect(res.granted_days).toBe(1);
        expect(createEarnedLotMock).toHaveBeenCalledTimes(1);
    });
});
