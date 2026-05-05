import { Schema, model, Types, type Document, type Model } from 'mongoose';

import { BASE_SCHEMA_OPTIONS } from './_base.js';
import { COLLECTIONS } from '../constants/collections.js';
import { PERMISSION_VALUES, type Permission } from '../constants/permissions.js';

/**
 * `roles` — Phase 4 Step 47.
 *
 * The flat-role enum (`users.role: 'admin' | 'manager' | ...`) is
 * replaced by a per-user array of role-document references, where
 * each role carries an explicit permission set. Five system roles
 * (admin / manager / team_lead / employee / client) are seeded on
 * first boot and cannot be deleted or have their `key` / `is_system`
 * flag mutated. Their permission sets MAY be updated via PATCH so
 * customers can broaden / narrow what a system role grants without
 * forking the role-key namespace.
 *
 * Custom roles are admin-defined: any number, any name, any
 * permission subset (the `system.admin` wildcard is rejected on
 * create/update — only the seeded Admin role holds it).
 *
 * `key` is unique across all roles. System role keys mirror the
 * legacy `ROLES` enum strings ('admin', 'manager', etc.) so service
 * code that branches on `caller.role_keys.includes('admin')`
 * continues to work after migration.
 */

export interface RoleDocument extends Document {
    _id: Types.ObjectId;

    /**
     * Stable identifier — used by `caller.role_keys` checks at the
     * service layer (where row-visibility scoping needs to know
     * "is this caller an admin / manager" without resolving every
     * permission bit).
     */
    key: string;

    display_name: string;
    description: string;

    /**
     * The grant set. Validated against the `PERMISSION_VALUES`
     * allowlist on save — the `system.admin` wildcard is allowed
     * here in storage but the role service rejects it on
     * create/update for non-system roles.
     */
    permissions: Permission[];

    /**
     * `true` for the seeded admin / manager / team_lead / employee
     * / client roles. Enforced as immutable by the role service:
     *  - Cannot be deleted.
     *  - `key` and `is_system` cannot be patched.
     *  - `permissions` and `display_name` and `description` MAY be
     *    patched (so an operator can grant team_lead an extra
     *    permission across the org without making a custom role).
     */
    is_system: boolean;

    created_by: Types.ObjectId | null;
    updated_by: Types.ObjectId | null;
    created_at: Date;
    updated_at: Date;
}

const roleSchema = new Schema<RoleDocument>(
    {
        key: {
            type: String,
            required: true,
            trim: true,
            lowercase: true,
            unique: true,
            // Allow `[a-z0-9_-]` only — used in URL paths + JWT
            // claims, so keep it conservative.
            match: [
                /^[a-z][a-z0-9_-]{0,39}$/,
                'role key must be lowercase alphanumeric / underscore / hyphen, 1-40 chars',
            ],
        },
        display_name: { type: String, required: true, trim: true, maxlength: 100 },
        description: { type: String, required: false, default: '', maxlength: 500 },
        permissions: {
            type: [String],
            required: true,
            default: [],
            validate: {
                validator: (v: string[]) => {
                    const allowed = new Set<string>(PERMISSION_VALUES);
                    return v.every((p) => allowed.has(p));
                },
                message: 'permissions must be drawn from PERMISSION_VALUES',
            },
        },
        is_system: { type: Boolean, required: true, default: false },

        created_by: { type: Schema.Types.ObjectId, ref: COLLECTIONS.USERS, default: null },
        updated_by: { type: Schema.Types.ObjectId, ref: COLLECTIONS.USERS, default: null },
    },
    {
        ...BASE_SCHEMA_OPTIONS,
        collection: COLLECTIONS.ROLES,
    }
);

// `key` already has a unique index from the field-level `unique: true`
// above; the role lookup hot path is "resolve user.role_ids → docs"
// which uses the implicit `_id` index.

export const Role: Model<RoleDocument> = model<RoleDocument>(COLLECTIONS.ROLES, roleSchema);
