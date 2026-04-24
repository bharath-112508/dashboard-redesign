import { Types } from 'mongoose';
import jwt from 'jsonwebtoken';

import { User } from '../models/user.model.js';
import { AppError } from '../utils/app-error.js';
import { verifyPassword } from '../utils/password.js';
import { encryptSecret, decryptSecret } from '../utils/crypto-aes.js';
import {
    buildOtpAuthUrl,
    findMatchingBackupCodeIndex,
    generateBackupCodes,
    generateQrDataUrl,
    generateTotpSecret,
    verifyTotp,
} from '../utils/mfa.js';
import { verifyMfaSession } from '../utils/mfa-session.js';
import { applyFailedLoginAttempt, completeLoginAfterMfa, type LoginTokenResult } from './auth.service.js';
import { ERROR_CODES } from '../constants/error-codes.js';
import { USER_STATUSES } from '../constants/user-statuses.js';

/**
 * MFA lifecycle (API_Contract §2.7 / §2.8 / §2.3).
 *
 * Setup:
 *   init    → generate secret, store ENCRYPTED on the user, return otpauth + QR.
 *             mfa_enabled stays false until confirm succeeds.
 *   confirm → verify the first TOTP, flip mfa_enabled=true, issue backup codes.
 *
 * Runtime:
 *   verify     → called during login after password succeeds and MFA is on.
 *                TOTP OR backup code. On success: clear counters, issue tokens.
 *                On failure: share the password lockout counter.
 *   disable    → requires password + current TOTP. Wipes secret + codes.
 *   regenerate → requires current TOTP. Replaces all backup-code hashes.
 */

// ─── Setup ─────────────────────────────────────────────────────────────────

interface SetupInitResult {
    otpauth_url: string;
    secret_base32: string;
    qr_data_url: string;
}

export const setupInit = async (user_id: Types.ObjectId): Promise<SetupInitResult> => {
    const user = await User.findById(user_id);
    if (!user) {
        throw AppError.notFound('User not found', ERROR_CODES.USER_NOT_FOUND);
    }
    if (user.mfa_enabled) {
        throw AppError.conflict(
            'MFA is already enabled. Disable it first to re-enroll.',
            ERROR_CODES.DUPLICATE_RESOURCE
        );
    }

    const secret = generateTotpSecret();
    const otpauth = buildOtpAuthUrl(user.email, secret);
    const qr = await generateQrDataUrl(otpauth);

    // Persist the (unconfirmed) encrypted secret so /confirm can verify against
    // it. An abandoned enrollment is safe: mfa_enabled stays false, so the
    // stored secret is never consulted until the user rebooks /init.
    await User.updateOne({ _id: user._id }, { $set: { mfa_secret_encrypted: encryptSecret(secret) } });

    return { otpauth_url: otpauth, secret_base32: secret, qr_data_url: qr };
};

interface SetupConfirmResult {
    mfa_enabled: true;
    backup_codes: string[];
}

export const setupConfirm = async (user_id: Types.ObjectId, code: string): Promise<SetupConfirmResult> => {
    const user = await User.findById(user_id).select('+mfa_secret_encrypted +mfa_backup_codes_hashed');
    if (!user) {
        throw AppError.notFound('User not found', ERROR_CODES.USER_NOT_FOUND);
    }
    if (user.mfa_enabled) {
        throw AppError.conflict('MFA is already enabled', ERROR_CODES.DUPLICATE_RESOURCE);
    }
    if (!user.mfa_secret_encrypted) {
        throw AppError.badRequest('No MFA enrollment in progress. Call /auth/mfa/setup/init first.');
    }

    const secret = decryptSecret(user.mfa_secret_encrypted);
    if (!verifyTotp(code, secret)) {
        throw AppError.badRequest('Invalid MFA code', ERROR_CODES.INVALID_MFA_CODE);
    }

    const { plain, hashed } = await generateBackupCodes();

    await User.updateOne(
        { _id: user._id },
        {
            $set: {
                mfa_enabled: true,
                mfa_backup_codes_hashed: hashed,
            },
        }
    );

    return { mfa_enabled: true, backup_codes: plain };
};

// ─── Login MFA challenge ───────────────────────────────────────────────────

interface VerifyInput {
    mfa_session_token: string;
    code: string;
    is_backup_code: boolean;
    device_info?: string;
    ip_address?: string;
}

export const verify = async (input: VerifyInput): Promise<LoginTokenResult> => {
    let payload;
    try {
        payload = verifyMfaSession(input.mfa_session_token);
    } catch (err) {
        // Signature / expiry failures should read as a generic MFA session
        // error from the client's perspective. TOKEN_EXPIRED for expiry
        // (matches refresh semantics); UNAUTHENTICATED for anything else.
        if (err instanceof jwt.TokenExpiredError) {
            throw AppError.tokenExpired('MFA session expired, please login again');
        }
        throw AppError.unauthenticated('Invalid MFA session');
    }

    const user = await User.findById(payload.user_id).select(
        '+password_hash +mfa_secret_encrypted +mfa_backup_codes_hashed +failed_login_attempts +locked_until'
    );
    if (!user) {
        throw AppError.unauthenticated('Invalid MFA session');
    }

    // Defence in depth: re-check lockout / status between password and MFA.
    if (user.locked_until && user.locked_until > new Date()) {
        throw AppError.accountLocked();
    }
    if (user.status !== USER_STATUSES.ACTIVE) {
        throw AppError.forbidden('Account is deactivated', ERROR_CODES.ACCOUNT_DEACTIVATED);
    }
    if (!user.mfa_enabled || !user.mfa_secret_encrypted) {
        // MFA turned off between /login and /verify — force the client back through login.
        throw AppError.unauthenticated('Invalid MFA session');
    }

    let success: boolean;
    let consumedBackupIndex = -1;

    if (input.is_backup_code) {
        consumedBackupIndex = await findMatchingBackupCodeIndex(input.code, user.mfa_backup_codes_hashed);
        success = consumedBackupIndex >= 0;
    } else {
        success = verifyTotp(input.code, decryptSecret(user.mfa_secret_encrypted));
    }

    if (!success) {
        await applyFailedLoginAttempt(user);
        throw AppError.badRequest('Invalid MFA code', ERROR_CODES.INVALID_MFA_CODE);
    }

    if (consumedBackupIndex >= 0) {
        // Single-use: remove the matched hash so the same code can never be reused.
        const remaining = user.mfa_backup_codes_hashed.filter((_, i) => i !== consumedBackupIndex);
        await User.updateOne({ _id: user._id }, { $set: { mfa_backup_codes_hashed: remaining } });
    }

    return completeLoginAfterMfa(user, input.device_info, input.ip_address);
};

// ─── Disable ───────────────────────────────────────────────────────────────

interface DisableInput {
    user_id: Types.ObjectId;
    password: string;
    code: string;
}

export const disable = async (input: DisableInput): Promise<void> => {
    const user = await User.findById(input.user_id).select(
        '+password_hash +mfa_secret_encrypted +mfa_backup_codes_hashed'
    );
    if (!user) {
        throw AppError.notFound('User not found', ERROR_CODES.USER_NOT_FOUND);
    }
    if (!user.mfa_enabled || !user.mfa_secret_encrypted) {
        throw AppError.badRequest('MFA is not enabled');
    }

    const passwordOk = await verifyPassword(input.password, user.password_hash);
    if (!passwordOk) {
        throw AppError.invalidCredentials('Invalid password');
    }

    if (!verifyTotp(input.code, decryptSecret(user.mfa_secret_encrypted))) {
        throw AppError.badRequest('Invalid MFA code', ERROR_CODES.INVALID_MFA_CODE);
    }

    await User.updateOne(
        { _id: user._id },
        {
            $set: {
                mfa_enabled: false,
                mfa_secret_encrypted: null,
                mfa_backup_codes_hashed: [],
            },
        }
    );
};

// ─── Regenerate backup codes ───────────────────────────────────────────────

interface RegenerateInput {
    user_id: Types.ObjectId;
    code: string;
}

interface RegenerateResult {
    backup_codes: string[];
}

export const regenerateBackupCodes = async (input: RegenerateInput): Promise<RegenerateResult> => {
    const user = await User.findById(input.user_id).select('+mfa_secret_encrypted +mfa_backup_codes_hashed');
    if (!user) {
        throw AppError.notFound('User not found', ERROR_CODES.USER_NOT_FOUND);
    }
    if (!user.mfa_enabled || !user.mfa_secret_encrypted) {
        throw AppError.badRequest('MFA is not enabled');
    }

    if (!verifyTotp(input.code, decryptSecret(user.mfa_secret_encrypted))) {
        throw AppError.badRequest('Invalid MFA code', ERROR_CODES.INVALID_MFA_CODE);
    }

    const { plain, hashed } = await generateBackupCodes();
    await User.updateOne({ _id: user._id }, { $set: { mfa_backup_codes_hashed: hashed } });
    return { backup_codes: plain };
};
