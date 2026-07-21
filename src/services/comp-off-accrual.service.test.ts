import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Types } from 'mongoose';

/**
 * Orchestration tests for `accrueCompOffForDay`. The pure rule maths live in
 * `utils/comp-off-accrual.test.ts`; here we pin the routing + wiring:
 *   - disabled setting → no-op (never touches attendance)
 *   - weekend full-day → grants 1 (ledger + balance + mark accrued)
 *   - working-day sub-threshold overtime → no grant, banks the remainder
 */

const {
    attendanceFindMock,
    attendanceUpdateOneMock,
    userFindByIdMock,
    userFindOneAndUpdateMock,
    userUpdateOneMock,
    ledgerCreateMock,
    holidayExistsMock,
    notificationCreateMock,
    getSettingsMock,
    recordSystemAuditMock,
    syncMirrorMock,
} = vi.hoisted(() => ({
    attendanceFindMock: vi.fn(),
    attendanceUpdateOneMock: vi.fn(),
    userFindByIdMock: vi.fn(),
    userFindOneAndUpdateMock: vi.fn(),
    userUpdateOneMock: vi.fn(),
    ledgerCreateMock: vi.fn(),
    holidayExistsMock: vi.fn(),
    notificationCreateMock: vi.fn(),
    getSettingsMock: vi.fn(),
    recordSystemAuditMock: vi.fn(),
    syncMirrorMock: vi.fn(),
}));

vi.mock('../models/attendance-record.model.js', () => ({
    AttendanceRecord: { find: attendanceFindMock, updateOne: attendanceUpdateOneMock },
}));
vi.mock('../models/user.model.js', () => ({
    User: { findById: userFindByIdMock, findOneAndUpdate: userFindOneAndUpdateMock, updateOne: userUpdateOneMock },
}));
vi.mock('../models/comp-off-ledger.model.js', () => ({
    CompOffLedger: { create: ledgerCreateMock },
}));
vi.mock('../models/holiday.model.js', () => ({ Holiday: { exists: holidayExistsMock } }));
vi.mock('../models/notification.model.js', () => ({ Notification: { create: notificationCreateMock } }));
vi.mock('./settings.service.js', () => ({ getOrInitSettings: getSettingsMock }));
vi.mock('./audit.service.js', () => ({ recordSystemAudit: recordSystemAuditMock }));
vi.mock('./comp-off.service.js', () => ({ syncLeaveBalanceForCompOff: syncMirrorMock }));

const svc = await import('./comp-off-accrual.service.js');
import { ROLES } from '../constants/roles.js';

const settings = (enabled: boolean, working_days = [1, 2, 3, 4, 5]) => ({
    work_schedule: { daily_expected_hours: 8, working_days },
    leave_policy: { comp_off_auto_accrual_enabled: enabled, comp_off_hours_per_day: 8 },
});

/** A User.findById(...).select() stub that awaits to `user` (no live session). */
const userQuery = (user: unknown) => ({ select: () => Promise.resolve(user) });

const record = (over: { worked?: number; overtime?: number } = {}) => ({
    _id: new Types.ObjectId(),
    user_id: new Types.ObjectId(),
    total_worked_minutes: over.worked ?? 0,
    overtime_minutes: over.overtime ?? 0,
});

beforeEach(() => {
    vi.clearAllMocks();
    holidayExistsMock.mockResolvedValue(false);
    ledgerCreateMock.mockResolvedValue({ _id: new Types.ObjectId() });
    userFindOneAndUpdateMock.mockResolvedValue({ comp_off_balance: 1 });
    attendanceUpdateOneMock.mockResolvedValue({});
    userUpdateOneMock.mockResolvedValue({});
    syncMirrorMock.mockResolvedValue(undefined);
});

describe('accrueCompOffForDay', () => {
    it('is a no-op when the setting is disabled', async () => {
        getSettingsMock.mockResolvedValue(settings(false));
        const res = await svc.accrueCompOffForDay('2026-07-13'); // a Monday
        expect(res.enabled).toBe(false);
        expect(res.processed).toBe(0);
        expect(attendanceFindMock).not.toHaveBeenCalled();
        expect(ledgerCreateMock).not.toHaveBeenCalled();
    });

    it('grants 1 comp-off for a full weekend day worked', async () => {
        getSettingsMock.mockResolvedValue(settings(true));
        const rec = record({ worked: 480 }); // full 8h shift on a Sunday
        attendanceFindMock.mockResolvedValue([rec]);
        userFindByIdMock.mockReturnValue(userQuery({ role: ROLES.EMPLOYEE, comp_off_balance: 0 }));

        const res = await svc.accrueCompOffForDay('2026-07-19'); // a Sunday

        expect(res.granted_days).toBe(1);
        expect(ledgerCreateMock).toHaveBeenCalledTimes(1);
        expect(ledgerCreateMock.mock.calls[0]![0]).toMatchObject({ type: 'earned', days: 1 });
        expect(userFindOneAndUpdateMock).toHaveBeenCalled(); // balance $inc
        expect(attendanceUpdateOneMock).toHaveBeenCalled(); // marked accrued
    });

    it('banks sub-threshold overtime on a working day without granting', async () => {
        getSettingsMock.mockResolvedValue(settings(true));
        const rec = record({ worked: 600, overtime: 120 }); // 2h overtime
        attendanceFindMock.mockResolvedValue([rec]);
        userFindByIdMock.mockReturnValue(
            userQuery({ role: ROLES.EMPLOYEE, comp_off_balance: 0, comp_off_overtime_bank_minutes: 300 })
        );

        const res = await svc.accrueCompOffForDay('2026-07-13'); // a Monday

        expect(res.granted_days).toBe(0);
        expect(ledgerCreateMock).not.toHaveBeenCalled();
        // bank 300 + 120 = 420 (< 480) carried forward
        expect(userUpdateOneMock).toHaveBeenCalledWith(
            expect.anything(),
            { $set: { comp_off_overtime_bank_minutes: 420 } },
            expect.anything()
        );
        expect(attendanceUpdateOneMock).toHaveBeenCalled(); // still marked accrued
    });

    it('skips (but marks) records for client users', async () => {
        getSettingsMock.mockResolvedValue(settings(true));
        const rec = record({ worked: 480 });
        attendanceFindMock.mockResolvedValue([rec]);
        userFindByIdMock.mockReturnValue(userQuery({ role: ROLES.CLIENT, comp_off_balance: 0 }));

        const res = await svc.accrueCompOffForDay('2026-07-19');

        expect(res.granted_days).toBe(0);
        expect(ledgerCreateMock).not.toHaveBeenCalled();
        expect(attendanceUpdateOneMock).toHaveBeenCalled();
    });
});
