import { Schema, Types, model, type Document, type Model } from 'mongoose';

import { BASE_SCHEMA_OPTIONS } from './_base.js';
import { COLLECTIONS } from '../constants/collections.js';

/**
 * `payroll_profiles` — one per-user store of statutory/bank fields (PAN,
 * UAN, PF, ESI, PRAN, bank details, tax regime) consumed by payroll
 * exports and certificate generation. Read-gated on `payroll.read`,
 * write-gated on `payroll.write` — see `payroll-profile.routes.ts`.
 */

export interface PayrollProfileDocument extends Document {
    _id: Types.ObjectId;
    user_id: Types.ObjectId;
    pan: string;
    uan: string;
    pf_account_number: string;
    esi_number: string;
    pran_number: string;
    bank_details: string;
    tax_regime: string;
    updated_by: Types.ObjectId;
    created_at: Date;
    updated_at: Date;
}

const payrollProfileSchema = new Schema<PayrollProfileDocument>(
    {
        user_id: { type: Schema.Types.ObjectId, ref: COLLECTIONS.USERS, required: true, unique: true },
        pan: { type: String, default: '', trim: true },
        uan: { type: String, default: '', trim: true },
        pf_account_number: { type: String, default: '', trim: true },
        esi_number: { type: String, default: '', trim: true },
        pran_number: { type: String, default: '', trim: true },
        bank_details: { type: String, default: '', trim: true },
        tax_regime: { type: String, default: 'Regular Tax Regime', trim: true },
        updated_by: { type: Schema.Types.ObjectId, ref: COLLECTIONS.USERS, required: true },
    },
    { ...BASE_SCHEMA_OPTIONS, collection: COLLECTIONS.PAYROLL_PROFILES }
);

export const PayrollProfile: Model<PayrollProfileDocument> = model<PayrollProfileDocument>(
    'PayrollProfile',
    payrollProfileSchema
);
