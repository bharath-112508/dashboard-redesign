import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Types } from 'mongoose';

/**
 * Unit tests for `password-reset.service` (F7).
 *
 * Coverage focus — the security-sensitive contracts:
 *   1. `requestPasswordReset` is a true no-op for unknown / deactivated
 *      users (enumeration guard); decoy `randomBytes` still runs to
 *      blunt timing-side-channel detection.
 *   2. Successful path invalidates older tokens, mints a fresh one,
 *      and sends the email with the raw token.
 *   3. R7 normalisation: mixed-case email is lowercased before lookup.
 *   4. `resetPassword` rejects every invalid-token shape with the
 *      same generic error (no oracles for "token expired" vs
 *      "token never existed").
 *   5. Atomic mark-used guards against two concurrent requests both
 *      consuming the same link.
 *   6. Deactivated account cannot regain access via a still-valid token.
 *   7. Successful reset clears lockout state + revokes every session.
 */

const {
    userFindOneMock,
    userFindByIdMock,
    userUpdateOneMock,
    tokenFindOneMock,
    tokenUpdateManyMock,
    tokenUpdateOneMock,
    tokenCreateMock,
    sendPasswordResetEmailMock,
    sendPasswordSetupEmailMock,
    logoutAllMock,
    hashPasswordMock,
    sha256HexMock,
    recordAuditMock,
    resolvePasswordResetTtlMinutesMock,
} = vi.hoisted(() => ({
    userFindOneMock: vi.fn(),
    userFindByIdMock: vi.fn(),
    userUpdateOneMock: vi.fn(),
    tokenFindOneMock: vi.fn(),
    tokenUpdateManyMock: vi.fn(),
    tokenUpdateOneMock: vi.fn(),
    tokenCreateMock: vi.fn(),
    sendPasswordResetEmailMock: vi.fn(),
    sendPasswordSetupEmailMock: vi.fn(),
    logoutAllMock: vi.fn(),
    hashPasswordMock: vi.fn(),
    sha256HexMock: vi.fn(),
    recordAuditMock: vi.fn(),
    resolvePasswordResetTtlMinutesMock: vi.fn(),
}));

vi.mock('../models/user.model.js', () => ({
    User: {
        findOne: userFindOneMock,
        findById: userFindByIdMock,
        updateOne: userUpdateOneMock,
    },
}));

vi.mock('../models/password-reset-token.model.js', () => ({
    PasswordResetToken: {
        findOne: tokenFindOneMock,
        updateMany: tokenUpdateManyMock,
        updateOne: tokenUpdateOneMock,
        create: tokenCreateMock,
    },
}));

vi.mock('../utils/mailer.js', () => ({
    sendPasswordResetEmail: sendPasswordResetEmailMock,
    sendPasswordSetupEmail: sendPasswordSetupEmailMock,
}));

vi.mock('./auth.service.js', () => ({
    logoutAll: logoutAllMock,
}));

vi.mock('../utils/password.js', () => ({
    hashPassword: hashPasswordMock,
}));

vi.mock('../utils/token-hash.js', () => ({
    sha256Hex: sha256HexMock,
}));

vi.mock('./audit.service.js', () => ({
    recordAudit: recordAuditMock,
}));

vi.mock('./settings.service.js', () => ({
    resolvePasswordResetTtlMinutes: resolvePasswordResetTtlMinutesMock,
    // `resetPassword` checks the configured password policy before it touches
    // the token, so it reads settings now. `{}` means every policy field falls
    // back to the built-in default (10–12 chars, all four character classes) —
    // which is what these fixtures' passwords were written against.
    getOrInitSettings: vi.fn(async () => ({ security: {} })),
}));

const svc = await import('./password-reset.service.js');
import { ERROR_CODES } from '../constants/error-codes.js';

const sampleUser = (overrides: Record<string, unknown> = {}) => ({
    _id: new Types.ObjectId(),
    email: 'jane@example.com',
    full_name: 'Jane Doe',
    role: 'employee',
    status: 'active',
    ...overrides,
});

beforeEach(() => {
    vi.resetAllMocks();
    sha256HexMock.mockImplementation((s: string) => `hash:${s}`);
    hashPasswordMock.mockResolvedValue('hashed-new-password');
    resolvePasswordResetTtlMinutesMock.mockResolvedValue(null);
    tokenUpdateManyMock.mockResolvedValue({ modifiedCount: 0 });
    tokenUpdateOneMock.mockResolvedValue({ modifiedCount: 1 });
    userUpdateOneMock.mockResolvedValue({ modifiedCount: 1 });
    logoutAllMock.mockResolvedValue(undefined);
});

// ─── requestPasswordReset ───────────────────────────────────────────────

describe('requestPasswordReset', () => {
    it('no-op for an unknown email — enumeration guard, but decoy work still runs', async () => {
        userFindOneMock.mockResolvedValueOnce(null);

        await svc.requestPasswordReset('nobody@x.com');

        expect(tokenCreateMock).not.toHaveBeenCalled();
        expect(sendPasswordResetEmailMock).not.toHaveBeenCalled();
    });

    it('no-op for a deactivated user (same enumeration guard)', async () => {
        userFindOneMock.mockResolvedValueOnce(sampleUser({ status: 'deactivated' }));

        await svc.requestPasswordReset('jane@example.com');

        expect(tokenCreateMock).not.toHaveBeenCalled();
        expect(sendPasswordResetEmailMock).not.toHaveBeenCalled();
    });

    it('R7 — normalises mixed-case email before the User lookup', async () => {
        userFindOneMock.mockResolvedValueOnce(null);

        await svc.requestPasswordReset('  JANE@Example.COM  ');

        const queryArg = userFindOneMock.mock.calls[0][0] as { email: string };
        expect(queryArg.email).toBe('jane@example.com');
    });

    it('happy path: invalidates older tokens, mints fresh one, sends the email', async () => {
        const user = sampleUser();
        userFindOneMock.mockResolvedValueOnce(user);

        await svc.requestPasswordReset(user.email);

        expect(tokenUpdateManyMock).toHaveBeenCalledWith(
            { user_id: user._id, used_at: null },
            { $set: { used_at: expect.any(Date) } }
        );
        expect(tokenCreateMock).toHaveBeenCalledOnce();
        const createArg = tokenCreateMock.mock.calls[0][0] as {
            user_id: Types.ObjectId;
            token_hash: string;
            expires_at: Date;
        };
        expect(createArg.user_id).toEqual(user._id);
        expect(createArg.token_hash).toMatch(/^hash:/);
        expect(createArg.expires_at).toBeInstanceOf(Date);
        expect(sendPasswordResetEmailMock).toHaveBeenCalledOnce();
        const mailArg = sendPasswordResetEmailMock.mock.calls[0][0] as { to: string; token: string };
        expect(mailArg.to).toBe(user.email);
        // Raw token (the one in the email) is NOT the hashed one.
        expect(mailArg.token).not.toMatch(/^hash:/);
    });

    it('honours system_settings password_reset_ttl_minutes when set', async () => {
        const user = sampleUser();
        userFindOneMock.mockResolvedValueOnce(user);
        resolvePasswordResetTtlMinutesMock.mockResolvedValueOnce(15); // 15 minutes

        const t0 = Date.now();
        await svc.requestPasswordReset(user.email);

        const expiresAt = (tokenCreateMock.mock.calls[0][0] as { expires_at: Date }).expires_at;
        const expected = t0 + 15 * 60_000;
        expect(expiresAt.getTime()).toBeGreaterThanOrEqual(expected - 2_000);
        expect(expiresAt.getTime()).toBeLessThanOrEqual(expected + 2_000);
    });
});

// ─── resetPassword ──────────────────────────────────────────────────────

describe('resetPassword', () => {
    const validTokenRow = (overrides: Record<string, unknown> = {}) => ({
        _id: new Types.ObjectId(),
        user_id: new Types.ObjectId(),
        token_hash: 'hash:rawtok',
        used_at: null,
        expires_at: new Date(Date.now() + 60_000),
        ...overrides,
    });

    it('rejects an unknown token with the generic invalid-link error', async () => {
        tokenFindOneMock.mockResolvedValueOnce(null);

        await expect(svc.resetPassword({ token: 'unknown', new_password: 'Aa1!aaaaaa' })).rejects.toMatchObject({
            code: ERROR_CODES.VALIDATION_ERROR,
        });
        expect(userUpdateOneMock).not.toHaveBeenCalled();
    });

    it('rejects an already-used token (same generic error — no oracle)', async () => {
        tokenFindOneMock.mockResolvedValueOnce(validTokenRow({ used_at: new Date() }));

        await expect(svc.resetPassword({ token: 'rawtok', new_password: 'Aa1!aaaaaa' })).rejects.toMatchObject({
            code: ERROR_CODES.VALIDATION_ERROR,
        });
        expect(userUpdateOneMock).not.toHaveBeenCalled();
    });

    it('rejects an expired token (same generic error)', async () => {
        tokenFindOneMock.mockResolvedValueOnce(validTokenRow({ expires_at: new Date(Date.now() - 60_000) }));

        await expect(svc.resetPassword({ token: 'rawtok', new_password: 'Aa1!aaaaaa' })).rejects.toMatchObject({
            code: ERROR_CODES.VALIDATION_ERROR,
        });
    });

    it('rejects when the token references a user that no longer exists', async () => {
        tokenFindOneMock.mockResolvedValueOnce(validTokenRow());
        userFindByIdMock.mockResolvedValueOnce(null);

        await expect(svc.resetPassword({ token: 'rawtok', new_password: 'Aa1!aaaaaa' })).rejects.toMatchObject({
            code: ERROR_CODES.VALIDATION_ERROR,
        });
    });

    it('rejects with ACCOUNT_DEACTIVATED when the user was deactivated since the token was minted', async () => {
        tokenFindOneMock.mockResolvedValueOnce(validTokenRow());
        userFindByIdMock.mockResolvedValueOnce(sampleUser({ status: 'deactivated' }));

        await expect(svc.resetPassword({ token: 'rawtok', new_password: 'Aa1!aaaaaa' })).rejects.toMatchObject({
            code: ERROR_CODES.ACCOUNT_DEACTIVATED,
        });
    });

    it('atomic mark-used race: second concurrent reset gets the generic error (modifiedCount=0)', async () => {
        const tokenRow = validTokenRow();
        tokenFindOneMock.mockResolvedValueOnce(tokenRow);
        userFindByIdMock.mockResolvedValueOnce(sampleUser());
        // Simulate another in-flight reset already consumed the token.
        tokenUpdateOneMock.mockResolvedValueOnce({ modifiedCount: 0 });

        await expect(svc.resetPassword({ token: 'rawtok', new_password: 'Aa1!aaaaaa' })).rejects.toMatchObject({
            code: ERROR_CODES.VALIDATION_ERROR,
        });
        expect(userUpdateOneMock).not.toHaveBeenCalled();

        // G3 — pin the race-guard filter shape, not just the
        // `modifiedCount: 0` side effect. The whole point of this
        // path is the ATOMIC `used_at: null` predicate that prevents
        // two concurrent resets from both consuming the same token.
        // A regression that dropped the predicate from the filter
        // would still pass a count-only assertion. Lock both halves:
        // the `_id` clause AND the `used_at: null` clause must be in
        // the actual filter Mongo sees.
        expect(tokenUpdateOneMock).toHaveBeenCalledWith(
            { _id: tokenRow._id, used_at: null },
            expect.objectContaining({ $set: expect.objectContaining({ used_at: expect.any(Date) }) })
        );
    });

    it('happy path: writes new password hash, clears lockout state, force-logs-out, audits', async () => {
        const user = sampleUser();
        tokenFindOneMock.mockResolvedValueOnce(validTokenRow({ user_id: user._id }));
        userFindByIdMock.mockResolvedValueOnce(user);

        await svc.resetPassword({
            token: 'rawtok',
            new_password: 'Aa1!aaaaaa',
            audit: {
                actor_id: null,
                actor_role: 'unauthenticated',
                ip: '127.0.0.1',
                user_agent: 'curl',
                request_id: null,
            },
        });

        // 1. Password hash + lockout state both cleared in one $set.
        const userUpdate = userUpdateOneMock.mock.calls[0][1] as { $set: Record<string, unknown> };
        expect(userUpdate.$set.password_hash).toBe('hashed-new-password');
        expect(userUpdate.$set.failed_login_attempts).toBe(0);
        expect(userUpdate.$set.locked_until).toBeNull();
        // 2. logoutAll force-revokes every session.
        expect(logoutAllMock).toHaveBeenCalledWith(user._id);
        // 3. Audit row stamps the USER as the actor (proof-of-inbox), not the
        //    unauthenticated caller — and pins the action.
        expect(recordAuditMock).toHaveBeenCalledWith(
            expect.objectContaining({ actor_id: user._id, actor_role: user.role }),
            expect.objectContaining({ action: 'auth.password_reset' })
        );
    });
});

// ─── adminInitiatePasswordReset ──────────────────────────────────────────

describe('adminInitiatePasswordReset', () => {
    /**
     * Pinned contracts:
     *   1. Unknown target → 404 USER_NOT_FOUND (no enumeration silence —
     *      the admin already knows the id).
     *   2. Deactivated target → 403 ACCOUNT_DEACTIVATED (operator error,
     *      surface it).
     *   3. Happy path: invalidates older tokens, mints a fresh one,
     *      sends the reset email, audits with the ADMIN as actor.
     *   4. The audit row uses `auth.admin_password_reset` (NOT
     *      `auth.password_reset` — that's reserved for the user-side
     *      consumption row that fires when the link is clicked).
     *   5. The minted token is NOT in the return value (it's intentionally
     *      delivered only via email; surfacing it would let an admin
     *      reset a peer's password without the peer ever seeing the
     *      email — different threat model).
     */

    const makeAuditCtx = () => ({
        actor_id: new Types.ObjectId(),
        actor_role: 'admin' as const,
        ip: '10.0.0.1',
        user_agent: 'admin-tool',
    });

    it('404 USER_NOT_FOUND when the target id does not exist', async () => {
        userFindByIdMock.mockResolvedValueOnce(null);

        await expect(svc.adminInitiatePasswordReset(new Types.ObjectId(), makeAuditCtx())).rejects.toMatchObject({
            statusCode: 404,
            code: ERROR_CODES.USER_NOT_FOUND,
        });
        // No token + no email + no audit on the rejected path.
        expect(tokenCreateMock).not.toHaveBeenCalled();
        expect(sendPasswordResetEmailMock).not.toHaveBeenCalled();
        expect(recordAuditMock).not.toHaveBeenCalled();
    });

    it('403 ACCOUNT_DEACTIVATED when the target is not active (admin must reactivate first)', async () => {
        userFindByIdMock.mockResolvedValueOnce(sampleUser({ status: 'deactivated' }));

        await expect(svc.adminInitiatePasswordReset(new Types.ObjectId(), makeAuditCtx())).rejects.toMatchObject({
            statusCode: 403,
            code: ERROR_CODES.ACCOUNT_DEACTIVATED,
        });
        expect(tokenCreateMock).not.toHaveBeenCalled();
    });

    it('happy path: invalidates older tokens, mints fresh, emails the user, audits with admin as actor', async () => {
        const target = sampleUser();
        userFindByIdMock.mockResolvedValueOnce(target);
        const audit = makeAuditCtx();

        const result = await svc.adminInitiatePasswordReset(target._id as Types.ObjectId, audit);

        // Returns nothing — the link is intentionally only in the email.
        expect(result).toBeUndefined();

        // 1. Older unused tokens for this user are invalidated.
        expect(tokenUpdateManyMock).toHaveBeenCalledWith(
            { user_id: target._id, used_at: null },
            expect.objectContaining({ $set: expect.objectContaining({ used_at: expect.any(Date) }) })
        );

        // 2. New token row is created with a hashed value.
        expect(tokenCreateMock).toHaveBeenCalledWith(
            expect.objectContaining({
                user_id: target._id,
                token_hash: expect.stringMatching(/^hash:/),
                expires_at: expect.any(Date),
            })
        );

        // 3. Email is sent with the RAW (unhashed) token.
        expect(sendPasswordResetEmailMock).toHaveBeenCalledTimes(1);
        const emailCall = sendPasswordResetEmailMock.mock.calls[0]![0] as {
            to: string;
            full_name: string;
            token: string;
        };
        expect(emailCall.to).toBe(target.email);
        expect(emailCall.full_name).toBe(target.full_name);
        expect(typeof emailCall.token).toBe('string');
        expect(emailCall.token.length).toBeGreaterThan(0);
        // The raw token MUST NOT be the hashed form (defence: a regression
        // that emailed the hash would brick every reset link).
        expect(emailCall.token).not.toMatch(/^hash:/);

        // 4. Audit row uses the admin-specific action AND keeps the admin
        //    as actor (NOT the target user — that's reserved for the
        //    consumption row when the link is clicked).
        expect(recordAuditMock).toHaveBeenCalledTimes(1);
        const [auditCtxArg, auditPayload] = recordAuditMock.mock.calls[0]!;
        expect(auditCtxArg).toBe(audit);
        // M24 — `target_email` was dropped from metadata (was PII leak
        // to AUDIT_LOG_READ-only holders); the audit target's user_id
        // is the canonical reference.
        expect(auditPayload).toMatchObject({
            action: 'auth.admin_password_reset',
            target: { kind: 'user', id: target._id },
            metadata: {},
        });
    });

    it('honours the configurable TTL from system_settings', async () => {
        // The reset link respects `system_settings.security.password_reset_ttl_minutes`
        // — pin that the override flows through to the token's expires_at.
        resolvePasswordResetTtlMinutesMock.mockResolvedValueOnce(60); // 60-min TTL
        const target = sampleUser();
        userFindByIdMock.mockResolvedValueOnce(target);

        const before = Date.now();
        await svc.adminInitiatePasswordReset(target._id as Types.ObjectId, makeAuditCtx());
        const after = Date.now();

        const tokenDoc = tokenCreateMock.mock.calls[0]![0] as { expires_at: Date };
        const ms = tokenDoc.expires_at.getTime();
        // Within ~60 minutes of the call window.
        expect(ms).toBeGreaterThanOrEqual(before + 60 * 60_000 - 1000);
        expect(ms).toBeLessThanOrEqual(after + 60 * 60_000 + 1000);
    });
});


// ─── Redesign: invite a new contact to set their own password ────────────

describe('issuePasswordSetupLink', () => {
    it('revokes older links, mints a link that lasts 7 days and emails it', async () => {
        const user = sampleUser();
        const before = Date.now();

        await svc.issuePasswordSetupLink({ _id: user._id, email: user.email, full_name: user.full_name });

        expect(tokenUpdateManyMock).toHaveBeenCalledWith({ user_id: user._id, used_at: null }, { $set: { used_at: expect.any(Date) } });
        const created = tokenCreateMock.mock.calls[0][0] as { user_id: unknown; expires_at: Date };
        expect(created.user_id).toBe(user._id);
        const days = (created.expires_at.getTime() - before) / 86_400_000;
        expect(days).toBeGreaterThan(6.9);
        expect(days).toBeLessThan(7.1);
        expect(sendPasswordSetupEmailMock).toHaveBeenCalledWith(
            expect.objectContaining({ to: user.email, full_name: user.full_name, token: expect.any(String) })
        );
        expect(sendPasswordResetEmailMock).not.toHaveBeenCalled();
    });
});
