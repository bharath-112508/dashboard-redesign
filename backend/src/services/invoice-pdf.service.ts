import type { Types } from 'mongoose';

import { getInvoice } from './invoice.service.js';
import { getOrInitSettings } from './settings.service.js';
import { htmlToPdf } from './payroll/pdf.service.js';
import { buildInvoiceHtml, type InvoicePdfCompany, type InvoicePdfInvoice } from './invoice-pdf-template.js';

/**
 * Invoice PDF render service — `GET /invoices/:id/pdf`.
 *
 * Thin by design: loads the invoice (already hydrated with `company` +
 * `engagement` via `invoice.service.ts#getInvoice`, which throws
 * `INVOICE_NOT_FOUND` when missing — no need to duplicate that check here),
 * loads the seller letterhead from `SystemSettings.payroll`, builds the HTML
 * string (`invoice-pdf-template.ts`, unit-testable without Chromium), then
 * rasterises it via the shared headless-Chromium renderer
 * (`services/payroll/pdf.service.ts#htmlToPdf` — reused as-is, no second
 * renderer).
 *
 * No blob storage: invoices are immutable snapshots once persisted
 * (`models/invoice.model.ts`), so regenerating the PDF on every download is
 * deterministic and cheap enough to skip the storage round-trip.
 */

export interface RenderedInvoicePdf {
    buffer: Buffer;
    filename: string;
}

export const renderInvoicePdf = async (id: Types.ObjectId): Promise<RenderedInvoicePdf> => {
    const invoice = await getInvoice(id);
    const settings = await getOrInitSettings();

    const company = invoice.company as InvoicePdfCompany;
    const html = buildInvoiceHtml(invoice as unknown as InvoicePdfInvoice, company, settings.payroll);
    const buffer = await htmlToPdf(html);

    return { buffer, filename: `${invoice.number as string}.pdf` };
};
