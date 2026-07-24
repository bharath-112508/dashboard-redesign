import { describe, it, expect } from 'vitest';

import { CostRate } from './cost-rate.model.js';

describe('CostRate model', () => {
    it('defaults effective_to to null', () => {
        const r = new CostRate({
            user_id: '6a32a6d1fae64e468a3dc592',
            cost_per_hour: 500,
            currency: 'INR',
            effective_from: '2026-07-01',
            created_by: '6a32a6d1fae64e468a3dc592',
        });

        expect(r.effective_to).toBeNull();
    });

    it('uppercases currency', () => {
        const r = new CostRate({
            user_id: '6a32a6d1fae64e468a3dc592',
            cost_per_hour: 500,
            currency: 'inr',
            effective_from: '2026-07-01',
            created_by: '6a32a6d1fae64e468a3dc592',
        });

        expect(r.currency).toBe('INR');
    });

    it('requires user_id, cost_per_hour, currency, effective_from, and created_by', () => {
        const r = new CostRate({});

        const err = r.validateSync();
        expect(err).toBeDefined();
        expect(err?.errors.user_id).toBeDefined();
        expect(err?.errors.cost_per_hour).toBeDefined();
        expect(err?.errors.currency).toBeDefined();
        expect(err?.errors.effective_from).toBeDefined();
        expect(err?.errors.created_by).toBeDefined();
    });

    it('rejects a negative cost_per_hour', () => {
        const r = new CostRate({
            user_id: '6a32a6d1fae64e468a3dc592',
            cost_per_hour: -1,
            currency: 'INR',
            effective_from: '2026-07-01',
            created_by: '6a32a6d1fae64e468a3dc592',
        });

        const err = r.validateSync();
        expect(err?.errors.cost_per_hour).toBeDefined();
    });

    it('rejects a malformed effective_from', () => {
        const r = new CostRate({
            user_id: '6a32a6d1fae64e468a3dc592',
            cost_per_hour: 500,
            currency: 'INR',
            effective_from: '07-01-2026',
            created_by: '6a32a6d1fae64e468a3dc592',
        });

        const err = r.validateSync();
        expect(err?.errors.effective_from).toBeDefined();
    });

    it('accepts a fully-populated valid document', () => {
        const r = new CostRate({
            user_id: '6a32a6d1fae64e468a3dc592',
            cost_per_hour: 500,
            currency: 'INR',
            effective_from: '2026-07-01',
            effective_to: '2026-12-31',
            created_by: '6a32a6d1fae64e468a3dc592',
        });

        const err = r.validateSync();
        expect(err).toBeUndefined();
    });
});
