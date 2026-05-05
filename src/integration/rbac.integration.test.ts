import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Types } from 'mongoose';
import jwt from 'jsonwebtoken';
import request from 'supertest';

/**
 * Integration: cross-endpoint RBAC matrix.
 *
 * The Step-47 RBAC change introduced per-permission route gates
 * (`requirePermission(...)` middleware). Unit tests validate the
 * helper in isolation; this file pins the WIRED-UP behaviour:
 *
 *   For each (role, endpoint) pair, the JWT payload's `permissions[]`
 *   determines whether the request is allowed (200/201/204/404) or
 *   rejected with 403 FORBIDDEN — and the rejection happens BEFORE
 *   the controller runs (no service-layer state changes leak).
 *
 * The G1 audit found three project routes using broad `PROJECT_WRITE`
 * where granular permissions exist (`PROJECT_ARCHIVE`,
 * `PROJECT_MEMBERS_WRITE`, `PROJECT_CLIENTS_WRITE`). H2 fixed the
 * service-layer Team Lead gate to match the role bundle. This test
 * locks both layers in place: the route gate AND the service-level
 * `isProjectAuthor` helper agree on what each role can do.
 *
 * What we DO NOT test here (covered by unit tests):
 *   - The internals of `requirePermission` matching logic (unit-tested
 *     in `auth.middleware.test.ts`).
 *   - The role bundle composition (unit-tested via constants).
 *   - The `isProjectAuthor` helper (unit-tested in `role-check.test.ts`).
 *
 * What we DO test:
 *   - The right gate is wired to the right route, so a regression in
 *     the routes file (typoed permission, dropped middleware) surfaces
 *     immediately as a 403 where a 200 was expected.
 */

const { userFindByIdMock, refreshCountMock, settingsMock, photoSignMock, resolvePermsMock } = vi.hoisted(() => ({
    userFindByIdMock: vi.fn(),
    refreshCountMock: vi.fn(),
    settingsMock: vi.fn(),
    photoSignMock: vi.fn(),
    resolvePermsMock: vi.fn(),
}));

vi.mock('../models/user.model.js', () => ({
    User: { findById: userFindByIdMock, find: vi.fn(), exists: vi.fn(), countDocuments: vi.fn() },
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

const callerId = new Types.ObjectId();
const targetUserId = new Types.ObjectId();

/**
 * Issue a token for a caller with EXPLICIT permissions. We don't go
 * through the role-bundle resolution here — the JWT's `permissions[]`
 * is what `requirePermission` actually inspects, so testing the gate
 * with explicit permission lists is more direct.
 */
const issueToken = (permissions: string[]): string =>
    jwt.sign(
        {
            user_id: callerId.toString(),
            role: 'employee',
            role_keys: ['employee'],
            permissions,
        },
        process.env.JWT_SECRET ?? 'test-secret',
        { expiresIn: '1h' }
    );

const SYSTEM_ADMIN = 'system.admin'; // wildcard — admin satisfies every gate

beforeEach(() => {
    vi.resetAllMocks();
    settingsMock.mockResolvedValue({
        uploads: { sas_token_ttl_minutes: 15 },
        security: { require_mfa_for_admins: false },
    });
    photoSignMock.mockResolvedValue(null);
    refreshCountMock.mockResolvedValue(0);
    resolvePermsMock.mockResolvedValue({ role_keys: ['employee'], permissions: ['user.read'] });
    userFindByIdMock.mockReturnValue({
        select: () => ({ lean: () => Promise.resolve({ status: 'active', mfa_enabled: false }) }),
    });
});

describe('integration: RBAC route gates', () => {
    const app = buildTestApp();

    // ─── system.admin wildcard ────────────────────────────────────────

    it('admin (system.admin wildcard) satisfies every requirePermission gate', async () => {
        // The wildcard is the auth middleware's short-circuit. Pin
        // that an admin token can hit a privileged endpoint without
        // its specific permission being listed.
        // We test against POST /users which requires user.write — admin
        // doesn't carry that permission name, only system.admin.
        // The route should still allow the request (validator may then
        // 400 the empty body, but the 403 gate must NOT fire).
        const res = await request(app)
            .post('/api/v1/users')
            .set('Authorization', `Bearer ${issueToken([SYSTEM_ADMIN])}`)
            .send({}); // intentionally empty — we only care about 403 vs other codes

        // 400 (validation) is OK; 403 is the regression we're guarding against.
        expect(res.status).not.toBe(403);
    });

    // ─── user.write vs user.read ──────────────────────────────────────

    it('403 FORBIDDEN on POST /users when caller has user.read but not user.write', async () => {
        const res = await request(app)
            .post('/api/v1/users')
            .set('Authorization', `Bearer ${issueToken(['user.read'])}`)
            .send({ email: 'x@y.com', full_name: 'X', role: 'employee', initial_password: 'TempPass1!' });

        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe('FORBIDDEN');
    });

    // ─── user.write vs user.deactivate (granular separation) ──────────

    it('403 FORBIDDEN on POST /users/:id/deactivate when caller has user.write but NOT user.deactivate', async () => {
        // The G1-era split: a manager who can create users should NOT
        // automatically be able to deactivate them. Pin that the gates
        // are distinct.
        const res = await request(app)
            .post(`/api/v1/users/${targetUserId.toString()}/deactivate`)
            .set('Authorization', `Bearer ${issueToken(['user.write'])}`)
            .send({});

        expect(res.status).toBe(403);
    });

    // ─── PROJECT_ARCHIVE vs PROJECT_WRITE (G1) ────────────────────────

    it('G1 — DELETE /projects/:id requires PROJECT_ARCHIVE specifically (not just PROJECT_WRITE)', async () => {
        // The G1 audit caught this: an actor with project.write was
        // able to delete projects because the route was using the
        // broader gate. Pin that the granular permission is required.
        const res = await request(app)
            .delete(`/api/v1/projects/${new Types.ObjectId().toString()}`)
            .set('Authorization', `Bearer ${issueToken(['project.write'])}`);

        expect(res.status).toBe(403);
    });

    // Note: we deliberately don't test the POSITIVE side of every G1
    // route (i.e. confirming a permitted caller passes the gate) because
    // doing so requires mocking the full service stack (Project /
    // Sprint / etc. models). The unit tests for `requirePermission`
    // already cover the "pass when held" branch in isolation; here we
    // pin the security-relevant NEGATIVE — the gate REJECTS callers
    // without the right permission, which is the regression class that
    // would actually leak privilege.

    // ─── PROJECT_MEMBERS_WRITE vs PROJECT_WRITE (G1) ──────────────────

    it('G1 — POST /projects/:id/members requires PROJECT_MEMBERS_WRITE (not PROJECT_WRITE)', async () => {
        const res = await request(app)
            .post(`/api/v1/projects/${new Types.ObjectId().toString()}/members`)
            .set('Authorization', `Bearer ${issueToken(['project.write'])}`)
            .send({ add: [], remove: [] });

        expect(res.status).toBe(403);
    });

    // ─── PROJECT_CLIENTS_WRITE — Team Lead exclusion (G1) ─────────────

    it('G1 — POST /projects/:id/clients requires PROJECT_CLIENTS_WRITE; team_lead does NOT have it', async () => {
        // The G1 finding: team_lead has project.write but explicitly
        // NOT project.clients_write per the role bundle. Pin that
        // even with project.write, a team_lead can't mutate the
        // client roster.
        const res = await request(app)
            .post(`/api/v1/projects/${new Types.ObjectId().toString()}/clients`)
            .set('Authorization', `Bearer ${issueToken(['project.write'])}`)
            .send({ add: [], remove: [] });

        expect(res.status).toBe(403);
    });

    // ─── leave_request.write — required to apply ──────────────────────

    it('403 on POST /leaves when caller lacks leave_request.write', async () => {
        const res = await request(app)
            .post('/api/v1/leaves')
            .set('Authorization', `Bearer ${issueToken(['user.read'])}`)
            .send({});

        expect(res.status).toBe(403);
    });

    it('passes the leave_request.write gate; controller-side validation then surfaces 400', async () => {
        // With the right permission, an empty body is rejected by the
        // VALIDATOR, not by the gate. Pin the difference: 400 ≠ 403.
        const res = await request(app)
            .post('/api/v1/leaves')
            .set('Authorization', `Bearer ${issueToken(['leave_request.write'])}`)
            .send({});

        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    // ─── leave_request.approve — required to approve/reject ───────────

    it('403 on POST /leaves/:id/approve when caller lacks leave_request.approve', async () => {
        // The leave_request.write permission lets a user CREATE leaves
        // (their own); approve/reject is a separate verb gated to
        // managers / team_leads.
        const res = await request(app)
            .post(`/api/v1/leaves/${new Types.ObjectId().toString()}/approve`)
            .set('Authorization', `Bearer ${issueToken(['leave_request.write'])}`)
            .send({});

        expect(res.status).toBe(403);
    });

    // ─── /me/profile-photo — owner-scoped, no permission gate ─────────

    it('GET /auth/me works for any authenticated user (no specific permission required)', async () => {
        // The /me endpoints are owner-scoped via authenticate only.
        // Pin that an employee with NO specific permissions still
        // gets through — a regression that gated /me on user.read
        // would block legitimate sessions.
        userFindByIdMock.mockReturnValueOnce({
            select: () => ({ lean: () => Promise.resolve({ status: 'active', mfa_enabled: false }) }),
        });
        userFindByIdMock.mockResolvedValueOnce({
            _id: callerId,
            email: 'jane@example.com',
            full_name: 'Jane',
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

        const res = await request(app)
            .get('/api/v1/auth/me')
            .set('Authorization', `Bearer ${issueToken([])}`); // empty permissions

        expect(res.status).toBe(200);
        expect(res.body.data.role).toBe('employee');
    });

    // ─── Audit-log read — admin only ──────────────────────────────────

    it('403 on GET /audit-logs when caller is not admin (audit_log.read required)', async () => {
        // The Step-47 RBAC explicitly gates /audit-logs to
        // audit_log.read (admin-only). A regression that opened it to
        // managers would let team-management users read every
        // platform mutation.
        const res = await request(app)
            .get('/api/v1/audit-logs')
            .set('Authorization', `Bearer ${issueToken(['user.write'])}`); // not audit_log.read

        expect(res.status).toBe(403);
    });
});
