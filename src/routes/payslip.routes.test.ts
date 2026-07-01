// src/routes/payslip.routes.test.ts
//
// HTTP-level tests for POST /api/v1/payslips proving the route is gated
// purely by the `payslip.generate` PERMISSION, not by role.
//
// Harness mirrors dashboard.routes.test.ts / attendance.routes.test.ts:
// real JWTs signed with the test JWT secret drive the full
// authenticate → requirePermission → validate chain; only the payslip
// service and the User model (read by `authenticate`) are mocked.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Types } from 'mongoose';
import jwt from 'jsonwebtoken';
import request from 'supertest';

// ─── Hoisted mock factories ───────────────────────────────────────────────

const { generatePayslipMock, userFindByIdMock, settingsMock } = vi.hoisted(() => ({
    generatePayslipMock: vi.fn(),
    userFindByIdMock: vi.fn(),
    settingsMock: vi.fn(),
}));

// ─── Module mocks (must be before any imports that load these) ───────────

vi.mock('../services/payslip.service.js', () => ({
    generatePayslip: generatePayslipMock,
    listPayslips: vi.fn(),
    downloadPayslip: vi.fn(),
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

const VALID_BODY = {
    user_id: '5f'.padEnd(24, '0'),
    pay_period: 'February-2026',
    days_present: 22,
    effective_on: '2026-02-28',
};

const STUB_RESULT = { _id: new Types.ObjectId().toString(), pay_period: VALID_BODY.pay_period };

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

    generatePayslipMock.mockResolvedValue(STUB_RESULT);
});

// ─── POST /payslips ────────────────────────────────────────────────────────

describe('POST /api/v1/payslips', () => {
    it('403s a token that lacks payslip.generate', async () => {
        const token = issueToken({ role: 'employee', permissions: ['payroll.read'] });

        const res = await request(app).post('/api/v1/payslips').set(authHeader(token)).send(VALID_BODY);

        expect(res.status).toBe(403);
        expect(generatePayslipMock).not.toHaveBeenCalled();
    });

    it('allows (not 403) a token that holds payslip.generate', async () => {
        const token = issueToken({ role: 'manager', permissions: ['payslip.generate'] });

        const res = await request(app).post('/api/v1/payslips').set(authHeader(token)).send(VALID_BODY);

        expect(res.status).not.toBe(403);
        expect(res.status).toBe(201);
        expect(generatePayslipMock).toHaveBeenCalledOnce();
    });

    it('allows a non-manager token that carries payslip.generate (permission-based, not role-based)', async () => {
        const token = issueToken({ role: 'accountant', permissions: ['payslip.generate', 'payroll.read'] });

        const res = await request(app).post('/api/v1/payslips').set(authHeader(token)).send(VALID_BODY);

        expect(res.status).not.toBe(403);
        expect(res.status).toBe(201);
        expect(generatePayslipMock).toHaveBeenCalledOnce();
    });

    it('422/400s an invalid body even with a valid permission (validate middleware still runs)', async () => {
        const token = issueToken({ role: 'accountant', permissions: ['payslip.generate'] });

        const res = await request(app)
            .post('/api/v1/payslips')
            .set(authHeader(token))
            .send({ ...VALID_BODY, days_present: 'not-a-number' });

        expect([400, 422]).toContain(res.status);
        expect(generatePayslipMock).not.toHaveBeenCalled();
    });

    it('401s without auth', async () => {
        const res = await request(app).post('/api/v1/payslips').send(VALID_BODY);

        expect(res.status).toBe(401);
        expect(generatePayslipMock).not.toHaveBeenCalled();
    });
});
