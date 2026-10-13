import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Types } from 'mongoose';
import jwt from 'jsonwebtoken';
import request from 'supertest';

/**
 * Integration: POST /api/v1/auth/refresh + /api/v1/auth/logout —
 * the token-rotation contract end-to-end.
 *
 * Five branches worth pinning:
 *   1. Refresh happy path issues a NEW token pair, revokes the
 *      presented token, and returns the canonical envelope.
 *   2. Replay of an already-rotated token triggers REUSE detection
 *      → revokes ENTIRE chain → 401 TOKEN_REUSE_DETECTED.
 *   3. Refresh on a deactivated user → 403 + chain-revoked
 *      (defence: a token issued before deactivation must not survive).
 *   4. Refresh on an expired token → 401 TOKEN_EXPIRED.
 *   5. Logout is idempotent (unknown / already-revoked → 204 silently),
 *      so a stale FE that re-sends the same logout doesn't 4xx.
 */

import { JWT_REFRESH_SECRET } from '../config/server.config.js';

const {
    refreshFindOneMock,
    refreshUpdateOneMock,
    refreshUpdateManyMock,
    refreshCreateMock,
    refreshFindMock,
    userFindByIdMock,
    auditMock,
    settingsMock,
    resolvePermsMock,
} = vi.hoisted(() => ({
    refreshFindOneMock: vi.fn(),
    refreshUpdateOneMock: vi.fn(),
    refreshUpdateManyMock: vi.fn(),
    refreshCreateMock: vi.fn(),
    refreshFindMock: vi.fn(),
    userFindByIdMock: vi.fn(),
    auditMock: vi.fn(),
    settingsMock: vi.fn(),
    resolvePermsMock: vi.fn(),
}));

vi.mock('../models/refresh-token.model.js', () => ({
    RefreshToken: {
        findOne: refreshFindOneMock,
        updateOne: refreshUpdateOneMock,
        updateMany: refreshUpdateManyMock,
        create: refreshCreateMock,
        find: refreshFindMock,
        countDocuments: vi.fn().mockResolvedValue(0),
    },
}));

vi.mock('../models/user.model.js', () => ({
    User: {
        findById: userFindByIdMock,
    },
}));

vi.mock('../services/audit.service.js', () => ({
    recordAudit: auditMock,
    recordSystemAudit: vi.fn(),
}));

vi.mock('../services/settings.service.js', () => ({
    getOrInitSettings: settingsMock,
    resolveLoginLockoutPolicy: vi.fn().mockResolvedValue({
        failed_login_threshold: null,
        lockout_duration_minutes: null,
    }),
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
const tokenRowId = new Types.ObjectId();

/** Issue a real refresh token signed with the test JWT secret so the
 *  service's `verifyRefreshToken` call succeeds. */
const validRefreshToken = (overrides: Record<string, unknown> = {}) =>
    jwt.sign({ user_id: userId.toString(), kind: 'refresh', ...overrides }, JWT_REFRESH_SECRET, { expiresIn: '5d' });

beforeEach(() => {
    vi.clearAllMocks();
    settingsMock.mockResolvedValue({ uploads: { sas_token_ttl_minutes: 15 } });
    resolvePermsMock.mockResolvedValue({ role_keys: ['employee'], permissions: ['user.read'] });
    refreshCreateMock.mockImplementation(async (doc: Record<string, unknown>) => ({
        ...doc,
        _id: new Types.ObjectId(),
    }));
    refreshFindMock.mockReturnValue({
        sort: () => ({ skip: () => ({ limit: () => Promise.resolve([]) }) }),
    });
    refreshUpdateOneMock.mockResolvedValue({ acknowledged: true, modifiedCount: 1 });
    refreshUpdateManyMock.mockResolvedValue({ acknowledged: true });
});

describe('integration: POST /api/v1/auth/refresh', () => {
    const app = buildTestApp();

    // ─── Validation ───────────────────────────────────────────────────

    it('400 VALIDATION_ERROR when refresh_token is missing', async () => {
        const res = await request(app).post('/api/v1/auth/refresh').send({});
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    // ─── Unknown / revoked token ──────────────────────────────────────

    it('401 UNAUTHENTICATED when the token hash is not in the DB', async () => {
        // The token verifies (signature is valid) but the hash isn't
        // in `refresh_tokens`. This happens after a logout-all + the
        // FE retains a stale token in localStorage.
        refreshFindOneMock.mockResolvedValueOnce(null);

        const res = await request(app).post('/api/v1/auth/refresh').send({ refresh_token: validRefreshToken() });

        expect(res.status).toBe(401);
        expect(res.body.error.code).toBe('UNAUTHENTICATED');
    });

    it('401 UNAUTHENTICATED when the token row is revoked (single revoke, no replacement)', async () => {
        // A token revoked via /logout (NOT rotated) — replaced_by_token_id
        // is null. Different from reuse detection which requires both
        // revoked_at AND replaced_by_token_id to be set.
        refreshFindOneMock.mockResolvedValueOnce({
            _id: tokenRowId,
            user_id: userId,
            revoked_at: new Date(Date.now() - 60_000),
            replaced_by_token_id: null,
            expires_at: new Date(Date.now() + 86_400_000),
        });

        const res = await request(app).post('/api/v1/auth/refresh').send({ refresh_token: validRefreshToken() });

        expect(res.status).toBe(401);
        expect(res.body.error.code).toBe('UNAUTHENTICATED');
        // Chain revoke MUST NOT fire on a plain-revoked branch.
        expect(refreshUpdateManyMock).not.toHaveBeenCalled();
    });

    // ─── Reuse detection ──────────────────────────────────────────────

    it('401 TOKEN_REUSE_DETECTED + chain-revoke when an already-rotated token is replayed', async () => {
        // Cardinal security rule: a refresh that's been rotated (both
        // revoked_at AND replaced_by_token_id set) is a theft signal.
        // The whole chain MUST be revoked. Pin it.
        refreshFindOneMock.mockResolvedValueOnce({
            _id: tokenRowId,
            user_id: userId,
            revoked_at: new Date(Date.now() - 60_000),
            replaced_by_token_id: new Types.ObjectId(),
            expires_at: new Date(Date.now() + 86_400_000),
        });

        const res = await request(app).post('/api/v1/auth/refresh').send({ refresh_token: validRefreshToken() });

        expect(res.status).toBe(401);
        expect(res.body.error.code).toBe('TOKEN_REUSE_DETECTED');
        // Chain revoke must have fired with the user_id predicate.
        expect(refreshUpdateManyMock).toHaveBeenCalledWith(
            { user_id: userId, revoked_at: null },
            expect.objectContaining({ $set: expect.objectContaining({ revoked_at: expect.any(Date) }) })
        );
    });

    // ─── Expired branch ───────────────────────────────────────────────

    it("401 TOKEN_EXPIRED when the row's expires_at has passed", async () => {
        // The row exists but its expiry window is over. Distinct code
        // (TOKEN_EXPIRED) so the FE can show "your session expired,
        // please log in again" vs the generic UNAUTHENTICATED.
        refreshFindOneMock.mockResolvedValueOnce({
            _id: tokenRowId,
            user_id: userId,
            revoked_at: null,
            replaced_by_token_id: null,
            expires_at: new Date(Date.now() - 60_000),
        });

        const res = await request(app).post('/api/v1/auth/refresh').send({ refresh_token: validRefreshToken() });

        expect(res.status).toBe(401);
        expect(res.body.error.code).toBe('TOKEN_EXPIRED');
    });

    // ─── Deactivated user ─────────────────────────────────────────────

    it('403 ACCOUNT_DEACTIVATED + chain-revoke when the user is no longer active', async () => {
        // Defence: a user deactivated AFTER a refresh token was issued
        // must not be able to keep refreshing past deactivation. Pin
        // both the 403 AND the chain-revoke side effect.
        refreshFindOneMock.mockResolvedValueOnce({
            _id: tokenRowId,
            user_id: userId,
            revoked_at: null,
            replaced_by_token_id: null,
            expires_at: new Date(Date.now() + 86_400_000),
            device_info: '',
            ip_address: '',
        });
        userFindByIdMock.mockReturnValueOnce({
            select: () => Promise.resolve({ status: 'deactivated', role: 'employee' }),
        });

        const res = await request(app).post('/api/v1/auth/refresh').send({ refresh_token: validRefreshToken() });

        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe('ACCOUNT_DEACTIVATED');
        expect(refreshUpdateManyMock).toHaveBeenCalled();
    });

    // ─── Race between two concurrent refreshes ────────────────────────

    it('401 TOKEN_REUSE_DETECTED when the predicate-guarded revoke loses the race', async () => {
        // Two concurrent refresh calls arrive. Both pass the initial
        // findOne (token still active). The first one's predicate-
        // guarded `updateOne({_id, revoked_at: null}, ...)` modifies
        // the row. The second's identical update finds 0 rows because
        // the predicate no longer matches. The implementation treats
        // modifiedCount=0 as "lost the race == reuse" and revokes the
        // chain. Pin this branch — without it, a race could allow
        // two concurrent rotations to issue tokens.
        refreshFindOneMock.mockResolvedValueOnce({
            _id: tokenRowId,
            user_id: userId,
            revoked_at: null,
            replaced_by_token_id: null,
            expires_at: new Date(Date.now() + 86_400_000),
            device_info: '',
            ip_address: '',
        });
        userFindByIdMock.mockReturnValueOnce({
            select: () => Promise.resolve({ status: 'active', role: 'employee' }),
        });
        // The first updateOne returns modifiedCount=0 — race lost.
        refreshUpdateOneMock.mockResolvedValueOnce({ acknowledged: true, modifiedCount: 0 });

        const res = await request(app).post('/api/v1/auth/refresh').send({ refresh_token: validRefreshToken() });

        expect(res.status).toBe(401);
        expect(res.body.error.code).toBe('TOKEN_REUSE_DETECTED');
    });

    // ─── Happy path ───────────────────────────────────────────────────

    it('200 with a NEW token pair on a successful rotation', async () => {
        refreshFindOneMock.mockResolvedValueOnce({
            _id: tokenRowId,
            user_id: userId,
            revoked_at: null,
            replaced_by_token_id: null,
            expires_at: new Date(Date.now() + 86_400_000),
            device_info: 'iPhone',
            ip_address: '10.0.0.1',
        });
        userFindByIdMock.mockReturnValueOnce({
            select: () => Promise.resolve({ status: 'active', role: 'employee' }),
        });

        const res = await request(app).post('/api/v1/auth/refresh').send({ refresh_token: validRefreshToken() });

        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({
            access_token: expect.any(String),
            refresh_token: expect.any(String),
            access_token_expires_at: expect.any(String),
            refresh_token_expires_at: expect.any(String),
        });
        // The NEW refresh token MUST differ from the one we sent in —
        // a regression that returned the same token would defeat the
        // whole rotation contract.
        expect(res.body.data.refresh_token).not.toBe(validRefreshToken());
    });
});

describe('integration: POST /api/v1/auth/logout', () => {
    const app = buildTestApp();

    it('400 VALIDATION_ERROR when refresh_token is missing', async () => {
        const res = await request(app).post('/api/v1/auth/logout').send({});
        expect(res.status).toBe(400);
    });

    it('204 No Content on a successful logout', async () => {
        // The controller calls `RefreshToken.updateOne` and returns
        // 204 regardless of whether anything was modified. The mock's
        // default response (modifiedCount=1) suffices.
        const res = await request(app).post('/api/v1/auth/logout').send({ refresh_token: validRefreshToken() });

        expect(res.status).toBe(204);
        expect(res.body).toEqual({});
        // Hashes the token + revokes the matching row.
        expect(refreshUpdateOneMock).toHaveBeenCalledWith(
            expect.objectContaining({ token_hash: expect.any(String), revoked_at: null }),
            expect.objectContaining({ $set: expect.objectContaining({ revoked_at: expect.any(Date) }) })
        );
    });

    it('idempotent — 204 even when the token hash is unknown / already revoked', async () => {
        // The FE re-sends a logout if the user double-clicks; `updateOne`
        // matches zero rows but the controller MUST still 204 (no error).
        // A regression that 4xx'd here would surface a confusing failure
        // toast for a no-op action.
        refreshUpdateOneMock.mockResolvedValueOnce({ acknowledged: true, modifiedCount: 0 });

        const res = await request(app).post('/api/v1/auth/logout').send({ refresh_token: validRefreshToken() });

        expect(res.status).toBe(204);
    });
});
