import { describe, expect, it } from 'vitest';

import {
    createReportSubscriptionBodySchema,
    listReportSubscriptionsQuerySchema,
    patchReportSubscriptionBodySchema,
} from './report-subscription.validator.js';

const baseBody = (overrides: Record<string, unknown> = {}) => ({
    name: 'Weekly billing',
    report_name: 'billing',
    filters: { project_id: 'a'.repeat(24), from_date: '2026-04-01', to_date: '2026-04-30' },
    day_of_week: 1,
    ...overrides,
});

describe('createReportSubscriptionBodySchema', () => {
    it('accepts a valid body and applies hour_local + is_active defaults', () => {
        const parsed = createReportSubscriptionBodySchema.parse(baseBody());
        expect(parsed.hour_local).toBe(7); // default
        expect(parsed.is_active).toBe(true); // default
    });

    it('rejects day_of_week < 0 or > 6', () => {
        expect(createReportSubscriptionBodySchema.safeParse(baseBody({ day_of_week: -1 })).success).toBe(false);
        expect(createReportSubscriptionBodySchema.safeParse(baseBody({ day_of_week: 7 })).success).toBe(false);
    });

    it('rejects hour_local out of [0, 23]', () => {
        expect(createReportSubscriptionBodySchema.safeParse(baseBody({ hour_local: -1 })).success).toBe(false);
        expect(createReportSubscriptionBodySchema.safeParse(baseBody({ hour_local: 24 })).success).toBe(false);
    });

    it('rejects extra top-level keys via .strict()', () => {
        expect(createReportSubscriptionBodySchema.safeParse({ ...baseBody(), foo: 'no' }).success).toBe(false);
    });

    it('rejects unknown report_name', () => {
        expect(createReportSubscriptionBodySchema.safeParse(baseBody({ report_name: 'bogus' })).success).toBe(false);
    });
});

describe('patchReportSubscriptionBodySchema', () => {
    it('accepts each subset (name / filters / schedule / is_active)', () => {
        expect(patchReportSubscriptionBodySchema.safeParse({ name: 'New' }).success).toBe(true);
        expect(patchReportSubscriptionBodySchema.safeParse({ filters: {} }).success).toBe(true);
        expect(patchReportSubscriptionBodySchema.safeParse({ day_of_week: 5 }).success).toBe(true);
        expect(patchReportSubscriptionBodySchema.safeParse({ is_active: false }).success).toBe(true);
    });

    it('rejects an empty patch (no fields to update)', () => {
        expect(patchReportSubscriptionBodySchema.safeParse({}).success).toBe(false);
    });

    it('rejects report_name in the patch (locked at creation)', () => {
        expect(patchReportSubscriptionBodySchema.safeParse({ name: 'x', report_name: 'leaves' }).success).toBe(false);
    });
});

describe('listReportSubscriptionsQuerySchema', () => {
    it('coerces is_active from "true"/"false" strings', () => {
        expect(listReportSubscriptionsQuerySchema.parse({ is_active: 'true' }).is_active).toBe(true);
        expect(listReportSubscriptionsQuerySchema.parse({ is_active: 'false' }).is_active).toBe(false);
    });

    it('caps limit at 100', () => {
        expect(listReportSubscriptionsQuerySchema.safeParse({ limit: 101 }).success).toBe(false);
    });

    it('rejects extra keys via .strict()', () => {
        expect(listReportSubscriptionsQuerySchema.safeParse({ malicious: 1 }).success).toBe(false);
    });
});
