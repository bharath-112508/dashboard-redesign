import { describe, expect, it } from 'vitest';

import {
    auditSnapshotDroppedTotal,
    auditWritesTotal,
    getMetricsContentType,
    getMetricsText,
    httpRequestDurationSeconds,
    httpRequestsTotal,
    jobRunsTotal,
    jwtVerifyFailuresTotal,
    refreshTokensIssuedTotal,
    recordHttp,
    stuckJobSweepsTotal,
    __resetMetrics,
} from './metrics.js';

/**
 * Smoke tests for the Prometheus instrumentation (BACKEND_AUDIT.md P1-5).
 *
 * The contract worth pinning at this level:
 *   - Every counter / histogram is registered.
 *   - `recordHttp` derives a low-cardinality `route` label from the
 *     matched Express route, NOT the raw URL.
 *   - The `/metrics` text payload contains every metric we expose.
 */

describe('metrics module', () => {
    it('exposes the OpenMetrics content type', () => {
        const ct = getMetricsContentType();
        expect(ct).toMatch(/text\/plain/);
        expect(ct).toMatch(/version=/);
    });

    it('renders every registered metric in the text payload', async () => {
        // Touch every metric so it appears in the output even at zero.
        httpRequestsTotal.inc({ method: 'GET', route: '/api/health', status_class: '2xx' }, 0);
        httpRequestDurationSeconds.observe({ method: 'GET', route: '/api/health', status_class: '2xx' }, 0.001);
        jobRunsTotal.inc({ name: 'token_cleanup', status: 'success' }, 0);
        stuckJobSweepsTotal.inc(0);
        jwtVerifyFailuresTotal.inc({ kind: 'access' }, 0);
        auditWritesTotal.inc({ outcome: 'ok' }, 0);
        auditSnapshotDroppedTotal.inc({ which: 'before' }, 0);
        refreshTokensIssuedTotal.inc({ reason: 'login' }, 0);

        const text = await getMetricsText();
        expect(text).toContain('viljetech_http_requests_total');
        expect(text).toContain('viljetech_http_request_duration_seconds');
        expect(text).toContain('viljetech_job_runs_total');
        expect(text).toContain('viljetech_stuck_jobs_swept_total');
        expect(text).toContain('viljetech_jwt_verify_failures_total');
        expect(text).toContain('viljetech_audit_writes_total');
        expect(text).toContain('viljetech_audit_snapshot_dropped_total');
        expect(text).toContain('viljetech_refresh_tokens_issued_total');
        // Default Node metrics also captured (process / heap / event loop).
        expect(text).toContain('viljetech_process_cpu_user_seconds_total');
    });

    it('recordHttp uses the matched Express route for the label, not the raw URL', async () => {
        __resetMetrics();
        const req = {
            method: 'GET',
            route: { path: '/:id' },
            baseUrl: '/api/users',
            originalUrl: '/api/users/507f1f77bcf86cd799439011',
        } as unknown as Parameters<typeof recordHttp>[0];
        const res = { statusCode: 200 } as unknown as Parameters<typeof recordHttp>[1];

        recordHttp(req, res, 0.05);

        const text = await getMetricsText();
        expect(text).toContain('route="/api/users/:id"');
        // The raw ObjectId must NOT appear in the metric output.
        expect(text).not.toContain('507f1f77');
    });

    it('T4 — recordHttp falls back to a single __not_found__ bucket when req.route is missing (e.g. 404)', async () => {
        // Pre-T4 the fallback tried to id-collapse the raw URL with a
        // regex, conflating `/api/users/:id/foo` with legitimate route
        // segments like `/v2/health`. Single bucket is both lower
        // cardinality and more honest about what happened.
        __resetMetrics();
        const req = {
            method: 'POST',
            route: undefined,
            originalUrl: '/api/users/507f1f77bcf86cd799439011/foo',
        } as unknown as Parameters<typeof recordHttp>[0];
        const res = { statusCode: 404 } as unknown as Parameters<typeof recordHttp>[1];

        recordHttp(req, res, 0.001);

        const text = await getMetricsText();
        expect(text).toContain('route="__not_found__"');
        expect(text).toContain('status_class="4xx"');
        // Ensure the raw URL is NOT echoed at all — defence against
        // a future fallback that leaks ObjectIds into Prometheus.
        expect(text).not.toContain('507f1f77');
        expect(text).not.toContain('/api/users');
    });

    it('status_class is bucketed (2xx / 4xx / 5xx) — never raw status code', async () => {
        __resetMetrics();
        const req = {
            method: 'GET',
            route: { path: '/' },
            baseUrl: '/api/health',
            originalUrl: '/api/health',
        } as unknown as Parameters<typeof recordHttp>[0];
        recordHttp(req, { statusCode: 503 } as unknown as Parameters<typeof recordHttp>[1], 0.001);

        const text = await getMetricsText();
        expect(text).toContain('status_class="5xx"');
        // No raw status code leaks into a label.
        expect(text).not.toMatch(/status_class="503"/);
    });
});
