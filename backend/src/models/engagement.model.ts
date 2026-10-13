import { Schema, Types, model, type Document, type Model } from 'mongoose';
import { BASE_SCHEMA_OPTIONS } from './_base.js';
import { COLLECTIONS } from '../constants/collections.js';

export const BILLING_TYPES = ['hourly', 'retainer', 'fixed', 'hybrid'] as const;
export type BillingType = (typeof BILLING_TYPES)[number];
export const RETAINER_PERIODS = ['month', 'quarter', 'year'] as const;
export type RetainerPeriod = (typeof RETAINER_PERIODS)[number];
export const ENGAGEMENT_STATUSES = ['active', 'ended'] as const;
export type EngagementStatus = (typeof ENGAGEMENT_STATUSES)[number];

export interface EngagementDocument extends Document {
    _id: Types.ObjectId;
    company_id: Types.ObjectId;
    project_ids: Types.ObjectId[]; // [] = all the company's projects
    name: string;
    currency: string; // ISO 4217, uppercase
    billing_type: BillingType;
    setup_fee: number | null;
    setup_fee_invoiced: boolean;
    retainer_amount: number | null;
    retainer_period: RetainerPeriod | null;
    included_hours: number | null;
    fixed_amount: number | null;
    start_date: string; // YYYY-MM-DD
    end_date: string | null;
    status: EngagementStatus;
    notes: string;
    created_by: Types.ObjectId;
    created_at: Date;
    updated_at: Date;
}

const engagementSchema = new Schema<EngagementDocument>(
    {
        company_id: { type: Schema.Types.ObjectId, ref: COLLECTIONS.COMPANIES, required: true },
        project_ids: [{ type: Schema.Types.ObjectId, ref: COLLECTIONS.PROJECTS }],
        name: { type: String, required: true, trim: true },
        currency: { type: String, required: true, uppercase: true, minlength: 3, maxlength: 3 },
        billing_type: { type: String, required: true, enum: BILLING_TYPES },
        setup_fee: { type: Number, default: null, min: 0 },
        setup_fee_invoiced: { type: Boolean, default: false },
        retainer_amount: { type: Number, default: null, min: 0 },
        retainer_period: { type: String, default: null, enum: [...RETAINER_PERIODS, null] },
        included_hours: { type: Number, default: null, min: 0 },
        fixed_amount: { type: Number, default: null, min: 0 },
        start_date: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
        end_date: { type: String, default: null, match: /^\d{4}-\d{2}-\d{2}$/ },
        status: { type: String, enum: ENGAGEMENT_STATUSES, default: 'active' },
        notes: { type: String, default: '' },
        created_by: { type: Schema.Types.ObjectId, ref: COLLECTIONS.USERS, required: true },
    },
    { ...BASE_SCHEMA_OPTIONS, collection: COLLECTIONS.ENGAGEMENTS }
);
engagementSchema.index({ company_id: 1, status: 1 });

export const Engagement: Model<EngagementDocument> = model<EngagementDocument>('Engagement', engagementSchema);
