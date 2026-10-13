import { Schema, Types, model, type Document, type Model } from 'mongoose';

import { BASE_SCHEMA_OPTIONS } from './_base.js';
import { COLLECTIONS } from '../constants/collections.js';

/**
 * `salary_structures` — a per-user, VERSIONED salary structure. Each row
 * is an immutable snapshot valid from `effective_from` onward; the
 * service layer (never the model) decides which row is "current" for a
 * given date by finding the newest `effective_from <= date`.
 *
 * `is_current` is a denormalized convenience flag maintained by
 * `salary-structure.service.ts#createStructure` — it's always the row
 * with the max `effective_from` for that user. It exists so list/detail
 * screens can render a "current" badge without a second query; the
 * authoritative accessor for "what applies on date X" is
 * `getCurrentStructure`, which re-derives from `effective_from` directly
 * rather than trusting the flag.
 *
 * This is the data source Task 6 (payroll calc), Task 7 (payslip), and
 * Task 8 (hike/promotion letters) read from — `getCurrentStructure`'s
 * signature is depended on downstream; don't change it.
 */

export interface LineItem {
    label: string;
    amount: number;
}

export interface SalaryStructureDocument extends Document {
    _id: Types.ObjectId;
    user_id: Types.ObjectId;
    effective_from: string; // YYYY-MM-DD
    earnings: LineItem[];
    deductions: LineItem[];
    is_current: boolean;
    created_by: Types.ObjectId;
    created_at: Date;
    updated_at: Date;
}

const lineItemSchema = new Schema<LineItem>(
    {
        label: { type: String, required: true, trim: true },
        amount: { type: Number, required: true, default: 0 },
    },
    { _id: false }
);

const salaryStructureSchema = new Schema<SalaryStructureDocument>(
    {
        user_id: { type: Schema.Types.ObjectId, ref: COLLECTIONS.USERS, required: true },
        effective_from: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
        earnings: { type: [lineItemSchema], default: [] },
        deductions: { type: [lineItemSchema], default: [] },
        is_current: { type: Boolean, default: true },
        created_by: { type: Schema.Types.ObjectId, ref: COLLECTIONS.USERS, required: true },
    },
    { ...BASE_SCHEMA_OPTIONS, collection: COLLECTIONS.SALARY_STRUCTURES }
);

// Newest-first lookup path used by `listStructures` and `getCurrentStructure`.
salaryStructureSchema.index({ user_id: 1, effective_from: -1 });

// Defence in depth against the parallel-create race — two concurrent
// creates for the same (user, effective_from) both pass an in-process
// check before either writes; the unique index turns the loser into a
// clean E11000 the service maps to a 409 `DUPLICATE_RESOURCE`.
salaryStructureSchema.index({ user_id: 1, effective_from: 1 }, { unique: true, name: 'salary_user_effective_unique' });

export const SalaryStructure: Model<SalaryStructureDocument> = model<SalaryStructureDocument>(
    'SalaryStructure',
    salaryStructureSchema
);
