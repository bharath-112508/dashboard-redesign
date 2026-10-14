import { Schema, Types, model, type Document } from 'mongoose';
import { BASE_SCHEMA_OPTIONS } from './_base.js';
import { COLLECTIONS } from '../constants/collections.js';

/**
 * Redesign: a person's decision on one invoice in the InvoiceMatch live-app
 * demo (approve, hold, reject). The invoices themselves are the app's fixed
 * sample; only decisions are stored. `by` is the decider's name.
 */
export interface InvoicematchDecisionDocument extends Document {
    _id: Types.ObjectId;
    project_id: Types.ObjectId;
    no: string;
    st: 'approved' | 'hold' | 'rejected';
    note: string;
    by: string;
    by_id: Types.ObjectId;
    created_at: Date;
    updated_at: Date;
}

const schema = new Schema<InvoicematchDecisionDocument>(
    {
        project_id: { type: Schema.Types.ObjectId, ref: COLLECTIONS.PROJECTS, required: true },
        no: { type: String, required: true },
        st: { type: String, enum: ['approved', 'hold', 'rejected'], required: true },
        note: { type: String, default: '' },
        by: { type: String, required: true },
        by_id: { type: Schema.Types.ObjectId, ref: COLLECTIONS.USERS, required: true },
    },
    { ...BASE_SCHEMA_OPTIONS, collection: COLLECTIONS.INVOICEMATCH_DECISIONS }
);

schema.index({ project_id: 1, no: 1 }, { unique: true });

export const InvoicematchDecision = model<InvoicematchDecisionDocument>('InvoicematchDecision', schema);
