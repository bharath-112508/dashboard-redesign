import type { ClientSession } from 'mongoose';

import { InvoiceCounter } from '../models/invoice-counter.model.js';

/**
 * Mint the next sequential invoice number for a given calendar year, e.g.
 * `nextInvoiceNumber(2026)` → `"INV-2026-0001"`, then `"INV-2026-0002"`.
 *
 * Race-safe: `findOneAndUpdate({year}, {$inc:{seq:1}}, {upsert:true,
 * new:true})` is atomic at the Mongo layer — two concurrent callers for the
 * same year always receive distinct sequence numbers (same pattern as
 * `projects.task_seq` in `task.service.ts`). Pass `session` to participate
 * in an enclosing `withTransaction` call.
 */
export const nextInvoiceNumber = async (year: number, prefix = 'INV', session?: ClientSession): Promise<string> => {
    const doc = await InvoiceCounter.findOneAndUpdate(
        { year },
        { $inc: { seq: 1 } },
        { upsert: true, new: true, setDefaultsOnInsert: true, ...(session ? { session } : {}) }
    ).lean<{ seq: number }>();
    const seq = String(doc!.seq).padStart(4, '0');
    return `${prefix}-${year}-${seq}`;
};
