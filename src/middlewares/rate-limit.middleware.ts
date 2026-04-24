import rateLimit from 'express-rate-limit';

import { AUTH_RATE_LIMIT_MAX, GENERAL_RATE_LIMIT_MAX } from '../config/server.config.js';

/**
 * General-purpose limiter — applied globally on `/api/*`.
 * Default: 120 requests / minute / IP. Override with `GENERAL_RATE_LIMIT_MAX`.
 */
export const generalRateLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: GENERAL_RATE_LIMIT_MAX,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { message: 'Too many requests. Please retry later.' },
});

/**
 * Strict limiter for authentication endpoints (login, refresh, password-reset, MFA).
 * Default: 10 requests / 15 minutes / IP — defence-in-depth alongside the
 * per-user 5-failed-attempt lockout enforced in the auth service (plan §7.2).
 * Successful requests are not counted. Override with `AUTH_RATE_LIMIT_MAX`.
 */
export const authRateLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: AUTH_RATE_LIMIT_MAX,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    message: { message: 'Too many authentication attempts. Please retry later.' },
});
