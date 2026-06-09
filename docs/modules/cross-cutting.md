# Cross-cutting infrastructure — Backend

The platform plumbing every other module sits on top of. Six themes:

1. **Boot + middleware order** ([`src/index.ts`](../../src/index.ts)) — trust proxy, pino-http, helmet, CORS, Slack-before-parsers, body limits, prom metrics, rate limit, routes, error handler.
2. **Error model** — `AppError` class + `globalErrorHandler` + canonical `{error: {code, message, details?}}` envelope.
3. **Response envelope + async wrapper** — `ok`/`created`/`noContent`/`paginated` + `asyncHandler`.
4. **Validation** — Zod middleware + empty-body coercion.
5. **Persistence atomicity** — `withTransaction` helper + graceful degradation on non-replica-set topology.
6. **Observability** — pino logger with M23 redaction + App Insights bridge + Prometheus metrics.
7. **Boot migrations + cron scheduler** — five boot migrations + the registry of 11 scheduled jobs with consecutive-failure tracking.
8. **Graceful shutdown** — server.close → cron drain → Mongo disconnect, in that exact order.

Cross-references: every module documented in this directory uses some of this layer. Auth specifically is documented in [`auth-identity.md`](./auth-identity.md); audit's `recordAudit` non-throwing contract in [`audit-compliance.md`](./audit-compliance.md); JWT details in the auth module.

---

## Scope

| Theme | Files |
|---|---|
| Boot + shutdown | [`src/index.ts`](../../src/index.ts), [`config/server.config.ts`](../../src/config/server.config.ts), [`config/database.config.ts`](../../src/config/database.config.ts) |
| Routes + middleware | [`routes/index.ts`](../../src/routes/index.ts), [`middlewares/*.ts`](../../src/middlewares/) |
| Error model | [`utils/app-error.ts`](../../src/utils/app-error.ts), [`middlewares/error-handler.middleware.ts`](../../src/middlewares/error-handler.middleware.ts), [`constants/error-codes.ts`](../../src/constants/error-codes.ts) |
| Response shape | [`utils/api-response.ts`](../../src/utils/api-response.ts), [`utils/async-handler.ts`](../../src/utils/async-handler.ts) |
| Validation | [`middlewares/validate.middleware.ts`](../../src/middlewares/validate.middleware.ts) |
| Atomicity | [`utils/with-transaction.ts`](../../src/utils/with-transaction.ts) |
| Logging | [`utils/logger.ts`](../../src/utils/logger.ts) |
| Metrics | [`utils/metrics.ts`](../../src/utils/metrics.ts) |
| Date / TZ helpers | [`utils/date.ts`](../../src/utils/date.ts) (IST default) |
| Bounded concurrency | [`utils/run-with-concurrency.ts`](../../src/utils/run-with-concurrency.ts) |
| Crypto + secrets | [`utils/crypto-aes.ts`](../../src/utils/crypto-aes.ts), [`utils/password.ts`](../../src/utils/password.ts), [`utils/token-hash.ts`](../../src/utils/token-hash.ts) |
| Blob storage | [`utils/azure-blob.ts`](../../src/utils/azure-blob.ts) |
| Email | [`utils/mailer.ts`](../../src/utils/mailer.ts) + [`utils/email-transports/`](../../src/utils/email-transports/) (stub/acs/mailjet) |
| Job scheduler | [`jobs/index.ts`](../../src/jobs/index.ts), [`jobs/runner.ts`](../../src/jobs/runner.ts), per-job `*.job.ts` files |
| Role utility | [`utils/role-check.ts`](../../src/utils/role-check.ts) |
| Comment sanitiser | [`utils/comment-sanitiser.ts`](../../src/utils/comment-sanitiser.ts) — HTML allowlist for task comments |

---

## 1. Boot order ([`src/index.ts`](../../src/index.ts))

The single most opinionated file in the codebase. **Middleware order matters**; the comments inline are extensive because reordering things silently breaks security guarantees.

```
1.  app.set('trust proxy', TRUST_PROXY)            ← so req.ip is the client IP (per-deploy value)
2.  pinoHttp({ logger, genReqId, customLogLevel }) ← x-request-id mint + status-code-aware level
3.  helmet({                                       ← API-only CSP locked down
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ['none'],   baseUri:     ['none'],
          frameAncestors: ['none'], formAction: ['none'],
          upgradeInsecureRequests: [],
        }
      },
      crossOriginEmbedderPolicy: false,            ← API consumed by separate-origin SPA
      crossOriginOpenerPolicy: 'same-origin',
      crossOriginResourcePolicy: 'cross-origin',
    })
4.  cors({ origin: allowlist or '*' })             ← CORS_ORIGINS from env
5.  app.use('/api/v1/slack', slackRoutes)          ← MUST be before body parsers (raw-body for HMAC)
6.  app.use(compression())                          ← M28: AFTER Slack mount — defensive ordering
7.  app.use('/api/v1/auth', express.json({limit: '4kb'}))      ← scoped tight on auth bodies
8.  app.use(express.json({limit: '1mb'}))                       ← global default
9.  HTTP metrics middleware (res.on('finish') hook)             ← capture duration + labels
10. app.use('/api/v1', generalRateLimiter)         ← 120/min/IP
11. /health, /health/live, /health/ready, /metrics ← healthRateLimiter (600/min/IP), OUTSIDE /api/*
12. app.use('/api/v1', appRoutes)                  ← business routes assembled in routes/index.ts
13. 404 catch-all                                  ← /{*path} → RESOURCE_NOT_FOUND
14. globalErrorHandler                             ← MUST be the last middleware
```

### Why each ordering matters

| Step | Consequence of moving |
|---|---|
| 1. trust proxy | Wrong value → `req.ip` is the proxy IP → rate limiter buckets everyone together; audit IP wrong |
| 2. pino-http | Before middleware → no log of routing decisions. After helmet → headers logged before sanitisation |
| 3. helmet | Move after auth → 401 responses miss CSP headers |
| 5. Slack mount | **CRITICAL** — Slack signs raw bytes; if body parsers run first, HMAC fails (slack-webhook.middleware captures `express.raw` itself) |
| 6. compression | M28 — kept AFTER Slack mount as defensive ordering for future request-touching variants |
| 7. auth tight limit | Hostile client sends 5 MB password payload → server burns parser CPU. 4 KB ceiling on `/auth/*` only |
| 8. global 1 MB | Bulk holiday import + JSON payloads. Tighter would break legitimate bulks |
| 9. HTTP metrics | AFTER body parser → duration includes parse time. BEFORE routes → finish hook fires |
| 11. health | OUTSIDE `/api/*` → escapes generalRateLimiter. M26 adds `healthRateLimiter` 600/min/IP |
| 12. routes | LAST before 404 — anything afterwards short-circuits the 404 catch-all |
| 14. error handler | MUST be last — Express invokes error middleware only after all others |

### Health probe semantics (T6)

| Endpoint | Returns | Used by |
|---|---|---|
| `/health` | 200 always (back-compat alias) | Legacy probes |
| `/health/live` | 200 if event loop responsive (no DB hit) | k8s **liveness** — failure → restart container |
| `/health/ready` | 200 iff Mongo connected AND scheduler running (when JOBS_ENABLED) | k8s **readiness** — failure → remove from LB |

**F3 — cached Mongo ping** (`READY_PING_CACHE_MS = 5_000`, `READY_PING_TIMEOUT_MS = 1_000`): the readiness probe ran `db.admin().ping()` per request → under K8s 10s probe cadence per pod, ping queues on the connection pool, 1s timeout fires → false-positive 503 → eviction → self-DDoS feedback loop. 5s cache means at most one ping every 5s; 6s worst-case detection latency.

### Graceful shutdown sequence

```
SIGTERM / SIGINT:
  1. server.close()         ← stop accepting new conns; await in-flight (C7 — promisified)
  2. stopScheduler()        ← cron drain (F5 — await in-flight runJob promises ≤ 25s)
  3. disconnectDB()         ← Mongo close
  ── 30s outer watchdog ──  ← logger.error + process.exit(1) if step 1-3 don't complete

unhandledRejection         ← unhandledRejectionTotal.inc() + log; do NOT exit (L2)
uncaughtException          ← logger.fatal + process.exit(1)
```

**C7** — pre-fix `server.close(async () => disconnectDB())` was fire-and-forget; `disconnectDB` could run while a handler was still mid-await on Mongo → `MongoNotConnectedError`. Promisified close + await before step 2.

**F5** — `stopScheduler` is async; awaits in-flight handlers up to `JOB_SCHEDULER_DRAIN_TIMEOUT_MS` (25s) before resolving. The outer 30s watchdog leaves 5s for steps 2-3 to settle.

**L2** — Node ≥15 default for `unhandledRejection` is throw → `uncaughtException` → exit. We swallow + log instead: best-effort fire-and-forget side effects (audit dispatch retries) shouldn't kill the API. `unhandledRejectionTotal` Prometheus counter exposes the rate.

**H16 — HTTP server timeouts**: `requestTimeout: 30_000`, `headersTimeout: 65_000`, `keepAliveTimeout: 61_000`. Node 18+ defaults are 300s + 60s respectively → Slowloris-style attacks tie up sockets for the full default window. Behind Azure Front Door (~60s idle timeout), `keepAliveTimeout` MUST be > LB idle timeout or socket hangups create spurious 502s.

**L3** — `app.listen(PORT, '0.0.0.0', ...)` — explicit bind. Defaulting (no host arg) lands the same on Azure but explicit is safer when the deploy target changes.

### Boot migrations

Run sequentially BEFORE `app.listen()`:

```
1. connectDB()
2. seedDefaultLeaveTypes()                    ← 7 canonical types via $setOnInsert (idempotent)
3. bootstrapRolesMigration()                  ← Step 47 — seed 5 system roles + backfill role_ids
4. migratePlaintextSlackBotToken()            ← J1 — AES-encrypt any legacy plaintext bot_token
5. migrateShareLinkTokensToHashed()           ← C9 — sha256 share-link tokens
6. migrateDisallowedPushEndpoints()           ← C8 — prune SSRF-vulnerable push endpoints
7. app.listen() → startScheduler() inside callback
```

All migrations are **idempotent** + **never throw** (failures log warn + boot continues). Cron starts inside the `app.listen` callback so a boot failure can't leave a half-initialized cron registry running.

---

## 2. Error model

### `AppError` class ([`utils/app-error.ts`](../../src/utils/app-error.ts))

```ts
class AppError extends Error {
  statusCode: number;
  code: ErrorCode;     // canonical from constants/error-codes.ts (60+ values)
  details?: unknown;
}
```

Static factories shape every status code:
- `AppError.validation(message, details)` → 400 `VALIDATION_ERROR`
- `AppError.badRequest(message, code?, details)` → 400 (custom code)
- `AppError.unauthenticated(message?)` → 401 `UNAUTHENTICATED`
- `AppError.invalidCredentials(message?)` → 401 `INVALID_CREDENTIALS`
- `AppError.tokenExpired(message?)` → 401 `TOKEN_EXPIRED`
- `AppError.forbidden(message?, code?)` → 403 `FORBIDDEN`
- `AppError.notFound(message?, code?)` → 404 `RESOURCE_NOT_FOUND`
- `AppError.conflict(message, code?, details?)` → 409 `DUPLICATE_RESOURCE` (default)
- `AppError.gone(message, code, details?)` → 410 (deliberately-removed reference)
- `AppError.unprocessable(message, code, details?)` → 422 (custom domain code)
- `AppError.accountLocked(message?)` → 423 `ACCOUNT_LOCKED`
- `AppError.internal(message?)` → 500 `INTERNAL_ERROR`

### `globalErrorHandler` middleware

Single sink for every thrown error. Maps to canonical envelope `{error: {code, message, details?}}`:

| Caught error | Status | Code | Notes |
|---|---|---|---|
| `AppError` | err.statusCode | err.code | Pre-shaped — log + return |
| `jwt.TokenExpiredError` | 401 | `TOKEN_EXPIRED` | warn-log |
| `jwt.JsonWebTokenError` | 401 | `UNAUTHENTICATED` | warn-log |
| Mongoose `CastError` (bad ObjectId) | 400 | `VALIDATION_ERROR` | `{field}` in details |
| Mongoose `ValidationError` | 400 | `VALIDATION_ERROR` | `{errors: [{field, message}]}` |
| Mongo E11000 (duplicate) | 409 | `DUPLICATE_RESOURCE` | **R14** — echoes field NAMES only, never values |
| Anything else | 500 | `INTERNAL_ERROR` | Prod: generic message; dev: `err.message` |

**R14** — pre-R14 the duplicate handler echoed `keyValue` (which contains the actual collided value: raw token strings, synthetic GDPR emails, etc.). The caller already supplied the value; echoing it adds nothing and leaks server-side secrets. Now `Object.keys(keyValue ?? keyPattern)` only.

---

## 3. Response envelope + async wrapper

### `api-response.ts` — Canonical shape per API Contract §1.4

```
ok(res, data)            → 200 { data }
ok(res, data, meta)      → 200 { data, meta }
created(res, data)       → 201 { data }
noContent(res)           → 204 (empty body)
paginated(res, data, m)  → 200 { data, meta: { page, limit, total, total_pages } }
```

Every controller wraps its return through these — guarantees the wire shape.

### `asyncHandler(fn)` — Promise→next bridge

```ts
asyncHandler(fn) = (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);
```

Without this, an `async` controller's rejected promise vanishes (Express doesn't await handlers natively). Wrap **every** async route handler — the pattern is enforced by convention.

---

## 4. Validation ([`middlewares/validate.middleware.ts`](../../src/middlewares/validate.middleware.ts))

```ts
validate({ body?, query?, params? })
```

Each schema is a Zod `ZodType<unknown>`. The middleware:

1. **Empty-body coercion (Step 15.2)** — for object body schemas, `undefined` / `null` `req.body` is coerced to `{}` before parsing. Lets `POST /users/:id/deactivate` accept an empty body (curl with no `-d`, browser fetch with no body for optional-reason flows). Schemas with required fields still surface field-level "Required" errors instead of "expected object" on the whole body.

2. **`parseAsync` per part** — coerced values write back to `req.body` / `req.query` / `req.params`. Controllers see the coerced + defaulted shape.

3. **Express 5 query getter** — `req.query` became getter-only in Express 5; the middleware uses `Object.defineProperty` instead of `Object.assign` (which would silently no-op).

4. **Failure** — wraps `ZodError` as `AppError.validation('Validation failed', {errors: [{field: issue.path.join('.'), message}]})`. Field paths use dot notation matching the input shape.

---

## 5. Atomicity — `withTransaction` ([`utils/with-transaction.ts`](../../src/utils/with-transaction.ts))

```ts
withTransaction(async (session) => {
  const u = await User.create([input], { session });
  await LeaveBalance.create(rows.map(r => ({ ...r, user_id: u[0]._id })), { session });
  return u[0];
})
```

**Every write inside the callback MUST pass `{ session }`** — without it, the operation runs outside the transaction silently (no error, no rollback). The codebase relies on this convention; forgetting `{ session }` is the most common source of "rollback didn't happen" bugs.

### Three execution branches

| Topology | Behavior |
|---|---|
| Replica set (Atlas, prod) | Real transaction; `session.withTransaction` retries on `TransientTransactionError` + `UnknownTransactionCommitResult` |
| Standalone mongod (local dev) | Catches `Transaction numbers are only allowed on a replica set` error → falls back to non-atomic sequential writes + logs warn |
| Mongoose `readyState !== 1` (mocked in vitest) | Runs callback without a session — matches pre-helper behaviour |

The `readyState` check is critical: `mongoose.startSession()` against an unconnected Mongoose **buffers for 10s** before throwing (default `bufferTimeoutMS`). In tests where models are `vi.mock`'d, that would hang every test through this helper. Bypass by checking the connection state up-front.

### Audit + transaction interaction

**Audit writes inside `withTransaction` retry with the transaction** (intentional). On a commit conflict the callback runs again — audit row needs to retry too, otherwise the retried transaction would lose its audit row.

---

## 6. Logging + metrics

### Logger ([`utils/logger.ts`](../../src/utils/logger.ts))

**pino** instance with three layers:

| Component | Purpose |
|---|---|
| `redact: {paths: [...], remove: true}` | M23 — strips secrets from ANY log payload tree. 17 known field names: `password`, `token`, `refresh_token`, `authorization`, `bot_token`, `slack_signing_secret`, `vapid_private_key`, `mfa_secret_encrypted`, `mfa_backup_codes_hashed`, `totp_secret`, `mfa_session_token`, `azure_storage_connection_string`, `connection_string`, `api_secret`, `api_key` + 4 HTTP request headers/body paths |
| `pino-http` (req/res logger) | x-request-id mint via `ulid()` if header absent; status-code-aware level (5xx → error, 4xx → warn) |
| App Insights bridge (V2-OPS-3) | When `APPLICATIONINSIGHTS_CONNECTION_STRING` set, multistream to stdout + AI's `trackTrace`/`trackException`. Auto-collection (HTTP/dep/console) disabled to avoid duplicate request logs |

**Dev mode** (`NODE_ENV !== 'production'` + no AI): `pino-pretty` transport with colours.

**Failure mode** — AI bootstrap exceptions log to stderr once + fall through to stdout-only. The application's log pipeline never breaks.

### Metrics ([`utils/metrics.ts`](../../src/utils/metrics.ts))

`prom-client` default registry + bound custom metrics. `getOrCreateCounter` / `getOrCreateHistogram` / `getOrCreateGauge` lazy idempotent: tests `vi.resetModules()` re-evaluate this module while prom-client's native module stays cached — without `getSingleMetric` lookup the second registration throws.

| Metric | Labels | Source |
|---|---|---|
| `viljetech_http_requests_total` | `method, route, status_class` | `recordHttp` from finish hook |
| `viljetech_http_request_duration_seconds` | same | histogram, buckets sized for an internal API |
| `viljetech_job_runs_total` | `name, status (success/failed/skipped)` | Job runner |
| `viljetech_job_run_duration_seconds` | same | Histogram, buckets 0.5–1800s |
| `viljetech_stuck_jobs_swept_total` | none | `stuck_job_sweeper` cron |
| `viljetech_unhandled_rejection_total` | none | L2 process handler |
| `viljetech_audit_writes_total` | `outcome (ok/failed)` | `recordAudit` |
| `viljetech_audit_snapshot_dropped_total` | `which (before/after)` | G4 — 16 KiB cap fired |
| `viljetech_audit_log_mirror_lag_rows` | none (gauge) | R9 — mirror cron sets per tick |
| `viljetech_jwt_verify_failures_total` | `kind (access/refresh/mfa_session)` | Auth middleware |
| `viljetech_refresh_tokens_issued_total` | `reason (login/mfa/rotation)` | Auth service |
| `viljetech_email_rate_limited_total` | `transport (acs/mailjet)` | T12 — 429 from upstream |

**Cardinality discipline**: HTTP labels use Express's matched route (`/users/:id` not `/users/abc123`); the **`__not_found__`** bucket (T4) catches every unmatched 404. Pre-T4 the fallback regex'd numeric segments → conflated `/api/v1/reports/2026/q1` with `/api/v1/reports/2025/q1` AND falsely turned legit segments like `/v2/health` into `/v:id/health`.

### `/metrics` endpoint

Unauthenticated by design — deploy network restricts to scrape origin (App Service VNet integration / Container Apps internal port). Healthier than minting a shared secret for the orchestrator scraper.

---

## 7. Rate limiters ([`middlewares/rate-limit.middleware.ts`](../../src/middlewares/rate-limit.middleware.ts))

7 buckets — 4 global per-IP + 3 per-user:

| Limiter | Scope | Window / limit | Notes |
|---|---|---|---|
| `generalRateLimiter` | per-IP, `/api/*` | 60s / 120 (env `GENERAL_RATE_LIMIT_MAX`) | Standard headers (draft-7) |
| `authRateLimiter` | per-IP, `/auth/*` | 15min / 10 (env `AUTH_RATE_LIMIT_MAX`) | `skipSuccessfulRequests: true` — only failures count |
| `healthRateLimiter` | per-IP, `/health/*` + `/metrics` | 60s / 600 | M26 — Prometheus + k8s probe friendly |
| `slackWebhookRateLimiter` | per-IP, `/slack/*` | 60s / 30 | Sits in front of HMAC verify to discourage forged-payload spam cheaply |
| `reportReadRateLimiter` | per-user, `/reports/*` GETs | 60s / 60 | P2-9 — layered on per-IP |
| `exportRateLimiter` | per-user, `/reports/:name/export` | 15min / 10 | Heavier than read; tighter ceiling |
| `searchRateLimiter` | per-user, `/search` | 60s / 60 | Regex `$or` pathological in tight loop |
| `commandPaletteRateLimiter` | per-user, `/command-palette` | 60s / 60 | H3 — **separate bucket** from search; Cmd-K + search don't compete |

### `buildUserRateLimiter` (P2-9 — per-user)

Per-IP-only has two failure modes:
- Behind corporate NAT, hundreds of users share one IP → exhaust budget collectively.
- Logged-in attacker rotates residential proxies → evades the per-IP cap.

Per-user buckets on `req.user.user_id` (set by `authenticate`) layer on top. Falls back to IP when `req.user` absent (defensive — per-user routes always run after `authenticate`).

**In-memory per instance** — multi-instance fleet sees `instances × limit` effective ceiling per user. Acceptable for advisory-not-security buckets here. The security-critical login lockout lives in `auth.service` via `failed_login_attempts` (Mongo-backed, instance-independent).

---

## 8. Job scheduler ([`jobs/index.ts`](../../src/jobs/index.ts) + [`jobs/runner.ts`](../../src/jobs/runner.ts))

### Registry

11 scheduled jobs registered with `node-cron` schedules in `JOB_TIMEZONE = 'Asia/Kolkata'`:

| Job | Schedule | Idempotency key |
|---|---|---|
| `attendance_finalizer` | Daily 23:00 IST | Per-day |
| `leave_year_rollover` | Jan 1 00:05 IST | Per-year (retry 3×) |
| `token_cleanup` | Sun 02:00 IST | Per-ISO-week |
| `timesheet_reminder` | Daily 20:00 IST | Per-day |
| `report_export_cleanup` | Daily 03:00 IST | Per-day |
| `audit_archive` | Daily 04:00 IST | Per-day |
| `recurring_task_sweep` | Daily 06:00 IST | Per-day + per-template `last_generated_at` |
| `report_subscription_sweep` | Daily 07:00 IST | Per-day + per-subscription `last_sent_at` |
| `stuck_job_sweeper` | */15 min | Per-15m bucket |
| `audit_log_mirror` | Hourly :07 | Per-hour |
| `comp_off_reconciliation` | Daily 02:30 IST | Per-day |

Overlap guard: `{job_name, run_key}` unique index on `job_runs` collection. Same-day manual re-runs collide → "skipped" status.

### M25 — scale-out contract

`JOBS_ENABLED` is read once per process and gates ALL cron registration. On multi-instance scale-out, **set `JOBS_ENABLED=true` on EXACTLY ONE designated instance**. Why this matters even though the unique index dedupes work: every instance would still run cron-firing bookkeeping, emit logs, increment metrics. On a 4-instance fleet that's 4× log volume + 4× metric noise. Future Mongo-backed leader election (TTL doc in `cron_leader`) is deferred — env-flag contract is operationally simple today.

### L4 — consecutive-failure tracker

```ts
const consecutiveFailures = new Map<JobName, number>();   // in-process only

.then(() => consecutiveFailures.delete(name))             // success resets
.catch((err) => {
  const next = (consecutiveFailures.get(name) ?? 0) + 1;
  consecutiveFailures.set(name, next);
  logger.error({job, consecutive_failures: next}, 'Cron tick threw');
  if (next === JOB_CONSECUTIVE_FAILURE_THRESHOLD) {
    logger.fatal({job, consecutive_failures, threshold}, 'Crossed threshold — investigate');
  }
})
```

A `fatal` log fires ONCE when the streak crosses the threshold — operator gets a single high-signal line instead of N×repeat errors. Process restart resets the counter (acceptable — operator already saw it).

### `stopScheduler` — F5 drain

```
1. for each task: task.stop()                    ← cancel future fires
2. tasks.clear()
3. const running = getInFlightRunJobs()
4. if running.length === 0: return
5. await Promise.race([
     Promise.allSettled(running),                 ← drain in-flight up to 25s
     setTimeout(JOB_SCHEDULER_DRAIN_TIMEOUT_MS)
   ])
6. if timed out: log warn — outer 30s watchdog will force-exit
```

Pre-F5, `node-cron`'s `.stop()` only cancelled FUTURE fires; an in-flight handler mid-write was truncated by the subsequent `disconnectDB`. F5 awaits the outer `runJob` promise so the DB-update + audit-emit completes.

---

## 9. Other plumbing

### Date helpers ([`utils/date.ts`](../../src/utils/date.ts))

- `DEFAULT_TIMEZONE = 'Asia/Kolkata'` — IST, used everywhere `local_date` is computed.
- `DATE_FORMAT = 'YYYY-MM-DD'`.
- `dayjs` extended with `timezone` + `utc` plugins; default export is the configured `dayjs`.

### Bounded concurrency ([`utils/run-with-concurrency.ts`](../../src/utils/run-with-concurrency.ts))

R11 — single-file `p-limit`-equivalent. Used by `notification-dispatcher.service` to cap per-event fan-out at 5 concurrent recipients. A single rejection does NOT abort the rest; first error rethrown after every item settles.

### Comment sanitiser ([`utils/comment-sanitiser.ts`](../../src/utils/comment-sanitiser.ts))

HTML allowlist for task comment bodies (rich text). Strips everything except a small set of inline tags (`b`, `i`, `u`, `a`, `code`, `br`, `p`, `ul/ol/li`). Mentions are pre-extracted as `@<user_id>` tokens BEFORE sanitisation so the HTML pass doesn't reformat them.

### Role-check helper ([`utils/role-check.ts`](../../src/utils/role-check.ts))

`isAdminLike(caller)` — three-signal admin recognition (matches `auth.middleware.isCallerAdmin` and `command-palette.service.isCallerAdmin`):

```ts
isAdminLike(caller) =
  caller.permissions.includes('system.admin') ||
  caller.role === 'admin' ||                     // legacy denormalised
  (caller.role_keys ?? []).includes('admin')     // Step-47 resolved
```

Bridges the Step-47 deploy window where JWTs lacked the `permissions` claim.

### Azure Blob ([`utils/azure-blob.ts`](../../src/utils/azure-blob.ts))

- `isAzureConfigured()` — env check; many callers short-circuit when false.
- `mintSas` — 15-min write SAS (content-type pinned).
- `mintDownloadSas` — variable-TTL download SAS with optional RFC 5987 `filename*` override (L14).
- `putBlob` / `putBlobStream` — streaming uploads (audit archive uses the stream variant to avoid buffer-the-world).
- `deleteBlob` — best-effort; logs on failure.

Lazy — first blob call throws `AzureNotConfiguredError` if env missing. The rest of the BE runs fine without it (dev / on-prem).

### Email mailer ([`utils/mailer.ts`](../../src/utils/mailer.ts) + [`utils/email-transports/`](../../src/utils/email-transports/))

Pluggable transport via `EMAIL_TRANSPORT` env: `stub` (default — logs only, no outbound), `acs` (Azure Communication Services), `mailjet`. `sendEmail({to, subject, html, text, context, attachments?})` is the only public entry point. Non-throwing — failures log under `NOTIFICATION_DISPATCH_FAILED` / `EMAIL_SEND_FAILED`. T12 — counts 429 responses via `emailRateLimitedTotal{transport}`.

### Crypto AES ([`utils/crypto-aes.ts`](../../src/utils/crypto-aes.ts))

`encryptSecret(plaintext)` / `decryptSecret(envelope)` — AES-GCM via `MFA_ENCRYPTION_KEY` env. Two envelope shapes:
- Legacy: `<b64url>.<b64url>.<b64url>` (iv.tag.ciphertext, 3 parts)
- Rotation: `kid:<kid>:<b64url>.<b64url>.<b64url>` — multi-key support

Used by MFA secrets, Slack bot token (J1), and refresh-token storage when AES-at-rest is wired (future).

---

## Cross-cutting gotchas

| # | Behavior | Why |
|---|---|---|
| 1 | Slack webhook routes MOUNTED BEFORE body parsers in `src/index.ts` | Slack signs raw bytes; parsing destroys HMAC base |
| 2 | M28 — `compression` mounted AFTER Slack router | Defensive ordering for future request-touching variants |
| 3 | Auth body limit 4 KB (route-scoped); global 1 MB | Hostile password payloads can't burn parser CPU |
| 4 | `app.set('trust proxy', TRUST_PROXY)` per-deploy value | `req.ip` accuracy drives rate-limit + audit fidelity |
| 5 | `/health/*` + `/metrics` OUTSIDE `/api/*` (escape `generalRateLimiter`) | M26 `healthRateLimiter` 600/min/IP applied instead |
| 6 | F3 — `/health/ready` Mongo ping cached 5s | Avoid probe-rate-driven pool exhaustion + self-DDoS feedback |
| 7 | F3 — Mongo ping 1s timeout via `Promise.race` | Prevent slow pool from blocking the probe |
| 8 | C7 — `server.close` promisified + awaited before Mongo disconnect | Pre-fix `disconnectDB` could fire mid-handler → MongoNotConnectedError |
| 9 | F5 — `stopScheduler` awaits in-flight runJob promises up to 25s | Pre-F5 `node-cron`'s `.stop()` only cancelled future fires; mid-write truncated |
| 10 | L2 — `unhandledRejection` swallowed + counted, NOT exited | Best-effort audit/notify rejections shouldn't kill the API |
| 11 | H16 — `requestTimeout: 30_000, headersTimeout: 65_000, keepAliveTimeout: 61_000` | Slowloris defense + Front Door idle-timeout compatibility |
| 12 | L3 — explicit `listen(PORT, '0.0.0.0')` | Grep-able + safe across deploy targets |
| 13 | M25 — `JOBS_ENABLED=true` on EXACTLY ONE instance in multi-instance fleets | Avoid log/metric noise; DB-side dedupe still works but it's wasteful |
| 14 | L4 — consecutive-failure tracker emits ONE fatal log on crossing threshold | High-signal alert instead of N×repeat errors |
| 15 | `withTransaction` requires `{ session }` on every inner write | Without it the op runs OUTSIDE the transaction silently |
| 16 | `withTransaction` falls back to non-atomic sequential on standalone Mongo | Local dev convenience; warn-logged |
| 17 | `withTransaction` short-circuits when `readyState !== 1` (no session) | Test environments don't hang on `startSession()` 10s buffer |
| 18 | Audit writes INSIDE `withTransaction` retry with the transaction | Intentional — retried tx mustn't lose its audit row |
| 19 | `globalErrorHandler` MUST be the LAST middleware | Express invokes error middleware only after all others |
| 20 | R14 — duplicate handler echoes field NAMES, never values (`keyValue` stripped) | Caller already supplied the value; echoing leaks server-side secrets |
| 21 | `validate({body})` coerces undefined/null to `{}` for object schemas | Empty curl POSTs work for "all-fields-optional" actions |
| 22 | `Object.defineProperty(req, 'query', ...)` instead of `Object.assign` | Express 5 made `req.query` a getter; assign silently no-ops |
| 23 | M23 — pino redact strips 17 known secret field names from any payload tree | Defense against accidental `logger.error({user})` / `logger.warn({settings})` |
| 24 | App Insights auto-collection (HTTP/dep/console) DISABLED | Avoid duplicate request logs + ~1 MB cold-start hit |
| 25 | App Insights bootstrap failure → stderr warning + fall through to stdout-only | App's log pipeline never breaks |
| 26 | T4 — metrics route fallback is `__not_found__` bucket (not regex'd) | Pre-T4 regex conflated unrelated paths AND broke legit segments |
| 27 | `getOrCreateCounter/Histogram/Gauge` via `getSingleMetric` lookup | Tests `vi.resetModules()` would otherwise re-register |
| 28 | `/metrics` unauthenticated by design — deploy network restricts | Better than minting a shared secret for scraper |
| 29 | P2-9 — per-user limiters layered on top of per-IP for expensive surfaces | Per-IP fails on NAT + proxy rotation |
| 30 | H3 — `commandPaletteRateLimiter` is SEPARATE bucket from `searchRateLimiter` | Cmd-K + search-page shouldn't compete for same budget |
| 31 | Auth rate limiter `skipSuccessfulRequests: true` | Only failed login attempts count against the budget |
| 32 | All 5 boot migrations are idempotent + never throw | Boot continues even if any fail; runtime fallback code paths handle it |
| 33 | Cron starts INSIDE the `app.listen` callback | Boot failure can't leave cron running against half-initialized DB |
| 34 | `JOB_TIMEZONE = 'Asia/Kolkata'` so "23:00" means 23:00 IST regardless of host TZ | Anchors all cron times to business calendar |
| 35 | `runWithConcurrency` first-error semantics: continue scheduling, throw first error after all settle | Matches dispatcher "best effort across recipients" contract |
| 36 | `DEFAULT_TIMEZONE = 'Asia/Kolkata'` is the platform's TZ default | Per-user TZ overrides are v1.5 — every `local_date` is IST today |
| 37 | `isAdminLike` recognises admin via 3 signals (`permissions`, `role`, `role_keys`) | Bridges Step-47 JWT deploy window |
| 38 | Crypto envelope supports legacy 3-part AND rotation `kid:<kid>:<3-parts>` formats | Key rotation without re-encryption sweep |
| 39 | Azure Blob is LAZY — first call throws if env missing; rest of BE runs fine | Dev / on-prem deployments work without storage |
| 40 | Email mailer is LAZY + PLUGGABLE — `EMAIL_TRANSPORT=stub` (default) logs only | Tests + dev don't need a real mail provider |
