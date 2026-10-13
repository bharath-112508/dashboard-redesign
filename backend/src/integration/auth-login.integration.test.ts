import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Types } from 'mongoose';
import request from 'supertest';

/**
 * Integration: POST /api/v1/auth/login — exercise the full pipeline
 * end-to-end with the model layer mocked.
 *
 * What this catches that the auth.service unit tests don't:
 *   - Routing wiring (`/api/v1/auth/login` reaches `auth.postLogin`).
 *   - The `validate({body: loginBodySchema})` middleware runs BEFORE
 *     the controller and returns 400 with the canonical envelope.
 *   - The `authRateLimiter` is wired in front of the controller (we
 *     just confirm it doesn't reject normal traffic; the limiter has
 *     its own unit tests).
 *   - The error handler maps each AppError flavour to the right
 *     status code + body shape.
 *   - The success body has the public-projection envelope (`{data: ...}`).
 *
 * The seven branches of the login flow:
 *   1. Validation error (missing email / password) → 400
 *   2. Unknown email → 401 INVALID_CREDENTIALS (timing-equalised)
 *   3. Wrong password → 401 INVALID_CREDENTIALS + counter increment
 *   4. Currently locked → 423 ACCOUNT_LOCKED
 *   5. Deactivated → 403 ACCOUNT_DEACTIVATED
 *   6. MFA-enabled user → 200 with `{mfa_required: true, mfa_session_token}`
 *      — NEVER issues access/refresh tokens on this branch
 *   7. Happy path → 200 with token pair + user public projection
 */

const {
    userFindOneMock,
    userUpdateOneMock,
    userFindByIdMock,
    refreshCreateMock,
    refreshFindMock,
    refreshUpdateManyMock,
    auditMock,
    settingsMock,
    photoSignMock,
    resolvePermsMock,
} = vi.hoisted(() => ({
    userFindOneMock: vi.fn(),
    userUpdateOneMock: vi.fn(),
    userFindByIdMock: vi.fn(),
    refreshCreateMock: vi.fn(),
    refreshFindMock: vi.fn(),
    refreshUpdateManyMock: vi.fn(),
    auditMock: vi.fn(),
    settingsMock: vi.fn(),
    photoSignMock: vi.fn(),
    resolvePermsMock: vi.fn(),
}));

vi.mock('../models/user.model.js', () => ({
    User: {
        findOne: userFindOneMock,
        findById: userFindByIdMock,
        updateOne: userUpdateOneMock,
    },
}));

vi.mock('../models/refresh-token.model.js', () => ({
    RefreshToken: {
        create: refreshCreateMock,
        find: refreshFindMock,
        updateMany: refreshUpdateManyMock,
        countDocuments: vi.fn().mockResolvedValue(0),
    },
}));

vi.mock('../services/audit.service.js', () => ({
    recordAudit: auditMock,
    recordSystemAudit: vi.fn(),
}));

vi.mock('../services/settings.service.js', () => ({
    getOrInitSettings: settingsMock,
    resolveLoginLockoutPolicy: vi.fn().mockResolvedValue({
        failed_login_threshold: 5,
        lockout_duration_minutes: 15,
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
const { hashPassword } = await import('../utils/password.js');

const userId = new Types.ObjectId();
const VALID_PASSWORD = 'CorrectPass1!';

const makeUserDoc = async (overrides: Record<string, unknown> = {}) => {
    const passwordHash = await hashPassword(VALID_PASSWORD);
    return {
        _id: userId,
        email: 'jane@example.com',
        full_name: 'Jane Doe',
        role: 'employee',
        status: 'active',
        password_hash: passwordHash,
        failed_login_attempts: 0,
        locked_until: null as Date | null,
        mfa_enabled: false,
        ...overrides,
    };
};

beforeEach(() => {
    vi.clearAllMocks();
    settingsMock.mockResolvedValue({
        uploads: { sas_token_ttl_minutes: 15 },
        security: { require_mfa_for_admins: false, failed_login_threshold: 5, lockout_duration_minutes: 15 },
    });
    photoSignMock.mockResolvedValue(null);
    resolvePermsMock.mockResolvedValue({
        role_keys: ['employee'],
        permissions: ['user.read'],
    });
    refreshCreateMock.mockImplementation(async (doc: Record<string, unknown>) => ({
        ...doc,
        _id: new Types.ObjectId(),
    }));
    refreshFindMock.mockReturnValue({
        sort: () => ({ skip: () => ({ limit: () => Promise.resolve([]) }) }),
    });
});

describe('integration: POST /api/v1/auth/login', () => {
    const app = buildTestApp();

    // ─── Validation branch ────────────────────────────────────────────

    it('400 VALIDATION_ERROR when password is missing', async () => {
        const res = await request(app).post('/api/v1/auth/login').send({ email: 'jane@example.com' });

        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
        // The missing-field path is reported in details so the FE can
        // highlight it. A regression that flattened details would break
        // the FE's per-field error display.
        expect(res.body.error.details).toBeDefined();
    });

    it('400 VALIDATION_ERROR when email is malformed', async () => {
        // Pin: `.email()` rejects "not-an-email" before the controller
        // even sees it. A regression to a custom regex would let
        // borderline strings through.
        const res = await request(app).post('/api/v1/auth/login').send({ email: 'not-an-email', password: 'whatever' });

        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    // ─── Unknown email branch (timing-equalised) ──────────────────────

    it('401 INVALID_CREDENTIALS for an unknown email — never leaks "user not found"', async () => {
        // The user-enumeration defence: an unknown email returns the
        // SAME shape as a wrong-password attempt. A regression that
        // surfaced a 404 or USER_NOT_FOUND here would let an attacker
        // probe which emails exist via login.
        userFindOneMock.mockReturnValueOnce({ select: () => Promise.resolve(null) });

        const res = await request(app)
            .post('/api/v1/auth/login')
            .send({ email: 'ghost@example.com', password: 'whatever' });

        expect(res.status).toBe(401);
        expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
        // No leak of "user not found" or anything specific to enumeration.
        expect(res.body.error.message.toLowerCase()).not.toContain('user');
        expect(res.body.error.message.toLowerCase()).not.toContain('found');
    });

    // ─── Currently-locked branch ──────────────────────────────────────

    it('423 ACCOUNT_LOCKED when the user is currently within the lockout window', async () => {
        const lockedUser = await makeUserDoc({
            locked_until: new Date(Date.now() + 5 * 60 * 1000), // 5 min in the future
        });
        userFindOneMock.mockReturnValueOnce({ select: () => Promise.resolve(lockedUser) });

        const res = await request(app)
            .post('/api/v1/auth/login')
            .send({ email: 'jane@example.com', password: VALID_PASSWORD });

        expect(res.status).toBe(423);
        expect(res.body.error.code).toBe('ACCOUNT_LOCKED');
    });

    // ─── Deactivated branch ───────────────────────────────────────────

    it('403 ACCOUNT_DEACTIVATED when status != active', async () => {
        const deactivatedUser = await makeUserDoc({ status: 'deactivated' });
        userFindOneMock.mockReturnValueOnce({ select: () => Promise.resolve(deactivatedUser) });

        const res = await request(app)
            .post('/api/v1/auth/login')
            .send({ email: 'jane@example.com', password: VALID_PASSWORD });

        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe('ACCOUNT_DEACTIVATED');
    });

    // ─── Wrong-password branch ────────────────────────────────────────

    it('401 INVALID_CREDENTIALS when password does not match', async () => {
        const user = await makeUserDoc();
        userFindOneMock.mockReturnValueOnce({ select: () => Promise.resolve(user) });

        const res = await request(app)
            .post('/api/v1/auth/login')
            .send({ email: 'jane@example.com', password: 'WrongPass1!' });

        expect(res.status).toBe(401);
        expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
    });

    // ─── MFA challenge branch ─────────────────────────────────────────

    it('200 with MFA challenge (NEVER token pair) when mfa_enabled is true', async () => {
        // Cardinal rule: MFA branch MUST NOT issue access/refresh tokens.
        // A regression that sent both would let an attacker who got past
        // the password gate skip the TOTP entirely.
        const mfaUser = await makeUserDoc({ mfa_enabled: true });
        userFindOneMock.mockReturnValueOnce({ select: () => Promise.resolve(mfaUser) });

        const res = await request(app)
            .post('/api/v1/auth/login')
            .send({ email: 'jane@example.com', password: VALID_PASSWORD });

        expect(res.status).toBe(200);
        expect(res.body.data.mfa_required).toBe(true);
        expect(typeof res.body.data.mfa_session_token).toBe('string');
        expect(res.body.data.mfa_session_token.length).toBeGreaterThan(0);
        // No tokens leaked.
        expect(res.body.data.access_token).toBeUndefined();
        expect(res.body.data.refresh_token).toBeUndefined();
    });

    // ─── Happy path ───────────────────────────────────────────────────

    it('200 with the canonical token pair + user projection on a successful login', async () => {
        const user = await makeUserDoc();
        userFindOneMock.mockReturnValueOnce({ select: () => Promise.resolve(user) });

        const res = await request(app)
            .post('/api/v1/auth/login')
            .send({ email: 'jane@example.com', password: VALID_PASSWORD });

        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({
            access_token: expect.any(String),
            access_token_expires_at: expect.any(String),
            refresh_token: expect.any(String),
            refresh_token_expires_at: expect.any(String),
            user: {
                id: userId.toString(),
                role: 'employee',
                full_name: 'Jane Doe',
            },
        });
        // The public projection MUST NOT leak password_hash etc.
        const userJson = JSON.stringify(res.body.data.user);
        expect(userJson).not.toContain('password');
        expect(userJson).not.toContain('failed_login');
    });

    it('lowercases the email before lookup (so case-variant logins hit the same user)', async () => {
        // R7: defence-in-depth normalisation. A regression that dropped
        // the lowercase/trim would let the same user log in only via
        // their exact-cased email — accidental support escalation when
        // a user types "Jane@Example.com" and lookup misses.
        const user = await makeUserDoc();
        userFindOneMock.mockReturnValueOnce({ select: () => Promise.resolve(user) });

        await request(app).post('/api/v1/auth/login').send({ email: '  Jane@Example.COM  ', password: VALID_PASSWORD });

        // findOne was called with the LOWERCASED + trimmed email.
        expect(userFindOneMock).toHaveBeenCalledWith({ email: 'jane@example.com' });
    });

    // ─── Response envelope contract ───────────────────────────────────

    it('every error response uses the canonical {error: {code, message}} envelope', async () => {
        // Pin the error envelope shape across branches. The FE has a
        // single error-handling util that keys off `error.code`; a
        // regression that changed the envelope shape would silently
        // break every error-rendering surface.
        userFindOneMock.mockReturnValueOnce({ select: () => Promise.resolve(null) });
        const res = await request(app)
            .post('/api/v1/auth/login')
            .send({ email: 'ghost@example.com', password: 'wrong-pass' });

        expect(res.body).toEqual({
            error: expect.objectContaining({
                code: expect.any(String),
                message: expect.any(String),
            }),
        });
    });
});
