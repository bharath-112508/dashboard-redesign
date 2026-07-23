import { Schema, model, Types, type Document, type Model } from 'mongoose';

import { BASE_SCHEMA_OPTIONS, sensitiveToJSON } from './_base.js';
import type { CompOffContribution } from './comp-off-ledger.model.js';
import { COLLECTIONS } from '../constants/collections.js';
import { ROLES, type RoleType } from '../constants/roles.js';
import { USER_STATUSES, type UserStatus } from '../constants/user-statuses.js';
import { PERMISSION_VALUES } from '../constants/permissions.js';
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

/**
 * The company-side profile, carried by BOTH client-side roles:
 *   - `client`         — the company-level person
 *   - `representative` — that company's project-scoped person
 *
 * `company_name` (free text) is gone: it's what made two people at the
 * same company unrelated records. `company_id` points at `companies`.
 *
 * There is no `point_of_contact`: the `client`-role users ARE the contacts,
 * so a free-text note duplicating that was removed (2026-07-20).
 */
export interface ClientProfile {
    company_id: Types.ObjectId;
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
    /**
     * Phase-4 Step 47 (RBAC). Array of `roles._id` references; effective
     * permissions are the union of every assigned role's `permissions[]`.
     * The legacy `role` field above is kept as a denormalised cache of
     * the FIRST system-role key in this array — service code that branches
     * on `caller.role === 'admin'` continues to work during the Phase-B
     * migration window. Phase B replaces those checks with permission
     * lookups; Phase C drops the `role` field entirely.
     */
    role_ids: Types.ObjectId[];
    /**
     * Phase-4 Step 47 — per-user "Pattern B" extra grants. Effective
     * permissions are `union(role_ids[].permissions, extra_permissions)`.
     * Used for one-off admin overrides without spinning up a custom
     * role (e.g. "Bob also gets `report.read` for Q3"). The
     * `system.admin` wildcard is rejected at the service layer the
     * same way custom roles are.
     */
    extra_permissions: string[];
    status: UserStatus;
    timezone: string;
    slack_user_id: string | null;
    /** Cached Slack profile avatar URL (`profile.image_72`), warmed from
     *  users.lookupByEmail / users.info. Null until warmed; the Slack Home
     *  dashboard falls back to an emoji. */
    slack_avatar_url: string | null;
    /**
     * Step 25 — global Slack DM opt-in. Defaults to `true` so a user
     * who provides their `slack_user_id` automatically receives Slack
     * notifications. Toggle this to `false` to keep the handle on
     * record (for, e.g., team directory display) without the DM
     * fan-out.
     */
    slack_notifications_enabled: boolean;
    /**
     * V2-BE-10 — global Web Push opt-in. Defaults to `true` so a user
     * who registers a browser subscription gets push automatically.
     * Toggling this to `false` silences push without unsubscribing the
     * browser endpoints (they're kept so the toggle can be flipped back
     * on without re-prompting for the browser permission).
     */
    push_notifications_enabled: boolean;
    comp_off_balance: number;
    /** Un-converted overtime remainder (minutes) for automatic comp-off
     *  accrual. Overtime accumulates across days; every half-step of the
     *  threshold earns 0.5 comp-off, the leftover carries here. */
    comp_off_overtime_bank_minutes: number;
    /** Provenance for the un-converted bank above: the (day, project, minutes)
     *  overtime slices that haven't yet been minted into a comp-off lot. When
     *  the bank crosses a step, these are attached to the granted lot's
     *  `contributions` and cleared. */
    comp_off_pending_contributions: CompOffContribution[];

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
        company_id: { type: Schema.Types.ObjectId, ref: COLLECTIONS.COMPANIES, required: true },
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
        // T8 — `select: false` keeps the bcrypt hash out of any
        // `find` / `findOne` / `findById` projection by default. The
        // existing readers all use the `+password_hash` opt-in syntax
        // which still works; this guards against a future
        // `.lean<UserDocument>()` accidentally loading hashes into a
        // response payload or log line.
        password_hash: { type: String, required: true, select: false },
        full_name: { type: String, required: true, trim: true },
        phone: { type: String, trim: true },
        profile_photo_blob_key: { type: String, default: null },
        role: { type: String, enum: Object.values(ROLES), required: true },
        // Step 47 — array of role-document references. Validated at the
        // service layer (must be non-empty + every id must reference a
        // real role row). Defaulted to empty so the schema accepts
        // pre-Step-47 fixture data; the bootstrap migration backfills
        // `role_ids` from the legacy `role` field on next start.
        role_ids: { type: [Schema.Types.ObjectId], ref: COLLECTIONS.ROLES, default: [] },
        // Step 47 Pattern B — per-user extra permission grants. Each
        // entry must be drawn from the catalog (`PERMISSION_VALUES`);
        // the service-layer rejects the `system.admin` wildcard the
        // same way it does on custom roles.
        extra_permissions: {
            type: [String],
            required: true,
            default: [],
            validate: {
                validator: (v: string[]) => {
                    const allowed = new Set<string>(PERMISSION_VALUES);
                    return v.every((p) => allowed.has(p));
                },
                message: 'Some of these permissions are no longer available. Remove them and try again.',
            },
        },
        status: {
            type: String,
            enum: Object.values(USER_STATUSES),
            default: USER_STATUSES.ACTIVE,
            required: true,
        },
        timezone: { type: String, default: DEFAULT_TIMEZONE },
        slack_user_id: { type: String, default: null },
        slack_avatar_url: { type: String, default: null },
        slack_notifications_enabled: { type: Boolean, required: true, default: true },
        push_notifications_enabled: { type: Boolean, required: true, default: true },
        comp_off_balance: { type: Number, default: 0, min: 0 },
        comp_off_overtime_bank_minutes: { type: Number, default: 0, min: 0 },
        comp_off_pending_contributions: {
            type: [
                new Schema<CompOffContribution>(
                    {
                        date: { type: String, required: true },
                        project_id: { type: Schema.Types.ObjectId, ref: COLLECTIONS.PROJECTS, default: null },
                        project_name: { type: String, default: null },
                        minutes: { type: Number, required: true, min: 0 },
                    },
                    { _id: false }
                ),
            ],
            default: [],
        },

        internal_profile: { type: internalProfileSchema, required: false },
        client_profile: { type: clientProfileSchema, required: false },

        mfa_enabled: { type: Boolean, default: false },
        // T8 — `select: false` on the encrypted TOTP secret + the
        // hashed backup codes. Same rationale as `password_hash`:
        // `.lean<UserDocument>()` callers must explicitly opt in via
        // `+mfa_secret_encrypted` / `+mfa_backup_codes_hashed`.
        mfa_secret_encrypted: { type: String, default: null, select: false },
        mfa_backup_codes_hashed: { type: [String], default: [], select: false },

        // Brute-force counters. `select: false` here too — they're
        // enforcement state, not part of any user-facing response.
        failed_login_attempts: { type: Number, default: 0, min: 0, select: false },
        last_failed_login_at: { type: Date, default: null, select: false },
        locked_until: { type: Date, default: null, select: false },

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

// M39 — `GET /users` default sort is `{ created_at: -1, _id: 1 }` with a
// `status` predicate (active-by-default, deactivated only for callers
// who hold USER_WRITE + show_deleted=true). The pre-M39 indexes
// (`{ role, status }`, `{ employee_id }`) didn't cover this — Mongo
// either collection-scanned or pulled `role+status` and in-memory
// sorted. This compound serves the default list path directly.
userSchema.index({ status: 1, created_at: -1 });

/**
 * R6 — single-active-admin invariant backstop.
 *
 * The single-tenancy contract is "exactly one active admin user per
 * deployment". `assertSingleAdmin` checks for an existing admin before
 * `User.create` / `reactivateUser` / `changeUserRole` set role=admin,
 * but two concurrent calls can both observe no existing admin and
 * both insert — a TOCTOU race the friendly check can't close on its
 * own.
 *
 * This partial unique index makes the database the source of truth.
 * Two concurrent inserts/updates with `(role: 'admin', status: 'active')`
 * collide on E11000; the second one is caught and re-thrown as
 * `ADMIN_ALREADY_EXISTS` by the service layer.
 *
 * Partial filter: only the (admin, active) tuple is unique. A
 * `deactivated` admin doesn't block a fresh admin promotion;
 * non-admin users have no constraint here.
 */
userSchema.index(
    { role: 1 },
    {
        unique: true,
        partialFilterExpression: { role: 'admin', status: 'active' },
        name: 'one_active_admin',
    }
);

/**
 * A Slack user id identifies exactly one human, so at most one Viljetech
 * account may carry a given `slack_user_id`. Without this, two rows could hold
 * the same id and the Slack resolver's `findOne({ slack_user_id })` fast-path
 * would return whichever row Mongo hit first — the bug where a team lead saw
 * the admin's App Home because both accounts had been mapped to his Slack id.
 *
 * Partial (not sparse): every unmapped user stores `slack_user_id: null`
 * (schema default), so a sparse index wouldn't skip them and all the nulls
 * would collide on the unique constraint. The partial filter indexes only
 * string (mapped) values, leaving unlimited nulls. Mirrors `employee_id`'s
 * intent but uses a partial filter because that field is unset-when-absent
 * while this one is explicitly null.
 */
userSchema.index(
    { slack_user_id: 1 },
    {
        unique: true,
        partialFilterExpression: { slack_user_id: { $type: 'string' } },
        name: 'unique_slack_user_id',
    }
);

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
