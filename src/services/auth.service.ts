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
import { resolveLoginLockoutPolicy } from './settings.service.js';
import { AUDIT_ACTIONS, AUDIT_TARGET_KINDS } from '../constants/audit.js';
import { recordAudit, type AuditContext } from './audit.service.js';
import { resolveProfilePhotoTtlMinutes, signProfilePhotoUrl } from './profile-photo.service.js';
import { getOrInitSettings } from './settings.service.js';
import logger from '../utils/logger.js';
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
 *
 * Step 33: threshold + lockout duration are read from `system_settings.security`
 * (with a fall-back to the compile-time defaults when the resolver returns
 * `null`, which happens only on a totally fresh DB before the singleton has
 * been seeded). Operators can tune both via `PATCH /settings`.
 */
export const applyFailedLoginAttempt = async (user: UserDocument): Promise<void> => {
    const now = new Date();
    const nextAttempts = (user.failed_login_attempts ?? 0) + 1;
    const policy = await resolveLoginLockoutPolicy();
    const threshold = policy.failed_login_threshold ?? MAX_LOGIN_ATTEMPTS;
    const lockoutMs = (policy.lockout_duration_minutes ?? LOGIN_LOCKOUT_MS / 60_000) * 60_000;
    const update: Record<string, unknown> = {
        failed_login_attempts: nextAttempts,
        last_failed_login_at: now,
    };
    if (nextAttempts >= threshold) {
        update.locked_until = new Date(now.getTime() + lockoutMs);
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
 *
 * `session_count` (Step 27) is the number of active refresh-token rows
 * the caller holds — used by the FE to surface a "you have N other
 * sessions" badge. Computed via the same `activeSessionFilter` the
 * `/auth/sessions` list endpoint uses, so the two views stay coherent.
 */
export const getMe = async (user_id: Types.ObjectId): Promise<Record<string, unknown>> => {
    const user = await User.findById(user_id);
    if (!user) {
        throw AppError.notFound('User not found', ERROR_CODES.USER_NOT_FOUND);
    }

    const settings = await getOrInitSettings();
    const photoTtl = resolveProfilePhotoTtlMinutes(settings.uploads.sas_token_ttl_minutes);

    // `session_count` is best-effort. Step 27 added a Mongo round-trip
    // to the hot `/auth/me` path; a transient `RefreshToken`
    // failure would otherwise 500 the entire endpoint and break the FE
    // home page even when the user lookup + photo SAS succeed. We
    // surface `null` ("unknown") rather than `0` (which would lie about
    // the user's session state) so the FE can render a neutral
    // placeholder instead of "0 active sessions".
    let sessionCount: number | null;
    try {
        sessionCount = await RefreshToken.countDocuments(activeSessionFilter(user._id));
    } catch (err) {
        sessionCount = null;
        logger.warn(
            { err, code: 'SESSION_COUNT_READ_FAILED', user_id: user._id.toString() },
            'Failed to count active sessions for /auth/me — surfacing null'
        );
    }

    return {
        id: user._id.toString(),
        email: user.email,
        full_name: user.full_name,
        role: user.role,
        status: user.status,
        timezone: user.timezone,
        mfa_enabled: user.mfa_enabled,
        profile_photo_url: signProfilePhotoUrl(user.profile_photo_blob_key, photoTtl),
        session_count: sessionCount,
        permissions: [], // TODO (RBAC slice): derive from role.
    };
};

// ─── Session management (Step 27) ────────────────────────────────────────
//
// A "session" maps one-to-one to an active `refresh_tokens` row. The
// rotation flow already invalidates predecessors via `replaced_by_token_id`
// + `revoked_at`, so the active set naturally has at most one row per
// logical device-session — no chain-walking required.
//
// `last_used_at` is derived from `created_at` of the latest row in each
// chain: every rotation creates a new row with a fresh `created_at`, so
// the un-revoked row's `created_at` IS "when this session was last
// refreshed". For a session that has only been logged in (no refresh
// yet), `created_at` equals the login time, which is also "last used".

interface PublicSession {
    id: string;
    device_info: string;
    ip_address: string;
    last_used_at: Date;
    expires_at: Date;
}

/**
 * Mongo filter for "active sessions of this user". Used by both the
 * list endpoint and the `getMe` count so the two stay in lock-step
 * without re-deriving the predicate.
 */
const activeSessionFilter = (user_id: Types.ObjectId): Record<string, unknown> => ({
    user_id,
    revoked_at: null,
    expires_at: { $gt: new Date() },
});

const toPublicSession = (row: {
    _id: Types.ObjectId;
    device_info: string;
    ip_address: string;
    created_at: Date;
    expires_at: Date;
}): PublicSession => ({
    id: row._id.toString(),
    device_info: row.device_info,
    ip_address: row.ip_address,
    last_used_at: row.created_at,
    expires_at: row.expires_at,
});

/**
 * GET /auth/sessions — caller's active refresh-token rows. Sorted
 * newest-first (the most-recently-used session is what the FE
 * highlights). No pagination: a single user typically has < 10
 * active devices and the list shouldn't grow large enough to need
 * one. If we ever land an admin "view another user's sessions" flow
 * (deferred), pagination + an ADMIN gate go on that endpoint, not
 * this one.
 */
export const listSessions = async (user_id: Types.ObjectId): Promise<PublicSession[]> => {
    const rows = await RefreshToken.find(activeSessionFilter(user_id))
        .select('_id device_info ip_address created_at expires_at')
        .sort({ created_at: -1 })
        .lean<
            {
                _id: Types.ObjectId;
                device_info: string;
                ip_address: string;
                created_at: Date;
                expires_at: Date;
            }[]
        >();
    return rows.map(toPublicSession);
};

/**
 * POST /auth/sessions/:id/revoke — caller-only. The same id presented
 * by another user receives a 404 (not 403) so the existence of a
 * specific session-id is not leaked across accounts.
 *
 * Atomic + idempotent. The revoke uses `findOneAndUpdate` with the
 * `revoked_at: null` guard so two concurrent calls cannot both win the
 * write — only the request whose update modifies the row proceeds to
 * the audit step. The losing concurrent caller falls into the
 * idempotent fall-through below and returns success without a second
 * audit row, so an admin double-click cannot shift the audit-log
 * boundary forward in time. Same atomic pattern as the rotation flow
 * in `refreshTokens` above (which uses the same predicate to detect
 * token reuse).
 *
 * Three terminal paths:
 *   - Row not found for `(id, user_id)` → 404 `SESSION_NOT_FOUND`.
 *     Same code for unknown id AND cross-user id; existence-leak
 *     guarded.
 *   - Row found and we won the atomic write → record audit, return ok.
 *   - Row found but already revoked (or another revoke beat us) →
 *     no save, no audit, return ok with the existing id.
 */
export const revokeSession = async (input: {
    user_id: Types.ObjectId;
    session_id: Types.ObjectId;
    audit?: AuditContext;
}): Promise<{ revoked: true; id: string }> => {
    // Atomic guarded update. The predicate is `(id, user_id, revoked_at: null)`:
    //  - cross-user → predicate misses (different user_id) → null
    //  - unknown id → predicate misses → null
    //  - already revoked for this user → predicate misses (revoked_at: null) → null
    //  - active for this user → predicate matches; this caller flips
    //    revoked_at and `findOneAndUpdate` returns the modified row.
    // Concurrent second revoke hits the same filter after the first
    // caller already nulled `revoked_at: null`, gets null back, and
    // falls into the idempotent path below.
    const updated = await RefreshToken.findOneAndUpdate(
        { _id: input.session_id, user_id: input.user_id, revoked_at: null },
        { $set: { revoked_at: new Date() } },
        { new: true }
    );

    if (updated) {
        if (input.audit) {
            await recordAudit(input.audit, {
                action: AUDIT_ACTIONS.AUTH_SESSION_REVOKE,
                target: { kind: AUDIT_TARGET_KINDS.SESSION, id: updated._id },
                metadata: {
                    user_id: input.user_id.toString(),
                    device_info: updated.device_info,
                    ip_address: updated.ip_address,
                },
            });
        }
        return { revoked: true, id: updated._id.toString() };
    }

    // Atomic update missed. Distinguish "row exists for this user
    // but was already revoked" (idempotent ok) from "row doesn't
    // exist for this user" (404). The follow-up read still filters on
    // `user_id` so a cross-user id can't reach the idempotent branch.
    const existing = await RefreshToken.findOne({
        _id: input.session_id,
        user_id: input.user_id,
    }).select('_id');
    if (!existing) {
        throw AppError.notFound('Session not found', ERROR_CODES.SESSION_NOT_FOUND);
    }
    return { revoked: true, id: existing._id.toString() };
};
