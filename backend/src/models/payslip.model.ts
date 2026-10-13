import { Schema, Types, model, type Document, type Model } from 'mongoose';

import { BASE_SCHEMA_OPTIONS } from './_base.js';
import { COLLECTIONS } from '../constants/collections.js';

/**
 * `payslips` — one immutable row per generated payslip PDF (Task 7).
 *
 * A payslip is never edited in place: re-running generation for the same
 * `(user_id, pay_period)` creates a NEW row with a fresh `blob_key` /
 * `content_hash` (the blob key embeds a content hash, so identical inputs
 * produce the same key and Azure de-dupes the bytes; different inputs
 * produce a distinct row). `render_snapshot` freezes the exact render-data
 * payload used to produce the PDF so a later audit/dispute can be resolved
 * without re-deriving payroll state that may have since changed.
 *
 * The PDF bytes themselves live in a **private** Azure Blob container
 * (`AZURE_BLOB_PAYROLL_DOCUMENTS_CONTAINER`); `blob_key` is the pointer,
 * `content_hash` (SHA-256 of the PDF bytes) is a tamper-evidence check.
 * Downloads are always short-lived SAS URLs — no permanent public URL is
 * ever stored.
 */

export interface PayslipDocument extends Document {
    _id: Types.ObjectId;

    user_id: Types.ObjectId;
    pay_period: string;
    days_present: number;
    net_pay: number;
    render_snapshot: unknown;
    blob_key: string;
    content_hash: string;
    generated_by: Types.ObjectId;

    created_at: Date;
    updated_at: Date;
}

const payslipSchema = new Schema<PayslipDocument>(
    {
        user_id: { type: Schema.Types.ObjectId, ref: COLLECTIONS.USERS, required: true },
        pay_period: { type: String, required: true, trim: true },
        days_present: { type: Number, required: true, min: 0 },
        net_pay: { type: Number, required: true },
        render_snapshot: { type: Schema.Types.Mixed, required: true },
        blob_key: { type: String, required: true },
        content_hash: { type: String, required: true },
        generated_by: { type: Schema.Types.ObjectId, ref: COLLECTIONS.USERS, required: true },
    },
    { ...BASE_SCHEMA_OPTIONS, collection: COLLECTIONS.PAYSLIPS }
);

payslipSchema.index({ user_id: 1, pay_period: 1 });

export const Payslip: Model<PayslipDocument> = model<PayslipDocument>('Payslip', payslipSchema);
