import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Types } from 'mongoose';
import jwt from 'jsonwebtoken';
import request from 'supertest';

/**
 * Integration: POST /api/v1/leaves — apply for leave end-to-end.
 *
 * The whole point of an integration test here is to exercise the
 * `superRefine` cross-field rules in the validator AT ROUTE TIME,
 * not just by directly calling the schema. Unit tests have already
 * covered every refine branch (`leave-request.validator.test.ts`);
 * these integration tests confirm:
 *
 *   1. The validator middleware fires before the controller,
 *      surfacing 400 with the canonical envelope.
 *   2. The `requirePermission(LEAVE_REQUEST_WRITE)` route gate
 *      runs first — a caller without the permission gets 403
 *      regardless of payload validity.
 *   3. The service-layer error codes (INSUFFICIENT_LEAVE_BALANCE,
 *      ATTENDANCE_LEAVE_OVERLAP, etc.) reach the wire correctly
 *      after the validator passes.
 */

const { applyLeaveMock, userFindByIdMock, refreshCountMock, settingsMock, photoSignMock, resolvePermsMock } =
    vi.hoisted(() => ({
        applyLeaveMock: vi.fn(),
        userFindByIdMock: vi.fn(),
        refreshCountMock: vi.fn(),
        settingsMock: vi.fn(),
        photoSignMock: vi.fn(),
        resolvePermsMock: vi.fn(),
    }));

vi.mock('../services/leave-request.service.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../services/leave-request.service.js')>();
    return {
        ...actual,
        applyLeave: applyLeaveMock,
    };
});

vi.mock('../models/user.model.js', () => ({
    User: { findById: userFindByIdMock },
}));

vi.mock('../models/refresh-token.model.js', () => ({
    RefreshToken: { countDocuments: refreshCountMock },
}));

vi.mock('../services/settings.service.js', () => ({
    getOrInitSettings: settingsMock,
    resolveLoginLockoutPolicy: vi.fn().mockResolvedValue({
        failed_login_threshold: null,
        lockout_duration_minutes: null,
    }),
}));

vi.mock('../services/profile-photo.service.js', () => ({
    signProfilePhotoUrl: photoSignMock,
    resolveProfilePhotoTtlMinutes: vi.fn().mockReturnValue(15),
}));

vi.mock('../services/role.service.js', async () => {
    const actual = await vi.importActual<typeof import('../services/role.service.js')>('../services/role.service.js');
    return {
        ...actual,
        resolvePermissionsForUser: resolvePermsMock,
        ensureLegacyRoleAssigned: vi.fn(),
        bootstrapRolesMigration: vi.fn(),
    };
});

const { buildTestApp } = await import('./_helpers/build-app.js');
const { ERROR_CODES } = await import('../constants/error-codes.js');

const callerId = new Types.ObjectId();

const issueToken = (overrides: { permissions?: string[]; role?: string } = {}): string =>
    jwt.sign(
        {
            user_id: callerId.toString(),
            role: overrides.role ?? 'employee',
            role_keys: [overrides.role ?? 'employee'],
            permissions: overrides.permissions ?? ['leave_request.write'],
        },
        process.env.JWT_SECRET ?? 'test-secret',
        { expiresIn: '1h' }
    );

const validApplyPayload = {
    leave_type_id: '507f1f77bcf86cd799439011',
    start_date: '2026-04-23',
    end_date: '2026-04-25',
    is_half_day: false,
    reason: 'Family event',
};

beforeEach(() => {
    vi.resetAllMocks();
    settingsMock.mockResolvedValue({
        uploads: { sas_token_ttl_minutes: 15 },
        security: { require_mfa_for_admins: false },
    });
    photoSignMock.mockResolvedValue(null);
    refreshCountMock.mockResolvedValue(0);
    resolvePermsMock.mockResolvedValue({
        role_keys: ['employee'],
        permissions: ['leave_request.write'],
    });
    userFindByIdMock.mockReturnValue({
        select: () => ({ lean: () => Promise.resolve({ status: 'active', mfa_enabled: false }) }),
    });
});

describe('integration: POST /api/v1/leaves', () => {
    const app = buildTestApp();

    // ─── Auth + permission gating ─────────────────────────────────────

    it('401 UNAUTHENTICATED when no token is supplied', async () => {
        const res = await request(app).post('/api/v1/leaves').send(validApplyPayload);
        expect(res.status).toBe(401);
    });

    it('403 FORBIDDEN when the caller lacks leave_request.write', async () => {
        // A client (no leave_request.write) tries to apply for leave.
        // Pin the gate fires BEFORE the validator runs.
        const clientToken = issueToken({
            role: 'client',
            permissions: ['project.read'],
        });

        const res = await request(app)
            .post('/api/v1/leaves')
            .set('Authorization', `Bearer ${clientToken}`)
            .send(validApplyPayload);

        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe('FORBIDDEN');
        expect(applyLeaveMock).not.toHaveBeenCalled();
    });

    // ─── Validator superRefine — date constraints ─────────────────────

    it('400 VALIDATION_ERROR when start_date > end_date', async () => {
        // The cross-field check from `applyLeaveBodySchema.superRefine`.
        // Pin via integration that the error reaches the wire BEFORE
        // the service is even called.
        const res = await request(app)
            .post('/api/v1/leaves')
            .set('Authorization', `Bearer ${issueToken()}`)
            .send({
                ...validApplyPayload,
                start_date: '2026-04-25',
                end_date: '2026-04-23',
            });

        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
        expect(applyLeaveMock).not.toHaveBeenCalled();
    });

    it('400 VALIDATION_ERROR for an impossible calendar date (month 13)', async () => {
        // The H1-era `.refine` that catches invalid dates AFTER the
        // regex shape passes. The validator has the customParseFormat
        // plugin loaded (we just fixed that latent bug), so month 13
        // is correctly rejected at route time rather than slipping
        // through to the engine.
        const res = await request(app)
            .post('/api/v1/leaves')
            .set('Authorization', `Bearer ${issueToken()}`)
            .send({
                ...validApplyPayload,
                start_date: '2026-13-01',
                end_date: '2026-13-01',
            });

        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    // ─── Validator superRefine — half-day rules ───────────────────────

    it('400 VALIDATION_ERROR when is_half_day=true but start ≠ end', async () => {
        const res = await request(app)
            .post('/api/v1/leaves')
            .set('Authorization', `Bearer ${issueToken()}`)
            .send({
                ...validApplyPayload,
                is_half_day: true,
                half_day_slot: 'first_half',
                start_date: '2026-04-23',
                end_date: '2026-04-24',
            });

        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('400 VALIDATION_ERROR when is_half_day=true but half_day_slot is missing', async () => {
        const res = await request(app)
            .post('/api/v1/leaves')
            .set('Authorization', `Bearer ${issueToken()}`)
            .send({
                ...validApplyPayload,
                is_half_day: true,
                start_date: '2026-04-23',
                end_date: '2026-04-23',
            });

        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    // ─── Service-layer error code propagation ─────────────────────────

    it('422 INSUFFICIENT_LEAVE_BALANCE surfaces from the service layer with the canonical envelope', async () => {
        // Pin: a service-layer engine error reaches the wire correctly.
        // The validator passed; the service decided the user doesn't
        // have enough balance and threw a typed AppError.
        const { AppError } = await import('../utils/app-error.js');
        applyLeaveMock.mockRejectedValueOnce(
            AppError.unprocessable('Insufficient leave balance', ERROR_CODES.INSUFFICIENT_LEAVE_BALANCE, {
                available: 0.5,
                requested: 3,
            })
        );

        const res = await request(app)
            .post('/api/v1/leaves')
            .set('Authorization', `Bearer ${issueToken()}`)
            .send(validApplyPayload);

        expect(res.status).toBe(422);
        expect(res.body.error.code).toBe('INSUFFICIENT_LEAVE_BALANCE');
        expect(res.body.error.details).toEqual({ available: 0.5, requested: 3 });
    });

    it('409 LEAVE_OVERLAP surfaces from the service layer correctly', async () => {
        const { AppError } = await import('../utils/app-error.js');
        applyLeaveMock.mockRejectedValueOnce(
            AppError.conflict('Overlapping leave already exists', ERROR_CODES.LEAVE_OVERLAP, {
                conflicting_request_id: '507f1f77bcf86cd799439099',
            })
        );

        const res = await request(app)
            .post('/api/v1/leaves')
            .set('Authorization', `Bearer ${issueToken()}`)
            .send(validApplyPayload);

        expect(res.status).toBe(409);
        expect(res.body.error.code).toBe('LEAVE_OVERLAP');
    });

    // ─── Happy path ───────────────────────────────────────────────────

    it('201 with the created leave-request public projection', async () => {
        const newId = new Types.ObjectId();
        applyLeaveMock.mockResolvedValueOnce({
            id: newId.toString(),
            user_id: callerId.toString(),
            requested_leave_type_id: validApplyPayload.leave_type_id,
            start_date: '2026-04-23',
            end_date: '2026-04-25',
            total_days: 3,
            status: 'pending',
        });

        const res = await request(app)
            .post('/api/v1/leaves')
            .set('Authorization', `Bearer ${issueToken()}`)
            .send(validApplyPayload);

        expect(res.status).toBe(201);
        expect(res.body.data).toMatchObject({
            id: newId.toString(),
            status: 'pending',
            total_days: 3,
        });
        expect(applyLeaveMock).toHaveBeenCalledTimes(1);
    });

    // ─── Defaults / coercion ──────────────────────────────────────────

    it('defaults is_half_day to false when omitted (Zod default)', async () => {
        // The validator has `is_half_day: z.boolean().default(false)`.
        // Pin via integration that omitting the field doesn't 400 and
        // that the service receives `is_half_day: false` in the body.
        applyLeaveMock.mockResolvedValueOnce({ id: 'x', status: 'pending', total_days: 1 });

        const { is_half_day: _omit, ...payloadWithoutHalfDay } = validApplyPayload;
        void _omit;

        const res = await request(app)
            .post('/api/v1/leaves')
            .set('Authorization', `Bearer ${issueToken()}`)
            .send(payloadWithoutHalfDay);

        expect(res.status).toBe(201);
        // The validated body that reached the service has the default applied.
        const passedBody = applyLeaveMock.mock.calls[0]![0] as { is_half_day: boolean };
        expect(passedBody.is_half_day).toBe(false);
    });
});
