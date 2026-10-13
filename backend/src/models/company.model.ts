import { Schema, Types, model, type Document, type Model } from 'mongoose';

import { BASE_SCHEMA_OPTIONS } from './_base.js';
import { COLLECTIONS } from '../constants/collections.js';

/**
 * `companies` — the client organisation.
 *
 * In this model **"Client" means the company**, and the limited person is a
 * **"Representative"**. A company has many projects and many people; people
 * hold the roles (`client` = company-level, `representative` = assigned-only).
 * The company itself has **no login**.
 *
 * There is deliberately **no `owner_id`**: several people may hold the `client`
 * role for one company, so the company survives any one of them leaving. The
 * `client`-role users are the contacts — which is why `client_profile
 * .point_of_contact` is retired.
 *
 * Replaces the free-text `User.client_profile.company_name`. That string is
 * exactly how two people at the same company ended up as unrelated records
 * with nothing linking them.
 *
 * Soft-delete via `status: 'archived'` — never hard-delete. Projects carry
 * `company_id` and historic references must stay resolvable.
 */

export type CompanyStatus = 'active' | 'archived';

export const COMPANY_STATUSES: readonly CompanyStatus[] = ['active', 'archived'] as const;

export interface CompanyDocument extends Document {
    _id: Types.ObjectId;
    name: string;
    status: CompanyStatus;
    created_by: Types.ObjectId;
    created_at: Date;
    updated_at: Date;
}

const companySchema = new Schema<CompanyDocument>(
    {
        name: { type: String, required: true, trim: true },
        status: {
            type: String,
            required: true,
            enum: COMPANY_STATUSES as unknown as string[],
            default: 'active',
        },
        created_by: { type: Schema.Types.ObjectId, ref: COLLECTIONS.USERS, required: true },
    },
    {
        ...BASE_SCHEMA_OPTIONS,
        collection: COLLECTIONS.COMPANIES,
    }
);

/**
 * Case-insensitive unique name.
 *
 * `strength: 2` compares without regard to case or accents, so "TCS" and "tcs"
 * collide instead of silently becoming two companies. Free-text
 * `company_name` had no such guard and is why near-duplicates are a migration
 * hazard — this index is what stops them recurring.
 *
 * Note: queries must supply the same collation to use this index (Mongo won't
 * use a collated index for a non-collated query). The service layer owns that.
 */
companySchema.index({ name: 1 }, { unique: true, collation: { locale: 'en', strength: 2 } });

// Cheap status filter for the default list query.
companySchema.index({ status: 1, created_at: -1 });

export const Company: Model<CompanyDocument> = model<CompanyDocument>(COLLECTIONS.COMPANIES, companySchema);
