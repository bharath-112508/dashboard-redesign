import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Types } from 'mongoose';

/**
 * Unit tests for `cost-rate.service` (Billing Phase 2 — Cost Rates &
 * Margin, Task 3).
 *
 * Cost-side twin of `billing-rate.service.test.ts` — same mock idiom,
 * adapted for the one-dimension-less shape (`user_id` only, no
 * `project_id`/`task_id`).
 *
 * Coverage focus:
 *   1. `createCostRate` — invalid range rejected, user-must-exist,
 *      auto-close of overlapping open predecessor, same-day-or-earlier
 *      overlap rejected, unique-index 11000 mapped to 409, audit row
 *      carries `previous_rate_id`.
 *   2. `updateCostRate` — `effective_to < effective_from` rejected.
 *   3. `endCostRate` — idempotent IST-today soft-end.
 *   4. `deleteCostRate` — refuses with `COST_RATE_IN_USE` when a
 *      timesheet entry falls inside the effective range; allows
 *      otherwise.
 *   5. `listCostRates` — `active_on` filter shape.
 *   6. `resolveCostRateForUser` — window-matching rate, null when none.
 */

const {
    rateCreateMock,
    rateFindByIdMock,
    rateFindOneMock,
    rateFindMock,
    rateCountMock,
    timesheetExistsMock,
    userExistsMock,
    recordAuditMock,
} = vi.hoisted(() => ({
    rateCreateMock: vi.fn(),
    rateFindByIdMock: vi.fn(),
    rateFindOneMock: vi.fn(),
    rateFindMock: vi.fn(),
    rateCountMock: vi.fn(),
    timesheetExistsMock: vi.fn(),
    userExistsMock: vi.fn(),
    recordAuditMock: vi.fn(),
}));

vi.mock('../models/cost-rate.model.js', () => ({
    CostRate: {
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

vi.mock('./audit.service.js', () => ({
    recordAudit: recordAuditMock,
    recordSystemAudit: vi.fn(),
}));

const svc = await import('./cost-rate.service.js');
import { ERROR_CODES } from '../constants/error-codes.js';
import dayjs, { DATE_FORMAT, DEFAULT_TIMEZONE } from '../utils/date.js';

// ─── Helpers ─────────────────────────────────────────────────────────────

const todayLocal = (): string => dayjs().tz(DEFAULT_TIMEZONE).format(DATE_FORMAT);

const makeCaller = () => ({ id: new Types.ObjectId(), audit: undefined });

const makeRate = (overrides: Record<string, unknown> = {}) => {
    const r = {
        _id: new Types.ObjectId(),
        user_id: new Types.ObjectId(),
        cost_per_hour: 500,
        currency: 'USD',
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
        cost_per_hour: r.cost_per_hour,
        currency: r.currency,
        effective_from: r.effective_from,
        effective_to: r.effective_to,
    }));
    return r;
};

beforeEach(() => {
    vi.resetAllMocks();
    userExistsMock.mockResolvedValue({ _id: new Types.ObjectId() });
    timesheetExistsMock.mockResolvedValue(null);
    // Default: no overlapping rate. `findOverlappingRates` returns the
    // resolved array directly from `CostRate.find(filter)`.
    rateFindMock.mockResolvedValue([]);
});

// ─── createCostRate ──────────────────────────────────────────────────────

describe('createCostRate', () => {
    const baseBody = (overrides: Record<string, unknown> = {}) => ({
        user_id: new Types.ObjectId().toString(),
        cost_per_hour: 500,
        currency: 'USD',
        effective_from: '2026-05-01',
        effective_to: null,
        ...overrides,
    });

    it('rejects effective_to < effective_from with COST_RATE_INVALID_RANGE', async () => {
        await expect(
            svc.createCostRate(baseBody({ effective_from: '2026-05-01', effective_to: '2026-04-01' }), makeCaller())
        ).rejects.toMatchObject({ code: ERROR_CODES.COST_RATE_INVALID_RANGE });
        expect(rateCreateMock).not.toHaveBeenCalled();
    });

    it('rejects when the user reference does not exist', async () => {
        userExistsMock.mockResolvedValueOnce(null);
        await expect(svc.createCostRate(baseBody(), makeCaller())).rejects.toMatchObject({
            code: ERROR_CODES.USER_NOT_FOUND,
        });
    });

    it('auto-closes an overlapping open predecessor to (effective_from - 1)', async () => {
        const predecessor = makeRate({ effective_from: '2026-01-01', effective_to: null });
        rateFindMock.mockResolvedValueOnce([predecessor]);
        rateCreateMock.mockResolvedValueOnce([makeRate({ effective_from: '2026-05-01' })]);

        await svc.createCostRate(baseBody({ effective_from: '2026-05-01' }), makeCaller());

        expect(predecessor.effective_to).toBe('2026-04-30');
        expect(predecessor.save).toHaveBeenCalledTimes(1);
    });

    it('rejects a new rate that starts on/before the predecessor (would yield to < from)', async () => {
        const predecessor = makeRate({ effective_from: '2026-05-15', effective_to: null });
        rateFindMock.mockResolvedValueOnce([predecessor]);

        await expect(
            svc.createCostRate(baseBody({ effective_from: '2026-05-15' }), makeCaller())
        ).rejects.toMatchObject({
            code: ERROR_CODES.COST_RATE_INVALID_RANGE,
        });
        expect(predecessor.save).not.toHaveBeenCalled();
    });

    it('refuses a create that would overlap multiple existing closed rates', async () => {
        const a = makeRate({ effective_from: '2025-01-01', effective_to: '2025-06-30' });
        const b = makeRate({ effective_from: '2025-07-01', effective_to: '2025-12-31' });
        rateFindMock.mockResolvedValueOnce([a, b]);

        await expect(
            svc.createCostRate(baseBody({ effective_from: '2025-03-01', effective_to: '2025-09-30' }), makeCaller())
        ).rejects.toMatchObject({ code: ERROR_CODES.COST_RATE_INVALID_RANGE });
    });

    it('maps the unique-index 11000 violation into a deterministic 409 DUPLICATE_RESOURCE', async () => {
        rateCreateMock.mockRejectedValueOnce({ code: 11000, keyPattern: { effective_from: 1 } });
        await expect(
            svc.createCostRate(baseBody({ effective_from: '2026-05-01' }), makeCaller())
        ).rejects.toMatchObject({
            code: ERROR_CODES.DUPLICATE_RESOURCE,
            statusCode: 409,
        });
    });

    it('records an audit row with previous_rate_id when an overlap was auto-closed', async () => {
        const predecessor = makeRate({ effective_from: '2026-01-01', effective_to: null });
        rateFindMock.mockResolvedValueOnce([predecessor]);
        const created = makeRate({ effective_from: '2026-05-01' });
        rateCreateMock.mockResolvedValueOnce([created]);
        const caller = {
            id: new Types.ObjectId(),
            audit: { actor_id: new Types.ObjectId(), actor_role: 'admin' as const, ip: null, user_agent: null },
        };

        await svc.createCostRate(baseBody({ effective_from: '2026-05-01' }), caller);

        expect(recordAuditMock).toHaveBeenCalledTimes(1);
        const payload = recordAuditMock.mock.calls[0][1] as { metadata: { previous_rate_id: string | null } };
        expect(payload.metadata.previous_rate_id).toBe(predecessor._id.toString());
    });
});

// ─── updateCostRate ──────────────────────────────────────────────────────

describe('updateCostRate', () => {
    it('rejects effective_to < existing effective_from', async () => {
        const rate = makeRate({ effective_from: '2026-05-01' });
        rateFindByIdMock.mockResolvedValueOnce(rate);
        await expect(svc.updateCostRate(rate._id, { effective_to: '2026-04-01' }, makeCaller())).rejects.toMatchObject({
            code: ERROR_CODES.COST_RATE_INVALID_RANGE,
        });
    });

    it('updates cost_per_hour and saves', async () => {
        const rate = makeRate();
        rateFindByIdMock.mockResolvedValueOnce(rate);
        await svc.updateCostRate(rate._id, { cost_per_hour: 750 }, makeCaller());
        expect(rate.cost_per_hour).toBe(750);
        expect(rate.save).toHaveBeenCalledTimes(1);
    });
});

// ─── endCostRate ─────────────────────────────────────────────────────────

describe('endCostRate', () => {
    it('sets effective_to to today for an active row', async () => {
        const rate = makeRate({ effective_from: '2025-01-01', effective_to: null });
        rateFindByIdMock.mockResolvedValueOnce(rate);
        await svc.endCostRate(rate._id, makeCaller());
        expect(rate.effective_to).toBe(todayLocal());
    });

    it('sets effective_to to effective_from when the row is forward-dated (never applied)', async () => {
        const future = dayjs().tz(DEFAULT_TIMEZONE).add(30, 'day').format(DATE_FORMAT);
        const rate = makeRate({ effective_from: future, effective_to: null });
        rateFindByIdMock.mockResolvedValueOnce(rate);
        await svc.endCostRate(rate._id, makeCaller());
        expect(rate.effective_to).toBe(future);
    });

    it('is a no-op when the rate is already ended (regression — re-end must not move the boundary)', async () => {
        const ended = '2025-12-31';
        const rate = makeRate({ effective_from: '2025-01-01', effective_to: ended });
        rateFindByIdMock.mockResolvedValueOnce(rate);
        await svc.endCostRate(rate._id, makeCaller());
        expect(rate.effective_to).toBe(ended);
        expect(rate.save).not.toHaveBeenCalled();
        expect(recordAuditMock).not.toHaveBeenCalled();
    });
});

// ─── deleteCostRate ──────────────────────────────────────────────────────

describe('deleteCostRate', () => {
    it('refuses with COST_RATE_IN_USE when a timesheet entry exists inside the effective range', async () => {
        const rate = makeRate({ effective_from: '2026-01-01', effective_to: '2026-12-31' });
        rateFindByIdMock.mockResolvedValueOnce(rate);
        timesheetExistsMock.mockResolvedValueOnce({ _id: new Types.ObjectId() });
        await expect(svc.deleteCostRate(rate._id, makeCaller())).rejects.toMatchObject({
            code: ERROR_CODES.COST_RATE_IN_USE,
        });
        expect(rate.deleteOne).not.toHaveBeenCalled();
    });

    it('deletes when no timesheet entry uses the rate', async () => {
        const rate = makeRate();
        rateFindByIdMock.mockResolvedValueOnce(rate);
        timesheetExistsMock.mockResolvedValueOnce(null);
        await expect(svc.deleteCostRate(rate._id, makeCaller())).resolves.toEqual({ deleted: true });
        expect(rate.deleteOne).toHaveBeenCalledTimes(1);
    });

    it('uses the user_id + effective-range window for the usage filter (lte capped when set)', async () => {
        const rate = makeRate({
            user_id: new Types.ObjectId(),
            effective_from: '2026-01-01',
            effective_to: '2026-06-30',
        });
        rateFindByIdMock.mockResolvedValueOnce(rate);
        await svc.deleteCostRate(rate._id, makeCaller());

        const filterArg = timesheetExistsMock.mock.calls[0][0] as Record<string, unknown>;
        expect(filterArg.user_id).toEqual(rate.user_id);
        expect(filterArg.local_date).toEqual({ $gte: '2026-01-01', $lte: '2026-06-30' });
    });
});

// ─── listCostRates ───────────────────────────────────────────────────────

describe('listCostRates', () => {
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
        await svc.listCostRates({ active_on: '2026-05-15', page: 1, limit: 20 });
        const filterArg = rateFindMock.mock.calls[0][0] as Record<string, unknown>;
        expect(filterArg.effective_from).toEqual({ $lte: '2026-05-15' });
        expect(filterArg.$or).toEqual([{ effective_to: null }, { effective_to: { $gte: '2026-05-15' } }]);
    });

    it('omits the effective filters when active_on is absent', async () => {
        stubFind([]);
        await svc.listCostRates({ page: 1, limit: 20 });
        const filterArg = rateFindMock.mock.calls[0][0] as Record<string, unknown>;
        expect('effective_from' in filterArg).toBe(false);
        expect('$or' in filterArg).toBe(false);
    });
});

// ─── resolveCostRateForUser ──────────────────────────────────────────────

describe('resolveCostRateForUser', () => {
    it('returns { cost_per_hour, currency } for the window-matching rate', async () => {
        const rate = makeRate({
            cost_per_hour: 1200,
            currency: 'INR',
            effective_from: '2026-01-01',
            effective_to: null,
        });
        rateFindOneMock.mockReturnValueOnce({ sort: () => Promise.resolve(rate) });

        const result = await svc.resolveCostRateForUser(rate.user_id, '2026-03-15');

        expect(result).toEqual({ cost_per_hour: 1200, currency: 'INR' });
        const filterArg = rateFindOneMock.mock.calls[0][0] as Record<string, unknown>;
        expect(filterArg.user_id).toEqual(rate.user_id);
        expect(filterArg.effective_from).toEqual({ $lte: '2026-03-15' });
        expect(filterArg.$or).toEqual([{ effective_to: null }, { effective_to: { $gte: '2026-03-15' } }]);
    });

    it('returns null when no rate window contains the date', async () => {
        rateFindOneMock.mockReturnValueOnce({ sort: () => Promise.resolve(null) });
        const result = await svc.resolveCostRateForUser(new Types.ObjectId(), '2026-03-15');
        expect(result).toBeNull();
    });
});
