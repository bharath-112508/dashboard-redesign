import { Schema, model, type Document, type Model } from 'mongoose';

import { BASE_SCHEMA_OPTIONS } from './_base.js';
import { COLLECTIONS } from '../constants/collections.js';

/**
 * `invoice_counters` — one row per calendar year, used to atomically mint
 * sequential invoice numbers (`INV-2026-0001`, `INV-2026-0002`, …) via
 * `services/invoice-number.service.ts`.
 *
 * Race-safety: the service issues `findOneAndUpdate({year}, {$inc:{seq:1}},
 * {upsert:true, new:true})` — the same atomic-increment pattern used by
 * `projects.task_seq` (see `services/task.service.ts`). Two concurrent
 * callers for the same year always get distinct `seq` values; no
 * read-then-write race window.
 */

export interface InvoiceCounterDocument extends Document {
    year: number;
    seq: number;

    created_at: Date;
    updated_at: Date;
}

const invoiceCounterSchema = new Schema<InvoiceCounterDocument>(
    {
        year: { type: Number, required: true, unique: true },
        seq: { type: Number, default: 0 },
    },
    {
        ...BASE_SCHEMA_OPTIONS,
        collection: COLLECTIONS.INVOICE_COUNTERS,
    }
);

export const InvoiceCounter: Model<InvoiceCounterDocument> = model<InvoiceCounterDocument>(
    'InvoiceCounter',
    invoiceCounterSchema
);
