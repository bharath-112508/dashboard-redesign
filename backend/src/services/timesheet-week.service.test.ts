import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';
import { ERROR_CODES } from '../constants/error-codes.js';
import { ROLES } from '../constants/roles.js';

const { upsertMock, findMock, deleteOneMock, existsMock, scopedMock, auditMock, teamMock } = vi.hoisted(() => ({
    teamMock: vi.fn(),
    upsertMock: vi.fn(),
    findMock: vi.fn(),
    deleteOneMock: vi.fn(),
    existsMock: vi.fn(),
    scopedMock: vi.fn(),
    auditMock: vi.fn(),
}));

vi.mock('../models/timesheet-week.model.js', () => ({
    TimesheetWeek: { findOneAndUpdate: upsertMock, find: findMock, findOneAndDelete: deleteOneMock, exists: existsMock },
}));
vi.mock('./reporting-scope.service.js', () => ({ scopedUserIdFilter: scopedMock, teamScopeIdsOf: teamMock }));
vi.mock('./audit.service.js', () => ({ recordAudit: auditMock }));

const svc = await import('./timesheet-week.service.js');

const caller = (role: string, id = new Types.ObjectId()) => ({ id, role, audit: undefined }) as never;
const row = (user: Types.ObjectId, week: string) => ({
    _id: new Types.ObjectId(),
    user_id: user,
    week_start: week,
    submitted_at: new Date('2026-10-12T14:05:00.000Z'),
});

beforeEach(() => {
    vi.resetAllMocks();
});

describe('weekOf', () => {
    it('gives the Monday of a date', () => {
        expect(svc.weekOf('2026-10-14')).toBe('2026-10-12');
        expect(svc.weekOf('2026-10-12')).toBe('2026-10-12');
        expect(svc.weekOf('2026-10-18')).toBe('2026-10-12');
    });
});

describe('submitWeek', () => {
    it('stores the week once for the caller', async () => {
        const me = new Types.ObjectId();
        upsertMock.mockResolvedValueOnce(row(me, '2026-10-12'));
        const out = await svc.submitWeek('2026-10-12', caller(ROLES.EMPLOYEE, me));
        expect(upsertMock).toHaveBeenCalledWith(
            { user_id: me, week_start: '2026-10-12' },
            expect.objectContaining({ $setOnInsert: expect.objectContaining({ user_id: me, week_start: '2026-10-12' }) }),
            expect.objectContaining({ upsert: true, new: true })
        );
        expect(out).toMatchObject({ user_id: me.toString(), week_start: '2026-10-12' });
    });

    it('refuses a week that does not start on a Monday', async () => {
        await expect(svc.submitWeek('2026-10-13', caller(ROLES.EMPLOYEE))).rejects.toMatchObject({ statusCode: 422 });
        expect(upsertMock).not.toHaveBeenCalled();
    });
});

describe('listWeeks', () => {
    const chain = (rows: unknown[]) => ({ sort: () => ({ limit: () => Promise.resolve(rows) }) });

    it('lists only the caller\'s weeks for an employee', async () => {
        const me = new Types.ObjectId();
        findMock.mockReturnValueOnce(chain([row(me, '2026-10-12')]));
        const out = await svc.listWeeks({ from_date: '2026-09-01' }, caller(ROLES.EMPLOYEE, me));
        expect(findMock).toHaveBeenCalledWith({ user_id: me, week_start: { $gte: '2026-09-01' } });
        expect(out).toHaveLength(1);
        expect(scopedMock).not.toHaveBeenCalled();
    });

    it('lists the team for a manager', async () => {
        const team = { $in: [new Types.ObjectId()] };
        scopedMock.mockResolvedValueOnce(team);
        findMock.mockReturnValueOnce(chain([]));
        await svc.listWeeks({}, caller(ROLES.MANAGER));
        expect(findMock).toHaveBeenCalledWith({ user_id: team });
    });
});

describe('reopenWeek', () => {
    it('lets the owner reopen their week', async () => {
        const me = new Types.ObjectId();
        deleteOneMock.mockResolvedValueOnce({ deletedCount: 1 });
        await svc.reopenWeek('2026-10-12', undefined, caller(ROLES.EMPLOYEE, me));
        expect(deleteOneMock).toHaveBeenCalledWith({ user_id: me, week_start: '2026-10-12' });
    });

    it('lets a manager reopen a team member\'s week', async () => {
        const other = new Types.ObjectId();
        teamMock.mockResolvedValueOnce([other]);
        deleteOneMock.mockResolvedValueOnce(row(other, '2026-10-12'));
        await svc.reopenWeek('2026-10-12', other.toString(), caller(ROLES.MANAGER));
        expect(deleteOneMock).toHaveBeenCalledWith({ user_id: other, week_start: '2026-10-12' });
    });

    it('refuses a manager reopening a week outside their team', async () => {
        teamMock.mockResolvedValueOnce([new Types.ObjectId()]);
        await expect(svc.reopenWeek('2026-10-12', new Types.ObjectId().toString(), caller(ROLES.MANAGER))).rejects.toMatchObject({ statusCode: 403 });
        expect(deleteOneMock).not.toHaveBeenCalled();
    });

    it('lets an admin reopen anyone\'s week', async () => {
        const other = new Types.ObjectId();
        deleteOneMock.mockResolvedValueOnce(null);
        await svc.reopenWeek('2026-10-12', other.toString(), caller(ROLES.ADMIN));
        expect(deleteOneMock).toHaveBeenCalledWith({ user_id: other, week_start: '2026-10-12' });
        expect(teamMock).not.toHaveBeenCalled();
    });

    it('refuses an employee reopening someone else\'s week', async () => {
        await expect(svc.reopenWeek('2026-10-12', new Types.ObjectId().toString(), caller(ROLES.EMPLOYEE))).rejects.toMatchObject({
            statusCode: 403,
        });
        expect(deleteOneMock).not.toHaveBeenCalled();
    });
});

describe('assertWeekOpen', () => {
    it('refuses time in a submitted week', async () => {
        existsMock.mockResolvedValueOnce({ _id: new Types.ObjectId() });
        await expect(svc.assertWeekOpen(new Types.ObjectId(), '2026-10-14')).rejects.toMatchObject({
            code: ERROR_CODES.TIMESHEET_WEEK_SUBMITTED,
        });
        expect(existsMock).toHaveBeenCalledWith(expect.objectContaining({ week_start: '2026-10-12' }));
    });

    it('lets time into an open week', async () => {
        existsMock.mockResolvedValueOnce(null);
        await expect(svc.assertWeekOpen(new Types.ObjectId(), '2026-10-14')).resolves.toBeUndefined();
    });
});
