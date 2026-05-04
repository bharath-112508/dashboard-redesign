import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { parseExportBody } from './report-export.validator.js';

/**
 * Validator-dispatch tests (Step 30 final-check).
 *
 * `parseExportBody` is the per-name dispatcher that backs the
 * `POST /reports/:name/export` body validation. The controller catches
 * its `ZodError` and converts to `AppError.validation` — these tests
 * lock in the contract that:
 *
 *  1. Each report name accepts its own filter shape (the same shape the
 *     synchronous GET endpoint validates) verbatim.
 *  2. Cross-name filter shapes are rejected (e.g. billing filters under
 *     leaves throws ZodError).
 *  3. Format enum is enforced.
 *
 * These are the precise behaviours the global error handler relies on
 * the controller to translate into 400 VALIDATION_ERROR; the controller
 * test covers the conversion path, this file covers the parse contract.
 */

const validBillingBody = () => ({
    format: 'csv' as const,
    filters: {
        project_id: 'a'.repeat(24),
        from_date: '2026-04-01',
        to_date: '2026-04-30',
    },
});

const validLeavesBody = () => ({
    format: 'xlsx' as const,
    filters: { year: 2026 },
});

describe('parseExportBody', () => {
    it('accepts a valid billing body and returns the parsed (defaulted) shape', () => {
        const parsed = parseExportBody('billing', validBillingBody());
        expect(parsed.format).toBe('csv');
        expect((parsed.filters as { group_by: string }).group_by).toBe('employee'); // schema default
    });

    it('accepts pdf format (validator forward-compat — worker fails it later)', () => {
        const parsed = parseExportBody('billing', { ...validBillingBody(), format: 'pdf' });
        expect(parsed.format).toBe('pdf');
    });

    it('throws ZodError for an unknown format value', () => {
        expect(() => parseExportBody('billing', { ...validBillingBody(), format: 'docx' as unknown })).toThrowError(
            z.ZodError
        );
    });

    it('throws ZodError when billing filters are submitted under the leaves report (cross-name shape)', () => {
        expect(() => parseExportBody('leaves', { format: 'csv', filters: validBillingBody().filters })).toThrowError(
            z.ZodError
        );
    });

    it('rejects extra top-level keys via .strict()', () => {
        expect(() => parseExportBody('billing', { ...validBillingBody(), extra: 'nope' })).toThrowError(z.ZodError);
    });

    it('accepts a valid leaves body with the year-only filter shape', () => {
        const parsed = parseExportBody('leaves', validLeavesBody());
        expect(parsed.format).toBe('xlsx');
        expect((parsed.filters as { year: number }).year).toBe(2026);
    });

    it('rejects a leaves body with a date-range filter (wrong shape for this report)', () => {
        expect(() =>
            parseExportBody('leaves', {
                format: 'csv',
                filters: { from_date: '2026-04-01', to_date: '2026-04-30' },
            })
        ).toThrowError(z.ZodError);
    });
});
