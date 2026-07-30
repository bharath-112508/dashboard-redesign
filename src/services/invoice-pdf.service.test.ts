import { describe, expect, it, vi, beforeEach } from 'vitest';

const { getInvoiceMock, getOrInitSettingsMock, htmlToPdfMock, buildInvoiceHtmlMock } = vi.hoisted(() => ({
    getInvoiceMock: vi.fn(),
    getOrInitSettingsMock: vi.fn(),
    htmlToPdfMock: vi.fn(),
    buildInvoiceHtmlMock: vi.fn(),
}));

vi.mock('./invoice.service.js', () => ({ getInvoice: getInvoiceMock }));
vi.mock('./settings.service.js', () => ({ getOrInitSettings: getOrInitSettingsMock }));
vi.mock('./payroll/pdf.service.js', () => ({ htmlToPdf: htmlToPdfMock }));
vi.mock('./invoice-pdf-template.js', () => ({ buildInvoiceHtml: buildInvoiceHtmlMock }));

import { Types } from 'mongoose';
import { renderInvoicePdf } from './invoice-pdf.service.js';

/**
 * Unit tests for `invoice-pdf.service.ts` — thin wiring only. The HTML→PDF
 * pixel render itself needs Chromium (not available in CI/sandbox), so this
 * mocks `htmlToPdf` and only asserts the service loads the right data and
 * calls the builder/renderer with it.
 */

describe('renderInvoicePdf', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('loads the invoice + settings, builds HTML, renders a PDF, and returns {buffer, filename}', async () => {
        const invoiceId = new Types.ObjectId();
        const invoice = {
            _id: invoiceId.toString(),
            number: 'INV-2026-0012',
            status: 'draft',
            currency: 'USD',
            company: { id: 'company-1', name: 'Acme Corp' },
            engagement: { id: 'engagement-1', name: 'Acme Retainer' },
            line_items: [],
            subtotal: 0,
            tax_rate: 0,
            tax_label: 'No tax',
            tax_amount: 0,
            total: 0,
            notes: '',
        };
        const settings = { payroll: { company_legal_name: 'Viljetech', company_address_lines: [] } };

        getInvoiceMock.mockResolvedValue(invoice);
        getOrInitSettingsMock.mockResolvedValue(settings);
        buildInvoiceHtmlMock.mockReturnValue('<html>fake</html>');
        htmlToPdfMock.mockResolvedValue(Buffer.from('%PDF-1.7 fake'));

        const result = await renderInvoicePdf(invoiceId);

        expect(getInvoiceMock).toHaveBeenCalledWith(invoiceId);
        expect(getOrInitSettingsMock).toHaveBeenCalledOnce();
        expect(buildInvoiceHtmlMock).toHaveBeenCalledWith(invoice, invoice.company, settings.payroll);
        expect(htmlToPdfMock).toHaveBeenCalledWith('<html>fake</html>');
        expect(result).toEqual({ buffer: Buffer.from('%PDF-1.7 fake'), filename: 'INV-2026-0012.pdf' });
    });

    it('propagates INVOICE_NOT_FOUND from getInvoice without calling settings/renderer', async () => {
        const invoiceId = new Types.ObjectId();
        const notFound = new Error('Invoice not found');
        getInvoiceMock.mockRejectedValue(notFound);

        await expect(renderInvoicePdf(invoiceId)).rejects.toThrow('Invoice not found');
        expect(getOrInitSettingsMock).not.toHaveBeenCalled();
        expect(htmlToPdfMock).not.toHaveBeenCalled();
    });
});
