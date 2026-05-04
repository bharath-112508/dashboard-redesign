import { Request, Response, NextFunction } from 'express';
import { Types } from 'mongoose';

import { verifyAccessToken } from '../utils/jwt.js';
import { AppError } from '../utils/app-error.js';
import { ROLES, RoleType } from '../constants/index.js';
import { ERROR_CODES } from '../constants/error-codes.js';
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
const enforceMfaGate = async (req: Request, userPayload: BaseJWTPayload): Promise<void> => {
    if (userPayload.role !== ROLES.ADMIN) return;
    if (READ_METHODS.has(req.method)) return;
    if (isExemptFromMfaGate(req)) return;

    const settings = await getOrInitSettings();
    if (!settings.security.require_mfa_for_admins) return;

    const userRow = await User.findById(new Types.ObjectId(userPayload.user_id))
        .select('mfa_enabled')
        .lean<{ mfa_enabled: boolean } | null>();

    if (!userRow?.mfa_enabled) {
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

    // Step 28: enforce the admin-MFA policy when configured. This runs
    // for every authenticated request; cheap short-circuits keep the
    // hot path fast on the typical "flag off" install.
    await enforceMfaGate(req, payload);

    next();
};

export const authorize = (...allowedRoles: RoleType[]) => {
    return (req: Request, _res: Response, next: NextFunction): void => {
        if (!req.user) {
            throw AppError.unauthenticated();
        }

        if (!allowedRoles.includes(req.user.role)) {
            throw AppError.forbidden();
        }

        next();
    };
};
