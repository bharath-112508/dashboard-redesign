import { describe, it, expect } from 'vitest';
import { Engagement, BILLING_TYPES } from './engagement.model.js';

describe('Engagement model', () => {
    it('exposes the billing types', () => {
        expect(BILLING_TYPES).toEqual(['hourly', 'retainer', 'fixed', 'hybrid']);
    });
    it('defaults project_ids to [] and status to active', () => {
        const e = new Engagement({
            company_id: '6a32a6d1fae64e468a3dc592',
            name: 'Test',
            currency: 'EUR',
            billing_type: 'hourly',
            start_date: '2026-07-01',
            created_by: '6a32a6d1fae64e468a3dc592',
        });
        expect(e.project_ids).toEqual([]);
        expect(e.status).toBe('active');
        expect(e.setup_fee_invoiced).toBe(false);
    });
});
