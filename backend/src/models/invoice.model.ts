import { Schema, Types, model, type Document, type Model } from 'mongoose';

import { BASE_SCHEMA_OPTIONS } from './_base.js';
import { COLLECTIONS } from '../constants/collections.js';

/**
 * `invoices` — Client Engagements & Invoicing design spec §3.2.
 *
 * A persisted, numbered bill generated from an `Engagement` + billing period
 * (`services/invoice.service.ts`, Task 7 — not built yet). `company_id`,
 * `project_ids`, and `currency` are **snapshots** taken at generation time —
 * they do not follow later edits to the engagement/company/project.
 *
 * Immutability rule (enforced at the service layer, not here): a `draft`
 * invoice is fully editable (lines, tax, dates, notes). Once it transitions
 * to `sent`, the invoice is frozen — no field edits except
 * `status → paid`/`void` and `paid_date`. That makes the invoice the durable
 * billing snapshot the report never was.
 *
 * Indexes:
 *  - `{ company_id: 1, status: 1 }` — the admin invoice-list filter.
 *  - unique `{ number: 1 }` — defence in depth alongside the race-safe
 *    `invoice_counters` increment (`services/invoice-number.service.ts`).
 */

export const INVOICE_STATUSES = ['draft', 'sent', 'paid', 'void'] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

export const LINE_KINDS = ['hours', 'retainer', 'setup', 'overage', 'fixed', 'manual'] as const;
export type LineKind = (typeof LINE_KINDS)[number];

export interface InvoiceLineItem {
    kind: LineKind;
    description: string;
    user_id: Types.ObjectId | null; // for 'hours'/'overage' lines
    quantity_minutes: number | null; // for 'hours'/'overage' lines
    rate: number | null; // hourly rate applied, or unit price
    amount: number; // line total in `currency`; may be negative (discount)
}

export interface InvoiceDocument extends Document {
    _id: Types.ObjectId;

    number: string; // "INV-2026-0001"
    company_id: Types.ObjectId; // snapshot of the client
    engagement_id: Types.ObjectId;
    project_ids: Types.ObjectId[]; // snapshot of what the invoice covered
    period_start: string; // YYYY-MM-DD
    period_end: string; // YYYY-MM-DD
    currency: string; // ISO 4217, uppercase, snapshot from engagement

    line_items: Types.DocumentArray<InvoiceLineItem>;

    subtotal: number; // Σ line amounts
    tax_rate: number; // percent, default 0
    tax_label: string; // display name, e.g. "IGST 18%"
    tax_amount: number; // round(subtotal * tax_rate / 100)
    total: number; // subtotal + tax_amount

    status: InvoiceStatus;
    issue_date: string | null; // YYYY-MM-DD, set on 'sent'
    due_date: string | null; // YYYY-MM-DD
    paid_date: string | null; // YYYY-MM-DD, set on 'paid'
    notes: string;

    created_by: Types.ObjectId;
    created_at: Date;
    updated_at: Date;
}

const ISO_DATE_MATCH = /^\d{4}-\d{2}-\d{2}$/;

const invoiceLineItemSchema = new Schema<InvoiceLineItem>(
    {
        kind: { type: String, required: true, enum: LINE_KINDS },
        description: { type: String, required: true, trim: true },
        user_id: { type: Schema.Types.ObjectId, ref: COLLECTIONS.USERS, default: null },
        quantity_minutes: { type: Number, default: null },
        rate: { type: Number, default: null },
        amount: { type: Number, required: true },
    },
    { _id: true }
);

const invoiceSchema = new Schema<InvoiceDocument>(
    {
        number: { type: String, required: true, unique: true, trim: true },
        company_id: { type: Schema.Types.ObjectId, ref: COLLECTIONS.COMPANIES, required: true },
        engagement_id: { type: Schema.Types.ObjectId, ref: COLLECTIONS.ENGAGEMENTS, required: true },
        project_ids: [{ type: Schema.Types.ObjectId, ref: COLLECTIONS.PROJECTS }],
        period_start: { type: String, required: true, match: ISO_DATE_MATCH },
        period_end: { type: String, required: true, match: ISO_DATE_MATCH },
        currency: { type: String, required: true, uppercase: true, minlength: 3, maxlength: 3 },

        line_items: [invoiceLineItemSchema],

        subtotal: { type: Number, required: true },
        tax_rate: { type: Number, default: 0 },
        tax_label: { type: String, default: '' },
        tax_amount: { type: Number, required: true },
        total: { type: Number, required: true },

        status: { type: String, enum: INVOICE_STATUSES, default: 'draft' },
        issue_date: { type: String, default: null, match: ISO_DATE_MATCH },
        due_date: { type: String, default: null, match: ISO_DATE_MATCH },
        paid_date: { type: String, default: null, match: ISO_DATE_MATCH },
        notes: { type: String, default: '' },

        created_by: { type: Schema.Types.ObjectId, ref: COLLECTIONS.USERS, required: true },
    },
    {
        ...BASE_SCHEMA_OPTIONS,
        collection: COLLECTIONS.INVOICES,
    }
);

invoiceSchema.index({ company_id: 1, status: 1 });
// `number` already has a unique index from the field-level `unique: true` above.

export const Invoice: Model<InvoiceDocument> = model<InvoiceDocument>('Invoice', invoiceSchema);
