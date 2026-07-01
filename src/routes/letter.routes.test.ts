// src/routes/letter.routes.test.ts
//
// HTTP-level tests for POST /api/v1/letters proving the route is gated
// purely by the `letter.generate` PERMISSION, not by role.
//
// Harness mirrors dashboard.routes.test.ts / attendance.routes.test.ts:
// real JWTs signed with the test JWT secret drive the full
// authenticate → requirePermission → validate chain; only the letter
// service and the User model (read by `authenticate`) are mocked.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Types } from 'mongoose';
import jwt from 'jsonwebtoken';
import request from 'supertest';

// ─── Hoisted mock factories ───────────────────────────────────────────────

const { generateLetterMock, userFindByIdMock, settingsMock } = vi.hoisted(() => ({
    generateLetterMock: vi.fn(),
    userFindByIdMock: vi.fn(),
    settingsMock: vi.fn(),
}));

// ─── Module mocks (must be before any imports that load these) ───────────

vi.mock('../services/letter.service.js', () => ({
    generateLetter: generateLetterMock,
    listLetters: vi.fn(),
    downloadLetter: vi.fn(),
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
    type: 'relieving',
    user_id: '5f'.padEnd(24, '0'),
    last_working_day: '2026-02-28',
};

const STUB_RESULT = { _id: new Types.ObjectId().toString(), type: VALID_BODY.type };

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

    generateLetterMock.mockResolvedValue(STUB_RESULT);
});

// ─── POST /letters ──────────────────────────────────────────────────────────

describe('POST /api/v1/letters', () => {
    it('403s a token that lacks letter.generate', async () => {
        const token = issueToken({ role: 'employee', permissions: ['payroll.read'] });

        const res = await request(app).post('/api/v1/letters').set(authHeader(token)).send(VALID_BODY);

        expect(res.status).toBe(403);
        expect(generateLetterMock).not.toHaveBeenCalled();
    });

    it('allows (not 403) a token that holds letter.generate', async () => {
        const token = issueToken({ role: 'manager', permissions: ['letter.generate'] });

        const res = await request(app).post('/api/v1/letters').set(authHeader(token)).send(VALID_BODY);

        expect(res.status).not.toBe(403);
        expect(res.status).toBe(201);
        expect(generateLetterMock).toHaveBeenCalledOnce();
    });

    it('allows a non-manager token that carries letter.generate (permission-based, not role-based)', async () => {
        const token = issueToken({ role: 'accountant', permissions: ['letter.generate', 'payroll.read'] });

        const res = await request(app).post('/api/v1/letters').set(authHeader(token)).send(VALID_BODY);

        expect(res.status).not.toBe(403);
        expect(res.status).toBe(201);
        expect(generateLetterMock).toHaveBeenCalledOnce();
    });

    it('401s without auth', async () => {
        const res = await request(app).post('/api/v1/letters').send(VALID_BODY);

        expect(res.status).toBe(401);
        expect(generateLetterMock).not.toHaveBeenCalled();
    });
});
