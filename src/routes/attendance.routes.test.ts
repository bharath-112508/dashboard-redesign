// src/routes/attendance.routes.test.ts
//
// HTTP-level tests for POST /api/v1/attendance/break/start and
// POST /api/v1/attendance/break/end.
//
// Harness mirrors dashboard.routes.test.ts: real JWTs, User.findById
// stubbed, attendance service mocked at module level via vi.hoisted.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Types } from 'mongoose';
import jwt from 'jsonwebtoken';
import request from 'supertest';

// ─── Hoisted mock factories ───────────────────────────────────────────────

const { startBreakMock, endBreakMock, userFindByIdMock, settingsMock } = vi.hoisted(() => ({
    startBreakMock: vi.fn(),
    endBreakMock: vi.fn(),
    userFindByIdMock: vi.fn(),
    settingsMock: vi.fn(),
}));

// ─── Module mocks ─────────────────────────────────────────────────────────

vi.mock('../services/attendance.service.js', () => ({
    checkIn: vi.fn(),
    checkOut: vi.fn(),
    verifyQr: vi.fn(),
    getMyToday: vi.fn(),
    listMyAttendance: vi.fn(),
    listAttendance: vi.fn(),
    patchAttendance: vi.fn(),
    submitCorrection: vi.fn(),
    listCorrections: vi.fn(),
    approveCorrection: vi.fn(),
    rejectCorrection: vi.fn(),
    cancelCorrection: vi.fn(),
    startBreak: startBreakMock,
    endBreak: endBreakMock,
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
            user_id: overrides.user_id ?? employeeUserId.toString(),
            role: overrides.role ?? 'employee',
            role_keys: overrides.role_keys ?? [overrides.role ?? 'employee'],
            permissions: overrides.permissions ?? ['attendance.check_in_out'],
        },
        TEST_SECRET,
        { expiresIn: '1h' }
    );

const employeeToken = issueToken();
const authHeader = { Authorization: `Bearer ${employeeToken}` };

const STUB_RECORD = { _id: new Types.ObjectId().toString(), status: 'present', breaks: [] };

// ─── Setup ────────────────────────────────────────────────────────────────

beforeEach(() => {
    vi.resetAllMocks();

    userFindByIdMock.mockReturnValue({
        select: () => ({ lean: () => Promise.resolve({ status: 'active', mfa_enabled: false }) }),
    });

    settingsMock.mockResolvedValue({
        security: { require_mfa_for_admins: false },
    });

    startBreakMock.mockResolvedValue(STUB_RECORD);
    endBreakMock.mockResolvedValue(STUB_RECORD);
});

// ─── POST /attendance/break/start ─────────────────────────────────────────

describe('POST /api/v1/attendance/break/start', () => {
    it('validates break_type and calls startBreak with source=app', async () => {
        const res = await request(app)
            .post('/api/v1/attendance/break/start')
            .set(authHeader)
            .send({ break_type: 'lunch' });

        expect(res.status).toBe(200);
        expect(startBreakMock).toHaveBeenCalledWith(expect.anything(), 'lunch', 'app');
    });

    it('rejects an unknown break_type with 400', async () => {
        const res = await request(app)
            .post('/api/v1/attendance/break/start')
            .set(authHeader)
            .send({ break_type: 'nap' });

        expect(res.status).toBe(400);
        expect(startBreakMock).not.toHaveBeenCalled();
    });

    it('rejects a missing break_type with 400', async () => {
        const res = await request(app).post('/api/v1/attendance/break/start').set(authHeader).send({});

        expect(res.status).toBe(400);
        expect(startBreakMock).not.toHaveBeenCalled();
    });

    it('returns 401 without auth', async () => {
        const res = await request(app).post('/api/v1/attendance/break/start').send({ break_type: 'lunch' });

        expect(res.status).toBe(401);
        expect(startBreakMock).not.toHaveBeenCalled();
    });
});

// ─── POST /attendance/break/end ───────────────────────────────────────────

describe('POST /api/v1/attendance/break/end', () => {
    it('calls endBreak with source=app', async () => {
        const res = await request(app).post('/api/v1/attendance/break/end').set(authHeader).send({});

        expect(res.status).toBe(200);
        expect(endBreakMock).toHaveBeenCalledWith(expect.anything(), 'app');
    });

    it('returns 401 without auth', async () => {
        const res = await request(app).post('/api/v1/attendance/break/end').send({});

        expect(res.status).toBe(401);
        expect(endBreakMock).not.toHaveBeenCalled();
    });
});
