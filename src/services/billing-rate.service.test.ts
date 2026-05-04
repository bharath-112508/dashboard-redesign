import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Types } from 'mongoose';

/**
 * Unit tests for `billing-rate.service` (Step 23).
 *
 * Coverage focus:
 *   1. `createRate` — invalid range rejected, references-must-exist
 *      (user / project / task), auto-close of overlapping predecessor,
 *      same-day-or-earlier overlap rejected with intelligible error.
 *   2. `patchRate` — `effective_to < effective_from` rejected via the
 *      same range guard the model uses.
 *   3. `endRate` — sets `effective_to = today`; for forward-dated rows
 *      that haven't started yet, sets `effective_to = effective_from`.
 *   4. `deleteRate` — refuses with `BILLING_RATE_IN_USE` when any
 *      timesheet entry inside the effective range references the
 *      `(user, project, task)` tuple; allows when none does.
 *   5. `listRates` — `active_on` filter shape.
 */

const {
    rateCreateMock,
    rateFindByIdMock,
    rateFindOneMock,
    rateFindMock,
    rateCountMock,
    timesheetExistsMock,
    userExistsMock,
    projectExistsMock,
    taskExistsMock,
    recordAuditMock,
} = vi.hoisted(() => ({
    rateCreateMock: vi.fn(),
    rateFindByIdMock: vi.fn(),
    rateFindOneMock: vi.fn(),
    rateFindMock: vi.fn(),
    rateCountMock: vi.fn(),
    timesheetExistsMock: vi.fn(),
    userExistsMock: vi.fn(),
    projectExistsMock: vi.fn(),
    taskExistsMock: vi.fn(),
    recordAuditMock: vi.fn(),
}));

vi.mock('../models/billing-rate.model.js', () => ({
    BillingRate: {
        create: rateCreateMock,
        findById: rateFindByIdMock,
        findOne: rateFindOneMock,
        find: rateFindMock,
        countDocuments: rateCountMock,
    },
}));

vi.mock('../models/timesheet-entry.model.js', () => ({
    TimesheetEntry: { exists: timesheetExistsMock },
}));

vi.mock('../models/user.model.js', () => ({
    User: { exists: userExistsMock },
}));

vi.mock('../models/project.model.js', () => ({
    Project: { exists: projectExistsMock },
}));

vi.mock('../models/task.model.js', () => ({
    Task: { exists: taskExistsMock },
}));

vi.mock('./audit.service.js', () => ({
    recordAudit: recordAuditMock,
    recordSystemAudit: vi.fn(),
}));

const svc = await import('./billing-rate.service.js');
import { ERROR_CODES } from '../constants/error-codes.js';
import dayjs, { DATE_FORMAT, DEFAULT_TIMEZONE } from '../utils/date.js';

// ─── Helpers ─────────────────────────────────────────────────────────────

const todayLocal = (): string => dayjs().tz(DEFAULT_TIMEZONE).format(DATE_FORMAT);
const yesterdayLocal = (): string => dayjs().tz(DEFAULT_TIMEZONE).subtract(1, 'day').format(DATE_FORMAT);

const makeCaller = () => ({ id: new Types.ObjectId(), audit: undefined });

const makeRate = (overrides: Record<string, unknown> = {}) => {
    const r = {
        _id: new Types.ObjectId(),
        user_id: new Types.ObjectId(),
        project_id: new Types.ObjectId(),
        task_id: null as Types.ObjectId | null,
        hourly_rate: 2500,
        effective_from: '2026-01-01',
        effective_to: null as string | null,
        created_by: new Types.ObjectId(),
        save: vi.fn(),
        deleteOne: vi.fn(),
        toJSON: vi.fn(),
        ...overrides,
    };
    r.save.mockImplementation(async () => r);
    r.deleteOne.mockImplementation(async () => undefined);
    r.toJSON.mockImplementation(() => ({
        id: r._id.toString(),
        user_id: r.user_id.toString(),
        project_id: r.project_id.toString(),
        task_id: r.task_id?.toString() ?? null,
        hourly_rate: r.hourly_rate,
        effective_from: r.effective_from,
        effective_to: r.effective_to,
    }));
    return r;
};

beforeEach(() => {
    vi.resetAllMocks();
    userExistsMock.mockResolvedValue({ _id: new Types.ObjectId() });
    projectExistsMock.mockResolvedValue({ _id: new Types.ObjectId() });
    taskExistsMock.mockResolvedValue({ _id: new Types.ObjectId() });
    timesheetExistsMock.mockResolvedValue(null);
    // Default: no overlapping rate. `findOverlappingRates` returns the
    // resolved array directly from `BillingRate.find(filter)`.
    rateFindMock.mockResolvedValue([]);
});

// ─── createRate ──────────────────────────────────────────────────────────

describe('createRate', () => {
    const baseBody = (overrides: Record<string, unknown> = {}) => ({
        user_id: new Types.ObjectId().toString(),
        project_id: new Types.ObjectId().toString(),
        task_id: null,
        hourly_rate: 2500,
        effective_from: '2026-05-01',
        effective_to: null,
        ...overrides,
    });

    it('rejects effective_to < effective_from with BILLING_RATE_INVALID_RANGE', async () => {
        await expect(
            svc.createRate(baseBody({ effective_from: '2026-05-01', effective_to: '2026-04-01' }), makeCaller())
        ).rejects.toMatchObject({ code: ERROR_CODES.BILLING_RATE_INVALID_RANGE });
        expect(rateCreateMock).not.toHaveBeenCalled();
    });

    it('rejects when user reference does not exist', async () => {
        userExistsMock.mockResolvedValueOnce(null);
        await expect(svc.createRate(baseBody(), makeCaller())).rejects.toMatchObject({
            code: ERROR_CODES.USER_NOT_FOUND,
        });
    });

    it('rejects when task_id is set but the task is not in the project', async () => {
        taskExistsMock.mockResolvedValueOnce(null);
        await expect(
            svc.createRate(baseBody({ task_id: new Types.ObjectId().toString() }), makeCaller())
        ).rejects.toMatchObject({ code: ERROR_CODES.TASK_NOT_FOUND });
    });

    it('auto-closes an overlapping open predecessor to (effective_from - 1)', async () => {
        const predecessor = makeRate({ effective_from: '2026-01-01', effective_to: null });
        rateFindMock.mockResolvedValueOnce([predecessor]);
        rateCreateMock.mockResolvedValueOnce(makeRate({ effective_from: '2026-05-01' }));

        await svc.createRate(baseBody({ effective_from: '2026-05-01' }), makeCaller());

        expect(predecessor.effective_to).toBe('2026-04-30');
        expect(predecessor.save).toHaveBeenCalledTimes(1);
    });

    it('rejects a new rate that starts on/before the predecessor (would yield to < from)', async () => {
        const predecessor = makeRate({ effective_from: '2026-05-15', effective_to: null });
        rateFindMock.mockResolvedValueOnce([predecessor]);

        await expect(svc.createRate(baseBody({ effective_from: '2026-05-15' }), makeCaller())).rejects.toMatchObject({
            code: ERROR_CODES.BILLING_RATE_INVALID_RANGE,
        });
        expect(predecessor.save).not.toHaveBeenCalled();
    });

    it('refuses a back-fill that would overlap an existing open rate (regression for the asymmetric-overlap bug)', async () => {
        // Existing open rate: 2026-01-01 → null. Admin tries to back-fill
        // 2025-06-01 → 2026-03-31 — would create two simultaneously-
        // applicable rows on 2026-02-15 if the old asymmetric filter
        // were still in place.
        const existing = makeRate({ effective_from: '2026-01-01', effective_to: null });
        rateFindMock.mockResolvedValueOnce([existing]);

        await expect(
            svc.createRate(baseBody({ effective_from: '2025-06-01', effective_to: '2026-03-31' }), makeCaller())
        ).rejects.toMatchObject({ code: ERROR_CODES.BILLING_RATE_INVALID_RANGE });
        expect(existing.save).not.toHaveBeenCalled();
        expect(rateCreateMock).not.toHaveBeenCalled();
    });

    it('refuses a create that would overlap multiple existing closed rates', async () => {
        const a = makeRate({ effective_from: '2025-01-01', effective_to: '2025-06-30' });
        const b = makeRate({ effective_from: '2025-07-01', effective_to: '2025-12-31' });
        rateFindMock.mockResolvedValueOnce([a, b]);

        await expect(
            svc.createRate(baseBody({ effective_from: '2025-03-01', effective_to: '2025-09-30' }), makeCaller())
        ).rejects.toMatchObject({ code: ERROR_CODES.BILLING_RATE_INVALID_RANGE });
    });

    it('maps the unique-index 11000 violation into a deterministic 409 DUPLICATE_RESOURCE', async () => {
        rateCreateMock.mockRejectedValueOnce({ code: 11000, keyPattern: { effective_from: 1 } });
        await expect(svc.createRate(baseBody({ effective_from: '2026-05-01' }), makeCaller())).rejects.toMatchObject({
            code: ERROR_CODES.DUPLICATE_RESOURCE,
            statusCode: 409,
        });
    });

    it('records an audit row with previous_rate_id when an overlap was auto-closed', async () => {
        const predecessor = makeRate({ effective_from: '2026-01-01', effective_to: null });
        rateFindMock.mockResolvedValueOnce([predecessor]);
        const created = makeRate({ effective_from: '2026-05-01' });
        rateCreateMock.mockResolvedValueOnce(created);
        const caller = {
            id: new Types.ObjectId(),
            audit: { actor_id: new Types.ObjectId(), actor_role: 'admin' as const, ip: null, user_agent: null },
        };

        await svc.createRate(baseBody({ effective_from: '2026-05-01' }), caller);

        expect(recordAuditMock).toHaveBeenCalledTimes(1);
        const payload = recordAuditMock.mock.calls[0][1] as { metadata: { previous_rate_id: string | null } };
        expect(payload.metadata.previous_rate_id).toBe(predecessor._id.toString());
    });
});

// ─── patchRate ───────────────────────────────────────────────────────────

describe('patchRate', () => {
    it('rejects effective_to < existing effective_from', async () => {
        const rate = makeRate({ effective_from: '2026-05-01' });
        rateFindByIdMock.mockResolvedValueOnce(rate);
        await expect(svc.patchRate(rate._id, { effective_to: '2026-04-01' }, makeCaller())).rejects.toMatchObject({
            code: ERROR_CODES.BILLING_RATE_INVALID_RANGE,
        });
    });

    it('updates hourly_rate and saves', async () => {
        const rate = makeRate();
        rateFindByIdMock.mockResolvedValueOnce(rate);
        await svc.patchRate(rate._id, { hourly_rate: 3000 }, makeCaller());
        expect(rate.hourly_rate).toBe(3000);
        expect(rate.save).toHaveBeenCalledTimes(1);
    });
});

// ─── endRate ─────────────────────────────────────────────────────────────

describe('endRate', () => {
    it('sets effective_to to today for an active row', async () => {
        const rate = makeRate({ effective_from: '2025-01-01', effective_to: null });
        rateFindByIdMock.mockResolvedValueOnce(rate);
        await svc.endRate(rate._id, makeCaller());
        expect(rate.effective_to).toBe(todayLocal());
    });

    it('sets effective_to to effective_from when the row is forward-dated (never applied)', async () => {
        const future = dayjs().tz(DEFAULT_TIMEZONE).add(30, 'day').format(DATE_FORMAT);
        const rate = makeRate({ effective_from: future, effective_to: null });
        rateFindByIdMock.mockResolvedValueOnce(rate);
        await svc.endRate(rate._id, makeCaller());
        expect(rate.effective_to).toBe(future);
    });

    it('is a no-op when the rate is already ended (regression — re-end must not move the boundary)', async () => {
        const ended = '2025-12-31';
        const rate = makeRate({ effective_from: '2025-01-01', effective_to: ended });
        rateFindByIdMock.mockResolvedValueOnce(rate);
        await svc.endRate(rate._id, makeCaller());
        expect(rate.effective_to).toBe(ended);
        expect(rate.save).not.toHaveBeenCalled();
        expect(recordAuditMock).not.toHaveBeenCalled();
    });
});

// ─── deleteRate ──────────────────────────────────────────────────────────

describe('deleteRate', () => {
    it('refuses with BILLING_RATE_IN_USE when a timesheet entry exists inside the effective range', async () => {
        const rate = makeRate({ effective_from: '2026-01-01', effective_to: '2026-12-31' });
        rateFindByIdMock.mockResolvedValueOnce(rate);
        timesheetExistsMock.mockResolvedValueOnce({ _id: new Types.ObjectId() });
        await expect(svc.deleteRate(rate._id, makeCaller())).rejects.toMatchObject({
            code: ERROR_CODES.BILLING_RATE_IN_USE,
        });
        expect(rate.deleteOne).not.toHaveBeenCalled();
    });

    it('deletes when no timesheet entry uses the rate', async () => {
        const rate = makeRate();
        rateFindByIdMock.mockResolvedValueOnce(rate);
        timesheetExistsMock.mockResolvedValueOnce(null);
        await expect(svc.deleteRate(rate._id, makeCaller())).resolves.toEqual({ deleted: true });
        expect(rate.deleteOne).toHaveBeenCalledTimes(1);
    });

    it('uses the rate effective range for the usage filter (lte capped when set)', async () => {
        const rate = makeRate({
            user_id: new Types.ObjectId(),
            project_id: new Types.ObjectId(),
            effective_from: '2026-01-01',
            effective_to: '2026-06-30',
        });
        rateFindByIdMock.mockResolvedValueOnce(rate);
        await svc.deleteRate(rate._id, makeCaller());

        const filterArg = timesheetExistsMock.mock.calls[0][0] as Record<string, unknown>;
        expect(filterArg.user_id).toEqual(rate.user_id);
        expect(filterArg.project_id).toEqual(rate.project_id);
        expect(filterArg.local_date).toEqual({ $gte: '2026-01-01', $lte: '2026-06-30' });
    });
});

// ─── listRates ───────────────────────────────────────────────────────────

describe('listRates', () => {
    const stubFind = (rows: ReturnType<typeof makeRate>[]): void => {
        rateFindMock.mockReturnValueOnce({
            sort: () => ({
                skip: () => ({
                    limit: () => Promise.resolve(rows),
                }),
            }),
        });
        rateCountMock.mockResolvedValueOnce(rows.length);
    };

    it('builds an "active_on" filter using effective_from <= and (effective_to null OR >=)', async () => {
        stubFind([]);
        await svc.listRates({ active_on: '2026-05-15', page: 1, limit: 20 });
        const filterArg = rateFindMock.mock.calls[0][0] as Record<string, unknown>;
        expect(filterArg.effective_from).toEqual({ $lte: '2026-05-15' });
        expect(filterArg.$or).toEqual([{ effective_to: null }, { effective_to: { $gte: '2026-05-15' } }]);
    });

    it('omits the effective filters when active_on is absent', async () => {
        stubFind([]);
        await svc.listRates({ page: 1, limit: 20 });
        const filterArg = rateFindMock.mock.calls[0][0] as Record<string, unknown>;
        expect(yesterdayLocal()).toMatch(/^\d{4}-\d{2}-\d{2}$/); // sanity for our helper
        expect('effective_from' in filterArg).toBe(false);
        expect('$or' in filterArg).toBe(false);
    });
});
