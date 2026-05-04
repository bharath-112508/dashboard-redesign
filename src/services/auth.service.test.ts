import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Types } from 'mongoose';

/**
 * Unit tests for `auth.service` (Step 15.1 gap-fill).
 *
 * Covers the security-critical branches the smokes already exercise as a
 * black box, but at the unit level so a regression here fails fast in CI:
 *
 *  1. Login — generic-credentials response on unknown email + on wrong
 *     password (no enumeration leak).
 *  2. Lockout — 5th wrong password sets `locked_until = now + 15 min` and
 *     resets the attempt counter (per `MAX_LOGIN_ATTEMPTS`).
 *  3. Locked + deactivated branches return the right error codes.
 *  4. MFA-enabled login returns the `mfa_required` shape and does NOT
 *     mint refresh tokens.
 *  5. Refresh — happy path rotates the row + back-links, and
 *     reuse-of-rotated-token revokes the chain (`TOKEN_REUSE_DETECTED`).
 *  6. Change password — verifies old, hashes new, calls logoutAll.
 */

const {
    userFindOneMock,
    userFindByIdMock,
    userUpdateOneMock,
    refreshCreateMock,
    refreshFindOneMock,
    refreshUpdateOneMock,
    refreshUpdateManyMock,
    refreshFindMock,
    refreshCountMock,
    refreshFindOneAndUpdateMock,
    bcryptCompareMock,
    verifyPasswordMock,
    hashPasswordMock,
    createAccessTokenMock,
    createRefreshTokenMock,
    verifyRefreshTokenMock,
    sha256HexMock,
    issueMfaSessionMock,
    recordAuditMock,
} = vi.hoisted(() => ({
    userFindOneMock: vi.fn(),
    userFindByIdMock: vi.fn(),
    userUpdateOneMock: vi.fn(),
    refreshCreateMock: vi.fn(),
    refreshFindOneMock: vi.fn(),
    refreshUpdateOneMock: vi.fn(),
    refreshUpdateManyMock: vi.fn(),
    refreshFindMock: vi.fn(),
    refreshCountMock: vi.fn(),
    refreshFindOneAndUpdateMock: vi.fn(),
    bcryptCompareMock: vi.fn(),
    verifyPasswordMock: vi.fn(),
    hashPasswordMock: vi.fn(),
    createAccessTokenMock: vi.fn(),
    createRefreshTokenMock: vi.fn(),
    verifyRefreshTokenMock: vi.fn(),
    sha256HexMock: vi.fn(),
    issueMfaSessionMock: vi.fn(),
    recordAuditMock: vi.fn(),
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
        findOne: refreshFindOneMock,
        find: refreshFindMock,
        countDocuments: refreshCountMock,
        findOneAndUpdate: refreshFindOneAndUpdateMock,
        updateOne: refreshUpdateOneMock,
        updateMany: refreshUpdateManyMock,
    },
}));

vi.mock('bcrypt', () => ({
    default: { compare: bcryptCompareMock },
}));

vi.mock('../utils/password.js', () => ({
    verifyPassword: verifyPasswordMock,
    hashPassword: hashPasswordMock,
}));

vi.mock('../utils/jwt.js', () => ({
    createAccessToken: createAccessTokenMock,
    createRefreshToken: createRefreshTokenMock,
    verifyRefreshToken: verifyRefreshTokenMock,
}));

vi.mock('../utils/token-hash.js', () => ({
    sha256Hex: sha256HexMock,
}));

vi.mock('../utils/mfa-session.js', () => ({
    issueMfaSession: issueMfaSessionMock,
}));

vi.mock('./audit.service.js', () => ({
    recordAudit: recordAuditMock,
}));

// Step-27 — `getMe` reads settings (for the photo SAS TTL) and signs a
// profile-photo URL. Both mocks return inert values; no test asserts
// the photo path itself, but the dependencies must be present so a
// fresh import doesn't hit the real settings collection.
vi.mock('./settings.service.js', () => ({
    getOrInitSettings: vi.fn(async () => ({ uploads: { sas_token_ttl_minutes: 15 } })),
    // Step-33 lockout-policy resolver — return `null` for both fields so
    // `applyFailedLoginAttempt` falls back to the compile-time defaults
    // (MAX_LOGIN_ATTEMPTS, LOGIN_LOCKOUT_MS) — exactly what the existing
    // assertions expect.
    resolveLoginLockoutPolicy: vi.fn(async () => ({
        failed_login_threshold: null,
        lockout_duration_minutes: null,
    })),
}));

vi.mock('./profile-photo.service.js', () => ({
    resolveProfilePhotoTtlMinutes: vi.fn(() => 15),
    signProfilePhotoUrl: vi.fn(() => null),
}));

const auth = await import('./auth.service.js');
import { ERROR_CODES } from '../constants/error-codes.js';
import { USER_STATUSES } from '../constants/user-statuses.js';
import { MAX_LOGIN_ATTEMPTS, LOGIN_LOCKOUT_MS } from '../constants/auth.js';
import { AppError } from '../utils/app-error.js';

const selectStub = (resolved: unknown) => ({
    select: () => Promise.resolve(resolved),
});

const baseUser = (overrides: Record<string, unknown> = {}) => ({
    _id: new Types.ObjectId(),
    email: 'jane@example.com',
    full_name: 'Jane Doe',
    role: 'employee',
    status: USER_STATUSES.ACTIVE,
    password_hash: 'hashed',
    failed_login_attempts: 0,
    locked_until: null,
    mfa_enabled: false,
    ...overrides,
});

const tokenPair = () => {
    createAccessTokenMock.mockReturnValue({
        token: 'access.jwt',
        expires_at: new Date('2026-01-01T00:00:00Z'),
    });
    createRefreshTokenMock.mockReturnValue({
        token: 'refresh.jwt',
        expires_at: new Date('2026-01-06T00:00:00Z'),
    });
    sha256HexMock.mockReturnValue('hash:refresh');
    refreshCreateMock.mockResolvedValue({ _id: new Types.ObjectId() });
};

beforeEach(() => {
    // resetAllMocks (not just clearAllMocks) so any pending
    // `mockReturnValueOnce` queue from a prior test is fully drained — without
    // it, a mock-once leftover from one describe bleeds into the next test.
    vi.resetAllMocks();
    bcryptCompareMock.mockResolvedValue(false);
    refreshUpdateOneMock.mockResolvedValue({ modifiedCount: 1 });
    refreshUpdateManyMock.mockResolvedValue({ modifiedCount: 0 });
    userUpdateOneMock.mockResolvedValue({});
});

// ─── Login ────────────────────────────────────────────────────────────────

describe('login', () => {
    it('returns INVALID_CREDENTIALS for unknown email and still does a timing-equalising bcrypt compare', async () => {
        userFindOneMock.mockReturnValueOnce(selectStub(null));

        await expect(auth.login({ email: 'nobody@x.com', password: 'whatever' })).rejects.toMatchObject({
            code: ERROR_CODES.INVALID_CREDENTIALS,
        });
        expect(bcryptCompareMock).toHaveBeenCalledOnce();
    });

    it('rejects with ACCOUNT_LOCKED when locked_until is in the future (no password compare attempted)', async () => {
        const u = baseUser({ locked_until: new Date(Date.now() + 60_000) });
        userFindOneMock.mockReturnValueOnce(selectStub(u));

        await expect(auth.login({ email: u.email, password: 'p' })).rejects.toMatchObject({
            code: ERROR_CODES.ACCOUNT_LOCKED,
        });
        expect(verifyPasswordMock).not.toHaveBeenCalled();
    });

    it('rejects with ACCOUNT_DEACTIVATED when status is not active', async () => {
        const u = baseUser({ status: USER_STATUSES.DEACTIVATED });
        userFindOneMock.mockReturnValueOnce(selectStub(u));

        await expect(auth.login({ email: u.email, password: 'p' })).rejects.toMatchObject({
            code: ERROR_CODES.ACCOUNT_DEACTIVATED,
        });
    });

    it('on wrong password: increments failed_login_attempts and throws INVALID_CREDENTIALS', async () => {
        const u = baseUser({ failed_login_attempts: 2 });
        userFindOneMock.mockReturnValueOnce(selectStub(u));
        verifyPasswordMock.mockResolvedValueOnce(false);

        await expect(auth.login({ email: u.email, password: 'wrong' })).rejects.toMatchObject({
            code: ERROR_CODES.INVALID_CREDENTIALS,
        });
        expect(userUpdateOneMock).toHaveBeenCalledWith(
            { _id: u._id },
            expect.objectContaining({
                $set: expect.objectContaining({ failed_login_attempts: 3 }),
            })
        );
    });

    it('locks the account on the MAX_LOGIN_ATTEMPTSth wrong password and resets the counter', async () => {
        const u = baseUser({ failed_login_attempts: MAX_LOGIN_ATTEMPTS - 1 });
        userFindOneMock.mockReturnValueOnce(selectStub(u));
        verifyPasswordMock.mockResolvedValueOnce(false);

        const t0 = Date.now();
        await expect(auth.login({ email: u.email, password: 'wrong' })).rejects.toMatchObject({
            code: ERROR_CODES.INVALID_CREDENTIALS,
        });
        const setArg = userUpdateOneMock.mock.calls[0][1] as { $set: Record<string, unknown> };
        expect(setArg.$set.failed_login_attempts).toBe(0);
        const lockedUntil = setArg.$set.locked_until as Date;
        expect(lockedUntil).toBeInstanceOf(Date);
        // Allow 2 s slop on the clock for slow CI.
        const expected = t0 + LOGIN_LOCKOUT_MS;
        expect(lockedUntil.getTime()).toBeGreaterThanOrEqual(expected - 2_000);
        expect(lockedUntil.getTime()).toBeLessThanOrEqual(expected + 2_000);
    });

    // Step 33 — hot-wired threshold + lockout duration
    it('honours system_settings.security.failed_login_threshold over the compile-time default', async () => {
        // Settings: threshold lowered to 3. With current attempts = 2,
        // the next failure (3rd) should trigger lockout — the compile-
        // time MAX_LOGIN_ATTEMPTS = 5 path would NOT lock yet.
        const settingsModule = await import('./settings.service.js');
        vi.mocked(settingsModule.resolveLoginLockoutPolicy).mockResolvedValueOnce({
            failed_login_threshold: 3,
            lockout_duration_minutes: null,
        });
        const u = baseUser({ failed_login_attempts: 2 });
        userFindOneMock.mockReturnValueOnce(selectStub(u));
        verifyPasswordMock.mockResolvedValueOnce(false);

        await expect(auth.login({ email: u.email, password: 'wrong' })).rejects.toMatchObject({
            code: ERROR_CODES.INVALID_CREDENTIALS,
        });
        const setArg = userUpdateOneMock.mock.calls[0][1] as { $set: Record<string, unknown> };
        // Counter reset to 0 + locked_until set proves the threshold-3
        // path fired (the 5-attempt default would have just incremented
        // the counter to 3 without locking).
        expect(setArg.$set.failed_login_attempts).toBe(0);
        expect(setArg.$set.locked_until).toBeInstanceOf(Date);
    });

    it('honours system_settings.security.lockout_duration_minutes over the 15-min default', async () => {
        // Settings: 30-minute lockout instead of the 15-minute compile-time default.
        const settingsModule = await import('./settings.service.js');
        vi.mocked(settingsModule.resolveLoginLockoutPolicy).mockResolvedValueOnce({
            failed_login_threshold: null, // fall back to MAX_LOGIN_ATTEMPTS
            lockout_duration_minutes: 30,
        });
        const u = baseUser({ failed_login_attempts: MAX_LOGIN_ATTEMPTS - 1 });
        userFindOneMock.mockReturnValueOnce(selectStub(u));
        verifyPasswordMock.mockResolvedValueOnce(false);

        const t0 = Date.now();
        await expect(auth.login({ email: u.email, password: 'wrong' })).rejects.toMatchObject({
            code: ERROR_CODES.INVALID_CREDENTIALS,
        });
        const setArg = userUpdateOneMock.mock.calls[0][1] as { $set: Record<string, unknown> };
        const lockedUntil = setArg.$set.locked_until as Date;
        const expected = t0 + 30 * 60_000;
        expect(lockedUntil.getTime()).toBeGreaterThanOrEqual(expected - 2_000);
        expect(lockedUntil.getTime()).toBeLessThanOrEqual(expected + 2_000);
    });

    it('returns the MFA challenge shape (no tokens, no counter clear) when mfa_enabled', async () => {
        const u = baseUser({ mfa_enabled: true });
        userFindOneMock.mockReturnValueOnce(selectStub(u));
        verifyPasswordMock.mockResolvedValueOnce(true);
        issueMfaSessionMock.mockReturnValueOnce({
            token: 'mfa-session-token',
            expires_at: new Date('2026-01-01T00:05:00Z'),
        });

        const result = await auth.login({ email: u.email, password: 'right' });

        expect(result).toEqual({
            mfa_required: true,
            mfa_session_token: 'mfa-session-token',
            mfa_session_expires_at: '2026-01-01T00:05:00.000Z',
        });
        expect(refreshCreateMock).not.toHaveBeenCalled();
        // counters are not cleared until /auth/mfa/verify succeeds.
        expect(userUpdateOneMock).not.toHaveBeenCalled();
    });

    it('happy path: clears counters, mints a token pair, returns user summary', async () => {
        const u = baseUser();
        userFindOneMock.mockReturnValueOnce(selectStub(u));
        verifyPasswordMock.mockResolvedValueOnce(true);
        tokenPair();

        const result = await auth.login({
            email: u.email,
            password: 'right',
            device_info: 'curl',
            ip_address: '127.0.0.1',
        });

        expect(result).toMatchObject({
            access_token: 'access.jwt',
            refresh_token: 'refresh.jwt',
            user: { id: u._id.toString(), role: 'employee', full_name: 'Jane Doe' },
        });
        expect(refreshCreateMock).toHaveBeenCalledWith(
            expect.objectContaining({
                user_id: u._id,
                token_hash: 'hash:refresh',
                device_info: 'curl',
                ip_address: '127.0.0.1',
            })
        );
        expect(userUpdateOneMock).toHaveBeenCalledWith(
            { _id: u._id },
            expect.objectContaining({
                $set: expect.objectContaining({ failed_login_attempts: 0, locked_until: null }),
            })
        );
    });
});

// ─── Refresh ──────────────────────────────────────────────────────────────

describe('refreshTokens', () => {
    const setupValidRefresh = (
        rowOverrides: Record<string, unknown> = {},
        userOverrides: Record<string, unknown> = {}
    ) => {
        verifyRefreshTokenMock.mockReturnValueOnce({ user_id: 'u1', role: 'employee' });
        sha256HexMock.mockReturnValueOnce('hash:in');
        const row = {
            _id: new Types.ObjectId(),
            user_id: new Types.ObjectId(),
            device_info: 'web',
            ip_address: '10.0.0.1',
            revoked_at: null,
            replaced_by_token_id: null,
            expires_at: new Date(Date.now() + 86_400_000),
            ...rowOverrides,
        };
        refreshFindOneMock.mockResolvedValueOnce(row);
        userFindByIdMock.mockReturnValueOnce(
            selectStub({ status: USER_STATUSES.ACTIVE, role: 'employee', ...userOverrides })
        );
        return row;
    };

    it('rotates the row, back-links the new one, and returns a fresh pair', async () => {
        const row = setupValidRefresh();
        tokenPair();

        const out = await auth.refreshTokens({ refresh_token: 'incoming' });

        expect(out.access_token).toBe('access.jwt');
        // Rotation: old row revoked, new one created with replaces back-link.
        expect(refreshUpdateOneMock).toHaveBeenCalledWith(
            { _id: row._id, revoked_at: null },
            expect.objectContaining({ $set: expect.objectContaining({ revoked_at: expect.any(Date) }) })
        );
        // The second `updateOne` call (back-link) is fired from `issueTokenPair`.
        expect(refreshUpdateOneMock).toHaveBeenCalledTimes(2);
    });

    it('reuse of an already-rotated token revokes the entire chain with TOKEN_REUSE_DETECTED', async () => {
        verifyRefreshTokenMock.mockReturnValueOnce({ user_id: 'u1', role: 'employee' });
        sha256HexMock.mockReturnValueOnce('hash:in');
        refreshFindOneMock.mockResolvedValueOnce({
            _id: new Types.ObjectId(),
            user_id: new Types.ObjectId(),
            device_info: 'web',
            ip_address: '10.0.0.1',
            revoked_at: new Date(Date.now() - 1_000),
            replaced_by_token_id: new Types.ObjectId(),
            expires_at: new Date(Date.now() + 86_400_000),
        });

        await expect(auth.refreshTokens({ refresh_token: 'replayed' })).rejects.toMatchObject({
            code: ERROR_CODES.TOKEN_REUSE_DETECTED,
        });
        expect(refreshUpdateManyMock).toHaveBeenCalledWith(
            expect.objectContaining({ revoked_at: null }),
            expect.objectContaining({ $set: expect.objectContaining({ revoked_at: expect.any(Date) }) })
        );
    });

    it('rejects an expired refresh row with TOKEN_EXPIRED', async () => {
        setupValidRefresh({ expires_at: new Date(Date.now() - 1_000) });

        await expect(auth.refreshTokens({ refresh_token: 'old' })).rejects.toMatchObject({
            code: ERROR_CODES.TOKEN_EXPIRED,
        });
    });

    it('rejects when the underlying user has been deactivated and revokes their chain', async () => {
        setupValidRefresh({}, { status: USER_STATUSES.DEACTIVATED });

        await expect(auth.refreshTokens({ refresh_token: 'x' })).rejects.toMatchObject({
            code: ERROR_CODES.ACCOUNT_DEACTIVATED,
        });
        expect(refreshUpdateManyMock).toHaveBeenCalled();
    });

    it('treats lost-the-revoke-race as reuse (concurrent second refresh)', async () => {
        setupValidRefresh();
        refreshUpdateOneMock.mockResolvedValueOnce({ modifiedCount: 0 });

        await expect(auth.refreshTokens({ refresh_token: 'x' })).rejects.toMatchObject({
            code: ERROR_CODES.TOKEN_REUSE_DETECTED,
        });
    });
});

// ─── Change password / logout ─────────────────────────────────────────────

describe('changePassword', () => {
    it('verifies old password, hashes new, stamps last_password_changed_at, revokes all sessions', async () => {
        const u = baseUser();
        userFindByIdMock.mockReturnValueOnce(selectStub(u));
        verifyPasswordMock.mockResolvedValueOnce(true);
        hashPasswordMock.mockResolvedValueOnce('hashed:new');

        await auth.changePassword({
            user_id: u._id,
            old_password: 'OldPass1!23',
            new_password: 'NewPass1!23',
        });

        expect(userUpdateOneMock).toHaveBeenCalledWith(
            { _id: u._id },
            expect.objectContaining({
                $set: expect.objectContaining({
                    password_hash: 'hashed:new',
                    last_password_changed_at: expect.any(Date),
                }),
            })
        );
        expect(refreshUpdateManyMock).toHaveBeenCalledWith(
            { user_id: u._id, revoked_at: null },
            expect.objectContaining({ $set: expect.objectContaining({ revoked_at: expect.any(Date) }) })
        );
    });

    it('rejects with INVALID_CREDENTIALS when old password is wrong (no DB writes)', async () => {
        const u = baseUser();
        userFindByIdMock.mockReturnValueOnce(selectStub(u));
        verifyPasswordMock.mockResolvedValueOnce(false);

        await expect(
            auth.changePassword({
                user_id: u._id,
                old_password: 'wrong',
                new_password: 'NewPass1!23',
            })
        ).rejects.toBeInstanceOf(AppError);
        expect(hashPasswordMock).not.toHaveBeenCalled();
        expect(userUpdateOneMock).not.toHaveBeenCalled();
    });

    it('rejects with USER_NOT_FOUND when the user no longer exists', async () => {
        userFindByIdMock.mockReturnValueOnce(selectStub(null));

        await expect(
            auth.changePassword({
                user_id: new Types.ObjectId(),
                old_password: 'x',
                new_password: 'NewPass1!23',
            })
        ).rejects.toMatchObject({ code: ERROR_CODES.USER_NOT_FOUND });
    });
});

describe('logout / logoutAll', () => {
    it('logout revokes only the presented token (idempotent)', async () => {
        sha256HexMock.mockReturnValueOnce('hash:t');

        await auth.logout('token');

        expect(refreshUpdateOneMock).toHaveBeenCalledWith(
            { token_hash: 'hash:t', revoked_at: null },
            expect.objectContaining({ $set: expect.objectContaining({ revoked_at: expect.any(Date) }) })
        );
    });

    it('logoutAll revokes every active refresh token for the user', async () => {
        const id = new Types.ObjectId();

        await auth.logoutAll(id);

        expect(refreshUpdateManyMock).toHaveBeenCalledWith(
            { user_id: id, revoked_at: null },
            expect.objectContaining({ $set: expect.objectContaining({ revoked_at: expect.any(Date) }) })
        );
    });
});

// ─── Session management (Step 27) ────────────────────────────────────────

describe('listSessions', () => {
    it('builds the active-only filter and projects to PublicSession shape', async () => {
        const userId = new Types.ObjectId();
        const sessionId = new Types.ObjectId();
        const created = new Date('2026-04-22T10:00:00Z');
        const expires = new Date('2026-04-29T10:00:00Z');

        // Mongoose query chain: find().select().sort().lean()
        refreshFindMock.mockReturnValueOnce({
            select: () => ({
                sort: () => ({
                    lean: () =>
                        Promise.resolve([
                            {
                                _id: sessionId,
                                device_info: 'Chrome on macOS',
                                ip_address: '203.0.113.7',
                                created_at: created,
                                expires_at: expires,
                            },
                        ]),
                }),
            }),
        });

        const sessions = await auth.listSessions(userId);

        expect(sessions).toEqual([
            {
                id: sessionId.toString(),
                device_info: 'Chrome on macOS',
                ip_address: '203.0.113.7',
                last_used_at: created,
                expires_at: expires,
            },
        ]);
        // Filter must include both gates: not revoked AND not expired.
        const filterArg = refreshFindMock.mock.calls[0][0] as Record<string, unknown>;
        expect(filterArg.user_id).toEqual(userId);
        expect(filterArg.revoked_at).toBeNull();
        expect(filterArg.expires_at).toEqual({ $gt: expect.any(Date) });
    });

    it('returns an empty array when the user has no active sessions', async () => {
        refreshFindMock.mockReturnValueOnce({
            select: () => ({ sort: () => ({ lean: () => Promise.resolve([]) }) }),
        });
        const sessions = await auth.listSessions(new Types.ObjectId());
        expect(sessions).toEqual([]);
    });
});

describe('revokeSession', () => {
    // The atomic flow uses `findOneAndUpdate` with a `revoked_at: null`
    // guard. Tests model the three terminal paths:
    //   1. predicate matches → `findOneAndUpdate` returns the updated row
    //      → audit + return ok
    //   2. predicate misses + `findOne` returns a row → already-revoked
    //      idempotent ok (no audit)
    //   3. predicate misses + `findOne` returns null → 404
    //      `SESSION_NOT_FOUND` (covers both unknown-id and cross-user-id)

    const makeUpdatedRow = (overrides: Record<string, unknown> = {}) => ({
        _id: new Types.ObjectId(),
        user_id: new Types.ObjectId(),
        device_info: 'curl/8.0',
        ip_address: '198.51.100.42',
        revoked_at: new Date(),
        ...overrides,
    });

    const selectStubReturning = (resolved: unknown) => ({
        select: () => Promise.resolve(resolved),
    });

    it('returns 404 SESSION_NOT_FOUND when the id does not exist for this user', async () => {
        // findOneAndUpdate misses (no matching row) AND the follow-up
        // findOne returns null too → 404. Asserts the filter shape
        // includes `user_id` so a cross-user id can't leak into the
        // idempotent branch via a future predicate change.
        refreshFindOneAndUpdateMock.mockResolvedValueOnce(null);
        refreshFindOneMock.mockReturnValueOnce(selectStubReturning(null));

        const callerId = new Types.ObjectId();
        const sessionId = new Types.ObjectId();

        await expect(auth.revokeSession({ user_id: callerId, session_id: sessionId })).rejects.toMatchObject({
            code: ERROR_CODES.SESSION_NOT_FOUND,
            statusCode: 404,
        });

        // Filter-shape lock-in (Finding 1a from review): both lookups
        // MUST scope by `user_id` so a cross-user id is indistinguishable
        // from an unknown id at the wire.
        expect(refreshFindOneAndUpdateMock).toHaveBeenCalledWith(
            { _id: sessionId, user_id: callerId, revoked_at: null },
            expect.any(Object),
            expect.any(Object)
        );
        expect(refreshFindOneMock).toHaveBeenCalledWith({ _id: sessionId, user_id: callerId });
    });

    it('returns 404 for a cross-user id (same code as unknown-id, no existence-leak)', async () => {
        // The atomic update with `user_id: callerId` matches nothing
        // (the row's user_id is different); the follow-up findOne also
        // filters by callerId so the row is invisible. Outward error
        // is identical to the unknown-id case above.
        refreshFindOneAndUpdateMock.mockResolvedValueOnce(null);
        refreshFindOneMock.mockReturnValueOnce(selectStubReturning(null));

        await expect(
            auth.revokeSession({
                user_id: new Types.ObjectId(),
                session_id: new Types.ObjectId(),
            })
        ).rejects.toMatchObject({ code: ERROR_CODES.SESSION_NOT_FOUND, statusCode: 404 });
    });

    it('atomically sets revoked_at and audits when caller carries an audit context', async () => {
        const userId = new Types.ObjectId();
        const row = makeUpdatedRow({ user_id: userId });
        refreshFindOneAndUpdateMock.mockResolvedValueOnce(row);
        const audit = {
            actor_id: userId,
            actor_role: 'employee' as const,
            ip: '198.51.100.42',
            user_agent: 'curl/8.0',
        };

        const result = await auth.revokeSession({
            user_id: userId,
            session_id: row._id,
            audit,
        });

        expect(result).toEqual({ revoked: true, id: row._id.toString() });
        // Atomic flow — a single Mongo round-trip flips `revoked_at`.
        expect(refreshFindOneAndUpdateMock).toHaveBeenCalledTimes(1);
        const [filterArg, updateArg, optsArg] = refreshFindOneAndUpdateMock.mock.calls[0];
        expect(filterArg).toEqual({ _id: row._id, user_id: userId, revoked_at: null });
        expect(updateArg).toEqual({ $set: { revoked_at: expect.any(Date) } });
        expect(optsArg).toEqual({ new: true });
        // Follow-up read should NOT fire on the happy path.
        expect(refreshFindOneMock).not.toHaveBeenCalled();

        expect(recordAuditMock).toHaveBeenCalledTimes(1);
        const [auditCtx, payload] = recordAuditMock.mock.calls[0];
        expect(auditCtx).toBe(audit);
        expect(payload).toEqual(
            expect.objectContaining({
                action: 'auth.session_revoke',
                target: { kind: 'session', id: row._id },
                metadata: expect.objectContaining({
                    user_id: userId.toString(),
                    device_info: 'curl/8.0',
                }),
            })
        );
    });

    it('is idempotent on already-revoked rows (no audit, returns success)', async () => {
        // findOneAndUpdate misses because the existing row has
        // `revoked_at != null` — the predicate `revoked_at: null`
        // doesn't match. Follow-up findOne (without that predicate)
        // returns the existing row → idempotent ok.
        const userId = new Types.ObjectId();
        const sessionId = new Types.ObjectId();
        refreshFindOneAndUpdateMock.mockResolvedValueOnce(null);
        refreshFindOneMock.mockReturnValueOnce(selectStubReturning({ _id: sessionId }));

        const result = await auth.revokeSession({ user_id: userId, session_id: sessionId });

        expect(result).toEqual({ revoked: true, id: sessionId.toString() });
        expect(recordAuditMock).not.toHaveBeenCalled();
    });

    it('does not record an audit row when caller has no audit context', async () => {
        const userId = new Types.ObjectId();
        const row = makeUpdatedRow({ user_id: userId });
        refreshFindOneAndUpdateMock.mockResolvedValueOnce(row);

        await auth.revokeSession({ user_id: userId, session_id: row._id });

        expect(refreshFindOneAndUpdateMock).toHaveBeenCalledTimes(1);
        expect(recordAuditMock).not.toHaveBeenCalled();
    });

    it('concurrent double-click only audits once (regression — atomic guard wins one race)', async () => {
        // Two concurrent revoke calls land. The first wins the
        // `findOneAndUpdate` race (returns the row). The second sees
        // null from `findOneAndUpdate` (the predicate `revoked_at: null`
        // no longer matches), then falls through to `findOne` which
        // returns the row, and exits via the idempotent branch. Net
        // effect: ONE audit row, NOT two — the previous read-then-save
        // implementation produced two on this race.
        const userId = new Types.ObjectId();
        const row = makeUpdatedRow({ user_id: userId });
        const sessionId = row._id;
        refreshFindOneAndUpdateMock.mockResolvedValueOnce(row).mockResolvedValueOnce(null);
        refreshFindOneMock.mockReturnValueOnce(selectStubReturning({ _id: sessionId }));
        const audit = {
            actor_id: userId,
            actor_role: 'employee' as const,
            ip: null,
            user_agent: null,
        };

        const [r1, r2] = await Promise.all([
            auth.revokeSession({ user_id: userId, session_id: sessionId, audit }),
            auth.revokeSession({ user_id: userId, session_id: sessionId, audit }),
        ]);

        expect(r1).toEqual({ revoked: true, id: sessionId.toString() });
        expect(r2).toEqual({ revoked: true, id: sessionId.toString() });
        expect(recordAuditMock).toHaveBeenCalledTimes(1);
    });
});

describe('getMe (Step 27 session_count integration)', () => {
    it('includes session_count derived from the same active-session filter as listSessions', async () => {
        const userId = new Types.ObjectId();
        const user = baseUser({ _id: userId });
        userFindByIdMock.mockResolvedValueOnce(user);
        refreshCountMock.mockResolvedValueOnce(3);

        const me = await auth.getMe(userId);

        expect(me.session_count).toBe(3);
        // Filter shape matches listSessions exactly.
        const countArg = refreshCountMock.mock.calls[0][0] as Record<string, unknown>;
        expect(countArg.user_id).toEqual(userId);
        expect(countArg.revoked_at).toBeNull();
        expect(countArg.expires_at).toEqual({ $gt: expect.any(Date) });
    });

    it('reports session_count = 0 when the user has no active sessions', async () => {
        const userId = new Types.ObjectId();
        userFindByIdMock.mockResolvedValueOnce(baseUser({ _id: userId }));
        refreshCountMock.mockResolvedValueOnce(0);

        const me = await auth.getMe(userId);
        expect(me.session_count).toBe(0);
    });

    it('surfaces session_count = null when the count query fails — does NOT 500 the whole /auth/me', async () => {
        // The Step-27 `getMe` widened its dependency surface to include
        // `RefreshToken.countDocuments`. A transient Mongo failure on
        // that query must NOT 500 the entire endpoint — the FE home
        // page would break even when user lookup + photo SAS succeed.
        // Surface `null` (= "unknown") instead of `0` (which would lie
        // about the user's actual session state).
        const userId = new Types.ObjectId();
        userFindByIdMock.mockResolvedValueOnce(baseUser({ _id: userId }));
        refreshCountMock.mockRejectedValueOnce(new Error('mongo timeout'));

        const me = await auth.getMe(userId);
        expect(me.session_count).toBeNull();
        // The rest of the response is intact.
        expect(me.id).toBe(userId.toString());
    });
});
