import { randomBytes } from 'node:crypto';
import { Types } from 'mongoose';

import { User } from '../models/user.model.js';
import { PasswordResetToken } from '../models/password-reset-token.model.js';
import { AppError } from '../utils/app-error.js';
import { hashPassword } from '../utils/password.js';
import { sha256Hex } from '../utils/token-hash.js';
import { sendPasswordResetEmail } from '../utils/mailer.js';
import { logoutAll } from './auth.service.js';
import { recordAudit, type AuditContext } from './audit.service.js';
import { RESET_TOKEN_BYTES, RESET_TOKEN_TTL_MS } from '../constants/auth.js';
import { resolvePasswordResetTtlMinutes } from './settings.service.js';
import { AUDIT_ACTIONS, AUDIT_TARGET_KINDS } from '../constants/audit.js';
import { ERROR_CODES } from '../constants/error-codes.js';
import { USER_STATUSES } from '../constants/user-statuses.js';

/**
 * Forgot / reset password flow (API_Contract §2.5 / §2.6).
 *
 *  POST /auth/forgot-password  → ALWAYS 200 with a generic message.
 *                                 Unknown email or deactivated user silently
 *                                 no-ops so the endpoint cannot be used for
 *                                 account enumeration.
 *
 *  POST /auth/reset-password   → Validates the opaque token, stamps `used_at`,
 *                                 writes the new password hash, and revokes
 *                                 every active refresh token for the user
 *                                 (plan §7.2).
 */

const GENERIC_INVALID_TOKEN = 'Reset link is invalid or expired';

const base64Url = (buf: Buffer): string =>
    buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// ─── Forgot ────────────────────────────────────────────────────────────────

export const requestPasswordReset = async (email: string): Promise<void> => {
    // R7 — defence-in-depth: normalise at the service boundary so a
    // direct caller (admin tool / cron) that skips the Zod validator
    // still hits the lowercased email index.
    const normalisedEmail = email.trim().toLowerCase();
    const user = await User.findOne({ email: normalisedEmail });

    // Enumeration guard — behave identically for missing / deactivated accounts.
    // Still incur a bit of work so timing is roughly comparable.
    if (!user || user.status !== USER_STATUSES.ACTIVE) {
        // Light decoy work: generate + discard a token to keep the branches closer in wall time.
        randomBytes(RESET_TOKEN_BYTES);
        return;
    }

    // Invalidate any older unused tokens so only the latest link is active.
    // (Phished-but-unused tokens are implicitly revoked here.)
    await PasswordResetToken.updateMany({ user_id: user._id, used_at: null }, { $set: { used_at: new Date() } });

    const rawToken = base64Url(randomBytes(RESET_TOKEN_BYTES));
    // Step 33: TTL is read from `system_settings.security.password_reset_ttl_minutes`,
    // falling back to the compile-time default during the fresh-install
    // bootstrap window when the singleton hasn't been seeded yet.
    const ttlMinutes = await resolvePasswordResetTtlMinutes();
    const ttlMs = ttlMinutes !== null ? ttlMinutes * 60_000 : RESET_TOKEN_TTL_MS;
    await PasswordResetToken.create({
        user_id: user._id,
        token_hash: sha256Hex(rawToken),
        expires_at: new Date(Date.now() + ttlMs),
    });

    await sendPasswordResetEmail({
        to: user.email,
        full_name: user.full_name,
        token: rawToken,
    });
};

// ─── Reset ─────────────────────────────────────────────────────────────────

interface ResetInput {
    token: string;
    new_password: string;
    /**
     * Optional audit context. The actor in the recorded row is *the user the
     * token belongs to*, regardless of who hit the endpoint — so callers
     * usually pass `{ actor_id: null, actor_role: 'unauthenticated', ip, user_agent }`
     * and let `resetPassword` rebuild the actor from the token. We override
     * `actor_id` + `actor_role` here once we've validated the token.
     */
    audit?: AuditContext;
}

export const resetPassword = async (input: ResetInput): Promise<void> => {
    const tokenHash = sha256Hex(input.token);
    const row = await PasswordResetToken.findOne({ token_hash: tokenHash });

    if (!row) {
        throw AppError.badRequest(GENERIC_INVALID_TOKEN, ERROR_CODES.VALIDATION_ERROR);
    }
    if (row.used_at) {
        throw AppError.badRequest(GENERIC_INVALID_TOKEN, ERROR_CODES.VALIDATION_ERROR);
    }
    if (row.expires_at.getTime() <= Date.now()) {
        throw AppError.badRequest(GENERIC_INVALID_TOKEN, ERROR_CODES.VALIDATION_ERROR);
    }

    const user = await User.findById(row.user_id);
    if (!user) {
        throw AppError.badRequest(GENERIC_INVALID_TOKEN, ERROR_CODES.VALIDATION_ERROR);
    }

    // A deactivated account mustn't silently regain access through a reset link.
    if (user.status !== USER_STATUSES.ACTIVE) {
        throw AppError.forbidden('Account is deactivated', ERROR_CODES.ACCOUNT_DEACTIVATED);
    }

    // Atomically mark the token consumed FIRST so a second in-flight request
    // can't race through with the same link.
    const markUsed = await PasswordResetToken.updateOne(
        { _id: row._id, used_at: null },
        { $set: { used_at: new Date() } }
    );
    if (markUsed.modifiedCount === 0) {
        throw AppError.badRequest(GENERIC_INVALID_TOKEN, ERROR_CODES.VALIDATION_ERROR);
    }

    const new_hash = await hashPassword(input.new_password);
    await User.updateOne(
        { _id: user._id },
        {
            $set: {
                password_hash: new_hash,
                last_password_changed_at: new Date(),
                // Clear lockout state too — the user just proved control of the inbox.
                failed_login_attempts: 0,
                last_failed_login_at: null,
                locked_until: null,
            },
        }
    );

    // Force logout everywhere (plan §7.2 & API_Contract §2.6).
    await logoutAll(user._id);

    if (input.audit) {
        await recordAudit(
            {
                ...input.audit,
                // Stamp the user as the actor — the reset link proved control
                // of their inbox, even though no JWT was used to call the API.
                actor_id: user._id,
                actor_role: user.role,
            },
            {
                action: AUDIT_ACTIONS.AUTH_PASSWORD_RESET,
                target: { kind: AUDIT_TARGET_KINDS.USER, id: user._id },
            }
        );
    }
};

// ─── Admin-triggered reset ────────────────────────────────────────────────

/**
 * Admin-triggered password reset (`POST /users/:id/reset-password`).
 *
 * Mints a one-time reset token for the target user and emails them a
 * link — same flow the user-initiated `requestPasswordReset` runs, but
 * with three differences:
 *
 *   1. **No enumeration silence.** The admin already knows the
 *      target's user_id (it's in the URL); a 404 here is fine and
 *      tells the operator their input was wrong. We surface
 *      `USER_NOT_FOUND` rather than the generic 200.
 *   2. **Deactivated → 403, not silent.** A reset link for a
 *      deactivated account is operator error — they should reactivate
 *      first. We surface `ACCOUNT_DEACTIVATED` so the admin sees the
 *      issue instead of wondering why the email never arrived.
 *   3. **Audit row tags the admin as actor.** `AUTH_ADMIN_PASSWORD_RESET`
 *      records WHICH admin requested the reset. The downstream
 *      `AUTH_PASSWORD_RESET` row (when the user consumes the link)
 *      records the user as actor — the two rows together tell the
 *      "admin asked, user consumed" story.
 *
 * Returns nothing — the controller maps to 204. The link is
 * intentionally NOT in the response (it would let an admin reset their
 * peer's password without the peer ever seeing the email — that's a
 * different design with different audit / abuse implications).
 */
export const adminInitiatePasswordReset = async (targetUserId: Types.ObjectId, audit: AuditContext): Promise<void> => {
    const user = await User.findById(targetUserId);
    if (!user) {
        throw AppError.notFound('User not found', ERROR_CODES.USER_NOT_FOUND);
    }
    if (user.status !== USER_STATUSES.ACTIVE) {
        throw AppError.forbidden('Cannot reset password for a deactivated user', ERROR_CODES.ACCOUNT_DEACTIVATED);
    }

    // Same token-mint flow as the user-initiated path — invalidate any
    // older unused tokens so only the most recent link works.
    await PasswordResetToken.updateMany({ user_id: user._id, used_at: null }, { $set: { used_at: new Date() } });

    const rawToken = base64Url(randomBytes(RESET_TOKEN_BYTES));
    const ttlMinutes = await resolvePasswordResetTtlMinutes();
    const ttlMs = ttlMinutes !== null ? ttlMinutes * 60_000 : RESET_TOKEN_TTL_MS;
    await PasswordResetToken.create({
        user_id: user._id,
        token_hash: sha256Hex(rawToken),
        expires_at: new Date(Date.now() + ttlMs),
    });

    await sendPasswordResetEmail({
        to: user.email,
        full_name: user.full_name,
        token: rawToken,
    });

    // Audit with the admin as actor. The downstream user-consumption
    // row (when they click the link) will record them as the actor on
    // `AUTH_PASSWORD_RESET`.
    await recordAudit(audit, {
        action: AUDIT_ACTIONS.AUTH_ADMIN_PASSWORD_RESET,
        target: { kind: AUDIT_TARGET_KINDS.USER, id: user._id },
        metadata: { target_email: user.email },
    });
};
