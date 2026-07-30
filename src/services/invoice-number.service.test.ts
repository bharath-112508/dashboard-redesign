import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * Unit tests for `invoice-number.service` (Task 5, Phase 1 billing).
 *
 * `InvoiceCounter.findOneAndUpdate` is mocked to emulate Mongo's atomic
 * `$inc: { seq: 1 }` — a per-year in-memory counter that increments on
 * every call, independent of insertion order across years.
 */

const { findOneAndUpdateMock } = vi.hoisted(() => ({
    findOneAndUpdateMock: vi.fn(),
}));

vi.mock('../models/invoice-counter.model.js', () => ({
    InvoiceCounter: {
        findOneAndUpdate: findOneAndUpdateMock,
    },
}));

import { nextInvoiceNumber } from './invoice-number.service.js';

describe('nextInvoiceNumber', () => {
    const seqByYear = new Map<number, number>();

    beforeEach(() => {
        seqByYear.clear();
        findOneAndUpdateMock.mockReset();
        findOneAndUpdateMock.mockImplementation((filter: { year: number }) => {
            const nextSeq = (seqByYear.get(filter.year) ?? 0) + 1;
            seqByYear.set(filter.year, nextSeq);
            return {
                lean: () => Promise.resolve({ seq: nextSeq }),
            };
        });
    });

    it('increments sequentially within the same year', async () => {
        const first = await nextInvoiceNumber(2026);
        const second = await nextInvoiceNumber(2026);

        expect(first).toBe('INV-2026-0001');
        expect(second).toBe('INV-2026-0002');
    });

    it('restarts at 0001 for a different year', async () => {
        await nextInvoiceNumber(2026);
        await nextInvoiceNumber(2026);
        const nextYear = await nextInvoiceNumber(2027);

        expect(nextYear).toBe('INV-2027-0001');
    });

    it('honours a custom prefix', async () => {
        const result = await nextInvoiceNumber(2026, 'QUO');

        expect(result).toBe('QUO-2026-0001');
    });

    it('calls findOneAndUpdate with the atomic $inc + upsert options', async () => {
        await nextInvoiceNumber(2026);

        expect(findOneAndUpdateMock).toHaveBeenCalledWith(
            { year: 2026 },
            { $inc: { seq: 1 } },
            expect.objectContaining({ upsert: true, new: true, setDefaultsOnInsert: true })
        );
    });
});
