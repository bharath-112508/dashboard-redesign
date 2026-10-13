import { describe, it, expect } from 'vitest';

import { createCostRateSchema, updateCostRateSchema, listCostRatesQuerySchema } from './cost-rate.validator.js';

const base = {
    user_id: 'a'.repeat(24),
    cost_per_hour: 500,
    currency: 'INR',
    effective_from: '2026-07-01',
};

describe('createCostRateSchema', () => {
    it('accepts a minimal valid payload', () => {
        expect(createCostRateSchema.safeParse(base).success).toBe(true);
    });

    it('rejects a missing user_id', () => {
        const { user_id: _user_id, ...rest } = base;
        expect(createCostRateSchema.safeParse(rest).success).toBe(false);
    });

    it('rejects a missing cost_per_hour', () => {
        const { cost_per_hour: _cost_per_hour, ...rest } = base;
        expect(createCostRateSchema.safeParse(rest).success).toBe(false);
    });

    it('rejects a missing currency', () => {
        const { currency: _currency, ...rest } = base;
        expect(createCostRateSchema.safeParse(rest).success).toBe(false);
    });

    it('rejects a missing effective_from', () => {
        const { effective_from: _effective_from, ...rest } = base;
        expect(createCostRateSchema.safeParse(rest).success).toBe(false);
    });

    it('rejects a negative cost_per_hour', () => {
        expect(createCostRateSchema.safeParse({ ...base, cost_per_hour: -1 }).success).toBe(false);
    });

    it('rejects a non-letter currency code', () => {
        expect(createCostRateSchema.safeParse({ ...base, currency: '12<' }).success).toBe(false);
    });

    it('accepts effective_to on or after effective_from', () => {
        expect(createCostRateSchema.safeParse({ ...base, effective_to: '2026-12-31' }).success).toBe(true);
    });

    it('rejects effective_to before effective_from', () => {
        expect(createCostRateSchema.safeParse({ ...base, effective_to: '2026-06-01' }).success).toBe(false);
    });

    it('defaults effective_to to null when omitted', () => {
        const parsed = createCostRateSchema.parse(base);
        expect(parsed.effective_to).toBeNull();
    });
});

describe('updateCostRateSchema', () => {
    it('accepts a cost_per_hour-only patch', () => {
        expect(updateCostRateSchema.safeParse({ cost_per_hour: 600 }).success).toBe(true);
    });

    it('accepts an effective_to-only patch, including null', () => {
        expect(updateCostRateSchema.safeParse({ effective_to: '2026-12-31' }).success).toBe(true);
        expect(updateCostRateSchema.safeParse({ effective_to: null }).success).toBe(true);
    });

    it('rejects an empty patch', () => {
        expect(updateCostRateSchema.safeParse({}).success).toBe(false);
    });

    it('rejects an unknown field', () => {
        expect(updateCostRateSchema.safeParse({ currency: 'USD' }).success).toBe(false);
    });
});

describe('listCostRatesQuerySchema', () => {
    it('applies pagination defaults', () => {
        const parsed = listCostRatesQuerySchema.parse({});
        expect(parsed.page).toBe(1);
        expect(parsed.limit).toBe(20);
    });

    it('accepts user_id and active_on filters', () => {
        expect(listCostRatesQuerySchema.safeParse({ user_id: 'a'.repeat(24), active_on: '2026-07-15' }).success).toBe(
            true
        );
    });

    it('rejects a limit above the max', () => {
        expect(listCostRatesQuerySchema.safeParse({ limit: '101' }).success).toBe(false);
    });
});
