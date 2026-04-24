import jwt from 'jsonwebtoken';
import { ulid } from 'ulid';

import { JWT_SECRET } from '../config/server.config.js';
import { MFA_SESSION_TTL_MS } from '../constants/auth.js';

/**
 * A short-lived bearer token issued after successful password verification when
 * the user has MFA enabled. Presented in the body of POST /auth/mfa/verify.
 *
 * Signed with JWT_SECRET (same key as access tokens) but the `type: 'mfa_session'`
 * claim prevents it from being accepted as an access token by `authenticate`
 * middleware — and vice versa. The `jti` collapses replay: once /mfa/verify
 * succeeds, the token is single-use for the client and effectively discarded.
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
    const token = jwt.sign(payload, JWT_SECRET, { expiresIn });
    return { token, expires_at: new Date(Date.now() + MFA_SESSION_TTL_MS) };
};

export const verifyMfaSession = (token: string): MfaSessionPayload => {
    const decoded = jwt.verify(token, JWT_SECRET) as MfaSessionPayload;
    if (decoded.type !== TYPE) {
        throw new jwt.JsonWebTokenError('Not an MFA session token');
    }
    return decoded;
};
