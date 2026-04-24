import jwt, { SignOptions } from 'jsonwebtoken';
import { ulid } from 'ulid';
import { JWT_SECRET, JWT_REFRESH_SECRET, JWT_EXPIRES_IN, JWT_REFRESH_EXPIRES_IN } from '../config/server.config.js';
import { BaseJWTPayload, RefreshJWTPayload } from '../types/index.js';

/**
 * JWT helpers (Company_Management_Plan.md §7 / API_Contract.md §2).
 *
 * Access tokens are stateless — verified by signature only.
 * Refresh tokens carry a unique `jti` (ULID) and are additionally looked up
 * in the `refresh_tokens` collection by SHA-256(token) for server-side
 * rotation + reuse detection.
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

export const createAccessToken = (payload: BaseJWTPayload): IssuedToken => {
    const token = jwt.sign(payload, JWT_SECRET, {
        expiresIn: JWT_EXPIRES_IN as SignOptions['expiresIn'],
    });
    return { token, expires_at: decodeExpiry(token) };
};

export const createRefreshToken = (payload: BaseJWTPayload): IssuedToken & { jti: string } => {
    const jti = ulid();
    const refreshPayload: RefreshJWTPayload = { ...payload, type: 'refresh', jti };
    const token = jwt.sign(refreshPayload, JWT_REFRESH_SECRET, {
        expiresIn: JWT_REFRESH_EXPIRES_IN as SignOptions['expiresIn'],
    });
    return { token, expires_at: decodeExpiry(token), jti };
};

export const verifyAccessToken = (token: string): BaseJWTPayload => {
    return jwt.verify(token, JWT_SECRET) as BaseJWTPayload;
};

export const verifyRefreshToken = (token: string): RefreshJWTPayload => {
    return jwt.verify(token, JWT_REFRESH_SECRET) as RefreshJWTPayload;
};
