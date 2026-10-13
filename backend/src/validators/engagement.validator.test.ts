import { describe, it, expect } from 'vitest';

import { createEngagementSchema } from './engagement.validator.js';

const base = { company_id: 'a'.repeat(24), name: 'X', currency: 'EUR', start_date: '2026-07-01' };

describe('createEngagementSchema', () => {
    it('accepts a minimal hourly engagement', () => {
        expect(createEngagementSchema.safeParse({ ...base, billing_type: 'hourly' }).success).toBe(true);
    });
    it('rejects a retainer with no amount/period', () => {
        expect(createEngagementSchema.safeParse({ ...base, billing_type: 'retainer' }).success).toBe(false);
    });
    it('accepts a retainer with amount + period', () => {
        expect(
            createEngagementSchema.safeParse({
                ...base,
                billing_type: 'retainer',
                retainer_amount: 1000,
                retainer_period: 'month',
            }).success
        ).toBe(true);
    });
    it('rejects a fixed engagement with no fixed_amount', () => {
        expect(createEngagementSchema.safeParse({ ...base, billing_type: 'fixed' }).success).toBe(false);
    });
    it('rejects end_date before start_date', () => {
        expect(
            createEngagementSchema.safeParse({ ...base, billing_type: 'hourly', end_date: '2026-06-01' }).success
        ).toBe(false);
    });
    it('rejects a non-letter currency code', () => {
        expect(createEngagementSchema.safeParse({ ...base, billing_type: 'hourly', currency: '12<' }).success).toBe(
            false
        );
    });
    it('accepts a lowercase currency code', () => {
        expect(createEngagementSchema.safeParse({ ...base, billing_type: 'hourly', currency: 'eur' }).success).toBe(
            true
        );
    });
    it('accepts an uppercase currency code', () => {
        expect(createEngagementSchema.safeParse({ ...base, billing_type: 'hourly', currency: 'EUR' }).success).toBe(
            true
        );
    });
});
