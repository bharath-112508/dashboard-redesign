import jwt, { type SignOptions } from 'jsonwebtoken';
import { ulid } from 'ulid';

import { JWT_ACTIVE_KID, JWT_KEY_REGISTRY, JWT_SECRET } from '../config/server.config.js';
import { MFA_SESSION_TTL_MS } from '../constants/auth.js';
import { MfaSessionUsedJti } from '../models/mfa-session-used-jti.model.js';
import { pickSigningKey, pickVerifyKey } from './jwt.js';
import { jwtVerifyFailuresTotal } from './metrics.js';

/**
 * A short-lived bearer token issued after successful password verification when
 * the user has MFA enabled. Presented in the body of POST /auth/mfa/verify.
 *
 * Signed against the SAME key registry as access tokens (`JWT_KEY_REGISTRY`),
 * so a `kid` rotation per the runbook in `.env.example` is graceful for
 * MFA challenges in flight too — see BACKEND_AUDIT.md R2. The
 * `type: 'mfa_session'` claim prevents the token from being accepted as
 * an access token by `authenticate` middleware (and vice versa).
 *
 * The `jti` is consumed by `consumeMfaSessionJti` after a successful
 * verify (BACKEND_AUDIT.md R10) so the same token can never be replayed.
 * The `mfa_session_used_jtis` collection is keyed on `jti` with a TTL
 * index that auto-expires rows at the JWT's `exp` claim — replay
 * protection costs at most one row per successful MFA verify, and they
 * GC themselves.
 */

const TYPE = 'mfa_session' as const;

export interface MfaSessionPayload {
    user_id: string;
    type: typeof TYPE;
    jti: string;
}

export interface IssuedMfaSession {
    token: string;
    expires_at: Date;
}

export const issueMfaSession = (user_id: string): IssuedMfaSession => {
    const payload: MfaSessionPayload = { user_id, type: TYPE, jti: ulid() };
    const expiresIn = Math.floor(MFA_SESSION_TTL_MS / 1000);
    const { secret, kid } = pickSigningKey(JWT_ACTIVE_KID, JWT_KEY_REGISTRY, JWT_SECRET);
    const opts: SignOptions = { expiresIn };
    if (kid) opts.keyid = kid;
    const token = jwt.sign(payload, secret, opts);
    return { token, expires_at: new Date(Date.now() + MFA_SESSION_TTL_MS) };
};

/**
 * Verified MFA-session payload. Surfaces `exp` from the JWT so callers
 * can use it as the TTL anchor when consuming the JTI (R10 — replay
 * guard).
 */
export interface VerifiedMfaSessionPayload extends MfaSessionPayload {
    /** Unix seconds — present on every signed token. */
    exp: number;
}

export const verifyMfaSession = (token: string): VerifiedMfaSessionPayload => {
    const secret = pickVerifyKey(token, JWT_KEY_REGISTRY, JWT_SECRET);
    let decoded: VerifiedMfaSessionPayload;
    try {
        decoded = jwt.verify(token, secret) as VerifiedMfaSessionPayload;
    } catch (err) {
        jwtVerifyFailuresTotal.inc({ kind: 'mfa_session' });
        throw err;
    }
    if (decoded.type !== TYPE) {
        jwtVerifyFailuresTotal.inc({ kind: 'mfa_session' });
        throw new jwt.JsonWebTokenError('Not an MFA session token');
    }
    return decoded;
};

/**
 * R10 — replay guard. Atomically marks the MFA-session JTI as used
 * by inserting a row in `mfa_session_used_jtis`. Returns true on
 * first use; throws an `MfaSessionReplayError` on E11000 (the same
 * JTI was consumed before).
 *
 * Caller should invoke this AFTER the TOTP / backup-code check
 * passes — that way a user mistyping their code doesn't burn the
 * session and force a re-login. Burning happens once we're sure a
 * successful verify is about to issue tokens.
 *
 * `expiresAt` is the JWT's `exp` claim (Date). The TTL index on the
 * model removes the row at that point so the collection stays bounded.
 */
export class MfaSessionReplayError extends Error {
    constructor() {
        super('MFA session token has already been used');
        this.name = 'MfaSessionReplayError';
    }
}

const isE11000 = (err: unknown): boolean =>
    !!err && typeof err === 'object' && 'code' in err && (err as { code: number }).code === 11000;

export const consumeMfaSessionJti = async (jti: string, expiresAt: Date): Promise<void> => {
    try {
        await MfaSessionUsedJti.create({ jti, expires_at: expiresAt });
    } catch (err) {
        if (isE11000(err)) {
            throw new MfaSessionReplayError();
        }
        throw err;
    }
};
