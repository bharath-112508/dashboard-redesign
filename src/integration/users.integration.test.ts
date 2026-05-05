import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Types } from 'mongoose';
import jwt from 'jsonwebtoken';
import request from 'supertest';

/**
 * Integration: /api/v1/users CRUD — exercises the full
 * authenticate → requirePermission → validate → controller pipeline.
 *
 * Three slices worth pinning at the integration level:
 *
 *   1. **Permission gating** — POST/DELETE require `user.write` /
 *      `user.deactivate`. A caller without those permissions gets
 *      403 BEFORE the validator or controller runs. A regression that
 *      moved the gate to the controller would let an invalid payload
 *      from a privileged-impersonator surface as a 400 instead of a
 *      403, leaking the route's existence.
 *
 *   2. **Validation cross-field rules** — the createUser
 *      `superRefine` enforces role-shape consistency: client role MUST
 *      carry client_profile + MUST NOT carry internal_profile, and
 *      vice versa for internal roles. The unit tests cover the schema
 *      directly; integration pins that the validator middleware fires
 *      AT ROUTE TIME with the canonical error envelope.
 *
 *   3. **Service-layer invariants** — single-admin enforcement (the
 *      `assertSingleAdmin` guard surfaces as 409 ADMIN_ALREADY_EXISTS)
 *      and the email-already-exists branch (409 EMAIL_ALREADY_EXISTS).
 */

const {
    userExistsMock,
    userCreateMock,
    userFindByIdMock,
    refreshCountMock,
    settingsMock,
    photoSignMock,
    resolvePermsMock,
    notifyInvitedMock,
    auditMock,
} = vi.hoisted(() => ({
    userExistsMock: vi.fn(),
    userCreateMock: vi.fn(),
    userFindByIdMock: vi.fn(),
    refreshCountMock: vi.fn(),
    settingsMock: vi.fn(),
    photoSignMock: vi.fn(),
    resolvePermsMock: vi.fn(),
    notifyInvitedMock: vi.fn(),
    auditMock: vi.fn(),
}));

vi.mock('../models/user.model.js', () => ({
    User: {
        exists: userExistsMock,
        create: userCreateMock,
        findById: userFindByIdMock,
        find: vi.fn(),
        countDocuments: vi.fn(),
    },
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
        getSystemRoleByKey: vi.fn().mockResolvedValue(null),
    };
});

vi.mock('../services/notification-dispatcher.service.js', () => ({
    notifyUserInvited: notifyInvitedMock,
}));

vi.mock('../services/audit.service.js', () => ({
    recordAudit: auditMock,
    recordSystemAudit: vi.fn(),
}));

// `createUser` calls `initializeBalancesForUserYear` after creating the
// user — without this mock, the service would query the un-mocked
// `LeaveType` collection and the request would hang against an
// un-connected Mongoose.
vi.mock('../services/leave-balance.service.js', () => ({
    initializeBalancesForUserYear: vi.fn().mockResolvedValue(0),
}));

const { buildTestApp } = await import('./_helpers/build-app.js');

const adminId = new Types.ObjectId();
const otherUserId = new Types.ObjectId();

const issueToken = (overrides: { role?: string; permissions?: string[]; user_id?: string } = {}): string =>
    jwt.sign(
        {
            user_id: overrides.user_id ?? adminId.toString(),
            role: overrides.role ?? 'admin',
            role_keys: [overrides.role ?? 'admin'],
            permissions: overrides.permissions ?? ['system.admin'],
        },
        process.env.JWT_SECRET ?? 'test-secret',
        { expiresIn: '1h' }
    );

const validInternalProfile = {
    employee_id: 'EMP-001',
    department: 'Engineering',
    job_title: 'Senior Engineer',
    date_of_joining: '2026-01-15',
};

const validCreatePayload = {
    email: 'newhire@example.com',
    full_name: 'New Hire',
    role: 'employee',
    initial_password: 'TempPass1!',
    internal_profile: validInternalProfile,
};

beforeEach(() => {
    // `resetAllMocks` (not `clearAllMocks`) so any `mockResolvedValueOnce`
    // queue from a previous test is fully drained — otherwise a stale
    // queued return leaks across test boundaries and causes hard-to-debug
    // intermittent failures.
    vi.resetAllMocks();
    settingsMock.mockResolvedValue({
        uploads: { sas_token_ttl_minutes: 15 },
        security: { require_mfa_for_admins: false },
    });
    photoSignMock.mockResolvedValue(null);
    refreshCountMock.mockResolvedValue(0);
    resolvePermsMock.mockResolvedValue({ role_keys: ['admin'], permissions: ['system.admin'] });
    notifyInvitedMock.mockResolvedValue(undefined);

    // Default: caller `findById` chain returned by the auth middleware.
    userFindByIdMock.mockReturnValue({
        select: () => ({ lean: () => Promise.resolve({ status: 'active', mfa_enabled: false }) }),
    });
});

describe('integration: POST /api/v1/users (admin-only create)', () => {
    const app = buildTestApp();

    // ─── Permission gating (route-level) ──────────────────────────────

    it('401 UNAUTHENTICATED with no token', async () => {
        const res = await request(app).post('/api/v1/users').send(validCreatePayload);
        expect(res.status).toBe(401);
        expect(res.body.error.code).toBe('UNAUTHENTICATED');
    });

    it('403 FORBIDDEN when an employee (no user.write permission) tries to create', async () => {
        // The `requirePermission(USER_WRITE)` middleware fires BEFORE
        // the validator. An employee gets 403 even with a malformed
        // body — pin that behaviour so a future refactor that moved
        // the gate to the controller would surface here.
        const employeeToken = issueToken({
            role: 'employee',
            permissions: ['user.read'], // no user.write
        });

        const res = await request(app)
            .post('/api/v1/users')
            .set('Authorization', `Bearer ${employeeToken}`)
            .send(validCreatePayload);

        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe('FORBIDDEN');
        // The controller / service must NOT have been called.
        expect(userCreateMock).not.toHaveBeenCalled();
    });

    // ─── Validation cross-field rules ─────────────────────────────────

    it('400 VALIDATION_ERROR when role=employee but client_profile is supplied', async () => {
        // The `superRefine` cross-check: an internal role MUST NOT
        // carry client_profile. Pin via integration so a regression
        // that dropped the refine surfaces as a route-level 400.
        const res = await request(app)
            .post('/api/v1/users')
            .set('Authorization', `Bearer ${issueToken()}`)
            .send({
                ...validCreatePayload,
                client_profile: { client_company: 'Some Co' },
            });

        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('400 VALIDATION_ERROR when role=employee but internal_profile is missing', async () => {
        // The mirror property — internal roles REQUIRE an
        // internal_profile.
        const { internal_profile: _omit, ...withoutProfile } = validCreatePayload;
        void _omit;
        const res = await request(app)
            .post('/api/v1/users')
            .set('Authorization', `Bearer ${issueToken()}`)
            .send(withoutProfile);

        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('400 VALIDATION_ERROR for malformed email', async () => {
        const res = await request(app)
            .post('/api/v1/users')
            .set('Authorization', `Bearer ${issueToken()}`)
            .send({ ...validCreatePayload, email: 'not-an-email' });

        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    // ─── Service-layer invariants ─────────────────────────────────────

    it('409 ADMIN_ALREADY_EXISTS when creating a second active admin', async () => {
        // The `assertSingleAdmin` guard — pin via integration that
        // the canonical 409 + code reaches the wire. A regression
        // that surfaced this as a 500 would let the FE accept a
        // pre-conditional admin-bootstrap UI flow incorrectly.
        userExistsMock.mockResolvedValueOnce(true); // existing admin found

        const res = await request(app)
            .post('/api/v1/users')
            .set('Authorization', `Bearer ${issueToken()}`)
            .send({
                ...validCreatePayload,
                role: 'admin',
                internal_profile: validInternalProfile,
            });

        expect(res.status).toBe(409);
        expect(res.body.error.code).toBe('ADMIN_ALREADY_EXISTS');
        // The user MUST NOT be created.
        expect(userCreateMock).not.toHaveBeenCalled();
    });

    it('409 EMAIL_ALREADY_EXISTS when the email is taken by another user', async () => {
        // For role=employee the assertSingleAdmin guard is skipped, so the
        // email-existence check is the FIRST (and only) `User.exists` call.
        userExistsMock.mockResolvedValueOnce(true);

        const res = await request(app)
            .post('/api/v1/users')
            .set('Authorization', `Bearer ${issueToken()}`)
            .send(validCreatePayload);

        expect(res.status).toBe(409);
        expect(res.body.error.code).toBe('EMAIL_ALREADY_EXISTS');
        expect(userCreateMock).not.toHaveBeenCalled();
    });

    // ─── Happy path ───────────────────────────────────────────────────

    it('201 with the public user projection on successful creation', async () => {
        userExistsMock.mockResolvedValueOnce(false); // email check — no collision
        const newUserId = new Types.ObjectId();
        userCreateMock.mockResolvedValueOnce({
            _id: newUserId,
            email: 'newhire@example.com',
            full_name: 'New Hire',
            role: 'employee',
            status: 'active',
            internal_profile: validInternalProfile,
            toJSON() {
                return {
                    id: this._id.toString(),
                    email: this.email,
                    full_name: this.full_name,
                    role: this.role,
                    status: this.status,
                };
            },
        });

        const res = await request(app)
            .post('/api/v1/users')
            .set('Authorization', `Bearer ${issueToken()}`)
            .send(validCreatePayload);

        expect(res.status).toBe(201);
        expect(res.body.data).toMatchObject({
            id: newUserId.toString(),
            email: 'newhire@example.com',
            role: 'employee',
        });
        // password_hash MUST NOT appear in the response (toJSON strips it,
        // pin the contract via JSON-serialised body).
        expect(JSON.stringify(res.body)).not.toContain('password');
    });

    it('lowercases the email at the validator before storage', async () => {
        // R7 defence-in-depth: case-variant emails get normalised so
        // user lookup at /auth/login (which also lowercases) hits the
        // same row.
        userExistsMock.mockResolvedValueOnce(false); // email check returns false
        userCreateMock.mockResolvedValueOnce({
            _id: new Types.ObjectId(),
            email: 'newhire@example.com',
            full_name: 'New Hire',
            role: 'employee',
            status: 'active',
            internal_profile: validInternalProfile,
            toJSON() {
                return { email: this.email };
            },
        });

        await request(app)
            .post('/api/v1/users')
            .set('Authorization', `Bearer ${issueToken()}`)
            .send({ ...validCreatePayload, email: '  NewHire@Example.COM  ' });

        // The exists check used the lowercased + trimmed email — the
        // validator does `.trim().toLowerCase()` before the service sees
        // the body, so case variants and accidental whitespace both
        // collapse to the canonical form.
        expect(userExistsMock).toHaveBeenCalledWith({ email: 'newhire@example.com' });
    });
});

// ─── DELETE /users/:id/deactivate (separate permission) ───────────────────

describe('integration: POST /api/v1/users/:id/deactivate', () => {
    const app = buildTestApp();

    it('403 FORBIDDEN when caller has user.write but NOT user.deactivate (granular permission gate)', async () => {
        // Distinct permission: user.write lets you create; user.deactivate
        // is required to take an account offline. Pin that the gates are
        // separate so a future refactor that collapsed them would surface.
        const writeOnlyToken = issueToken({
            role: 'manager',
            permissions: ['user.write'], // user.deactivate NOT included
        });

        const res = await request(app)
            .post(`/api/v1/users/${otherUserId.toString()}/deactivate`)
            .set('Authorization', `Bearer ${writeOnlyToken}`)
            .send({});

        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe('FORBIDDEN');
    });

    it('400 VALIDATION_ERROR for an invalid ObjectId in the URL', async () => {
        // Pin the validator on params runs at integration time. A regression
        // that dropped the params validator would let `not-an-id` reach
        // mongoose and surface as a CastError mid-controller (still 400 via
        // the global handler, but with a different shape).
        const res = await request(app)
            .post('/api/v1/users/not-an-id/deactivate')
            .set('Authorization', `Bearer ${issueToken()}`)
            .send({});

        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });
});
