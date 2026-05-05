import { RoleType } from '../constants/index.js';
import type { Permission } from '../constants/permissions.js';

/**
 * Claims carried in every access token.
 *
 * Phase 4 Step 47 introduced RBAC: tokens now carry the resolved
 * `role_keys[]` (all roles the user is assigned) and `permissions[]`
 * (deduped union of every assigned role's grants). The legacy `role`
 * field is kept as a denormalized cache during the migration window
 * (Phase B) so service code branching on `caller.role === 'admin'`
 * keeps working until each call site is migrated to permission checks.
 *
 * Legacy `role` is set to the **first** of the user's role_keys (or
 * the legacy `users.role` string for pre-bootstrap users). Once the
 * migration of all `authorize()` call sites lands, `role` is removed.
 */
export interface BaseJWTPayload {
    user_id: string;
    /** Legacy denormalized — first of `role_keys` for back-compat. */
    role: RoleType;
    /**
     * All role keys the user is assigned. Empty array is allowed for
     * brand-new users pre-bootstrap-migration; the auth layer rejects
     * privileged calls when this is empty.
     */
    role_keys: string[];
    /** Deduped union of every assigned role's permissions. */
    permissions: Permission[];
}

/** Refresh tokens carry a per-token `jti` so two tokens issued in the same second differ. */
export interface RefreshJWTPayload extends BaseJWTPayload {
    type: 'refresh';
    jti: string;
}

/** Shape returned by login / refresh (API_Contract §2.2, §2.4). */
export interface AuthTokenPair {
    access_token: string;
    access_token_expires_at: string;
    refresh_token: string;
    refresh_token_expires_at: string;
}
