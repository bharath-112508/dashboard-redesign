// src/routes/report.routes.test.ts
//
// HTTP-level tests for `GET /api/v1/reports/margin` (Billing Phase 2, Task 5).
//
// Harness mirrors invoice.routes.test.ts: real JWTs signed with the test
// JWT secret drive the full authenticate → requirePermission → validate
// chain; only the margin service and the User model (read by `authenticate`)
// are mocked.
//
// Margin is gated on `cost_rate.read`, NOT the router-level `report.read`
// blanket that gates the other sync reports (billing/utilization/
// attendance/leaves) — seeing margin means seeing cost, which is more
// sensitive. These tests prove a caller holding ONLY `cost_rate.read`
// (no `report.read`) can still reach it, and a caller holding ONLY
// `report.read` (no `cost_rate.read`) is refused.

// These suites exercise the billing module's real behaviour, so they run with
// the feature gate ON. `vi.hoisted` is the only hook that fires before the
// import graph, and `server.config` parses this flag once at module load — a
// plain assignment here would run after the config was already frozen.
vi.hoisted(() => {
    process.env.BILLING_MODULES_ENABLED = 'true';
});

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Types } from 'mongoose';
import jwt from 'jsonwebtoken';
import request from 'supertest';

// ─── Hoisted mock factories ───────────────────────────────────────────────

const { buildMarginReportMock, userFindByIdMock, settingsMock } = vi.hoisted(() => ({
    buildMarginReportMock: vi.fn(),
    userFindByIdMock: vi.fn(),
    settingsMock: vi.fn(),
}));

// ─── Module mocks (must be before any imports that load these) ───────────

vi.mock('../services/margin.service.js', () => ({
    buildMarginReport: buildMarginReportMock,
}));

vi.mock('../models/user.model.js', () => ({
    User: { findById: userFindByIdMock },
}));

vi.mock('../services/settings.service.js', () => ({
    getOrInitSettings: settingsMock,
    resolveLoginLockoutPolicy: vi.fn().mockResolvedValue({
        failed_login_threshold: null,
        lockout_duration_minutes: null,
    }),
}));

// ─── App under test ───────────────────────────────────────────────────────

const { buildTestApp } = await import('../integration/_helpers/build-app.js');
const app = buildTestApp();

// ─── JWT helpers ──────────────────────────────────────────────────────────

const TEST_SECRET = process.env.JWT_SECRET ?? 'test-secret';

const issueToken = (
    overrides: {
        user_id?: string;
        role?: string;
        permissions?: string[];
        role_keys?: string[];
    } = {}
): string =>
    jwt.sign(
        {
            user_id: overrides.user_id ?? new Types.ObjectId().toString(),
            role: overrides.role ?? 'employee',
            role_keys: overrides.role_keys ?? [overrides.role ?? 'employee'],
            permissions: overrides.permissions ?? [],
        },
        TEST_SECRET,
        { expiresIn: '1h' }
    );

const authHeader = (token: string) => ({ Authorization: `Bearer ${token}` });

const STUB_MARGIN_REPORT = {
    reporting_currency: 'USD',
    from_date: '2026-07-01',
    to_date: '2026-07-31',
    rows: [],
    totals: { revenue: 0, cost: 0, margin: 0, margin_pct: null },
    warnings: [],
};

// ─── Setup ────────────────────────────────────────────────────────────────

beforeEach(() => {
    vi.resetAllMocks();

    // Auth middleware does a User.findById → select → lean per request.
    userFindByIdMock.mockReturnValue({
        select: () => ({ lean: () => Promise.resolve({ status: 'active', mfa_enabled: false }) }),
    });

    settingsMock.mockResolvedValue({
        security: { require_mfa_for_admins: false },
    });

    buildMarginReportMock.mockResolvedValue(STUB_MARGIN_REPORT);
});

// ─── GET /reports/margin ────────────────────────────────────────────────

describe('GET /api/v1/reports/margin', () => {
    it('403s a token that lacks cost_rate.read (even holding report.read)', async () => {
        const token = issueToken({ role: 'employee', permissions: ['report.read'] });

        const res = await request(app)
            .get('/api/v1/reports/margin')
            .query({ from_date: '2026-07-01', to_date: '2026-07-31' })
            .set(authHeader(token));

        expect(res.status).toBe(403);
        expect(buildMarginReportMock).not.toHaveBeenCalled();
    });

    it('200s + returns the report body for a token that holds ONLY cost_rate.read (no report.read)', async () => {
        const token = issueToken({ role: 'employee', permissions: ['cost_rate.read'] });

        const res = await request(app)
            .get('/api/v1/reports/margin')
            .query({ from_date: '2026-07-01', to_date: '2026-07-31' })
            .set(authHeader(token));

        expect(res.status).toBe(200);
        expect(res.body.data).toEqual(STUB_MARGIN_REPORT);
        expect(buildMarginReportMock).toHaveBeenCalledOnce();
        expect(buildMarginReportMock).toHaveBeenCalledWith(
            expect.objectContaining({ from_date: '2026-07-01', to_date: '2026-07-31' })
        );
    });

    it('200s with optional project_id/company_id passed through for a manager token', async () => {
        const projectId = '5f'.padEnd(24, '1');
        const companyId = '5f'.padEnd(24, '2');
        const token = issueToken({ role: 'manager', permissions: ['cost_rate.read', 'report.read'] });

        const res = await request(app)
            .get('/api/v1/reports/margin')
            .query({ from_date: '2026-07-01', to_date: '2026-07-31', project_id: projectId, company_id: companyId })
            .set(authHeader(token));

        expect(res.status).toBe(200);
        expect(buildMarginReportMock).toHaveBeenCalledWith(
            expect.objectContaining({ project_id: projectId, company_id: companyId })
        );
    });

    it('400s when from_date is missing', async () => {
        const token = issueToken({ role: 'manager', permissions: ['cost_rate.read'] });

        const res = await request(app)
            .get('/api/v1/reports/margin')
            .query({ to_date: '2026-07-31' })
            .set(authHeader(token));

        expect([400, 422]).toContain(res.status);
        expect(buildMarginReportMock).not.toHaveBeenCalled();
    });

    it('400s when to_date < from_date', async () => {
        const token = issueToken({ role: 'manager', permissions: ['cost_rate.read'] });

        const res = await request(app)
            .get('/api/v1/reports/margin')
            .query({ from_date: '2026-07-31', to_date: '2026-07-01' })
            .set(authHeader(token));

        expect([400, 422]).toContain(res.status);
        expect(buildMarginReportMock).not.toHaveBeenCalled();
    });

    it('401s without auth', async () => {
        const res = await request(app)
            .get('/api/v1/reports/margin')
            .query({ from_date: '2026-07-01', to_date: '2026-07-31' });

        expect(res.status).toBe(401);
        expect(buildMarginReportMock).not.toHaveBeenCalled();
    });
});
