import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Types } from 'mongoose';
import jwt from 'jsonwebtoken';
import request from 'supertest';

/**
 * Integration: GET /api/v1/auth/me — exercise the full pipeline
 * from `authenticate` middleware → controller → response, with the
 * model layer stubbed.
 *
 * What this catches that unit tests don't:
 *   - Routing typos (a typo in the route prefix would 404 here even
 *     when the unit test for the controller passes).
 *   - Middleware ordering (rate-limit BEFORE auth, validate BEFORE
 *     controller, etc.).
 *   - Bearer-token parsing in the auth middleware.
 *   - Response envelope from the `ok` helper.
 */

const { userFindByIdMock, refreshCountMock, settingsMock, photoSignMock, resolvePermsMock } = vi.hoisted(() => ({
    userFindByIdMock: vi.fn(),
    refreshCountMock: vi.fn(),
    settingsMock: vi.fn(),
    photoSignMock: vi.fn(),
    resolvePermsMock: vi.fn(),
}));

vi.mock('../models/user.model.js', () => ({
    User: {
        findById: userFindByIdMock,
    },
}));

vi.mock('../models/refresh-token.model.js', () => ({
    RefreshToken: {
        countDocuments: refreshCountMock,
    },
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

const userId = new Types.ObjectId();

const issueAccessToken = () =>
    jwt.sign(
        {
            user_id: userId.toString(),
            role: 'employee',
            role_keys: ['employee'],
            permissions: ['user.read'],
        },
        process.env.JWT_SECRET ?? 'test-secret',
        { expiresIn: '1h' }
    );

beforeEach(() => {
    userFindByIdMock.mockReset();
    refreshCountMock.mockReset();
    settingsMock.mockReset();
    photoSignMock.mockReset();
    resolvePermsMock.mockReset();

    settingsMock.mockResolvedValue({
        uploads: { sas_token_ttl_minutes: 15 },
        security: { require_mfa_for_admins: false },
    });
    photoSignMock.mockResolvedValue(null);
    refreshCountMock.mockResolvedValue(2);
    resolvePermsMock.mockResolvedValue({ role_keys: ['employee'], permissions: ['user.read'] });
});

describe('integration: GET /api/v1/auth/me', () => {
    const app = buildTestApp();

    it('rejects an unauthenticated request with 401', async () => {
        const res = await request(app).get('/api/v1/auth/me');

        expect(res.status).toBe(401);
        expect(res.body.error?.code).toBe('UNAUTHENTICATED');
    });

    it('returns the caller summary for a valid bearer token', async () => {
        // T1 — `authenticate` middleware now does its own `findById`
        // BEFORE the controller runs (status + MFA gate). Mock the
        // chain pattern (`.select().lean()`) for that first call,
        // then mock the resolved doc that `getMe` consumes.
        userFindByIdMock.mockReturnValueOnce({
            select: () => ({ lean: () => Promise.resolve({ status: 'active', mfa_enabled: false }) }),
        });
        userFindByIdMock.mockResolvedValueOnce({
            _id: userId,
            email: 'jane@example.com',
            full_name: 'Jane Doe',
            role: 'employee',
            status: 'active',
            timezone: 'Asia/Kolkata',
            mfa_enabled: false,
            comp_off_balance: 0,
            slack_user_id: null,
            slack_notifications_enabled: true,
            profile_photo_blob_key: null,
            role_ids: [],
            extra_permissions: [],
            last_login_at: null,
        });

        const res = await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${issueAccessToken()}`);

        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({
            id: userId.toString(),
            email: 'jane@example.com',
            full_name: 'Jane Doe',
            role: 'employee',
        });
    });

    it('rejects a malformed Authorization header with 401', async () => {
        const res = await request(app).get('/api/v1/auth/me').set('Authorization', 'NotBearer xxx');

        expect(res.status).toBe(401);
    });
});
