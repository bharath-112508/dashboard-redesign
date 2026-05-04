import { Schema, model, Types, type Document, type Model } from 'mongoose';

import { BASE_SCHEMA_OPTIONS, sensitiveToJSON } from './_base.js';
import { COLLECTIONS } from '../constants/collections.js';
import { ROLES, type RoleType } from '../constants/roles.js';
import { USER_STATUSES, type UserStatus } from '../constants/user-statuses.js';
import { DEFAULT_TIMEZONE } from '../utils/date.js';

/**
 * `users` — Data_Model.md §1.1
 *
 * Single collection for all user types. Role-specific fields live in the
 * `internal_profile` sub-doc (admin/manager/employee) or `client_profile`
 * (client). MFA state and lockout state also live here — there are no
 * separate collections for those.
 *
 * Sensitive fields (password hash, MFA secret, backup codes, lockout counters)
 * are stripped from JSON output via `sensitiveToJSON`.
 */

// ─── Sub-docs ─────────────────────────────────────────────────────────────

export interface EmergencyContact {
    name: string;
    phone: string;
    relation: string;
}

export interface InternalProfile {
    employee_id: string;
    job_title: string;
    department: string;
    date_of_joining: string; // YYYY-MM-DD
    reporting_manager_id: Types.ObjectId | null;
    emergency_contact?: EmergencyContact;
}

export type ClientAccessType = 'login' | 'readonly_link';

export interface ClientProfile {
    company_name: string;
    point_of_contact?: string;
    access_type: ClientAccessType;
}

// ─── Document ─────────────────────────────────────────────────────────────

export interface UserDocument extends Document {
    _id: Types.ObjectId;

    // Core
    email: string;
    password_hash: string;
    full_name: string;
    phone?: string;
    profile_photo_blob_key: string | null;
    role: RoleType;
    status: UserStatus;
    timezone: string;
    slack_user_id: string | null;
    /**
     * Step 25 — global Slack DM opt-in. Defaults to `true` so a user
     * who provides their `slack_user_id` automatically receives Slack
     * notifications. Toggle this to `false` to keep the handle on
     * record (for, e.g., team directory display) without the DM
     * fan-out.
     */
    slack_notifications_enabled: boolean;
    comp_off_balance: number;

    // Role-specific
    internal_profile?: InternalProfile;
    client_profile?: ClientProfile;

    // MFA (opt-in)
    mfa_enabled: boolean;
    mfa_secret_encrypted: string | null;
    mfa_backup_codes_hashed: string[];

    // Brute-force protection
    failed_login_attempts: number;
    last_failed_login_at: Date | null;
    locked_until: Date | null;

    // Audit
    last_login_at: Date | null;
    last_password_changed_at: Date | null;
    created_by: Types.ObjectId | null;
    deactivated_at: Date | null;
    created_at: Date;
    updated_at: Date;
}

// ─── Schemas ──────────────────────────────────────────────────────────────

const emergencyContactSchema = new Schema<EmergencyContact>(
    {
        name: { type: String, required: true, trim: true },
        phone: { type: String, required: true, trim: true },
        relation: { type: String, required: true, trim: true },
    },
    { _id: false }
);

const internalProfileSchema = new Schema<InternalProfile>(
    {
        employee_id: { type: String, required: true, trim: true },
        job_title: { type: String, required: true, trim: true },
        department: { type: String, required: true, trim: true },
        date_of_joining: { type: String, required: true },
        reporting_manager_id: { type: Schema.Types.ObjectId, ref: COLLECTIONS.USERS, default: null },
        emergency_contact: { type: emergencyContactSchema, required: false },
    },
    { _id: false }
);

const clientProfileSchema = new Schema<ClientProfile>(
    {
        company_name: { type: String, required: true, trim: true },
        point_of_contact: { type: String, required: false, trim: true },
        access_type: { type: String, enum: ['login', 'readonly_link'], required: true },
    },
    { _id: false }
);

const SENSITIVE_FIELDS = [
    'password_hash',
    'mfa_secret_encrypted',
    'mfa_backup_codes_hashed',
    'failed_login_attempts',
    'last_failed_login_at',
    'locked_until',
] as const;

const userSchema = new Schema<UserDocument>(
    {
        email: {
            type: String,
            required: true,
            unique: true,
            lowercase: true,
            trim: true,
            index: true,
        },
        password_hash: { type: String, required: true },
        full_name: { type: String, required: true, trim: true },
        phone: { type: String, trim: true },
        profile_photo_blob_key: { type: String, default: null },
        role: { type: String, enum: Object.values(ROLES), required: true },
        status: {
            type: String,
            enum: Object.values(USER_STATUSES),
            default: USER_STATUSES.ACTIVE,
            required: true,
        },
        timezone: { type: String, default: DEFAULT_TIMEZONE },
        slack_user_id: { type: String, default: null },
        slack_notifications_enabled: { type: Boolean, required: true, default: true },
        comp_off_balance: { type: Number, default: 0, min: 0 },

        internal_profile: { type: internalProfileSchema, required: false },
        client_profile: { type: clientProfileSchema, required: false },

        mfa_enabled: { type: Boolean, default: false },
        mfa_secret_encrypted: { type: String, default: null },
        mfa_backup_codes_hashed: { type: [String], default: [] },

        failed_login_attempts: { type: Number, default: 0, min: 0 },
        last_failed_login_at: { type: Date, default: null },
        locked_until: { type: Date, default: null },

        last_login_at: { type: Date, default: null },
        last_password_changed_at: { type: Date, default: null },
        created_by: { type: Schema.Types.ObjectId, ref: COLLECTIONS.USERS, default: null },
        deactivated_at: { type: Date, default: null },
    },
    {
        ...BASE_SCHEMA_OPTIONS,
        collection: COLLECTIONS.USERS,
        toJSON: sensitiveToJSON(SENSITIVE_FIELDS),
    }
);

// ─── Indexes (Data_Model.md §1.1 indexes section) ─────────────────────────
userSchema.index({ role: 1, status: 1 });
userSchema.index({ 'internal_profile.reporting_manager_id': 1 });
userSchema.index({ 'internal_profile.employee_id': 1 }, { unique: true, sparse: true });

/**
 * Text index for global search (Data_Model.md §Text Indexes line 1120;
 * Step 33 indexes audit). One text index per collection — Mongo's hard
 * limit — so we combine the four searchable fields into a single
 * declaration. The Step-32 search service still uses regex by default
 * (Phase-4 will swap to `$text: {$search: q}` per its upgrade-path
 * note); this index lands ahead of that migration so the cutover is
 * code-only.
 */
userSchema.index({
    full_name: 'text',
    email: 'text',
    'internal_profile.employee_id': 'text',
    'internal_profile.job_title': 'text',
});

export const User: Model<UserDocument> = model<UserDocument>(COLLECTIONS.USERS, userSchema);
