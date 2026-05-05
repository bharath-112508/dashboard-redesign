import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Types } from 'mongoose';

import { ERROR_CODES } from '../constants/error-codes.js';

/**
 * Unit tests for `report-preset.service` (Phase 4 Step 42).
 *
 * Coverage focus:
 *   1. **Owner scoping** — every read/write filters by `user_id =
 *      caller`. Cross-user IDs surface as REPORT_PRESET_NOT_FOUND
 *      (anti-enumeration).
 *   2. **Per-user cap** — create rejects with REPORT_PRESET_LIMIT_EXCEEDED
 *      when the caller already has 50 presets.
 *   3. **Per-report-name filter dispatch** — create + patch validate
 *      `filters` against the matching Step-29 schema. Invalid filters
 *      surface as VALIDATION_ERROR.
 *   4. **(user_id, name) unique** — duplicate-name create raises
 *      DUPLICATE_RESOURCE (E11000 mapped).
 *   5. **patch validates against the LOCKED report_name** — operators
 *      can't sneak in a different report's filter shape via PATCH
 *      because the validator dispatches on the existing row's
 *      `report_name`, not anything in the patch body.
 */

const { presetCreateMock, presetCountMock, presetFindOneMock, presetFindMock, presetDeleteOneMock } = vi.hoisted(
    () => ({
        presetCreateMock: vi.fn(),
        presetCountMock: vi.fn(),
        presetFindOneMock: vi.fn(),
        presetFindMock: vi.fn(),
        presetDeleteOneMock: vi.fn(),
    })
);

vi.mock('../models/report-preset.model.js', () => ({
    ReportPreset: {
        create: presetCreateMock,
        countDocuments: presetCountMock,
        findOne: presetFindOneMock,
        find: presetFindMock,
        deleteOne: presetDeleteOneMock,
    },
}));

const svc = await import('./report-preset.service.js');

// ─── Helpers ───────────────────────────────────────────────────────────

const queryStub = (rows: unknown[]) => {
    const stub: Record<string, unknown> = {
        sort: () => stub,
        skip: () => stub,
        limit: () => stub,
        then: (r: (v: unknown) => void) => Promise.resolve(rows).then(r),
    };
    return stub;
};

const callerId = () => new Types.ObjectId();

const validBillingFilters = () => ({
    project_id: 'a'.repeat(24),
    from_date: '2026-04-01',
    to_date: '2026-04-30',
});

const validBillingBody = (overrides: Record<string, unknown> = {}) => ({
    name: 'Monthly billing — Apollo',
    report_name: 'billing' as const,
    filters: validBillingFilters(),
    ...overrides,
});

const makePresetDoc = (overrides: Record<string, unknown> = {}) => {
    const _id = new Types.ObjectId();
    const doc = {
        _id,
        user_id: new Types.ObjectId(),
        name: 'Some preset',
        report_name: 'billing' as const,
        filters: validBillingFilters(),
        save: vi.fn(),
        toJSON: vi.fn(),
        ...overrides,
    };
    doc.save.mockImplementation(async () => doc);
    doc.toJSON.mockImplementation(() => ({ id: _id.toString(), ...doc }));
    return doc;
};

beforeEach(() => {
    vi.resetAllMocks();
    presetCountMock.mockResolvedValue(0);
});

// ─── createPreset ──────────────────────────────────────────────────────

describe('createPreset', () => {
    it('happy path: persists with caller as user_id, returns the public shape', async () => {
        const caller = callerId();
        const doc = makePresetDoc({ user_id: caller, name: 'Apollo' });
        presetCreateMock.mockResolvedValueOnce(doc);

        const result = await svc.createPreset(validBillingBody({ name: 'Apollo' }), caller);

        expect(presetCreateMock).toHaveBeenCalledTimes(1);
        const createArg = presetCreateMock.mock.calls[0][0] as Record<string, unknown>;
        expect(createArg.user_id).toBe(caller);
        expect(createArg.name).toBe('Apollo');
        expect(result).toBeDefined();
    });

    it('rejects with REPORT_PRESET_LIMIT_EXCEEDED when caller already has 50 presets', async () => {
        presetCountMock.mockResolvedValueOnce(50);
        await expect(svc.createPreset(validBillingBody(), callerId())).rejects.toMatchObject({
            code: ERROR_CODES.REPORT_PRESET_LIMIT_EXCEEDED,
        });
        expect(presetCreateMock).not.toHaveBeenCalled();
    });

    it('rejects malformed filters with VALIDATION_ERROR (per-report-name dispatch)', async () => {
        // Billing requires `project_id`. Drop it; service must reject.
        const bad = validBillingBody({
            filters: { from_date: '2026-04-01', to_date: '2026-04-30' },
        });
        await expect(svc.createPreset(bad, callerId())).rejects.toMatchObject({
            code: ERROR_CODES.VALIDATION_ERROR,
        });
        expect(presetCreateMock).not.toHaveBeenCalled();
    });

    it('error path is prefixed with `filters.` so the FE knows which request field is bad', async () => {
        // Billing requires `project_id`. The ZodError's issue path is
        // relative to the filters object (e.g. ['project_id']); the
        // service's wrap prepends 'filters' so the FE sees the
        // request-body-relative path (`filters.project_id`).
        const bad = validBillingBody({ filters: { from_date: '2026-04-01', to_date: '2026-04-30' } });
        let caught: { details?: { errors?: { field: string }[] } } | undefined;
        await svc.createPreset(bad, callerId()).catch((err: unknown) => {
            caught = err as typeof caught;
        });
        const fields = caught?.details?.errors?.map((e) => e.field) ?? [];
        expect(fields.length).toBeGreaterThan(0);
        expect(fields.every((f) => f.startsWith('filters'))).toBe(true);
    });

    it('rejects cross-name filter shape (e.g. leaves filter under billing)', async () => {
        // Billing schema doesn't accept `year`-only filters.
        const bad = validBillingBody({ filters: { year: 2026 } });
        await expect(svc.createPreset(bad, callerId())).rejects.toMatchObject({
            code: ERROR_CODES.VALIDATION_ERROR,
        });
    });

    it('maps E11000 unique-index collision to DUPLICATE_RESOURCE', async () => {
        const dupErr = Object.assign(new Error('E11000'), { code: 11000 });
        presetCreateMock.mockRejectedValueOnce(dupErr);

        await expect(svc.createPreset(validBillingBody(), callerId())).rejects.toMatchObject({
            code: ERROR_CODES.DUPLICATE_RESOURCE,
        });
    });
});

// ─── listPresets ───────────────────────────────────────────────────────

describe('listPresets', () => {
    it('always filters by user_id = caller (owner scoping)', async () => {
        const caller = callerId();
        presetFindMock.mockReturnValueOnce(queryStub([]));
        presetCountMock.mockResolvedValueOnce(0);

        await svc.listPresets({ page: 1, limit: 20 }, caller);

        const filter = presetFindMock.mock.calls[0][0] as Record<string, unknown>;
        expect(filter.user_id).toBe(caller);
    });

    it('accepts an optional report_name filter', async () => {
        presetFindMock.mockReturnValueOnce(queryStub([]));
        presetCountMock.mockResolvedValueOnce(0);

        await svc.listPresets({ report_name: 'leaves', page: 1, limit: 20 }, callerId());

        const filter = presetFindMock.mock.calls[0][0] as Record<string, unknown>;
        expect(filter.report_name).toBe('leaves');
    });

    it('returns the meta envelope shape', async () => {
        presetFindMock.mockReturnValueOnce(queryStub([]));
        presetCountMock.mockResolvedValueOnce(47);

        const result = await svc.listPresets({ page: 1, limit: 20 }, callerId());

        expect(result.meta).toEqual({ page: 1, limit: 20, total: 47, total_pages: 3 });
    });
});

// ─── getPreset ─────────────────────────────────────────────────────────

describe('getPreset', () => {
    it('REPORT_PRESET_NOT_FOUND for unknown id (or cross-user — same code)', async () => {
        presetFindOneMock.mockResolvedValueOnce(null);

        await expect(svc.getPreset(new Types.ObjectId(), callerId())).rejects.toMatchObject({
            code: ERROR_CODES.REPORT_PRESET_NOT_FOUND,
        });
    });

    it('filter must include user_id (anti-enumeration)', async () => {
        const caller = callerId();
        presetFindOneMock.mockResolvedValueOnce(null);

        await svc.getPreset(new Types.ObjectId(), caller).catch(() => undefined);

        const filter = presetFindOneMock.mock.calls[0][0] as Record<string, unknown>;
        expect(filter.user_id).toBe(caller);
    });
});

// ─── updatePreset ──────────────────────────────────────────────────────

describe('updatePreset', () => {
    it('updates name only without touching filters when filters not provided', async () => {
        const doc = makePresetDoc({ name: 'Old name' });
        presetFindOneMock.mockResolvedValueOnce(doc);

        await svc.updatePreset(doc._id as Types.ObjectId, { name: 'New name' }, callerId());

        expect(doc.name).toBe('New name');
        expect(doc.save).toHaveBeenCalledTimes(1);
    });

    it('validates filters against the EXISTING report_name (locked at creation)', async () => {
        // Preset is for billing. Operator tries to PATCH with a leaves-shaped filter.
        const doc = makePresetDoc({ report_name: 'billing' });
        presetFindOneMock.mockResolvedValueOnce(doc);

        await expect(
            svc.updatePreset(doc._id as Types.ObjectId, { filters: { year: 2026 } }, callerId())
        ).rejects.toMatchObject({ code: ERROR_CODES.VALIDATION_ERROR });
    });

    it('REPORT_PRESET_NOT_FOUND on unknown id (filter includes user_id)', async () => {
        presetFindOneMock.mockResolvedValueOnce(null);
        await expect(svc.updatePreset(new Types.ObjectId(), { name: 'x' }, callerId())).rejects.toMatchObject({
            code: ERROR_CODES.REPORT_PRESET_NOT_FOUND,
        });
    });

    it('maps E11000 on save to DUPLICATE_RESOURCE (rename collision)', async () => {
        const doc = makePresetDoc();
        const dupErr = Object.assign(new Error('E11000'), { code: 11000 });
        doc.save.mockRejectedValueOnce(dupErr);
        presetFindOneMock.mockResolvedValueOnce(doc);

        await expect(svc.updatePreset(doc._id as Types.ObjectId, { name: 'taken' }, callerId())).rejects.toMatchObject({
            code: ERROR_CODES.DUPLICATE_RESOURCE,
        });
    });
});

// ─── deletePreset ──────────────────────────────────────────────────────

describe('deletePreset', () => {
    it('returns {deleted: true} on success', async () => {
        presetDeleteOneMock.mockResolvedValueOnce({ deletedCount: 1 });

        const result = await svc.deletePreset(new Types.ObjectId(), callerId());

        expect(result).toEqual({ deleted: true });
    });

    it('REPORT_PRESET_NOT_FOUND when nothing was deleted (unknown id OR cross-user)', async () => {
        presetDeleteOneMock.mockResolvedValueOnce({ deletedCount: 0 });

        await expect(svc.deletePreset(new Types.ObjectId(), callerId())).rejects.toMatchObject({
            code: ERROR_CODES.REPORT_PRESET_NOT_FOUND,
        });
    });

    it('filter must include user_id (anti-enumeration)', async () => {
        const caller = callerId();
        presetDeleteOneMock.mockResolvedValueOnce({ deletedCount: 1 });

        await svc.deletePreset(new Types.ObjectId(), caller);

        const filter = presetDeleteOneMock.mock.calls[0][0] as Record<string, unknown>;
        expect(filter.user_id).toBe(caller);
    });
});
