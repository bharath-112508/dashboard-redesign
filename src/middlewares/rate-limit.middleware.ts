import rateLimit, { ipKeyGenerator } from 'express-rate-limit';

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

/**
 * Per-user limiter factory (BACKEND_AUDIT.md P2-9).
 *
 * The global `generalRateLimiter` is per-IP, which has two failure
 * modes on its own:
 *   1. Behind corporate NAT, hundreds of legitimate users share one
 *      IP — they collectively exhaust a 120 req/min budget.
 *   2. A logged-in attacker can rotate residential proxies to evade
 *      the per-IP cap entirely.
 *
 * Per-user limiters layer on top: bucket on `user_id` from `req.user`
 * (set by `authenticate`), so each authenticated caller has their own
 * budget for expensive endpoints regardless of which IP they come from.
 *
 * Falls back to IP for the (rare) unauthenticated case so the limiter
 * still has a key — but per-user routes always run after `authenticate`,
 * so this branch is defensive only.
 *
 * Buckets are in-memory per-instance. With multiple instances behind
 * a load balancer the effective limit is `instances × limit` per user;
 * this is acceptable for the advisory-not-security buckets here. The
 * security-critical login lockout lives in the auth service via
 * `failed_login_attempts` (Mongo-backed, instance-independent).
 */
export const buildUserRateLimiter = (opts: { windowMs: number; limit: number; messageKey: string }) =>
    rateLimit({
        windowMs: opts.windowMs,
        limit: opts.limit,
        standardHeaders: 'draft-7',
        legacyHeaders: false,
        keyGenerator: (req) => {
            // `req.user.user_id` is set by `authenticate`. Falls back to
            // the IP-aware default for unauthenticated requests so the
            // limiter never throws. `ipKeyGenerator` handles IPv6
            // address normalisation (express-rate-limit v8 contract).
            const userId = req.user?.user_id;
            if (userId) return `user:${userId}`;
            return `ip:${ipKeyGenerator(req.ip ?? '')}`;
        },
        message: { message: opts.messageKey },
    });

/**
 * Report-read limiter — applied on the synchronous report GETs.
 * 60 reads / minute / user is roughly "one report every second" which
 * a human-driven dashboard never approaches; well above legitimate
 * usage and well below an automated scrape.
 */
export const reportReadRateLimiter = buildUserRateLimiter({
    windowMs: 60 * 1000,
    limit: 60,
    messageKey: 'Too many report requests. Please slow down.',
});

/**
 * Report-export limiter — applied on the async export POST.
 * Each export kicks off a background render (PDF / XLSX / CSV) that
 * scans Mongo + writes a Blob — much heavier than the read path.
 * 10 exports / 15 min / user matches the rough throughput a manager
 * needs to assemble a quarterly report set without unblocking a
 * runaway loop.
 */
export const exportRateLimiter = buildUserRateLimiter({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    messageKey: 'Too many export requests. Please retry in a few minutes.',
});

/**
 * Search limiter — applied on `/search`. The search service hits a
 * regex `$or` across multiple collections; cheap individually but
 * pathological in a tight loop. 60 / minute / user lets a human-driven
 * type-ahead UI breathe while shutting down a scrape.
 */
export const searchRateLimiter = buildUserRateLimiter({
    windowMs: 60 * 1000,
    limit: 60,
    messageKey: 'Too many search requests. Please slow down.',
});

/**
 * Command-palette limiter — applied on `/command-palette` (H3).
 * The endpoint reuses the search service's regex `$or` queries when
 * `q.length >= 2`, so it shares the same per-call cost as `/search`.
 * Budget mirrors the search limiter (60/min/user) but is a SEPARATE
 * instance so a user using both surfaces gets the full budget on
 * each — the FE's Cmd-K palette and any future search page don't
 * compete for the same bucket.
 */
export const commandPaletteRateLimiter = buildUserRateLimiter({
    windowMs: 60 * 1000,
    limit: 60,
    messageKey: 'Too many palette requests. Please slow down.',
});
