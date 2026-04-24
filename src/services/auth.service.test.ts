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
