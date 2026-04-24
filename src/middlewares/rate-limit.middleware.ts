import rateLimit from 'express-rate-limit';

/**
 * General-purpose limiter — applied globally on `/api/*`.
 * 120 requests / minute / IP.
 */
export const generalRateLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 120,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { message: 'Too many requests. Please retry later.' },
});

/**
 * Strict limiter for authentication endpoints (login, refresh, password-reset, MFA).
 * 10 requests / 15 minutes / IP — defence-in-depth alongside the
 * per-user 5-failed-attempt lockout enforced in the auth service (plan §7.2).
 * Successful requests are not counted.
 */
export const authRateLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    message: { message: 'Too many authentication attempts. Please retry later.' },
});
