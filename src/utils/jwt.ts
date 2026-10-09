import jwt, { SignOptions } from 'jsonwebtoken';
import { ulid } from 'ulid';
import {
    JWT_ACTIVE_KID,
    JWT_EXPIRES_IN,
    JWT_KEY_REGISTRY,
    JWT_REFRESH_ACTIVE_KID,
    JWT_REFRESH_EXPIRES_IN,
    JWT_REFRESH_KEY_REGISTRY,
    JWT_REFRESH_SECRET,
    JWT_SECRET,
} from '../config/server.config.js';
import { BaseJWTPayload, RefreshJWTPayload } from '../types/index.js';
import { jwtVerifyFailuresTotal } from './metrics.js';

/**
 * JWT helpers (Company_Management_Plan.md §7 / API_Contract.md §2).
 *
 * Access tokens are stateless — verified by signature only.
 * Refresh tokens carry a unique `jti` (ULID) and are additionally looked up
 * in the `refresh_tokens` collection by SHA-256(token) for server-side
 * rotation + reuse detection.
 *
 * **Key rotation (Step P0-3 in BACKEND_AUDIT.md):** When `JWT_ACTIVE_KID`
 * is set, every issued token carries a `kid` header naming the signing
 * key, and the verifier looks up the matching secret in the registry.
 * When unset (default / single-key mode), tokens are signed with the
 * legacy `JWT_SECRET` and have no `kid` header.
 *
 * Verification falls back gracefully: if a token carries a `kid` that
 * isn't in the registry, the verifier still tries the legacy
 * `JWT_SECRET` (so a malicious / future / typo'd kid doesn't bypass
 * the regular verify path). Same posture for refresh tokens with
 * their own registry.
 */

export interface IssuedToken {
    token: string;
    expires_at: Date;
}

const decodeExpiry = (token: string): Date => {
    const decoded = jwt.decode(token) as { exp?: number } | null;
    if (!decoded?.exp) {
        throw new Error('JWT missing exp claim');
    }
    return new Date(decoded.exp * 1000);
};

/**
 * Pick the signing secret. If `<active>_KID` is set + registered, use
 * that secret + return its kid (which the caller stamps into the token
 * header). Otherwise fall back to the legacy single-secret + null kid.
 *
 * Exported for reuse by `utils/mfa-session.ts` (R2 — MFA-session JWTs
 * share the access-key registry so a kid rotation is also graceful for
 * in-flight MFA challenges).
 */
export const pickSigningKey = (
    activeKid: string | null,
    registry: ReadonlyMap<string, string>,
    legacy: string
): { secret: string; kid: string | null } => {
    if (activeKid && registry.has(activeKid)) {
        return { secret: registry.get(activeKid)!, kid: activeKid };
    }
    return { secret: legacy, kid: null };
};

/**
 * Look up the verification secret for an incoming token. Reads the
 * token's `kid` header (without verifying) and returns the matching
 * registry entry, or the legacy single-secret if no kid was set.
 *
 * `kid` is read from the JOSE header and is not yet trusted at this
 * point — that's fine, we use it only as a key-table lookup. Fully
 * forged headers can't escape this function with anything other than
 * a registered secret or the legacy secret.
 *
 * Exported for reuse by `utils/mfa-session.ts` (R2).
 */
export const pickVerifyKey = (token: string, registry: ReadonlyMap<string, string>, legacy: string): string => {
    const decoded = jwt.decode(token, { complete: true }) as { header?: { kid?: unknown } } | null;
    const headerKid = decoded?.header?.kid;
    if (typeof headerKid === 'string' && registry.has(headerKid)) {
        return registry.get(headerKid)!;
    }
    return legacy;
};

export const createAccessToken = (payload: BaseJWTPayload): IssuedToken => {
    const { secret, kid } = pickSigningKey(JWT_ACTIVE_KID, JWT_KEY_REGISTRY, JWT_SECRET);
    const opts: SignOptions = { expiresIn: JWT_EXPIRES_IN as SignOptions['expiresIn'] };
    if (kid) opts.keyid = kid;
    const token = jwt.sign(payload, secret, opts);
    return { token, expires_at: decodeExpiry(token) };
};

export const createRefreshToken = (payload: BaseJWTPayload): IssuedToken & { jti: string } => {
    const jti = ulid();
    const refreshPayload: RefreshJWTPayload = { ...payload, type: 'refresh', jti };
    const { secret, kid } = pickSigningKey(JWT_REFRESH_ACTIVE_KID, JWT_REFRESH_KEY_REGISTRY, JWT_REFRESH_SECRET);
    const opts: SignOptions = { expiresIn: JWT_REFRESH_EXPIRES_IN as SignOptions['expiresIn'] };
    if (kid) opts.keyid = kid;
    const token = jwt.sign(refreshPayload, secret, opts);
    return { token, expires_at: decodeExpiry(token), jti };
};

export const verifyAccessToken = (token: string): BaseJWTPayload => {
    const secret = pickVerifyKey(token, JWT_KEY_REGISTRY, JWT_SECRET);
    try {
        return jwt.verify(token, secret) as BaseJWTPayload;
    } catch (err) {
        jwtVerifyFailuresTotal.inc({ kind: 'access' });
        throw err;
    }
};

/** Like `verifyAccessToken` but never throws and never counts a failure —
 *  for callers that only want a hint (the rate limiter runs before
 *  `authenticate`, which does the real, counted check on the same request).
 *  Refresh / MFA-session tokens (they carry a `type`) are not access tokens. */
export const tryVerifyAccessToken = (token: string): BaseJWTPayload | null => {
    try {
        const payload = jwt.verify(token, pickVerifyKey(token, JWT_KEY_REGISTRY, JWT_SECRET)) as BaseJWTPayload & {
            type?: string;
        };
        return payload.type ? null : payload;
    } catch {
        return null;
    }
};

export const verifyRefreshToken = (token: string): RefreshJWTPayload => {
    const secret = pickVerifyKey(token, JWT_REFRESH_KEY_REGISTRY, JWT_REFRESH_SECRET);
    try {
        return jwt.verify(token, secret) as RefreshJWTPayload;
    } catch (err) {
        jwtVerifyFailuresTotal.inc({ kind: 'refresh' });
        throw err;
    }
};
