import { Request, Response, NextFunction } from 'express';
import { Types } from 'mongoose';

import { verifyAccessToken } from '../utils/jwt.js';
import { AppError } from '../utils/app-error.js';
import { ROLES } from '../constants/index.js';
import { ERROR_CODES } from '../constants/error-codes.js';
import { SYSTEM_ROLE_KEYS } from '../constants/role-keys.js';
import { PERMISSIONS, type Permission } from '../constants/permissions.js';
import { USER_STATUSES } from '../constants/user-statuses.js';
import { BaseJWTPayload } from '../types/index.js';
import { User } from '../models/user.model.js';
import { getOrInitSettings } from '../services/settings.service.js';

declare global {
    namespace Express {
        interface Request {
            user?: BaseJWTPayload;
        }
    }
}

// ─── Step 28: Force-MFA-for-admins gate ──────────────────────────────────
//
// HTTP methods that don't change state — reads bypass the gate so an
// admin without MFA can still see dashboards / their own profile.
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Endpoints exempt from the gate when it's on. The MFA-setup paths
 * MUST be exempt — otherwise an admin without MFA (the exact case
 * the gate is meant to fix) can never enable MFA in the first place,
 * which is a chicken-and-egg lock-out.
 *
 * `req.path` here is relative to the router currently dispatching the
 * request — for `auth.routes.ts` mounted at `/api/v1/auth`, the
 * middleware sees `/mfa/setup/init`, not the full URL. We match
 * **exactly** rather than via `endsWith`: the latter would silently
 * exempt a hypothetical future route like
 * `/projects/:id/mfa/setup/init` (whose `req.path` ends with the
 * exempt suffix) from the admin-MFA gate. Exact match removes that
 * trap; if a new MFA-setup endpoint ever lands at a different mount,
 * add its router-relative path to the set explicitly.
 */
const MFA_GATE_EXEMPT_PATHS: ReadonlySet<string> = new Set(['/mfa/setup/init', '/mfa/setup/confirm']);

const isExemptFromMfaGate = (req: Request): boolean => MFA_GATE_EXEMPT_PATHS.has(req.path);

/**
 * Enforce the "admin must have MFA" policy when the system-settings
 * flag is on. Pulled out so the unit tests can exercise it
 * independently of the JWT-verification path.
 *
 * Three cheap short-circuits before any DB read:
 *  1. caller isn't an admin
 *  2. method is read-only
 *  3. path is in the exempt allowlist
 *
 * When the gate doesn't short-circuit, two reads:
 *  - settings singleton (one indexed doc, microseconds)
 *  - `User.findById(...).select('mfa_enabled').lean()`
 *
 * No-op when the flag is off (default), so the cost on a cold install
 * is just one settings read per admin write.
 */
/**
 * Step 47: "is the caller an admin" check now spans both the legacy
 * `role` string AND the new `role_keys` array. Tokens issued before
 * the Step-47 deploy don't carry `role_keys` (defaults to undefined
 * → []), so we still need the legacy field; tokens issued after the
 * deploy populate both. Either signal counts.
 */
const isCallerAdmin = (payload: BaseJWTPayload): boolean => {
    if (payload.role === ROLES.ADMIN) return true;
    return (payload.role_keys ?? []).includes(SYSTEM_ROLE_KEYS.ADMIN);
};

/**
 * T1 + Step-28 combined user-row read.
 *
 * Both gates (status check, admin-MFA) need a fresh read of the user
 * row on every authenticated request, so we coalesce them into ONE
 * `findById` per request that selects `status` + `mfa_enabled`.
 *
 * T1 status table:
 *   - `active`       → request continues with the loaded row.
 *   - `deactivated`  → 403 ACCOUNT_DEACTIVATED. Closes the
 *                       "JWT-outlives-deactivate" window — refresh
 *                       tokens are revoked at deactivate time, but
 *                       the access token lives 8h on its signature
 *                       alone, so without this gate a just-deactivated
 *                       user could keep mutating data for hours.
 *   - missing user   → 401 UNAUTHENTICATED (the token's user_id no
 *                       longer resolves; treat as forged for safety).
 *
 * Cost: one indexed findById per authenticated request. We
 * deliberately don't cache: deactivate must revoke access immediately.
 */
interface AuthUserRow {
    status: string;
    mfa_enabled?: boolean;
}

const loadAuthUserRow = async (userPayload: BaseJWTPayload): Promise<AuthUserRow> => {
    let userId: Types.ObjectId;
    try {
        userId = new Types.ObjectId(userPayload.user_id);
    } catch {
        throw AppError.unauthenticated();
    }
    const row = await User.findById(userId).select('status mfa_enabled').lean<AuthUserRow | null>();
    if (!row) {
        throw AppError.unauthenticated();
    }
    if (row.status !== USER_STATUSES.ACTIVE) {
        throw AppError.forbidden('Account is deactivated', ERROR_CODES.ACCOUNT_DEACTIVATED);
    }
    return row;
};

const enforceMfaGate = async (req: Request, userPayload: BaseJWTPayload, userRow: AuthUserRow): Promise<void> => {
    if (!isCallerAdmin(userPayload)) return;
    if (READ_METHODS.has(req.method)) return;
    if (isExemptFromMfaGate(req)) return;

    const settings = await getOrInitSettings();
    if (!settings.security.require_mfa_for_admins) return;

    if (!userRow.mfa_enabled) {
        throw AppError.forbidden(
            'Admins must enable MFA before performing this action — visit /auth/mfa/setup/init to enroll.',
            ERROR_CODES.MFA_REQUIRED
        );
    }
};

export const authenticate = async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        throw AppError.unauthenticated();
    }

    const token = authHeader.split(' ')[1];
    const payload = verifyAccessToken(token) as BaseJWTPayload & { type?: string };

    // Defence in depth: refresh or mfa_session tokens must never be accepted here,
    // even though the secrets differ / session type carries its own claim.
    if (payload.type) {
        throw AppError.unauthenticated();
    }

    req.user = payload;

    // T1 — close the deactivate-but-token-still-valid window AND fetch
    // the row needed by the Step-28 admin-MFA gate in the same query.
    const userRow = await loadAuthUserRow(payload);

    // Step 28: enforce the admin-MFA policy when configured. This runs
    // for every authenticated request; cheap short-circuits keep the
    // hot path fast on the typical "flag off" install.
    await enforceMfaGate(req, payload, userRow);

    next();
};

/**
 * Step 47 — RBAC permission gate.
 *
 * Replaces `authorize(...)` for role-based gates. Caller is allowed
 * through if EITHER:
 *  - they hold the `system.admin` wildcard (the seeded Admin role's
 *    sole permission), OR
 *  - they hold any one of `requiredPermissions` (OR semantics — pass
 *    multiple to require *any* of them; chain two `requirePermission`
 *    calls to require both).
 *
 * Pre-Step-47 tokens (no `permissions` claim) coerce to an empty
 * array and 403 here unless the wildcard short-circuit hits via the
 * legacy `role: 'admin'` field. This forces a re-login for non-admin
 * users on the first hit of a permission-gated route, which is the
 * desired behaviour for the Phase B migration window — the user
 * lands on `/auth/login`, the new login flow populates the JWT
 * permissions, and subsequent calls succeed.
 *
 * Empty `requiredPermissions` is a caller bug (would silently allow
 * everyone with any non-empty perms). Throw at module-load via the
 * factory rather than per-request to surface the typo immediately.
 */
export const requirePermission = (...requiredPermissions: Permission[]) => {
    if (requiredPermissions.length === 0) {
        throw new Error('requirePermission() called with no permissions — at least one required');
    }
    return (req: Request, _res: Response, next: NextFunction): void => {
        if (!req.user) {
            throw AppError.unauthenticated();
        }

        const held = req.user.permissions ?? [];

        // Wildcard fast-path. The seeded Admin role's sole permission
        // is `system.admin`; we accept it via either the resolved
        // permission set OR the legacy `role: 'admin'` claim so a
        // pre-Step-47 admin token still works during the migration
        // window.
        if (held.includes(PERMISSIONS.SYSTEM_ADMIN) || isCallerAdmin(req.user)) {
            next();
            return;
        }

        for (const perm of requiredPermissions) {
            if (held.includes(perm)) {
                next();
                return;
            }
        }

        throw AppError.forbidden();
    };
};

/**
 * Inline permission probe — same wildcard rules as `requirePermission`
 * but returns a boolean instead of throwing. Used by list controllers
 * that need to *silently* scrub privileged query params (e.g.
 * `show_deleted=true`) when a non-permitted caller sends them, rather
 * than rejecting the whole request.
 */
export const callerHasPermission = (req: Request, permission: Permission): boolean => {
    if (!req.user) return false;
    const held = req.user.permissions ?? [];
    if (held.includes(PERMISSIONS.SYSTEM_ADMIN) || isCallerAdmin(req.user)) return true;
    return held.includes(permission);
};
