import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Types } from 'mongoose';

/**
 * Coverage focus for `holiday.service` — the admin-only mutations that
 * drive every user's working-day rollups + leave calculations:
 *
 *   1. `createHoliday` — happy path persists, E11000 surfaces as a
 *      canonical 409 DUPLICATE_RESOURCE, and the I1 audit row is
 *      emitted with the right shape.
 *   2. `bulkCreateHolidays` — pre-check filters duplicates, race
 *      collisions on insertMany are tolerated and surfaced as
 *      `skipped[]`, and (I1) ONE summary audit row is emitted carrying
 *      the inserted items + counts (rather than one row per holiday).
 *   3. `updateHoliday` — happy path saves with before/after diff in
 *      the audit row.
 *   4. `deleteHoliday` — captures the deleted row in the `before` of
 *      the audit so the "what was deleted" forensic recovery works.
 *   5. The audit hook is OPTIONAL — every entry point still works
 *      when no AuditContext is passed (back-compat with legacy callers
 *      that don't have a request handle).
 */

const {
    holidayCreateMock,
    holidayInsertManyMock,
    holidayFindMock,
    holidayFindByIdMock,
    holidayFindByIdAndDeleteMock,
    recordAuditMock,
} = vi.hoisted(() => ({
    holidayCreateMock: vi.fn(),
    holidayInsertManyMock: vi.fn(),
    holidayFindMock: vi.fn(),
    holidayFindByIdMock: vi.fn(),
    holidayFindByIdAndDeleteMock: vi.fn(),
    recordAuditMock: vi.fn(),
}));

vi.mock('../models/holiday.model.js', () => ({
    Holiday: {
        create: holidayCreateMock,
        insertMany: holidayInsertManyMock,
        find: holidayFindMock,
        findById: holidayFindByIdMock,
        findByIdAndDelete: holidayFindByIdAndDeleteMock,
        countDocuments: vi.fn(),
    },
}));

vi.mock('./audit.service.js', () => ({
    recordAudit: recordAuditMock,
    recordSystemAudit: vi.fn(),
}));

const svc = await import('./holiday.service.js');
import { ERROR_CODES } from '../constants/error-codes.js';

const makeAudit = () => ({ actor_id: new Types.ObjectId(), actor_role: 'admin' as const });

const makeHoliday = (overrides: Record<string, unknown> = {}) => {
    const doc = {
        _id: new Types.ObjectId(),
        date: '2026-01-26',
        name: 'Republic Day',
        type: 'public' as const,
        description: '',
        save: vi.fn(),
        toJSON() {
            return {
                id: this._id.toString(),
                date: this.date,
                name: this.name,
                type: this.type,
                description: this.description,
            };
        },
        ...overrides,
    };
    doc.save.mockImplementation(async () => doc);
    return doc;
};

beforeEach(() => {
    vi.resetAllMocks();
});

// ─── createHoliday ────────────────────────────────────────────────────────

describe('createHoliday', () => {
    it('persists and returns the public projection', async () => {
        const doc = makeHoliday();
        holidayCreateMock.mockResolvedValueOnce(doc);

        const result = await svc.createHoliday({ date: '2026-01-26', name: 'Republic Day' }, new Types.ObjectId());

        expect(result).toMatchObject({ date: '2026-01-26', name: 'Republic Day' });
        expect(holidayCreateMock).toHaveBeenCalledTimes(1);
    });

    it('translates Mongo E11000 into 409 DUPLICATE_RESOURCE with the conflict date in details', async () => {
        // The unique index on `date` collides — the service surface must
        // give the FE a canonical code + the date so the toast can say
        // "this date is already on the calendar" without parsing the
        // raw mongo error.
        holidayCreateMock.mockRejectedValueOnce({ code: 11000, keyValue: { date: '2026-01-26' } });

        await expect(
            svc.createHoliday({ date: '2026-01-26', name: 'duplicate' }, new Types.ObjectId())
        ).rejects.toMatchObject({
            code: ERROR_CODES.DUPLICATE_RESOURCE,
            statusCode: 409,
            details: { date: '2026-01-26' },
        });
    });

    it('I1 — emits an audit row with the inserted holiday in `after` when audit ctx is provided', async () => {
        const doc = makeHoliday();
        holidayCreateMock.mockResolvedValueOnce(doc);
        const audit = makeAudit();

        await svc.createHoliday({ date: '2026-01-26', name: 'Republic Day' }, new Types.ObjectId(), audit);

        expect(recordAuditMock).toHaveBeenCalledTimes(1);
        const [ctxArg, payload] = recordAuditMock.mock.calls[0]!;
        expect(ctxArg).toBe(audit);
        expect(payload).toMatchObject({
            action: 'holiday.create',
            target: { kind: 'holiday', id: doc._id },
            after: expect.objectContaining({ date: '2026-01-26', name: 'Republic Day' }),
        });
    });

    it('does NOT call recordAudit when no audit ctx is provided (legacy callers)', async () => {
        holidayCreateMock.mockResolvedValueOnce(makeHoliday());
        await svc.createHoliday({ date: '2026-01-26', name: 'Republic Day' }, new Types.ObjectId());
        expect(recordAuditMock).not.toHaveBeenCalled();
    });
});

// ─── bulkCreateHolidays ───────────────────────────────────────────────────

describe('bulkCreateHolidays', () => {
    it('precheck filters out dates already on the calendar — they appear as `skipped`', async () => {
        // Stage: existing 2026-01-26 in DB. Request inserts 2026-01-26 + 2026-08-15.
        holidayFindMock.mockReturnValueOnce({
            select: () => Promise.resolve([{ date: '2026-01-26' }]),
        });
        const inserted = [makeHoliday({ date: '2026-08-15', name: 'Independence Day' })];
        holidayInsertManyMock.mockResolvedValueOnce(inserted);

        const result = await svc.bulkCreateHolidays(
            {
                items: [
                    { date: '2026-01-26', name: 'Republic Day' },
                    { date: '2026-08-15', name: 'Independence Day' },
                ],
            },
            new Types.ObjectId()
        );

        expect(result.inserted).toHaveLength(1);
        expect(result.inserted[0]).toMatchObject({ date: '2026-08-15' });
        expect(result.skipped).toEqual([{ date: '2026-01-26', reason: 'already_exists' }]);
    });

    it('returns early with empty inserted[] when every requested date already exists', async () => {
        holidayFindMock.mockReturnValueOnce({
            select: () => Promise.resolve([{ date: '2026-01-26' }, { date: '2026-08-15' }]),
        });

        const result = await svc.bulkCreateHolidays(
            {
                items: [
                    { date: '2026-01-26', name: 'A' },
                    { date: '2026-08-15', name: 'B' },
                ],
            },
            new Types.ObjectId()
        );

        // No actual insert performed — important so we don't waste a
        // round-trip with an empty insertMany.
        expect(holidayInsertManyMock).not.toHaveBeenCalled();
        expect(result.inserted).toHaveLength(0);
        expect(result.skipped).toHaveLength(2);
    });

    it('tolerates a race-condition E11000 from insertMany — partial success surfaces as `skipped: race_condition_duplicate`', async () => {
        // Pre-check passed (DB had no overlap), but a concurrent admin
        // slipped 2026-01-26 in between the precheck and the insertMany.
        // BulkWriteError still gives us the rows that DID land via
        // `insertedDocs`; we harvest those + tag the rest as racing
        // duplicates so the operator can see the full picture.
        holidayFindMock.mockReturnValueOnce({
            select: () => Promise.resolve([]),
        });
        const ok = makeHoliday({ date: '2026-08-15' });
        holidayInsertManyMock.mockRejectedValueOnce({
            insertedDocs: [ok],
            writeErrors: [{ err: { op: { date: '2026-01-26' } } }],
        });

        const result = await svc.bulkCreateHolidays(
            {
                items: [
                    { date: '2026-01-26', name: 'A' },
                    { date: '2026-08-15', name: 'B' },
                ],
            },
            new Types.ObjectId()
        );

        expect(result.inserted).toHaveLength(1);
        expect(result.skipped).toContainEqual({ date: '2026-01-26', reason: 'race_condition_duplicate' });
    });

    it('I1 — emits ONE summary audit row carrying inserted items + counts (not one per holiday)', async () => {
        // Pin the "no flooding" property: a 50-row import would otherwise
        // generate 50 audit rows. The collection-level event is
        // `target.id: null` because the bulk write spans many holidays.
        holidayFindMock.mockReturnValueOnce({ select: () => Promise.resolve([]) });
        const items = [makeHoliday({ date: '2026-08-15' }), makeHoliday({ date: '2026-10-02' })];
        holidayInsertManyMock.mockResolvedValueOnce(items);
        const audit = makeAudit();

        await svc.bulkCreateHolidays(
            {
                items: [
                    { date: '2026-08-15', name: 'A' },
                    { date: '2026-10-02', name: 'B' },
                ],
            },
            new Types.ObjectId(),
            audit
        );

        expect(recordAuditMock).toHaveBeenCalledTimes(1);
        const [, payload] = recordAuditMock.mock.calls[0]!;
        expect(payload).toMatchObject({
            action: 'holiday.bulk_create',
            target: { kind: 'holiday', id: null },
            metadata: { inserted_count: 2, skipped_count: 0, requested_count: 2 },
        });
    });

    it('I1 — does NOT emit an audit row when zero holidays were inserted (every requested date already existed)', async () => {
        holidayFindMock.mockReturnValueOnce({
            select: () => Promise.resolve([{ date: '2026-01-26' }]),
        });

        await svc.bulkCreateHolidays({ items: [{ date: '2026-01-26', name: 'A' }] }, new Types.ObjectId(), makeAudit());

        // Empty insert → no state change → nothing to audit.
        expect(recordAuditMock).not.toHaveBeenCalled();
    });
});

// ─── updateHoliday ────────────────────────────────────────────────────────

describe('updateHoliday', () => {
    it('returns 404 when the id is unknown', async () => {
        holidayFindByIdMock.mockResolvedValueOnce(null);
        await expect(svc.updateHoliday(new Types.ObjectId(), { name: 'Renamed' })).rejects.toMatchObject({
            code: ERROR_CODES.RESOURCE_NOT_FOUND,
            statusCode: 404,
        });
    });

    it('applies partial fields and saves; audit row carries before/after diff', async () => {
        const doc = makeHoliday({ name: 'Old', type: 'public', description: '' });
        holidayFindByIdMock.mockResolvedValueOnce(doc);
        const audit = makeAudit();

        await svc.updateHoliday(doc._id, { name: 'New', type: 'optional', description: 'Regional — see HR' }, audit);

        expect(doc.save).toHaveBeenCalledTimes(1);
        const [, payload] = recordAuditMock.mock.calls[0]!;
        expect(payload).toMatchObject({
            action: 'holiday.update',
            target: { kind: 'holiday', id: doc._id },
            before: expect.objectContaining({ name: 'Old', type: 'public', description: '' }),
            after: expect.objectContaining({
                name: 'New',
                type: 'optional',
                description: 'Regional — see HR',
            }),
        });
    });

    it('translates a save-time E11000 (date collision) into 409 DUPLICATE_RESOURCE', async () => {
        const doc = makeHoliday();
        holidayFindByIdMock.mockResolvedValueOnce(doc);
        doc.save.mockRejectedValueOnce({ code: 11000, keyValue: { date: '2026-01-26' } });

        await expect(svc.updateHoliday(doc._id, { date: '2026-01-26' })).rejects.toMatchObject({
            code: ERROR_CODES.DUPLICATE_RESOURCE,
            statusCode: 409,
        });
    });
});

// ─── deleteHoliday ────────────────────────────────────────────────────────

describe('deleteHoliday', () => {
    it('returns 404 when the id is unknown', async () => {
        holidayFindByIdAndDeleteMock.mockResolvedValueOnce(null);
        await expect(svc.deleteHoliday(new Types.ObjectId())).rejects.toMatchObject({
            code: ERROR_CODES.RESOURCE_NOT_FOUND,
            statusCode: 404,
        });
    });

    it('audit row captures the deleted row in `before` (forensic recovery)', async () => {
        // The audit's `before` is the only place the deleted holiday's
        // data survives. Pin that we capture it.
        const doc = makeHoliday({ name: 'About-to-be-deleted', date: '2026-12-25' });
        holidayFindByIdAndDeleteMock.mockResolvedValueOnce(doc);
        const audit = makeAudit();

        await svc.deleteHoliday(doc._id, audit);

        const [, payload] = recordAuditMock.mock.calls[0]!;
        expect(payload).toMatchObject({
            action: 'holiday.delete',
            target: { kind: 'holiday', id: doc._id },
            before: expect.objectContaining({ name: 'About-to-be-deleted', date: '2026-12-25' }),
        });
    });
});
