import { describe, expect, it } from 'vitest';

import {
    createReportPresetBodySchema,
    listReportPresetsQuerySchema,
    patchReportPresetBodySchema,
} from './report-preset.validator.js';

/**
 * Validator tests for `/report-presets/*` (Phase 4 Step 42).
 *
 * Per-report-name `filters` validation lives in the service layer
 * (`parsePresetFilters`); these tests cover the OUTER body shape that
 * the route's `validate({body})` middleware enforces — name length,
 * report_name enum, present-but-empty-shape filters object, etc.
 */

const validBody = (overrides: Record<string, unknown> = {}) => ({
    name: 'Monthly billing — Apollo',
    report_name: 'billing',
    filters: { project_id: 'a'.repeat(24), from_date: '2026-04-01', to_date: '2026-04-30' },
    ...overrides,
});

describe('createReportPresetBodySchema', () => {
    it('accepts a valid body', () => {
        expect(createReportPresetBodySchema.safeParse(validBody()).success).toBe(true);
    });

    it('rejects an empty name', () => {
        expect(createReportPresetBodySchema.safeParse(validBody({ name: '   ' })).success).toBe(false);
    });

    it('rejects a name > 100 chars', () => {
        expect(createReportPresetBodySchema.safeParse(validBody({ name: 'x'.repeat(101) })).success).toBe(false);
    });

    it('rejects an unknown report_name', () => {
        expect(createReportPresetBodySchema.safeParse(validBody({ report_name: 'bogus' })).success).toBe(false);
    });

    it('rejects extra top-level keys via .strict()', () => {
        expect(createReportPresetBodySchema.safeParse({ ...validBody(), extra: 'no' }).success).toBe(false);
    });
});

describe('patchReportPresetBodySchema', () => {
    it('accepts a name-only patch', () => {
        expect(patchReportPresetBodySchema.safeParse({ name: 'New' }).success).toBe(true);
    });

    it('accepts a filters-only patch', () => {
        expect(patchReportPresetBodySchema.safeParse({ filters: {} }).success).toBe(true);
    });

    it('rejects an empty patch (no fields to update)', () => {
        expect(patchReportPresetBodySchema.safeParse({}).success).toBe(false);
    });

    it('rejects report_name in the patch (locked at creation)', () => {
        expect(patchReportPresetBodySchema.safeParse({ name: 'x', report_name: 'leaves' }).success).toBe(false);
    });
});

describe('listReportPresetsQuerySchema', () => {
    it('accepts an empty query (defaults page=1, limit=20)', () => {
        const parsed = listReportPresetsQuerySchema.parse({});
        expect(parsed.page).toBe(1);
        expect(parsed.limit).toBe(20);
    });

    it('accepts an optional report_name filter', () => {
        expect(listReportPresetsQuerySchema.safeParse({ report_name: 'utilization' }).success).toBe(true);
    });

    it('caps limit at 100', () => {
        expect(listReportPresetsQuerySchema.safeParse({ limit: 101 }).success).toBe(false);
    });

    it('rejects extra keys via .strict()', () => {
        expect(listReportPresetsQuerySchema.safeParse({ malicious: 1 }).success).toBe(false);
    });
});
