import { Types } from 'mongoose';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';

import { User, type UserDocument } from '../models/user.model.js';
import { RefreshToken } from '../models/refresh-token.model.js';
import { AppError } from '../utils/app-error.js';
import { createAccessToken, createRefreshToken, verifyRefreshToken } from '../utils/jwt.js';
import { hashPassword, verifyPassword } from '../utils/password.js';
import { sha256Hex } from '../utils/token-hash.js';
import { issueMfaSession } from '../utils/mfa-session.js';
import { ERROR_CODES } from '../constants/error-codes.js';
import { USER_STATUSES } from '../constants/user-statuses.js';
import { MAX_LOGIN_ATTEMPTS, LOGIN_LOCKOUT_MS } from '../constants/auth.js';
import { AUDIT_ACTIONS, AUDIT_TARGET_KINDS } from '../constants/audit.js';
import { recordAudit, type AuditContext } from './audit.service.js';
import { resolveProfilePhotoTtlMinutes, signProfilePhotoUrl } from './profile-photo.service.js';
import { getOrInitSettings } from './settings.service.js';
import type { AuthTokenPair, BaseJWTPayload } from '../types/index.js';

interface LoginInput {
    email: string;
    password: string;
    device_info?: string;
    ip_address?: string;
}

export interface LoginTokenResult extends AuthTokenPair {
    user: { id: string; role: string; full_name: string };
}

export interface LoginMfaChallenge {
    mfa_required: true;
    mfa_session_token: string;
    mfa_session_expires_at: string;
}

export type LoginResult = LoginTokenResult | LoginMfaChallenge;

/**
 * Fixed bcrypt hash used to equalise timing on the unknown-email branch of
 * login. Hashing an arbitrary string against this keeps the response latency
 * within the distribution of a real compare and blunts email-enumeration via
 * timing. The plaintext intentionally never matches.
 */
const TIMING_DUMMY_HASH = '$2b$12$CwTycUXWue0Thq9StjUM0uJ8Y8l0yPb3xYqK2yL4V1.9mNRBrTf3e';

interface IssueTokensInput {
    user_id: Types.ObjectId;
    role: UserDocument['role'];
    device_info: string;
    ip_address: string;
    replaces_token_id?: Types.ObjectId;
}

const issueTokenPair = async (input: IssueTokensInput): Promise<AuthTokenPair & { refresh_row_id: Types.ObjectId }> => {
    const basePayload: BaseJWTPayload = {
        user_id: input.user_id.toString(),
        role: input.role,
    };

    const access = createAccessToken(basePayload);
    const refresh = createRefreshToken(basePayload);

    const row = await RefreshToken.create({
        user_id: input.user_id,
        token_hash: sha256Hex(refresh.token),
        device_info: input.device_info,
        ip_address: input.ip_address,
        expires_at: refresh.expires_at,
    });

    // Back-link the rotated row (if any) to this freshly minted one.
    if (input.replaces_token_id) {
        await RefreshToken.updateOne({ _id: input.replaces_token_id }, { $set: { replaced_by_token_id: row._id } });
    }

    return {
        access_token: access.token,
        access_token_expires_at: access.expires_at.toISOString(),
        refresh_token: refresh.token,
        refresh_token_expires_at: refresh.expires_at.toISOString(),
        refresh_row_id: row._id,
    };
};

/**
 * Shared by both password-failure and TOTP-failure paths. MFA code brute-force
 * is ultimately just another failed login attempt and reuses the same lockout
 * window and counter.
 */
export const applyFailedLoginAttempt = async (user: UserDocument): Promise<void> => {
    const now = new Date();
    const nextAttempts = (user.failed_login_attempts ?? 0) + 1;
    const update: Record<string, unknown> = {
        failed_login_attempts: nextAttempts,
        last_failed_login_at: now,
    };
    if (nextAttempts >= MAX_LOGIN_ATTEMPTS) {
        update.locked_until = new Date(now.getTime() + LOGIN_LOCKOUT_MS);
        update.failed_login_attempts = 0; // reset after lock so next unlock-window starts fresh
    }
    await User.updateOne({ _id: user._id }, { $set: update });
};

const clearLoginCounters = async (user_id: Types.ObjectId): Promise<void> => {
    await User.updateOne(
        { _id: user_id },
        {
            $set: {
                failed_login_attempts: 0,
                last_failed_login_at: null,
                locked_until: null,
                last_login_at: new Date(),
            },
        }
    );
};

/**
 * Called by the MFA service when the TOTP / backup code verifies. Equivalent
 * to the tail end of /auth/login when MFA is not enabled — clears counters,
 * stamps last_login_at, and mints a real access + refresh pair.
 */
export const completeLoginAfterMfa = async (
    user: UserDocument,
    device_info?: string,
    ip_address?: string
): Promise<LoginTokenResult> => {
    await clearLoginCounters(user._id);
    const tokens = await issueTokenPair({
        user_id: user._id,
        role: user.role,
        device_info: device_info ?? '',
        ip_address: ip_address ?? '',
    });
    return {
        access_token: tokens.access_token,
        access_token_expires_at: tokens.access_token_expires_at,
        refresh_token: tokens.refresh_token,
        refresh_token_expires_at: tokens.refresh_token_expires_at,
        user: { id: user._id.toString(), role: user.role, full_name: user.full_name },
    };
};

/**
 * POST /auth/login — email + password.
 *
 * Generic-response rule (API_Contract §2.2): unknown email and wrong password
 * both return `INVALID_CREDENTIALS` so email enumeration is not possible.
 * Lockout and deactivation are intentionally distinct codes — they apply only
 * to an authenticated existence check the attacker already has signal for.
 */
export const login = async (input: LoginInput): Promise<LoginResult> => {
    const user = await User.findOne({ email: input.email }).select(
        '+password_hash +failed_login_attempts +locked_until +mfa_enabled'
    );

    if (!user) {
        // Timing-equalising compare so the unknown-email branch takes
        // approximately the same wall time as a wrong-password branch.
        await bcrypt.compare(input.password, TIMING_DUMMY_HASH);
        throw AppError.invalidCredentials();
    }

    const now = new Date();
    if (user.locked_until && user.locked_until > now) {
        throw AppError.accountLocked();
    }

    if (user.status !== USER_STATUSES.ACTIVE) {
        throw AppError.forbidden('Account is deactivated', ERROR_CODES.ACCOUNT_DEACTIVATED);
    }

    const passwordOk = await verifyPassword(input.password, user.password_hash);
    if (!passwordOk) {
        await applyFailedLoginAttempt(user);
        throw AppError.invalidCredentials();
    }

    // MFA branch (API_Contract §2.2 "MFA required" response). Password counters
    // are NOT cleared here — we clear them only after /auth/mfa/verify succeeds,
    // so that TOTP brute-force continues to share the lockout budget.
    if (user.mfa_enabled) {
        const session = issueMfaSession(user._id.toString());
        return {
            mfa_required: true,
            mfa_session_token: session.token,
            mfa_session_expires_at: session.expires_at.toISOString(),
        };
    }

    await clearLoginCounters(user._id);

    const tokens = await issueTokenPair({
        user_id: user._id,
        role: user.role,
        device_info: input.device_info ?? '',
        ip_address: input.ip_address ?? '',
    });

    return {
        access_token: tokens.access_token,
        access_token_expires_at: tokens.access_token_expires_at,
        refresh_token: tokens.refresh_token,
        refresh_token_expires_at: tokens.refresh_token_expires_at,
        user: { id: user._id.toString(), role: user.role, full_name: user.full_name },
    };
};

/**
 * POST /auth/refresh — rotate the presented refresh token.
 *
 * Reuse detection (API_Contract §2.4): if a token that has already been
 * rotated (revoked_at != null AND replaced_by_token_id != null) is presented
 * again, revoke the **entire chain** for that user — treat as theft.
 */
export const refreshTokens = async (input: {
    refresh_token: string;
    device_info?: string;
    ip_address?: string;
}): Promise<AuthTokenPair> => {
    let payload;
    try {
        payload = verifyRefreshToken(input.refresh_token);
    } catch (err) {
        // Let jwt.TokenExpiredError / JsonWebTokenError surface via the global handler.
        throw err instanceof jwt.JsonWebTokenError ? err : AppError.unauthenticated('Invalid refresh token');
    }

    const tokenHash = sha256Hex(input.refresh_token);
    const row = await RefreshToken.findOne({ token_hash: tokenHash });

    if (!row) {
        throw AppError.unauthenticated('Invalid refresh token');
    }

    // Reuse of an already-rotated token → revoke whole chain.
    if (row.revoked_at && row.replaced_by_token_id) {
        await RefreshToken.updateMany({ user_id: row.user_id, revoked_at: null }, { $set: { revoked_at: new Date() } });
        throw new AppError({
            statusCode: 401,
            code: ERROR_CODES.TOKEN_REUSE_DETECTED,
            message: 'Refresh token reuse detected. All sessions revoked.',
        });
    }

    if (row.revoked_at) {
        throw AppError.unauthenticated('Refresh token revoked');
    }

    if (row.expires_at.getTime() <= Date.now()) {
        throw AppError.tokenExpired('Refresh token expired, please login again');
    }

    // Confirm the user is still active — a deactivated user should not refresh.
    const user = await User.findById(payload.user_id).select('status role');
    if (!user || user.status !== USER_STATUSES.ACTIVE) {
        await RefreshToken.updateMany({ user_id: row.user_id, revoked_at: null }, { $set: { revoked_at: new Date() } });
        throw AppError.forbidden('Account is not active', ERROR_CODES.ACCOUNT_DEACTIVATED);
    }

    // Revoke the presented token first so a concurrent second use hits the
    // reuse-detection branch.
    const revokeRes = await RefreshToken.updateOne(
        { _id: row._id, revoked_at: null },
        { $set: { revoked_at: new Date() } }
    );
    if (revokeRes.modifiedCount === 0) {
        // Lost the race with another refresh call — treat as reuse.
        await RefreshToken.updateMany({ user_id: row.user_id, revoked_at: null }, { $set: { revoked_at: new Date() } });
        throw new AppError({
            statusCode: 401,
            code: ERROR_CODES.TOKEN_REUSE_DETECTED,
            message: 'Refresh token reuse detected. All sessions revoked.',
        });
    }

    const tokens = await issueTokenPair({
        user_id: row.user_id,
        role: user.role,
        device_info: input.device_info ?? row.device_info,
        ip_address: input.ip_address ?? row.ip_address,
        replaces_token_id: row._id,
    });

    return {
        access_token: tokens.access_token,
        access_token_expires_at: tokens.access_token_expires_at,
        refresh_token: tokens.refresh_token,
        refresh_token_expires_at: tokens.refresh_token_expires_at,
    };
};

/**
 * POST /auth/logout — revoke the presented refresh token only.
 * Idempotent: unknown / already-revoked tokens succeed silently.
 */
export const logout = async (refresh_token: string): Promise<void> => {
    const tokenHash = sha256Hex(refresh_token);
    await RefreshToken.updateOne({ token_hash: tokenHash, revoked_at: null }, { $set: { revoked_at: new Date() } });
};

/**
 * POST /auth/logout-all — revoke every active refresh token for the caller.
 */
export const logoutAll = async (user_id: Types.ObjectId): Promise<void> => {
    await RefreshToken.updateMany({ user_id, revoked_at: null }, { $set: { revoked_at: new Date() } });
};

/**
 * POST /auth/change-password — requires authentication.
 * Verifies old password, enforces policy via the validator upstream, hashes
 * the new password, stamps `last_password_changed_at`, and revokes all active
 * refresh tokens for the user (plan §7.2).
 */
export const changePassword = async (input: {
    user_id: Types.ObjectId;
    old_password: string;
    new_password: string;
    audit?: AuditContext;
}): Promise<void> => {
    const user = await User.findById(input.user_id).select('+password_hash');
    if (!user) {
        throw AppError.notFound('User not found', ERROR_CODES.USER_NOT_FOUND);
    }

    const ok = await verifyPassword(input.old_password, user.password_hash);
    if (!ok) {
        throw AppError.invalidCredentials('Old password is incorrect');
    }

    const new_hash = await hashPassword(input.new_password);

    await User.updateOne(
        { _id: user._id },
        { $set: { password_hash: new_hash, last_password_changed_at: new Date() } }
    );

    await logoutAll(user._id);

    if (input.audit) {
        await recordAudit(input.audit, {
            action: AUDIT_ACTIONS.AUTH_PASSWORD_CHANGE,
            target: { kind: AUDIT_TARGET_KINDS.USER, id: user._id },
        });
    }
};

/**
 * GET /auth/me — fresh load from DB so status / MFA toggles are up to date.
 *
 * `profile_photo_url` is a freshly-minted SAS read URL (Step 22). Its
 * lifetime is `system_settings.uploads.sas_token_ttl_minutes` (clamped to
 * the safe range). The FE re-fetches `/auth/me` whenever it refreshes
 * the access token, so the URL never expires before the user notices.
 */
export const getMe = async (user_id: Types.ObjectId): Promise<Record<string, unknown>> => {
    const user = await User.findById(user_id);
    if (!user) {
        throw AppError.notFound('User not found', ERROR_CODES.USER_NOT_FOUND);
    }

    const settings = await getOrInitSettings();
    const photoTtl = resolveProfilePhotoTtlMinutes(settings.uploads.sas_token_ttl_minutes);

    return {
        id: user._id.toString(),
        email: user.email,
        full_name: user.full_name,
        role: user.role,
        status: user.status,
        timezone: user.timezone,
        mfa_enabled: user.mfa_enabled,
        profile_photo_url: signProfilePhotoUrl(user.profile_photo_blob_key, photoTtl),
        permissions: [], // TODO (RBAC slice): derive from role.
    };
};
