import { describe, it, expect } from 'vitest';

import { Invoice, INVOICE_STATUSES, LINE_KINDS } from './invoice.model.js';

describe('Invoice model', () => {
    it('exposes the status enum and line-item kinds', () => {
        expect(INVOICE_STATUSES).toEqual(['draft', 'sent', 'paid', 'void']);
        expect(LINE_KINDS).toEqual(['hours', 'retainer', 'setup', 'overage', 'fixed', 'manual']);
    });

    it("defaults status to draft, tax_rate to 0, tax_label to '', and line_items to []", () => {
        const inv = new Invoice({
            number: 'INV-2026-0001',
            company_id: '6a32a6d1fae64e468a3dc592',
            engagement_id: '6a32a6d1fae64e468a3dc593',
            period_start: '2026-07-01',
            period_end: '2026-07-31',
            currency: 'EUR',
            subtotal: 0,
            tax_amount: 0,
            total: 0,
            created_by: '6a32a6d1fae64e468a3dc592',
        });

        expect(inv.status).toBe('draft');
        expect(inv.tax_rate).toBe(0);
        expect(inv.tax_label).toBe('');
        expect(inv.line_items).toEqual([]);
        expect(inv.project_ids).toEqual([]);
        expect(inv.notes).toBe('');
        expect(inv.issue_date).toBeNull();
        expect(inv.due_date).toBeNull();
        expect(inv.paid_date).toBeNull();
    });

    it('requires kind, description, and amount on a line item', () => {
        const inv = new Invoice({
            number: 'INV-2026-0002',
            company_id: '6a32a6d1fae64e468a3dc592',
            engagement_id: '6a32a6d1fae64e468a3dc593',
            period_start: '2026-07-01',
            period_end: '2026-07-31',
            currency: 'EUR',
            line_items: [{}],
            subtotal: 0,
            tax_amount: 0,
            total: 0,
            created_by: '6a32a6d1fae64e468a3dc592',
        });

        const err = inv.validateSync();
        expect(err).toBeDefined();
        expect(err?.errors['line_items.0.kind']).toBeDefined();
        expect(err?.errors['line_items.0.description']).toBeDefined();
        expect(err?.errors['line_items.0.amount']).toBeDefined();
    });

    it('accepts a fully-populated line item and allows a negative amount (discount)', () => {
        const inv = new Invoice({
            number: 'INV-2026-0003',
            company_id: '6a32a6d1fae64e468a3dc592',
            engagement_id: '6a32a6d1fae64e468a3dc593',
            period_start: '2026-07-01',
            period_end: '2026-07-31',
            currency: 'EUR',
            line_items: [
                {
                    kind: 'hours',
                    description: 'Dev work',
                    user_id: '6a32a6d1fae64e468a3dc594',
                    quantity_minutes: 120,
                    rate: 50,
                    amount: 100,
                },
                {
                    kind: 'manual',
                    description: 'Loyalty discount',
                    amount: -25,
                },
            ],
            subtotal: 75,
            tax_amount: 0,
            total: 75,
            created_by: '6a32a6d1fae64e468a3dc592',
        });

        const err = inv.validateSync();
        expect(err).toBeUndefined();
        expect(inv.line_items).toHaveLength(2);
        expect(inv.line_items[1].amount).toBe(-25);
        expect(inv.line_items[0].user_id?.toString()).toBe('6a32a6d1fae64e468a3dc594');
    });
});
