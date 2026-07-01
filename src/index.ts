import express from 'express';
import cors, { type CorsOptions } from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import mongoose from 'mongoose';
import { pinoHttp } from 'pino-http';
import { ulid } from 'ulid';
import { StatusCodes } from 'http-status-codes';

import { JOBS_ENABLED, PORT, CORS_ORIGINS, NODE_ENV, TRUST_PROXY } from './config/server.config.js';
import connectDB, { disconnectDB } from './config/database.config.js';
import appRoutes from './routes/index.js';
import slackRoutes from './routes/slack.routes.js';
import eventsRoutes from './routes/events.routes.js';
import { globalErrorHandler } from './middlewares/error-handler.middleware.js';
import { realtimeEmit } from './middlewares/realtime-emit.middleware.js';
import { generalRateLimiter, healthRateLimiter } from './middlewares/rate-limit.middleware.js';
import { API_PREFIX, ERROR_CODES } from './constants/index.js';
import { ok } from './utils/api-response.js';
import { ensureBlobCorsRules, isAzureConfigured } from './utils/azure-blob.js';
import logger from './utils/logger.js';
import { getMetricsContentType, getMetricsText, recordHttp, unhandledRejectionTotal } from './utils/metrics.js';
import { seedDefaultLeaveTypes } from './services/leave-type.service.js';
// M16 — `migrateAttendanceSegments` (BUG-040 one-time backfill) removed.
// The backfill landed long enough ago that any unmigrated record would
// have been caught by smoke tests; the per-boot cursor scan was
// wasted work. If a future env needs a re-migration, the function is
// preserved in git history and can be re-introduced behind an explicit
// boot flag rather than running unconditionally.
import { bootstrapRolesMigration } from './services/role.service.js';
import { migratePlaintextSlackBotToken } from './services/slack-settings.service.js';
import { migrateShareLinkTokensToHashed } from './services/share-link.service.js';
import { migrateDisallowedPushEndpoints } from './services/push-subscription.service.js';
import { getScheduledJobCount, startScheduler, stopScheduler } from './jobs/index.js';
import { shutdownPdf } from './services/payroll/pdf.service.js';

const app = express();

// `trust proxy` controls how `req.ip` is derived from the X-Forwarded-For
// header — get the value wrong and rate limiting / audit log records the
// proxy IP instead of the client IP. Configured via `TRUST_PROXY` env;
// see `docs/deploy/trust-proxy-topology.md` for the per-deployment value.
app.set('trust proxy', TRUST_PROXY);

app.use(
    pinoHttp({
        logger,
        genReqId: (req, res) => {
            const incoming = (req.headers['x-request-id'] as string | undefined) ?? ulid();
            res.setHeader('x-request-id', incoming);
            return incoming;
        },
        customLogLevel: (_req, res, err) => {
            if (err || res.statusCode >= 500) return 'error';
            if (res.statusCode >= 400) return 'warn';
            return 'info';
        },
    })
);

// Helmet — JSON-only API, so we lock CSP all the way down: nothing is
// allowed to load FROM us into a browser context. The defaults already
// set sensible referrer / X-Frame / nosniff headers; we override CSP +
// COEP/COOP to match the API-only profile.
//
// `default-src 'none'` — refuse every fetch context (script, style,
//   image, font, connect, frame). Anything our routes return is JSON
//   that a browser shouldn't be parsing as a document anyway.
// `frame-ancestors 'none'` — refuse to be embedded in any iframe; the
//   X-Frame-Options shim is set to DENY for legacy UAs that ignore CSP.
// `base-uri 'none'` — no inline `<base>` injection vector (relevant for
//   the rare case an attacker gets HTML smuggled into a JSON response).
// `form-action 'none'` — no `<form action>` posts away from us.
// `upgradeInsecureRequests` is left enabled (Helmet default) so any
//   accidental http:// reference inside response bodies upgrades.
//
// See `BACKEND_AUDIT.md` P2-10 for the rationale. If we ever start
// serving HTML (status pages, public share-link landing), revisit
// these directives — `default-src 'none'` will block the page itself.
app.use(
    helmet({
        contentSecurityPolicy: {
            useDefaults: false,
            directives: {
                defaultSrc: ["'none'"],
                baseUri: ["'none'"],
                frameAncestors: ["'none'"],
                formAction: ["'none'"],
                upgradeInsecureRequests: [],
            },
        },
        // Cross-origin isolation: API responses are consumed by our SPA
        // (different origin); same-origin would break that, so use
        // `same-site` on COOP and `cross-origin` on CORP. COEP defaults
        // to require-corp which would reject responses from third-party
        // CDNs that don't set CORP — disable it for an API.
        crossOriginEmbedderPolicy: false,
        crossOriginOpenerPolicy: { policy: 'same-origin' },
        crossOriginResourcePolicy: { policy: 'cross-origin' },
    })
);

const corsOptions: CorsOptions = {
    origin: (origin, callback) => {
        if (!origin) return callback(null, true);
        if (CORS_ORIGINS.includes('*') || CORS_ORIGINS.includes(origin)) {
            return callback(null, true);
        }
        return callback(new Error(`CORS: origin ${origin} not allowed`));
    },
    credentials: false,
};
app.use(cors(corsOptions));

// M28 — `compression` is mounted AFTER the Slack raw-body boundary
// below. Today it's response-only and the ordering wouldn't matter,
// but a future "compression-equivalent" middleware that also reads
// the request body (e.g. transparent request-body inflate, or a
// security middleware that hashes the body) would silently break
// Slack signature verification, which is computed over the raw
// bytes. Keeping `compression` after the Slack mount is a
// defensive ordering: when this stack picks up such a middleware,
// the Slack boundary stays intact by construction. See also the
// `slackRoutes` mount comment a few lines down.
// ─── Body size limits (BACKEND_AUDIT.md P2-12) ────────────────────────
//
// Express's body-parser middleware short-circuits once `req.body` has
// been parsed (it sets a private flag), so the FIRST parser that
// matches a path wins. We exploit that to stack a tighter, route-scoped
// parser ahead of the global default — auth bodies (login / refresh /
// reset tokens) are well under 4 KB; we refuse anything larger so a
// hostile client can't burn parser CPU on megabyte-sized password
// payloads.
//
// All other routes fall through to the 1 MB default — large enough for
// the bulk-holiday import and for moderate JSON payloads, small enough
// to keep a runaway client from filling the request buffer. File
// uploads bypass this entirely (Azure Blob SAS direct-to-storage).
// Slack webhook routes — MUST be mounted BEFORE the global body
// parsers below. Slack signs the RAW request bytes; once
// `express.json` / `express.urlencoded` consume the stream the bytes
// are gone and HMAC-SHA256 verification fails. The slack router has
// its own raw-body parser inside (`slackWebhookMiddleware`) that
// captures the buffer, verifies the signature, then re-parses
// `req.body` for the handler. The central `appRoutes` router does
// not re-mount `/slack` — this early mount is the only one.
app.use(`${API_PREFIX}/slack`, slackRoutes);

// Real-time SSE stream — mounted BEFORE compression so the long-lived
// `text/event-stream` response is never buffered. Auth is enforced inside.
app.use(API_PREFIX, eventsRoutes);

// M28 — `compression` lives AFTER the Slack raw-body mount on purpose
// (see the long-form comment a few lines above). Today's compression
// middleware only touches responses, but the ordering is locked in
// here so a future request-touching variant can't silently break
// signature verification.
app.use(compression());

app.use(`${API_PREFIX}/auth`, express.json({ limit: '4kb' }));
app.use(`${API_PREFIX}/auth`, express.urlencoded({ extended: true, limit: '4kb' }));

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// Prometheus instrumentation (BACKEND_AUDIT.md P1-5). Captured AFTER
// the body parser + rate limiter so the timer reflects the full
// pipeline a real client sees, but BEFORE routes run so we can
// piggy-back on `res.on('finish')` for the duration sample.
app.use((req, res, next) => {
    const start = process.hrtime.bigint();
    res.on('finish', () => {
        const durationSec = Number(process.hrtime.bigint() - start) / 1e9;
        recordHttp(req, res, durationSec);
    });
    next();
});

app.use(API_PREFIX, generalRateLimiter);

// ─── Health probes (T6) ─────────────────────────────────────────────────
//
// Two endpoints, distinct semantics:
//
//   /health        — back-compat alias for `/health/live`. Some
//                    existing deploy probes / smoke scripts hit this
//                    path; keep it working with the same shape.
//   /health/live   — process is alive. Returns 200 when the event
//                    loop is responsive enough to render JSON.
//                    Liveness probes (k8s, App Service "always on")
//                    use this; a failure here means restart the
//                    container.
//   /health/ready  — process is ready to serve traffic. Returns 200
//                    only when EVERY downstream we depend on is
//                    healthy: Mongo connected, scheduler running
//                    (when JOBS_ENABLED), Mongo ping under 1 s.
//                    Readiness probes use this; a failure here
//                    means take the instance OUT of the LB pool
//                    until it recovers — not restart.
//
// Pre-T6 there was only `/health`, which returned 200 even when
// Mongo was partitioned or the scheduler had stopped — a zombie
// API would never auto-recover.

// M26 — `healthRateLimiter` (600/min/IP) on all health + metrics
// routes. Pre-M26 these sat OUTSIDE `/api/*` and so escaped the
// global limiter entirely; an anonymous flood could pin the cached
// Mongo ping or the Prometheus serialiser. Comfortable margin above
// any legitimate scrape (Prometheus default ~15-60s) and any
// orchestrator liveness probe (~10s).
app.get('/health', healthRateLimiter, (_req, res) => {
    return ok(res, { status: 'ok', env: NODE_ENV });
});

app.get('/health/live', healthRateLimiter, (_req, res) => {
    return ok(res, { status: 'ok', env: NODE_ENV });
});

// F3 — cached Mongo ping. The `db.admin().ping()` checks out a
// connection from the driver pool; under sustained burst load
// (every probe from K8s / App Service hits this), the ping itself
// queues on the pool, the 1s timeout fires, and the readiness probe
// reports 503 even when the cluster is healthy. K8s evicts the pod,
// traffic redistributes onto surviving pods, those saturate next —
// self-DDoS feedback loop.
//
// Cache the most recent result for `READY_PING_CACHE_MS`. The probe
// rate is typically 10s; a 5s cache means at most one ping every 5s
// regardless of inbound probe frequency. Stale-but-fresh data is the
// right tradeoff: a Mongo outage is recognised within 5s + 1s ping
// budget = 6s worst-case detection latency, which is still well
// under the typical K8s "3 failures × 10s interval = 30s" eviction
// window.
const READY_PING_CACHE_MS = 5_000;
const READY_PING_TIMEOUT_MS = 1_000;
let cachedMongoPing: { at: number; result: 'ok' | string } | null = null;

const checkMongoCached = async (now: number): Promise<'ok' | string> => {
    if (cachedMongoPing && now - cachedMongoPing.at < READY_PING_CACHE_MS) {
        return cachedMongoPing.result;
    }
    if (mongoose.connection.readyState !== 1) {
        const result = `not_connected (readyState=${mongoose.connection.readyState})`;
        cachedMongoPing = { at: now, result };
        return result;
    }
    const db = mongoose.connection.db;
    if (!db) {
        const result = 'no_db_handle';
        cachedMongoPing = { at: now, result };
        return result;
    }
    let result: 'ok' | string;
    try {
        const pingPromise = db.admin().ping();
        const timeoutPromise = new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('mongo ping timeout (>1s)')), READY_PING_TIMEOUT_MS)
        );
        await Promise.race([pingPromise, timeoutPromise]);
        result = 'ok';
    } catch (err) {
        result = err instanceof Error ? err.message : 'unknown_error';
    }
    cachedMongoPing = { at: now, result };
    return result;
};

app.get('/health/ready', healthRateLimiter, async (_req, res) => {
    const checks: Record<string, 'ok' | string> = {};
    let healthy = true;

    // 1. Mongo — cached so probe-rate doesn't drive pool pressure (F3).
    const mongoCheck = await checkMongoCached(Date.now());
    checks.mongo = mongoCheck;
    if (mongoCheck !== 'ok') healthy = false;

    // 2. Scheduler — only required when JOBS_ENABLED is on.
    if (JOBS_ENABLED) {
        const count = getScheduledJobCount();
        if (count === 0) {
            checks.scheduler = 'no_jobs_registered';
            healthy = false;
        } else {
            checks.scheduler = `ok (${count} jobs)`;
        }
    } else {
        checks.scheduler = 'disabled';
    }

    const status = healthy ? 200 : 503;
    return res.status(status).json({
        data: { status: healthy ? 'ok' : 'degraded', env: NODE_ENV, checks },
    });
});

// `/metrics` — OpenMetrics text payload for Prometheus / Grafana.
// Unauthenticated by design: the deploy network restricts it to the
// scrape origin (App Service VNet integration / Container Apps
// internal port). If we ever expose it on the public LB, gate with
// a shared-secret header here.
app.get('/metrics', healthRateLimiter, async (_req, res, next) => {
    try {
        res.setHeader('Content-Type', getMetricsContentType());
        res.send(await getMetricsText());
    } catch (err) {
        next(err);
    }
});

app.use(API_PREFIX, realtimeEmit);
app.use(API_PREFIX, appRoutes);

app.use('/{*path}', (_req, res) => {
    return res
        .status(StatusCodes.NOT_FOUND)
        .json({ error: { code: ERROR_CODES.RESOURCE_NOT_FOUND, message: 'Route not found' } });
});

app.use(globalErrorHandler);

const startServer = async () => {
    try {
        await connectDB();

        // Make sure the seven canonical leave types exist (idempotent).
        // Admin-tweaked rows are preserved via $setOnInsert.
        await seedDefaultLeaveTypes();

        // Step 47: seed the five system roles + back-fill `role_ids`
        // on any pre-RBAC users still carrying only the legacy `role`
        // string. Idempotent on a fully-migrated DB.
        await bootstrapRolesMigration();

        // M16 — BUG-040 one-time backfill of multi-segment attendance
        // was removed (was running on every boot even though the DB
        // was long-since migrated). See attendance.service.ts for the
        // matching deletion.

        // J1: encrypt-at-rest migration for any pre-J1 plaintext Slack
        // bot_token. Idempotent — a value that already looks like an
        // AES envelope is left alone. Boot continues even if migration
        // fails (the read path's plaintext fallback keeps the bot
        // operational).
        await migratePlaintextSlackBotToken();

        // C9: hash-at-rest migration for any pre-C9 plaintext share-link
        // tokens. Walks rows whose `token` field is set, computes
        // `sha256Hex(token)`, writes it to `token_hash`, clears `token`.
        // Idempotent — post-migration rows have `token: null` and are
        // skipped. Never throws.
        await migrateShareLinkTokensToHashed();

        // C8 follow-through: prune push-subscription rows whose
        // `endpoint` was stored pre-C8 (when any URL was accepted) and
        // doesn't pass the post-C8 hostname allowlist. The dispatcher
        // also re-checks at send time, but this one-shot migration
        // permanently deletes the bad rows so they stop consuming
        // dispatch attempts. Idempotent. Never throws.
        await migrateDisallowedPushEndpoints();

        // Configure the storage account's blob-service CORS rules so the
        // browser can PUT profile-photo / attachment bytes directly to a
        // SAS URL (and GET them back) from the FE origin. Without this the
        // cross-origin upload fails its preflight ("No Access-Control-
        // Allow-Origin header"). Self-healed from the same trusted origins
        // the API trusts (CORS_ORIGINS). Idempotent; never crashes boot.
        if (isAzureConfigured()) {
            try {
                await ensureBlobCorsRules(CORS_ORIGINS);
                logger.info({ origins: CORS_ORIGINS }, 'Configured Azure Blob CORS for browser uploads');
            } catch (err) {
                logger.warn(
                    { err, code: 'BLOB_CORS_CONFIG_FAILED' },
                    'Failed to configure Azure Blob CORS — direct browser uploads may be blocked'
                );
            }
        }

        // L3 — bind explicitly to `0.0.0.0` so the host interface is
        // grep-able + obvious. Defaulting (no host arg) lands on the
        // same address on Azure App Service / Container Apps / K8s,
        // but explicit is safer when the deploy target changes — a
        // future image that boots on localhost-only by default would
        // silently fail readiness probes.
        const server = app.listen(PORT, '0.0.0.0', () => {
            logger.info({ port: PORT, env: NODE_ENV, api_prefix: API_PREFIX }, 'Server is running');
            // Start scheduled jobs only after the HTTP server is up so a
            // boot failure can't leave a half-initialized cron registry
            // running against a half-initialized DB connection. Disabled
            // automatically when JOBS_ENABLED=false (tests + smoke).
            // `startScheduler` is async (reads nudge fire-times from
            // settings); a failure must never crash the listen callback.
            void startScheduler().catch((err: unknown) => {
                logger.error({ err }, 'Failed to start job scheduler');
            });
        });

        // H16 — HTTP server timeouts. Node 18+ defaults are 300 s
        // (`requestTimeout`) and 60 s (`headersTimeout`), which leave
        // sockets tied up by Slowloris-style trickle attacks for the
        // full default window. Behind Azure Front Door / any cloud
        // LB, `keepAliveTimeout` must also be > the LB's idle timeout
        // (~60 s for Front Door) or socket hang-ups create spurious
        // 502s.
        //
        // 30 s request timeout is well past every legitimate API call
        // (the longest sync path is the billing report exporter at
        // ~1-2 s); 65 s headers timeout pads a small slack above
        // keep-alive so a hung header doesn't slip past the keep-alive
        // cleanup.
        server.requestTimeout = 30_000;
        server.headersTimeout = 65_000;
        server.keepAliveTimeout = 61_000;

        const shutdown = async (signal: string) => {
            logger.info({ signal }, 'Shutdown signal received, closing gracefully');

            // F5 — extended watchdog (30s) so the cron-drain step in
            // `stopScheduler` (capped to 25s internally) has time to
            // settle in-flight handlers BEFORE we disconnect Mongo.
            // The HTTP server close runs in parallel — most pending
            // requests resolve in milliseconds, so they're not the
            // long pole.
            setTimeout(() => {
                logger.error('Could not close connections in time, forcefully shutting down');
                process.exit(1);
            }, 30000);

            // C7 — pre-fix `server.close(async () => …)` was fire-and-
            // forget; `disconnectDB()` could run while an HTTP handler
            // was still mid-await on Mongo, causing the in-flight
            // request to 500 with `MongoNotConnectedError`. Now we
            // promisify `server.close` and AWAIT it so step 2 only
            // starts after every in-flight request has resolved.
            //
            // 1. Stop accepting new HTTP connections AND drain
            //    in-flight requests.
            try {
                await new Promise<void>((resolve) => {
                    server.close((err) => {
                        if (err) {
                            logger.warn({ err }, 'server.close errored during shutdown');
                        } else {
                            logger.info('HTTP server closed');
                        }
                        resolve();
                    });
                });
            } catch (err) {
                // server.close's callback handles errors above; the
                // promise itself shouldn't throw, but defence in depth.
                logger.warn({ err }, 'server.close promise rejected during shutdown');
            }

            // 2. Close the Playwright browser used by the payroll PDF
            //    renderer so Chromium doesn't linger as an orphaned
            //    child process after the Node process exits.
            try {
                await shutdownPdf();
                logger.info('Playwright browser closed');
            } catch (err) {
                logger.warn({ err }, 'shutdownPdf threw during shutdown');
            }

            // 3. Drain cron handlers (F5 — `stopScheduler` is now
            //    async + awaits in-flight runJob promises up to 25s).
            try {
                await stopScheduler();
            } catch (err) {
                logger.warn({ err }, 'stopScheduler threw during shutdown');
            }

            // 4. Disconnect Mongo — only AFTER both HTTP + cron have
            //    drained so handlers that needed the DB to finalise
            //    their `job_runs` row + audit didn't lose access
            //    mid-write.
            try {
                await disconnectDB();
            } catch (err) {
                logger.warn({ err }, 'disconnectDB threw during shutdown');
            }

            process.exit(0);
        };

        process.on('SIGTERM', () => {
            shutdown('SIGTERM').catch((err) => logger.error({ err }, 'shutdown threw'));
        });
        process.on('SIGINT', () => {
            shutdown('SIGINT').catch((err) => logger.error({ err }, 'shutdown threw'));
        });

        // L2 — the Node ≥15 default for `unhandledRejection` is throw →
        // `uncaughtException` → exit. We swallow + log instead: the
        // most likely sources are best-effort fire-and-forget side
        // effects (audit dispatch failures, notification dispatch
        // retries) that shouldn't kill the API. The `unhandledRejectionTotal`
        // Prometheus counter gives ops a dashboard signal so a spike
        // is still visible even though the process stays up.
        process.on('unhandledRejection', (reason) => {
            unhandledRejectionTotal.inc();
            logger.error({ reason }, 'Unhandled promise rejection');
        });
        process.on('uncaughtException', (err) => {
            logger.fatal({ err }, 'Uncaught exception');
            process.exit(1);
        });
    } catch (error) {
        logger.error({ err: error }, 'Failed to start server');
        process.exit(1);
    }
};

startServer();
