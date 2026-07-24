import { z } from 'zod';

import { LINE_KINDS } from '../models/invoice.model.js';

/**
 * Zod schemas for `/invoices/*` (Client Engagements & Invoicing design spec
 * §3.2/§5). Mirrors `engagement.validator.ts`'s helper/refine style.
 *
 * Immutability rule (enforced by the service, not here — Task 7/8): a
 * `draft` invoice is fully editable; once `sent`, only
 * `status → paid`/`void` and `paid_date` may change.
 */

const objectId = z.string().regex(/^[a-f0-9]{24}$/i, 'Must be a valid ObjectId');
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD');

// ─── POST /invoices/generate ─────────────────────────────────────────────

export const generateInvoiceSchema = z
    .object({
        engagement_id: objectId,
        period_start: isoDate,
        period_end: isoDate,
        confirm: z.boolean().optional(),
    })
    .strict()
    .refine((v) => v.period_end >= v.period_start, {
        path: ['period_end'],
        message: 'period_end must be on or after period_start',
    });

// ─── PATCH /invoices/:id ─────────────────────────────────────────────────
//
// Draft-only field edits (the service refuses this once the invoice has
// left `draft`). Replaces the full `line_items` array when supplied.

const lineItemInputSchema = z.object({
    kind: z.enum(LINE_KINDS),
    description: z.string().trim().min(1),
    amount: z.number(),
    user_id: objectId.nullable().optional(),
    quantity_minutes: z.number().nullable().optional(),
    rate: z.number().nullable().optional(),
});

export const updateInvoiceSchema = z
    .object({
        line_items: z.array(lineItemInputSchema).optional(),
        tax_rate: z.number().min(0).optional(),
        tax_label: z.string().optional(),
        due_date: isoDate.nullable().optional(),
        notes: z.string().optional(),
    })
    .strict()
    .refine((v) => Object.keys(v).length > 0, { message: 'At least one field must be supplied' });

// ─── POST /invoices/:id/status ───────────────────────────────────────────

export const invoiceStatusSchema = z
    .object({
        to: z.enum(['sent', 'paid', 'void']),
        paid_date: isoDate.optional(),
    })
    .strict();

// ─── GET /invoices ────────────────────────────────────────────────────────

export const listInvoicesQuerySchema = z
    .object({
        company_id: objectId.optional(),
        engagement_id: objectId.optional(),
        status: z.enum(['draft', 'sent', 'paid', 'void']).optional(),
        page: z.coerce.number().int().min(1).default(1),
        limit: z.coerce.number().int().min(1).max(100).default(20),
    })
    .strict();

export type GenerateInvoiceInput = z.infer<typeof generateInvoiceSchema>;
export type UpdateInvoiceInput = z.infer<typeof updateInvoiceSchema>;
export type InvoiceStatusInput = z.infer<typeof invoiceStatusSchema>;
export type ListInvoicesQuery = z.infer<typeof listInvoicesQuerySchema>;

// ─── Path params ─────────────────────────────────────────────────────────

export const invoiceIdPathSchema = z.object({ id: objectId });
export type InvoiceIdPath = z.infer<typeof invoiceIdPathSchema>;
