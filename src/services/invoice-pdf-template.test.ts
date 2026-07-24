import { describe, expect, it } from 'vitest';

import { buildInvoiceHtml, type InvoicePdfCompany, type InvoicePdfInvoice } from './invoice-pdf-template.js';
import type { PayrollSettings } from '../models/system-settings.model.js';

/**
 * Unit tests for `buildInvoiceHtml` — pure string builder, no Chromium
 * needed. Verifies the rendered HTML contains the expected data points and
 * that user-provided strings are HTML-escaped (XSS defence — the invoice
 * `notes` field and the client company `name` are free text).
 */

const settings: PayrollSettings = {
    company_legal_name: 'M/S VILJA TECH LABS PRIVATE LIMITED',
    company_address_lines: ['221B Baker Street', 'London, UK'],
    company_email: 'hello@viljetech.com',
    cin_no: 'U12345KA2020PTC000000',
    iec_code: 'IEC0001',
    signatory_name: 'Jane Doe',
    signatory_title: 'Human Resources',
    hr_reply_to_address: 'hr@viljetech.com',
    hr_reply_to_name: 'HR Team',
};

const baseInvoice: InvoicePdfInvoice = {
    number: 'INV-2026-0007',
    status: 'sent',
    currency: 'EUR',
    period_start: '2026-06-01',
    period_end: '2026-06-30',
    issue_date: '2026-07-01',
    due_date: '2026-07-15',
    line_items: [
        {
            kind: 'retainer',
            description: 'Retainer (monthly)',
            quantity_minutes: null,
            rate: null,
            amount: 2000,
        },
        {
            kind: 'overage',
            description: 'Overage (12.00h over 40h included)',
            quantity_minutes: 720,
            rate: 50,
            amount: 600,
        },
        {
            kind: 'setup',
            description: 'Setup fee',
            quantity_minutes: null,
            rate: null,
            amount: 500,
        },
    ],
    subtotal: 3100,
    tax_rate: 18,
    tax_label: 'IGST',
    tax_amount: 558,
    total: 3658,
    notes: 'Thank you for your business.',
};

const company: InvoicePdfCompany = { name: 'Acme Corp' };

describe('buildInvoiceHtml', () => {
    it('includes the invoice number', () => {
        const html = buildInvoiceHtml(baseInvoice, company, settings);
        expect(html).toContain('INV-2026-0007');
    });

    it('includes the client company name', () => {
        const html = buildInvoiceHtml(baseInvoice, company, settings);
        expect(html).toContain('Acme Corp');
    });

    it('includes each line item description', () => {
        const html = buildInvoiceHtml(baseInvoice, company, settings);
        expect(html).toContain('Retainer (monthly)');
        expect(html).toContain('Overage (12.00h over 40h included)');
        expect(html).toContain('Setup fee');
    });

    it('formats hours from quantity_minutes for hours/overage lines', () => {
        const html = buildInvoiceHtml(baseInvoice, company, settings);
        expect(html).toContain('12.00'); // 720 minutes -> 12.00h
    });

    it('formats money using the invoice currency (EUR), not a hardcoded symbol', () => {
        const html = buildInvoiceHtml(baseInvoice, company, settings);
        expect(html).toMatch(/€\s?3,658\.00|EUR\s?3,658\.00/);
        expect(html).not.toContain('₹');
        expect(html).not.toMatch(/\$3,658\.00/);
    });

    it('includes the tax label and tax rate', () => {
        const html = buildInvoiceHtml(baseInvoice, company, settings);
        expect(html).toContain('IGST');
        expect(html).toContain('18');
    });

    it('includes the formatted total', () => {
        const html = buildInvoiceHtml(baseInvoice, company, settings);
        expect(html).toMatch(/3,658\.00/);
    });

    it('includes notes when present', () => {
        const html = buildInvoiceHtml(baseInvoice, company, settings);
        expect(html).toContain('Thank you for your business.');
    });

    it('omits the notes section when notes is empty', () => {
        const html = buildInvoiceHtml({ ...baseInvoice, notes: '' }, company, settings);
        expect(html).not.toContain('<h3>Notes</h3>');
    });

    it('includes the seller letterhead from settings.payroll', () => {
        const html = buildInvoiceHtml(baseInvoice, company, settings);
        expect(html).toContain('M/S VILJA TECH LABS PRIVATE LIMITED');
        expect(html).toContain('hello@viljetech.com');
        expect(html).toContain('U12345KA2020PTC000000');
        expect(html).toContain('IEC0001');
    });

    it('escapes an HTML-injection string in notes', () => {
        const html = buildInvoiceHtml({ ...baseInvoice, notes: '<script>alert(1)</script>' }, company, settings);
        expect(html).not.toContain('<script>alert(1)</script>');
        expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    });

    it('escapes an HTML-injection string in the client company name', () => {
        const html = buildInvoiceHtml(baseInvoice, { name: '<img src=x onerror=alert(1)>' }, settings);
        expect(html).not.toContain('<img src=x onerror=alert(1)>');
        expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    });

    it('escapes an HTML-injection string in a line item description', () => {
        const html = buildInvoiceHtml(
            {
                ...baseInvoice,
                line_items: [
                    {
                        kind: 'manual',
                        description: '<b>bold</b> & "quoted"',
                        quantity_minutes: null,
                        rate: null,
                        amount: 100,
                    },
                ],
            },
            company,
            settings
        );
        expect(html).not.toContain('<b>bold</b>');
        expect(html).toContain('&lt;b&gt;bold&lt;/b&gt; &amp; &quot;quoted&quot;');
    });

    it('escapes an HTML-injection string in the currency fallback', () => {
        // `Intl.NumberFormat` throws for any currency that isn't 3
        // alphabetic chars, so a malformed `Invoice.currency` (only
        // reachable via a direct DB write / pre-validation legacy row —
        // `Engagement.currency` validation is letter-only as of this fix)
        // falls back to the raw-string formatter. That fallback must escape
        // `currency` like every other user string in this template.
        const html = buildInvoiceHtml({ ...baseInvoice, currency: 'X"<' }, company, settings);
        expect(html).not.toContain('X"<');
        expect(html).toContain('X&quot;&lt;');
    });

    it('shows the invoice status', () => {
        const html = buildInvoiceHtml({ ...baseInvoice, status: 'paid' }, company, settings);
        expect(html).toContain('Paid');
    });

    it('shows an em-dash for a missing company name rather than crashing', () => {
        const html = buildInvoiceHtml(baseInvoice, { name: null }, settings);
        expect(html).toContain('—');
    });
});
