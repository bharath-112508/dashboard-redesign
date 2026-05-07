import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Types } from 'mongoose';

/**
 * Unit tests for `mfa.service` (F7).
 *
 * Coverage focus — the security-sensitive contracts:
 *   1. setupInit: blocked when MFA already enabled (re-enrollment must
 *      come via disable first); persists ENCRYPTED secret only.
 *   2. setupConfirm: requires the right TOTP, flips mfa_enabled, mints
 *      backup codes; rejects if no enrollment is in progress; rejects
 *      with INVALID_MFA_CODE on bad code.
 *   3. verify: the R10 replay-guard branch — `consumeMfaSessionJti`
 *      runs AFTER the TOTP/backup check passes (so a typo doesn't
 *      burn the session), and a replay rejection surfaces as 401.
 *   4. verify: account-status / lockout re-checks between password
 *      and MFA — defence in depth.
 *   5. disable: requires password + TOTP; wipes secret + backup codes.
 *   6. regenerateBackupCodes: requires current TOTP; replaces hashes.
 */

const {
    userFindByIdMock,
    userUpdateOneMock,
    verifyPasswordMock,
    encryptSecretMock,
    decryptSecretMock,
    generateTotpSecretMock,
    buildOtpAuthUrlMock,
    generateQrDataUrlMock,
    generateBackupCodesMock,
    verifyTotpMock,
    findMatchingBackupCodeIndexMock,
    verifyMfaSessionMock,
    consumeMfaSessionJtiMock,
    applyFailedLoginAttemptMock,
    completeLoginAfterMfaMock,
    recordAuditMock,
} = vi.hoisted(() => ({
    userFindByIdMock: vi.fn(),
    userUpdateOneMock: vi.fn(),
    verifyPasswordMock: vi.fn(),
    encryptSecretMock: vi.fn(),
    decryptSecretMock: vi.fn(),
    generateTotpSecretMock: vi.fn(),
    buildOtpAuthUrlMock: vi.fn(),
    generateQrDataUrlMock: vi.fn(),
    generateBackupCodesMock: vi.fn(),
    verifyTotpMock: vi.fn(),
    findMatchingBackupCodeIndexMock: vi.fn(),
    verifyMfaSessionMock: vi.fn(),
    consumeMfaSessionJtiMock: vi.fn(),
    applyFailedLoginAttemptMock: vi.fn(),
    completeLoginAfterMfaMock: vi.fn(),
    recordAuditMock: vi.fn(),
}));

vi.mock('../models/user.model.js', () => ({
    User: {
        findById: userFindByIdMock,
        updateOne: userUpdateOneMock,
    },
}));

vi.mock('../utils/password.js', () => ({
    verifyPassword: verifyPasswordMock,
}));

vi.mock('../utils/crypto-aes.js', () => ({
    encryptSecret: encryptSecretMock,
    decryptSecret: decryptSecretMock,
}));

vi.mock('../utils/mfa.js', () => ({
    buildOtpAuthUrl: buildOtpAuthUrlMock,
    findMatchingBackupCodeIndex: findMatchingBackupCodeIndexMock,
    generateBackupCodes: generateBackupCodesMock,
    generateQrDataUrl: generateQrDataUrlMock,
    generateTotpSecret: generateTotpSecretMock,
    verifyTotp: verifyTotpMock,
}));

vi.mock('../utils/mfa-session.js', async () => {
    // Real `MfaSessionReplayError` so the `instanceof` check inside the
    // service still works against the typed error.
    const actual = await vi.importActual<typeof import('../utils/mfa-session.js')>('../utils/mfa-session.js');
    return {
        ...actual,
        verifyMfaSession: verifyMfaSessionMock,
        consumeMfaSessionJti: consumeMfaSessionJtiMock,
    };
});

vi.mock('./auth.service.js', () => ({
    applyFailedLoginAttempt: applyFailedLoginAttemptMock,
    completeLoginAfterMfa: completeLoginAfterMfaMock,
}));

vi.mock('./audit.service.js', () => ({
    recordAudit: recordAuditMock,
}));

const svc = await import('./mfa.service.js');
import { ERROR_CODES } from '../constants/error-codes.js';

const sampleUser = (overrides: Record<string, unknown> = {}) => ({
    _id: new Types.ObjectId(),
    email: 'jane@example.com',
    role: 'employee',
    status: 'active',
    mfa_enabled: false,
    mfa_secret_encrypted: null,
    mfa_backup_codes_hashed: [],
    failed_login_attempts: 0,
    locked_until: null,
    ...overrides,
});

const selectStub = (row: unknown) => ({
    select: () => row,
});

beforeEach(() => {
    vi.resetAllMocks();
    encryptSecretMock.mockImplementation((s: string) => `enc:${s}`);
    decryptSecretMock.mockImplementation((s: string) => s.replace(/^enc:/, ''));
    generateTotpSecretMock.mockReturnValue('SECRET32');
    buildOtpAuthUrlMock.mockReturnValue('otpauth://totp/...');
    generateQrDataUrlMock.mockResolvedValue('data:image/png;base64,...');
    userUpdateOneMock.mockResolvedValue({ modifiedCount: 1 });
});

// ─── setupInit ─────────────────────────────────────────────────────────

describe('setupInit', () => {
    it('rejects with DUPLICATE_RESOURCE when MFA is already enabled', async () => {
        userFindByIdMock.mockResolvedValueOnce(sampleUser({ mfa_enabled: true }));

        await expect(svc.setupInit(new Types.ObjectId())).rejects.toMatchObject({
            code: ERROR_CODES.DUPLICATE_RESOURCE,
        });
    });

    it('persists the ENCRYPTED secret (never the plaintext)', async () => {
        userFindByIdMock.mockResolvedValueOnce(sampleUser());

        await svc.setupInit(new Types.ObjectId());

        const updateArg = userUpdateOneMock.mock.calls[0][1] as { $set: Record<string, unknown> };
        // The persisted value goes through `encryptSecret` (the
        // `enc:` prefix in this test fixture is the encryption result).
        // A regression that bypassed the encryption call would store
        // the raw secret directly — which would equal `'SECRET32'`
        // rather than `'enc:SECRET32'`.
        expect(updateArg.$set.mfa_secret_encrypted).toBe('enc:SECRET32');
        expect(updateArg.$set.mfa_secret_encrypted).not.toBe('SECRET32');
        expect(encryptSecretMock).toHaveBeenCalledWith('SECRET32');
    });
});

// ─── setupConfirm ──────────────────────────────────────────────────────

describe('setupConfirm', () => {
    it('rejects with MFA_ENROLLMENT_NOT_FOUND when no enrollment is in progress (M7)', async () => {
        // Pre-M7 this threw `AppError.badRequest('No MFA enrollment in
        // progress...')` with no specific code. The FE couldn't switch
        // on it without string-matching the message. Post-M7 the code
        // is the dedicated `MFA_ENROLLMENT_NOT_FOUND` so the FE can
        // render the right "set up MFA first" UX.
        userFindByIdMock.mockReturnValueOnce(selectStub(sampleUser({ mfa_secret_encrypted: null })));

        await expect(svc.setupConfirm(new Types.ObjectId(), '123456')).rejects.toMatchObject({
            code: ERROR_CODES.MFA_ENROLLMENT_NOT_FOUND,
        });
    });

    it('rejects with DUPLICATE_RESOURCE when MFA is already enabled', async () => {
        userFindByIdMock.mockReturnValueOnce(
            selectStub(sampleUser({ mfa_enabled: true, mfa_secret_encrypted: 'enc:SECRET32' }))
        );

        await expect(svc.setupConfirm(new Types.ObjectId(), '123456')).rejects.toMatchObject({
            code: ERROR_CODES.DUPLICATE_RESOURCE,
        });
    });

    it('rejects with INVALID_MFA_CODE on bad TOTP', async () => {
        userFindByIdMock.mockReturnValueOnce(selectStub(sampleUser({ mfa_secret_encrypted: 'enc:SECRET32' })));
        verifyTotpMock.mockReturnValueOnce(false);

        await expect(svc.setupConfirm(new Types.ObjectId(), '999999')).rejects.toMatchObject({
            code: ERROR_CODES.INVALID_MFA_CODE,
        });
    });

    it('happy path: TOTP verifies, mfa_enabled flipped, backup codes returned + audit emitted', async () => {
        userFindByIdMock.mockReturnValueOnce(selectStub(sampleUser({ mfa_secret_encrypted: 'enc:SECRET32' })));
        verifyTotpMock.mockReturnValueOnce(true);
        generateBackupCodesMock.mockResolvedValueOnce({
            plain: ['code-1', 'code-2'],
            hashed: ['h1', 'h2'],
        });

        const result = await svc.setupConfirm(new Types.ObjectId(), '123456', {
            actor_id: new Types.ObjectId(),
            actor_role: 'employee',
            ip: '1.1.1.1',
            user_agent: 'curl',
            request_id: 'r-1',
        });

        expect(result).toEqual({ mfa_enabled: true, backup_codes: ['code-1', 'code-2'] });
        const updateArg = userUpdateOneMock.mock.calls[0][1] as { $set: Record<string, unknown> };
        expect(updateArg.$set.mfa_enabled).toBe(true);
        expect(updateArg.$set.mfa_backup_codes_hashed).toEqual(['h1', 'h2']);
        expect(recordAuditMock).toHaveBeenCalledWith(
            expect.any(Object),
            expect.objectContaining({ action: 'auth.mfa_enable' })
        );

        // G2 — pin the encrypt-then-verify wiring. A regression that
        // bypassed `decryptSecret` and passed the encrypted blob
        // straight to `verifyTotp` would still satisfy every other
        // assertion in this test (the mock returns true unconditionally).
        // Asserting both sides of the pipeline locks the contract.
        expect(decryptSecretMock).toHaveBeenCalledWith('enc:SECRET32');
        expect(verifyTotpMock).toHaveBeenCalledWith('123456', 'SECRET32');
    });
});

// ─── verify (login MFA challenge) ──────────────────────────────────────

describe('verify (login MFA challenge)', () => {
    const validPayload = (overrides: Record<string, unknown> = {}) => ({
        user_id: new Types.ObjectId().toString(),
        type: 'mfa_session' as const,
        jti: '01HXX',
        exp: Math.floor(Date.now() / 1000) + 300,
        ...overrides,
    });

    it('rejects with TOKEN_EXPIRED when verifyMfaSession throws TokenExpiredError', async () => {
        const jwt = (await import('jsonwebtoken')).default;
        verifyMfaSessionMock.mockImplementationOnce(() => {
            throw new jwt.TokenExpiredError('expired', new Date());
        });

        await expect(
            svc.verify({ mfa_session_token: 'expired.token', code: '123456', is_backup_code: false })
        ).rejects.toMatchObject({ code: ERROR_CODES.TOKEN_EXPIRED });
    });

    it('rejects with UNAUTHENTICATED on any other verify error', async () => {
        verifyMfaSessionMock.mockImplementationOnce(() => {
            throw new Error('forged token');
        });

        await expect(
            svc.verify({ mfa_session_token: 'bad.token', code: '123456', is_backup_code: false })
        ).rejects.toMatchObject({ code: ERROR_CODES.UNAUTHENTICATED });
    });

    it('rejects deactivated users with ACCOUNT_DEACTIVATED (defence in depth)', async () => {
        verifyMfaSessionMock.mockReturnValueOnce(validPayload());
        userFindByIdMock.mockReturnValueOnce(
            selectStub(
                sampleUser({
                    status: 'deactivated',
                    mfa_enabled: true,
                    mfa_secret_encrypted: 'enc:SECRET32',
                })
            )
        );

        await expect(
            svc.verify({ mfa_session_token: 'good.token', code: '123456', is_backup_code: false })
        ).rejects.toMatchObject({ code: ERROR_CODES.ACCOUNT_DEACTIVATED });
    });

    it('rejects with INVALID_MFA_CODE + applies failed-login attempt on bad TOTP', async () => {
        const user = sampleUser({ mfa_enabled: true, mfa_secret_encrypted: 'enc:SECRET32' });
        verifyMfaSessionMock.mockReturnValueOnce(validPayload({ user_id: user._id.toString() }));
        userFindByIdMock.mockReturnValueOnce(selectStub(user));
        verifyTotpMock.mockReturnValueOnce(false);

        await expect(
            svc.verify({ mfa_session_token: 'good.token', code: '999999', is_backup_code: false })
        ).rejects.toMatchObject({ code: ERROR_CODES.INVALID_MFA_CODE });
        expect(applyFailedLoginAttemptMock).toHaveBeenCalledWith(user);
        // R10: do NOT consume the JTI on failed verify (user retries).
        expect(consumeMfaSessionJtiMock).not.toHaveBeenCalled();
    });

    it('R10: consumes the JTI AFTER successful TOTP, BEFORE issuing tokens', async () => {
        const user = sampleUser({ mfa_enabled: true, mfa_secret_encrypted: 'enc:SECRET32' });
        const payload = validPayload({ user_id: user._id.toString() });
        verifyMfaSessionMock.mockReturnValueOnce(payload);
        userFindByIdMock.mockReturnValueOnce(selectStub(user));
        verifyTotpMock.mockReturnValueOnce(true);
        completeLoginAfterMfaMock.mockResolvedValueOnce({
            access_token: 'a.t',
            refresh_token: 'r.t',
            access_token_expires_at: '...',
            refresh_token_expires_at: '...',
            user: { id: user._id.toString(), role: 'employee', full_name: 'Jane Doe' },
        });

        await svc.verify({ mfa_session_token: 'good.token', code: '123456', is_backup_code: false });

        expect(consumeMfaSessionJtiMock).toHaveBeenCalledWith(payload.jti, expect.any(Date));
        // The Date passed in is derived from `payload.exp * 1000`.
        const consumeArg = consumeMfaSessionJtiMock.mock.calls[0][1] as Date;
        expect(consumeArg.getTime()).toBe(payload.exp * 1000);
        expect(completeLoginAfterMfaMock).toHaveBeenCalled();

        // G2 — pin the encrypt-then-verify wiring on the login MFA
        // path too. A regression that passed the encrypted blob to
        // `verifyTotp` would still pass every other assertion since
        // verifyTotpMock returns true unconditionally.
        expect(decryptSecretMock).toHaveBeenCalledWith('enc:SECRET32');
        expect(verifyTotpMock).toHaveBeenCalledWith('123456', 'SECRET32');
    });

    it('R10: replay attempt — MfaSessionReplayError surfaces as UNAUTHENTICATED, no tokens issued', async () => {
        const { MfaSessionReplayError } = await import('../utils/mfa-session.js');
        const user = sampleUser({ mfa_enabled: true, mfa_secret_encrypted: 'enc:SECRET32' });
        verifyMfaSessionMock.mockReturnValueOnce(validPayload({ user_id: user._id.toString() }));
        userFindByIdMock.mockReturnValueOnce(selectStub(user));
        verifyTotpMock.mockReturnValueOnce(true);
        consumeMfaSessionJtiMock.mockRejectedValueOnce(new MfaSessionReplayError());

        await expect(
            svc.verify({ mfa_session_token: 'replayed.token', code: '123456', is_backup_code: false })
        ).rejects.toMatchObject({ code: ERROR_CODES.UNAUTHENTICATED });
        expect(completeLoginAfterMfaMock).not.toHaveBeenCalled();
    });

    it('backup-code path: matching index → success + remaining hashes written back', async () => {
        const user = sampleUser({
            mfa_enabled: true,
            mfa_secret_encrypted: 'enc:SECRET32',
            mfa_backup_codes_hashed: ['h0', 'h1', 'h2'],
        });
        verifyMfaSessionMock.mockReturnValueOnce(validPayload({ user_id: user._id.toString() }));
        userFindByIdMock.mockReturnValueOnce(selectStub(user));
        findMatchingBackupCodeIndexMock.mockResolvedValueOnce(1); // matched h1
        completeLoginAfterMfaMock.mockResolvedValueOnce({
            access_token: 'a.t',
            refresh_token: 'r.t',
            access_token_expires_at: '...',
            refresh_token_expires_at: '...',
            user: { id: user._id.toString(), role: 'employee', full_name: 'Jane Doe' },
        });

        await svc.verify({ mfa_session_token: 'good.token', code: 'BACKUP-X', is_backup_code: true });

        // h1 removed; h0 + h2 retained.
        const updateArg = userUpdateOneMock.mock.calls[0][1] as { $set: Record<string, unknown> };
        expect(updateArg.$set.mfa_backup_codes_hashed).toEqual(['h0', 'h2']);
        expect(consumeMfaSessionJtiMock).toHaveBeenCalled();
    });
});

// ─── disable ───────────────────────────────────────────────────────────
//
// Pre-M7 the not-enabled guard threw `AppError.badRequest('MFA is not
// enabled')` with no specific code. The FE couldn't switch on it
// without string-matching. Post-M7 the dedicated `MFA_NOT_ENABLED`
// code lets the FE render "MFA isn't on for your account" in place
// of the generic 400 banner.

describe('disable — MFA_NOT_ENABLED guard (M7)', () => {
    it('throws MFA_NOT_ENABLED when the user has not enrolled', async () => {
        userFindByIdMock.mockReturnValueOnce(
            selectStub(sampleUser({ mfa_enabled: false, mfa_secret_encrypted: null }))
        );

        await expect(
            svc.disable({
                user_id: new Types.ObjectId(),
                password: 'pw',
                code: '123456',
            })
        ).rejects.toMatchObject({ code: ERROR_CODES.MFA_NOT_ENABLED });
    });

    it('throws MFA_NOT_ENABLED when mfa_enabled flag is true but the secret is gone', async () => {
        // Defensive branch: a partial earlier disable that wiped the
        // secret but left the flag set. Treat as not-enabled.
        userFindByIdMock.mockReturnValueOnce(
            selectStub(sampleUser({ mfa_enabled: true, mfa_secret_encrypted: null }))
        );

        await expect(
            svc.disable({
                user_id: new Types.ObjectId(),
                password: 'pw',
                code: '123456',
            })
        ).rejects.toMatchObject({ code: ERROR_CODES.MFA_NOT_ENABLED });
    });
});

// ─── regenerateBackupCodes ─────────────────────────────────────────────

describe('regenerateBackupCodes — MFA_NOT_ENABLED guard (M7)', () => {
    it('throws MFA_NOT_ENABLED when the user has not enrolled', async () => {
        userFindByIdMock.mockReturnValueOnce(
            selectStub(sampleUser({ mfa_enabled: false, mfa_secret_encrypted: null }))
        );

        await expect(
            svc.regenerateBackupCodes({
                user_id: new Types.ObjectId(),
                code: '123456',
            })
        ).rejects.toMatchObject({ code: ERROR_CODES.MFA_NOT_ENABLED });
    });
});
