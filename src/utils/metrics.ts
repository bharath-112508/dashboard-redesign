/**
 * Prometheus metrics (BACKEND_AUDIT.md P1-5).
 *
 * Exposes a `/metrics` endpoint scraped by Prometheus / Azure Managed
 * Grafana / any OpenMetrics-compatible collector. The default registry
 * also captures Node process metrics (event loop lag, GC, heap) via
 * `prom-client`'s built-in `collectDefaultMetrics`.
 *
 * Cardinality discipline:
 *  - HTTP labels are `method` + `route` (Express's matched route, not
 *    the raw URL — `/users/:id` instead of `/users/abc123`) + status
 *    code class. Per-id explosion would melt Prometheus.
 *  - Job labels are `name` (one of JOB_NAMES) + status (success /
 *    failed / skipped). Bounded.
 *  - Audit / JWT verify counters carry no labels — they're system-
 *    wide signals, not per-request.
 *
 * `getMetricsText()` returns the OpenMetrics text payload for the
 * `/metrics` endpoint. `recordHttp(req, res, durationSeconds)` is
 * called from the global `pinoHttp` finish hook (see `src/index.ts`)
 * so we don't add a second logger pass.
 */

import client from 'prom-client';
import type { Request, Response } from 'express';

// `prom-client` keeps a process-global default registry. In tests
// `vi.resetModules()` re-evaluates *our* module repeatedly while the
// prom-client native module is cached, so the default + custom
// metrics would re-register on every reset and throw. Guard with
// `getSingleMetric` so re-evaluations re-use the already-registered
// instance.
//
// The cast back to the concrete type is safe — `getSingleMetric` only
// returns metrics WE registered with that exact name + label shape.

const defaultsKey = '__viljetech_default_metrics_registered';
type GlobalWithFlag = typeof globalThis & { [defaultsKey]?: boolean };
if (!(globalThis as GlobalWithFlag)[defaultsKey]) {
    client.collectDefaultMetrics({ prefix: 'viljetech_' });
    (globalThis as GlobalWithFlag)[defaultsKey] = true;
}

const getOrCreateCounter = <L extends string>(cfg: client.CounterConfiguration<L>): client.Counter<L> => {
    const existing = client.register.getSingleMetric(cfg.name);
    return (existing ?? new client.Counter(cfg)) as client.Counter<L>;
};

const getOrCreateHistogram = <L extends string>(cfg: client.HistogramConfiguration<L>): client.Histogram<L> => {
    const existing = client.register.getSingleMetric(cfg.name);
    return (existing ?? new client.Histogram(cfg)) as client.Histogram<L>;
};

// ─── HTTP request metrics ─────────────────────────────────────────────

export const httpRequestsTotal = getOrCreateCounter({
    name: 'viljetech_http_requests_total',
    help: 'Total HTTP requests processed, by method / route / status class.',
    labelNames: ['method', 'route', 'status_class'] as const,
});

export const httpRequestDurationSeconds = getOrCreateHistogram({
    name: 'viljetech_http_request_duration_seconds',
    help: 'HTTP request latency (seconds), by method / route / status class.',
    labelNames: ['method', 'route', 'status_class'] as const,
    // Buckets sized for an internal API: most requests under 100 ms,
    // tail down to 30 s for the export-trigger endpoints.
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
});

// ─── Job-run metrics ──────────────────────────────────────────────────

export const jobRunDurationSeconds = getOrCreateHistogram({
    name: 'viljetech_job_run_duration_seconds',
    help: 'Cron job run duration (seconds), by job name + status.',
    labelNames: ['name', 'status'] as const,
    // Cron jobs span "<1 s no-op" to "tens of minutes" (audit archive).
    buckets: [0.5, 1, 5, 10, 30, 60, 300, 600, 1800],
});

export const jobRunsTotal = getOrCreateCounter({
    name: 'viljetech_job_runs_total',
    help: 'Total cron job runs, by job name + status.',
    labelNames: ['name', 'status'] as const,
});

export const stuckJobSweepsTotal = getOrCreateCounter({
    name: 'viljetech_stuck_jobs_swept_total',
    help: 'Cumulative count of stuck job_runs rows auto-failed by the sweeper.',
    labelNames: [] as const,
});

const getOrCreateGauge = <L extends string>(cfg: client.GaugeConfiguration<L>): client.Gauge<L> => {
    const existing = client.register.getSingleMetric(cfg.name);
    return (existing ?? new client.Gauge(cfg)) as client.Gauge<L>;
};

export const auditLogMirrorLagRows = getOrCreateGauge({
    name: 'viljetech_audit_log_mirror_lag_rows',
    help: 'Number of audit_logs rows newer than the last successful mirror watermark. Set per hourly run; non-zero across runs means the mirror is falling behind.',
    labelNames: [] as const,
});

// ─── Auth / audit signals ─────────────────────────────────────────────

export const jwtVerifyFailuresTotal = getOrCreateCounter({
    name: 'viljetech_jwt_verify_failures_total',
    help: 'JWT signature / expiry verification failures (access + refresh combined).',
    labelNames: ['kind'] as const, // 'access' | 'refresh' | 'mfa_session'
});

export const auditWritesTotal = getOrCreateCounter({
    name: 'viljetech_audit_writes_total',
    help: 'Audit log row insertions, by outcome.',
    labelNames: ['outcome'] as const, // 'ok' | 'failed'
});

/**
 * G4 — count of audit-row writes where the `before` or `after` snapshot
 * exceeded `AUDIT_SNAPSHOT_BYTES_MAX` and was dropped to null. Operators
 * can alert on this directly rather than scanning audit rows for the
 * `metadata.before_snapshot_dropped` flag.
 */
export const auditSnapshotDroppedTotal = getOrCreateCounter({
    name: 'viljetech_audit_snapshot_dropped_total',
    help: 'Audit-log row writes where a `before` / `after` snapshot exceeded the size cap and was dropped to null.',
    labelNames: ['which'] as const, // 'before' | 'after'
});

export const refreshTokensIssuedTotal = getOrCreateCounter({
    name: 'viljetech_refresh_tokens_issued_total',
    help: 'Refresh token rows minted, by reason.',
    labelNames: ['reason'] as const, // 'login' | 'mfa' | 'rotation'
});

/** T12 — count of HTTP 429 responses observed from email transports. */
export const emailRateLimitedTotal = getOrCreateCounter({
    name: 'viljetech_email_rate_limited_total',
    help: 'Email send calls rejected with HTTP 429 by upstream (ACS / Mailjet).',
    labelNames: ['transport'] as const,
});

// ─── HTTP recorder helper ─────────────────────────────────────────────

/**
 * Pin an Express response to a route label that doesn't explode
 * cardinality. Express stores the matched route on `req.route?.path`
 * (e.g. `/users/:id`) once routing has run — perfect for the label.
 *
 * For requests that NEVER matched a route (404s, error short-circuits
 * fired before routing), we collapse to a single `__not_found__`
 * bucket rather than echoing the raw path. T4 — pre-T4 the fallback
 * tried to be clever and rewrote numeric segments with a regex, which
 * conflated `/api/v1/reports/2026/q1` with `/api/v1/reports/2025/q1`
 * AND falsely turned legitimate route segments like `/v2/health` into
 * `/v:id/health`. A single 404 bucket is both lower cardinality and
 * more honest about what happened.
 */
const NOT_FOUND_BUCKET = '__not_found__';

const routeLabel = (req: Request): string => {
    const matched = req.route?.path;
    if (typeof matched === 'string') {
        // Express records the path RELATIVE to the router that owned
        // it. `req.baseUrl` carries the mount prefix so we can rebuild
        // the canonical full route.
        return `${req.baseUrl ?? ''}${matched}`;
    }
    return NOT_FOUND_BUCKET;
};

const statusClass = (status: number): string => {
    if (status >= 500) return '5xx';
    if (status >= 400) return '4xx';
    if (status >= 300) return '3xx';
    if (status >= 200) return '2xx';
    return '1xx';
};

export const recordHttp = (req: Request, res: Response, durationSeconds: number): void => {
    const labels = {
        method: req.method,
        route: routeLabel(req),
        status_class: statusClass(res.statusCode),
    };
    httpRequestsTotal.inc(labels);
    httpRequestDurationSeconds.observe(labels, durationSeconds);
};

// ─── Metrics endpoint ─────────────────────────────────────────────────

/** Text body for the `/metrics` endpoint (OpenMetrics 0.0.1 / Prom text 0.0.4). */
export const getMetricsText = async (): Promise<string> => client.register.metrics();

export const getMetricsContentType = (): string => client.register.contentType;

/** Test seam — clear all counters / histograms between test cases. */
export const __resetMetrics = (): void => {
    client.register.resetMetrics();
};
