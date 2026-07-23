// src/routes/dashboard.routes.test.ts
//
// HTTP-level tests for GET /api/v1/dashboard/{scope}/analytics.
// Harness pattern mirrors the integration/_helpers/build-app + JWT pattern
// used in src/integration/users.integration.test.ts.
//
// Services are mocked at the module level. The `authenticate` middleware is
// NOT mocked — instead we issue real JWTs signed with the test secret so the
// full auth pipeline (JWT verify → User.findById status check) runs.
// User.findById is stubbed to return an `active` user row.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Types } from 'mongoose';
import jwt from 'jsonwebtoken';
import request from 'supertest';

// ─── Hoisted mock factories ───────────────────────────────────────────────

const {
    buildAdminAnalyticsMock,
    buildManagerAnalyticsMock,
    buildEmployeeAnalyticsMock,
    buildClientAnalyticsMock,
    buildAdminOverviewMock,
    buildManagerOverviewMock,
    buildEmployeeOverviewMock,
    buildClientOverviewMock,
    userFindByIdMock,
    settingsMock,
} = vi.hoisted(() => ({
    buildAdminAnalyticsMock: vi.fn(),
    buildManagerAnalyticsMock: vi.fn(),
    buildEmployeeAnalyticsMock: vi.fn(),
    buildClientAnalyticsMock: vi.fn(),
    buildAdminOverviewMock: vi.fn(),
    buildManagerOverviewMock: vi.fn(),
    buildEmployeeOverviewMock: vi.fn(),
    buildClientOverviewMock: vi.fn(),
    userFindByIdMock: vi.fn(),
    settingsMock: vi.fn(),
}));

// ─── Module mocks (must be before any imports that load these) ───────────

vi.mock('../services/dashboard-analytics.service.js', () => ({
    buildAdminAnalytics: buildAdminAnalyticsMock,
    buildManagerAnalytics: buildManagerAnalyticsMock,
    buildEmployeeAnalytics: buildEmployeeAnalyticsMock,
    buildClientAnalytics: buildClientAnalyticsMock,
}));

vi.mock('../services/dashboard-overview.service.js', () => ({
    buildAdminOverview: buildAdminOverviewMock,
    buildManagerOverview: buildManagerOverviewMock,
    buildEmployeeOverview: buildEmployeeOverviewMock,
    buildClientOverview: buildClientOverviewMock,
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
const adminUserId = new Types.ObjectId();
const employeeUserId = new Types.ObjectId();

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
            user_id: overrides.user_id ?? adminUserId.toString(),
            role: overrides.role ?? 'admin',
            role_keys: overrides.role_keys ?? [overrides.role ?? 'admin'],
            permissions: overrides.permissions ?? ['system.admin'],
        },
        TEST_SECRET,
        { expiresIn: '1h' }
    );

const adminToken = issueToken();
const employeeToken = issueToken({
    user_id: employeeUserId.toString(),
    role: 'employee',
    permissions: ['dashboard.employee'],
    role_keys: ['employee'],
});

const authHeader = (token: string) => ({ Authorization: `Bearer ${token}` });

const STUB_PAYLOAD = { generated_at: new Date().toISOString(), range: { key: 'month' }, sections: {} };

const STUB_ADMIN_OVERVIEW = {
    scope: 'admin',
    range: { from: '2026-07-01', to: '2026-07-22', is_single_day: false },
    summary: [
        { label: 'Total Employees', value: 10 },
        { label: 'Total Clients', value: 2 },
        { label: 'Total Projects', value: 5 },
    ],
    attendance: {
        present: 8,
        on_leave: 1,
        correction_requests: 0,
        incomplete: 0,
        total_internal_active: 10,
        is_single_day: false,
    },
    representatives: null,
    projects: { active: 3, completed: 2, on_hold: 0, total: 5 },
};

const STUB_CLIENT_OVERVIEW = {
    scope: 'client',
    range: { from: '2026-07-01', to: '2026-07-22', is_single_day: false },
    summary: [
        { label: 'Company Projects', value: 3 },
        { label: 'Representatives', value: 4 },
        { label: 'Active vs Completed', value: 2, hint: '1 completed' },
    ],
    attendance: null,
    representatives: { active: 3, inactive: 1, total: 4 },
    projects: { active: 2, completed: 1, on_hold: 0, total: 3 },
};

// ─── Setup ────────────────────────────────────────────────────────────────

beforeEach(() => {
    vi.resetAllMocks();

    // Auth middleware does a User.findById → select → lean per request.
    userFindByIdMock.mockReturnValue({
        select: () => ({ lean: () => Promise.resolve({ status: 'active', mfa_enabled: false }) }),
    });

    // Settings needed by the MFA gate (admin writes only, but kept for safety).
    settingsMock.mockResolvedValue({
        security: { require_mfa_for_admins: false },
    });

    // Default: all analytics builders return the stub payload.
    buildAdminAnalyticsMock.mockResolvedValue(STUB_PAYLOAD);
    buildManagerAnalyticsMock.mockResolvedValue(STUB_PAYLOAD);
    buildEmployeeAnalyticsMock.mockResolvedValue(STUB_PAYLOAD);
    buildClientAnalyticsMock.mockResolvedValue(STUB_PAYLOAD);

    // Default: all overview builders return a scope-appropriate stub payload.
    buildAdminOverviewMock.mockResolvedValue(STUB_ADMIN_OVERVIEW);
    buildManagerOverviewMock.mockResolvedValue(STUB_ADMIN_OVERVIEW);
    buildEmployeeOverviewMock.mockResolvedValue(STUB_ADMIN_OVERVIEW);
    buildClientOverviewMock.mockResolvedValue(STUB_CLIENT_OVERVIEW);
});

// ─── GET /dashboard/admin/analytics ───────────────────────────────────────

describe('GET /api/v1/dashboard/admin/analytics', () => {
    it('200 — passes held permissions + resolved range to buildAdminAnalytics', async () => {
        const res = await request(app).get('/api/v1/dashboard/admin/analytics?range=week').set(authHeader(adminToken));

        expect(res.status).toBe(200);
        expect(buildAdminAnalyticsMock).toHaveBeenCalledWith(
            ['system.admin'],
            expect.objectContaining({ key: 'week' })
        );
        expect(res.body.data.range.key).toBe('month'); // stub has month
    });

    it('range defaults to month when query param is absent', async () => {
        await request(app).get('/api/v1/dashboard/admin/analytics').set(authHeader(adminToken));

        expect(buildAdminAnalyticsMock).toHaveBeenCalledWith(
            ['system.admin'],
            expect.objectContaining({ key: 'month' })
        );
    });

    it('200 — a custom from/to window resolves to a custom range', async () => {
        const res = await request(app)
            .get('/api/v1/dashboard/admin/analytics?from=2026-06-01&to=2026-07-23')
            .set(authHeader(adminToken));

        expect(res.status).toBe(200);
        expect(buildAdminAnalyticsMock).toHaveBeenCalledWith(
            ['system.admin'],
            expect.objectContaining({ key: 'custom', from: '2026-06-01', to: '2026-07-23' })
        );
    });

    it('400 VALIDATION_ERROR when only one of from/to is supplied', async () => {
        const res = await request(app)
            .get('/api/v1/dashboard/admin/analytics?from=2026-06-01')
            .set(authHeader(adminToken));

        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
        expect(buildAdminAnalyticsMock).not.toHaveBeenCalled();
    });

    it('400 VALIDATION_ERROR when from is after to', async () => {
        const res = await request(app)
            .get('/api/v1/dashboard/admin/analytics?from=2026-07-23&to=2026-06-01')
            .set(authHeader(adminToken));

        expect(res.status).toBe(400);
        expect(buildAdminAnalyticsMock).not.toHaveBeenCalled();
    });

    it('400 VALIDATION_ERROR for an unrecognised range value', async () => {
        const res = await request(app).get('/api/v1/dashboard/admin/analytics?range=year').set(authHeader(adminToken));

        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
        expect(buildAdminAnalyticsMock).not.toHaveBeenCalled();
    });

    it('403 FORBIDDEN for a caller without dashboard.admin permission', async () => {
        const res = await request(app).get('/api/v1/dashboard/admin/analytics').set(authHeader(employeeToken));

        expect(res.status).toBe(403);
        expect(buildAdminAnalyticsMock).not.toHaveBeenCalled();
    });
});

// ─── GET /dashboard/manager/analytics ─────────────────────────────────────

describe('GET /api/v1/dashboard/manager/analytics', () => {
    const managerToken = issueToken({
        role: 'manager',
        permissions: ['dashboard.manager', 'timesheet.read'],
        role_keys: ['manager'],
    });

    it('200 — passes caller shape + held permissions + range key to buildManagerAnalytics', async () => {
        const res = await request(app)
            .get('/api/v1/dashboard/manager/analytics?range=today')
            .set(authHeader(managerToken));

        expect(res.status).toBe(200);
        expect(buildManagerAnalyticsMock).toHaveBeenCalledOnce();
        const [callerArg, heldArg, rangeArg] = buildManagerAnalyticsMock.mock.calls[0] as [
            { id: Types.ObjectId; role: string; role_keys: string[] },
            string[],
            { key: string },
        ];
        expect(callerArg.role).toBe('manager');
        expect(heldArg).toContain('dashboard.manager');
        expect(rangeArg.key).toBe('today');
    });

    it('403 for a caller without dashboard.manager', async () => {
        const res = await request(app).get('/api/v1/dashboard/manager/analytics').set(authHeader(employeeToken));

        expect(res.status).toBe(403);
        expect(buildManagerAnalyticsMock).not.toHaveBeenCalled();
    });
});

// ─── GET /dashboard/employee/analytics ────────────────────────────────────

describe('GET /api/v1/dashboard/employee/analytics', () => {
    it('200 — passes caller id + held permissions + range to buildEmployeeAnalytics', async () => {
        const res = await request(app)
            .get('/api/v1/dashboard/employee/analytics?range=30d')
            .set(authHeader(employeeToken));

        expect(res.status).toBe(200);
        expect(buildEmployeeAnalyticsMock).toHaveBeenCalledOnce();
        const [idArg, heldArg, rangeArg] = buildEmployeeAnalyticsMock.mock.calls[0] as [
            Types.ObjectId,
            string[],
            { key: string },
        ];
        expect(idArg.toString()).toBe(employeeUserId.toString());
        expect(heldArg).toContain('dashboard.employee');
        expect(rangeArg.key).toBe('30d');
    });

    it('400 for an unrecognised range', async () => {
        const res = await request(app)
            .get('/api/v1/dashboard/employee/analytics?range=year')
            .set(authHeader(employeeToken));

        expect(res.status).toBe(400);
    });

    it('403 for a caller without dashboard.employee', async () => {
        const noPermToken = issueToken({ role: 'employee', permissions: [], role_keys: ['employee'] });
        const res = await request(app).get('/api/v1/dashboard/employee/analytics').set(authHeader(noPermToken));

        expect(res.status).toBe(403);
    });
});

// ─── GET /dashboard/client/analytics ──────────────────────────────────────

describe('GET /api/v1/dashboard/client/analytics', () => {
    it('200 — passes caller id + held permissions + range to buildClientAnalytics', async () => {
        const userId = new Types.ObjectId();
        const token = issueToken({
            user_id: userId.toString(),
            role: 'client',
            permissions: ['dashboard.client', 'project.read'],
            role_keys: ['client'],
        });

        const res = await request(app).get('/api/v1/dashboard/client/analytics?range=quarter').set(authHeader(token));

        expect(res.status).toBe(200);
        expect(buildClientAnalyticsMock).toHaveBeenCalledOnce();
        // Now takes the whole caller, not a bare id — a `client` is
        // company-scoped, so the service needs role + company_id to build
        // the visibility filter.
        const [callerArg, , rangeArg] = buildClientAnalyticsMock.mock.calls[0] as [
            { id: Types.ObjectId; role: string },
            string[],
            { key: string },
        ];
        expect(callerArg.id.toString()).toBe(userId.toString());
        expect(callerArg.role).toBe('client');
        expect(rangeArg.key).toBe('quarter');
    });

    it('403 for a caller without dashboard.client', async () => {
        const res = await request(app)
            .get('/api/v1/dashboard/client/analytics')
            .set(authHeader(issueToken({ role: 'employee', permissions: [] })));

        expect(res.status).toBe(403);
    });
});

// ─── GET /dashboard/admin/overview ────────────────────────────────────────

describe('GET /api/v1/dashboard/admin/overview', () => {
    it('200 — 3 summary cards + non-null attendance', async () => {
        const res = await request(app)
            .get('/api/v1/dashboard/admin/overview?from=2026-07-01&to=2026-07-22')
            .set(authHeader(adminToken));

        expect(res.status).toBe(200);
        expect(buildAdminOverviewMock).toHaveBeenCalledWith('2026-07-01', '2026-07-22');
        expect(res.body.data.summary).toHaveLength(3);
        expect(res.body.data.attendance).not.toBeNull();
    });

    it('400 VALIDATION_ERROR when from is after to', async () => {
        const res = await request(app)
            .get('/api/v1/dashboard/admin/overview?from=2026-07-22&to=2026-07-01')
            .set(authHeader(adminToken));

        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
        expect(buildAdminOverviewMock).not.toHaveBeenCalled();
    });

    it('403 for a caller without dashboard.admin', async () => {
        const res = await request(app).get('/api/v1/dashboard/admin/overview').set(authHeader(employeeToken));

        expect(res.status).toBe(403);
        expect(buildAdminOverviewMock).not.toHaveBeenCalled();
    });
});

// ─── GET /dashboard/manager/overview ──────────────────────────────────────

describe('GET /api/v1/dashboard/manager/overview', () => {
    const managerToken = issueToken({
        role: 'manager',
        permissions: ['dashboard.manager', 'timesheet.read'],
        role_keys: ['manager'],
    });

    it('200 — passes caller shape + from/to to buildManagerOverview', async () => {
        const res = await request(app)
            .get('/api/v1/dashboard/manager/overview?from=2026-07-01&to=2026-07-22')
            .set(authHeader(managerToken));

        expect(res.status).toBe(200);
        expect(buildManagerOverviewMock).toHaveBeenCalledOnce();
        const [callerArg, fromArg, toArg] = buildManagerOverviewMock.mock.calls[0] as [
            { id: Types.ObjectId; role: string },
            string,
            string,
        ];
        expect(callerArg.role).toBe('manager');
        expect(fromArg).toBe('2026-07-01');
        expect(toArg).toBe('2026-07-22');
    });

    it('403 for a caller without dashboard.manager', async () => {
        const res = await request(app).get('/api/v1/dashboard/manager/overview').set(authHeader(employeeToken));

        expect(res.status).toBe(403);
        expect(buildManagerOverviewMock).not.toHaveBeenCalled();
    });
});

// ─── GET /dashboard/employee/overview ─────────────────────────────────────

describe('GET /api/v1/dashboard/employee/overview', () => {
    it('200 — passes caller shape + from/to to buildEmployeeOverview', async () => {
        const res = await request(app)
            .get('/api/v1/dashboard/employee/overview?from=2026-07-01&to=2026-07-22')
            .set(authHeader(employeeToken));

        expect(res.status).toBe(200);
        expect(buildEmployeeOverviewMock).toHaveBeenCalledOnce();
        const [callerArg, fromArg, toArg] = buildEmployeeOverviewMock.mock.calls[0] as [
            { id: Types.ObjectId; role: string },
            string,
            string,
        ];
        expect(callerArg.id.toString()).toBe(employeeUserId.toString());
        expect(fromArg).toBe('2026-07-01');
        expect(toArg).toBe('2026-07-22');
    });

    it('403 for a caller without dashboard.employee', async () => {
        const noPermToken = issueToken({ role: 'employee', permissions: [], role_keys: ['employee'] });
        const res = await request(app).get('/api/v1/dashboard/employee/overview').set(authHeader(noPermToken));

        expect(res.status).toBe(403);
        expect(buildEmployeeOverviewMock).not.toHaveBeenCalled();
    });
});

// ─── GET /dashboard/client/overview ───────────────────────────────────────

describe('GET /api/v1/dashboard/client/overview', () => {
    it('200 — attendance:null + non-null representatives', async () => {
        const userId = new Types.ObjectId();
        const token = issueToken({
            user_id: userId.toString(),
            role: 'client',
            permissions: ['dashboard.client', 'project.read'],
            role_keys: ['client'],
        });

        const res = await request(app)
            .get('/api/v1/dashboard/client/overview?from=2026-07-01&to=2026-07-22')
            .set(authHeader(token));

        expect(res.status).toBe(200);
        expect(buildClientOverviewMock).toHaveBeenCalledOnce();
        expect(res.body.data.attendance).toBeNull();
        expect(res.body.data.representatives).not.toBeNull();
    });

    it('403 for a caller without dashboard.client', async () => {
        const res = await request(app)
            .get('/api/v1/dashboard/client/overview')
            .set(authHeader(issueToken({ role: 'employee', permissions: [] })));

        expect(res.status).toBe(403);
        expect(buildClientOverviewMock).not.toHaveBeenCalled();
    });
});
