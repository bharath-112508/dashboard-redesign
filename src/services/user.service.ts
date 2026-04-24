import { Types } from 'mongoose';

// Mongoose 9 no longer exports `FilterQuery<T>` publicly — this loose alias is
// good enough for our needs (shape-only type-check on the caller side).
type Filter = Record<string, unknown>;

import { User, type UserDocument } from '../models/user.model.js';
import { RefreshToken } from '../models/refresh-token.model.js';
import { AppError } from '../utils/app-error.js';
import { hashPassword } from '../utils/password.js';
import { assertPasswordPolicy } from '../utils/password-policy.js';
import { ERROR_CODES } from '../constants/error-codes.js';
import { ROLES, type RoleType } from '../constants/roles.js';
import { USER_STATUSES } from '../constants/user-statuses.js';
import type { PaginationMeta } from '../utils/api-response.js';
import type { AssignableQuery, CreateUserBody, ListUsersQuery, UpdateUserBody } from '../validators/user.validator.js';
import { initializeBalancesForUserYear } from './leave-balance.service.js';
import { notifyUserInvited } from './notification-dispatcher.service.js';
import { recordAudit, type AuditContext } from './audit.service.js';
import { AUDIT_ACTIONS, AUDIT_TARGET_KINDS } from '../constants/audit.js';
import logger from '../utils/logger.js';

/**
 * User management service (API_Contract §3).
 *
 *  - Single-admin rule enforced at create + change-role.
 *  - Unique email enforced at the DB layer → surfaced as `409 EMAIL_ALREADY_EXISTS`.
 *  - Deactivation / role-change revoke every active refresh token for the user.
 *  - Profile-photo + admin-triggered reset-password deferred (need Azure Blob /
 *    Azure Communication Services). Call-sites will return `501 NOT_IMPLEMENTED`
 *    when those are added later.
 */

// ─── Fields that a non-admin caller is allowed to update on their own record.
// Matches API_Contract §3 "PATCH /users/:id (ADM or self for own profile fields)".
const SELF_EDITABLE_FIELDS = new Set([
    'full_name',
    'phone',
    'timezone',
    'slack_user_id',
    // internal_profile is partially self-editable; see `pickSelfInternalProfile`.
    'internal_profile',
]);
const SELF_EDITABLE_INTERNAL_PROFILE_FIELDS = new Set(['emergency_contact']);

// ─── Helpers ───────────────────────────────────────────────────────────────

const toPublicUser = (user: UserDocument): Record<string, unknown> => {
    // toJSON strips sensitive fields via `sensitiveToJSON` on the model.
    return user.toJSON();
};

const assertSingleAdmin = async (excludeUserId?: Types.ObjectId): Promise<void> => {
    const filter: Filter = {
        role: ROLES.ADMIN,
        status: USER_STATUSES.ACTIVE,
    };
    if (excludeUserId) {
        filter._id = { $ne: excludeUserId };
    }
    const existing = await User.exists(filter);
    if (existing) {
        throw AppError.conflict('An active admin already exists', ERROR_CODES.ADMIN_ALREADY_EXISTS);
    }
};

const revokeAllRefreshTokens = async (user_id: Types.ObjectId): Promise<void> => {
    await RefreshToken.updateMany({ user_id, revoked_at: null }, { $set: { revoked_at: new Date() } });
};

// ─── POST /users ───────────────────────────────────────────────────────────

export const createUser = async (
    input: CreateUserBody,
    created_by: Types.ObjectId,
    audit?: AuditContext
): Promise<Record<string, unknown>> => {
    assertPasswordPolicy(input.initial_password);

    if (input.role === ROLES.ADMIN) {
        await assertSingleAdmin();
    }

    const emailInUse = await User.exists({ email: input.email });
    if (emailInUse) {
        throw AppError.conflict('Email already exists', ERROR_CODES.EMAIL_ALREADY_EXISTS);
    }

    const password_hash = await hashPassword(input.initial_password);

    const doc: Partial<UserDocument> = {
        email: input.email,
        password_hash,
        full_name: input.full_name,
        phone: input.phone,
        role: input.role,
        status: USER_STATUSES.ACTIVE,
        created_by,
    };

    if (input.timezone) doc.timezone = input.timezone;
    if (input.slack_user_id) doc.slack_user_id = input.slack_user_id;

    if (input.role === ROLES.CLIENT && input.client_profile) {
        doc.client_profile = input.client_profile;
    } else if (input.internal_profile) {
        doc.internal_profile = {
            ...input.internal_profile,
            reporting_manager_id: input.internal_profile.reporting_manager_id
                ? new Types.ObjectId(input.internal_profile.reporting_manager_id)
                : null,
        };
    }

    const created = await User.create(doc);

    // Internal users get their leave-balance rows seeded for the current year
    // (and the joining year if different). Failure here must not block the
    // user create — surface as a warning so admin can re-run init manually.
    if (created.role !== ROLES.CLIENT && created.internal_profile?.date_of_joining) {
        try {
            const joining = created.internal_profile.date_of_joining;
            const [yStr, mStr] = joining.split('-');
            const joiningYear = Number.parseInt(yStr, 10);
            const joiningMonth = Number.parseInt(mStr, 10);
            const thisYear = new Date().getUTCFullYear();
            const yearsToInit = new Set<number>([joiningYear, thisYear]);
            for (const year of yearsToInit) {
                await initializeBalancesForUserYear({
                    user_id: created._id,
                    year,
                    joining_year: joiningYear,
                    joining_month: joiningMonth,
                });
            }
        } catch (err) {
            logger.warn(
                { err, user_id: created._id.toString() },
                'Leave-balance initialization failed for new user — will self-heal on first /leave-balances/me read'
            );
        }
    }

    // Welcome / invite email — best effort, never blocks the create. Logs
    // `NOTIFICATION_DISPATCH_FAILED` if the mailer chokes (Step 11).
    await notifyUserInvited({
        recipient_user_id: created._id,
        invited_by: { id: created_by },
        initial_password: input.initial_password,
    });

    // Step 12 — audit trail. The `after` snapshot is the public projection
    // so we never accidentally persist `password_hash` (toPublicUser already
    // strips sensitive fields via the model's toJSON).
    if (audit) {
        await recordAudit(audit, {
            action: AUDIT_ACTIONS.USER_CREATE,
            target: { kind: AUDIT_TARGET_KINDS.USER, id: created._id },
            after: toPublicUser(created),
            metadata: { created_role: created.role },
        });
    }

    return toPublicUser(created);
};

// ─── GET /users ────────────────────────────────────────────────────────────

export const listUsers = async (
    query: ListUsersQuery
): Promise<{ data: Record<string, unknown>[]; meta: PaginationMeta }> => {
    const filter: Filter = {};
    if (query.role) filter.role = query.role;
    if (query.status) filter.status = query.status;
    if (query.q) {
        const safe = query.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        filter.$or = [{ email: { $regex: safe, $options: 'i' } }, { full_name: { $regex: safe, $options: 'i' } }];
    }

    const skip = (query.page - 1) * query.limit;

    const [rows, total] = await Promise.all([
        User.find(filter).sort({ created_at: -1 }).skip(skip).limit(query.limit),
        User.countDocuments(filter),
    ]);

    return {
        data: rows.map(toPublicUser),
        meta: {
            page: query.page,
            limit: query.limit,
            total,
            total_pages: Math.max(1, Math.ceil(total / query.limit)),
        },
    };
};

// ─── GET /users/:id ────────────────────────────────────────────────────────

export const getUser = async (id: Types.ObjectId): Promise<Record<string, unknown>> => {
    const user = await User.findById(id);
    if (!user) {
        throw AppError.notFound('User not found', ERROR_CODES.USER_NOT_FOUND);
    }
    return toPublicUser(user);
};

// ─── PATCH /users/:id ──────────────────────────────────────────────────────

/**
 * Authorization:
 *   - Admin caller → may patch any field for any user.
 *   - Self caller  → may only patch fields in SELF_EDITABLE_FIELDS, and within
 *     `internal_profile` only `emergency_contact`.
 *   - Any other caller → already rejected at the route layer via `authorize`.
 */
export const updateUser = async (input: {
    target_id: Types.ObjectId;
    caller_id: Types.ObjectId;
    caller_role: RoleType;
    patch: UpdateUserBody;
}): Promise<Record<string, unknown>> => {
    const target = await User.findById(input.target_id);
    if (!target) {
        throw AppError.notFound('User not found', ERROR_CODES.USER_NOT_FOUND);
    }

    const isAdmin = input.caller_role === ROLES.ADMIN;
    const isSelf = input.caller_id.equals(target._id);

    if (!isAdmin && !isSelf) {
        throw AppError.forbidden();
    }

    // Self-scope: strip disallowed top-level fields + disallowed nested fields.
    let patch = { ...input.patch };
    if (!isAdmin) {
        patch = Object.fromEntries(
            Object.entries(patch).filter(([k]) => SELF_EDITABLE_FIELDS.has(k))
        ) as UpdateUserBody;

        if (patch.internal_profile) {
            const filtered = Object.fromEntries(
                Object.entries(patch.internal_profile).filter(([k]) => SELF_EDITABLE_INTERNAL_PROFILE_FIELDS.has(k))
            );
            // If the caller only sent disallowed nested keys, drop the key
            // entirely so it doesn't count toward "patch non-empty" below.
            if (Object.keys(filtered).length === 0) {
                delete patch.internal_profile;
            } else {
                patch.internal_profile = filtered;
            }
        }

        if (Object.keys(patch).length === 0) {
            throw AppError.forbidden('No fields in this patch are editable by the caller');
        }
    }

    // Role consistency: can't add internal_profile to a client or vice versa.
    if (patch.internal_profile && target.role === ROLES.CLIENT) {
        throw AppError.validation('internal_profile is not valid for a client user');
    }
    if (patch.client_profile && target.role !== ROLES.CLIENT) {
        throw AppError.validation('client_profile is only valid for a client user');
    }

    // Apply shallow merges for sub-docs so unset fields remain. The validator
    // gives `reporting_manager_id` as a hex string; coerce to ObjectId here.
    if (patch.internal_profile) {
        const coerced: Record<string, unknown> = { ...patch.internal_profile };
        if ('reporting_manager_id' in coerced) {
            const raw = coerced.reporting_manager_id;
            coerced.reporting_manager_id = typeof raw === 'string' ? new Types.ObjectId(raw) : raw;
        }
        target.internal_profile = target.internal_profile
            ? ({ ...target.internal_profile, ...coerced } as unknown as UserDocument['internal_profile'])
            : (coerced as unknown as UserDocument['internal_profile']);
    }

    if (patch.client_profile && target.client_profile) {
        target.client_profile = { ...target.client_profile, ...patch.client_profile };
    } else if (patch.client_profile) {
        target.client_profile = patch.client_profile as UserDocument['client_profile'];
    }

    if (patch.full_name !== undefined) target.full_name = patch.full_name;
    if (patch.phone !== undefined) target.phone = patch.phone;
    if (patch.timezone !== undefined) target.timezone = patch.timezone;
    if (patch.slack_user_id !== undefined) target.slack_user_id = patch.slack_user_id;

    await target.save();
    return toPublicUser(target);
};

// ─── POST /users/:id/deactivate ────────────────────────────────────────────

export const deactivateUser = async (input: {
    target_id: Types.ObjectId;
    caller_id: Types.ObjectId;
    reason?: string;
    audit?: AuditContext;
}): Promise<Record<string, unknown>> => {
    if (input.caller_id.equals(input.target_id)) {
        throw AppError.forbidden('You cannot deactivate your own account');
    }

    const target = await User.findById(input.target_id);
    if (!target) {
        throw AppError.notFound('User not found', ERROR_CODES.USER_NOT_FOUND);
    }

    if (target.status === USER_STATUSES.DEACTIVATED) {
        return toPublicUser(target);
    }

    const beforeSnapshot = { status: target.status, deactivated_at: target.deactivated_at };

    target.status = USER_STATUSES.DEACTIVATED;
    target.deactivated_at = new Date();
    await target.save();

    await revokeAllRefreshTokens(target._id);

    if (input.audit) {
        await recordAudit(input.audit, {
            action: AUDIT_ACTIONS.USER_DEACTIVATE,
            target: { kind: AUDIT_TARGET_KINDS.USER, id: target._id },
            before: beforeSnapshot,
            after: { status: target.status, deactivated_at: target.deactivated_at },
            metadata: input.reason ? { reason: input.reason } : {},
        });
    }

    return toPublicUser(target);
};

// ─── POST /users/:id/reactivate ────────────────────────────────────────────

export const reactivateUser = async (
    target_id: Types.ObjectId,
    audit?: AuditContext
): Promise<Record<string, unknown>> => {
    const target = await User.findById(target_id);
    if (!target) {
        throw AppError.notFound('User not found', ERROR_CODES.USER_NOT_FOUND);
    }

    if (target.status === USER_STATUSES.ACTIVE) {
        return toPublicUser(target);
    }

    // Single-admin check in case they're being reactivated back into admin role.
    if (target.role === ROLES.ADMIN) {
        await assertSingleAdmin(target._id);
    }

    const beforeSnapshot = { status: target.status, deactivated_at: target.deactivated_at };

    target.status = USER_STATUSES.ACTIVE;
    target.deactivated_at = null;
    await target.save();

    if (audit) {
        await recordAudit(audit, {
            action: AUDIT_ACTIONS.USER_REACTIVATE,
            target: { kind: AUDIT_TARGET_KINDS.USER, id: target._id },
            before: beforeSnapshot,
            after: { status: target.status, deactivated_at: target.deactivated_at },
        });
    }

    return toPublicUser(target);
};

// ─── POST /users/:id/change-role ───────────────────────────────────────────

export const changeUserRole = async (input: {
    target_id: Types.ObjectId;
    caller_id: Types.ObjectId;
    new_role: RoleType;
    audit?: AuditContext;
}): Promise<Record<string, unknown>> => {
    if (input.caller_id.equals(input.target_id)) {
        throw AppError.forbidden('You cannot change your own role');
    }

    const target = await User.findById(input.target_id);
    if (!target) {
        throw AppError.notFound('User not found', ERROR_CODES.USER_NOT_FOUND);
    }

    if (target.role === input.new_role) {
        return toPublicUser(target);
    }

    if (input.new_role === ROLES.ADMIN) {
        await assertSingleAdmin(target._id);
    }

    // Swapping the client/internal axis would leave stale sub-docs; the admin
    // must recreate the profile through PATCH afterwards. Reject for now.
    const goingToClient = input.new_role === ROLES.CLIENT;
    const wasClient = target.role === ROLES.CLIENT;
    if (goingToClient !== wasClient) {
        throw AppError.validation(
            'Cannot change role between client and non-client via this endpoint — ' +
                'deactivate and recreate the user instead.'
        );
    }

    const previousRole = target.role;
    target.role = input.new_role;
    await target.save();

    await revokeAllRefreshTokens(target._id);

    if (input.audit) {
        await recordAudit(input.audit, {
            action: AUDIT_ACTIONS.USER_ROLE_CHANGE,
            target: { kind: AUDIT_TARGET_KINDS.USER, id: target._id },
            before: { role: previousRole },
            after: { role: target.role },
        });
    }

    return toPublicUser(target);
};

// ─── GET /users/assignable ─────────────────────────────────────────────────

export const listAssignable = async (
    query: AssignableQuery
): Promise<Array<{ id: string; full_name: string; role: RoleType; job_title: string | null }>> => {
    const filter: Filter = { status: USER_STATUSES.ACTIVE };
    if (query.role) {
        filter.role = query.role;
    } else {
        // Default: exclude clients from assignee dropdowns.
        filter.role = { $ne: ROLES.CLIENT };
    }

    // TODO (projects slice): when `project_id` is provided, restrict to members
    // of that project. Ignored until the Projects collection ships.
    void query.project_id;

    const rows = await User.find(filter)
        .select('_id full_name role internal_profile.job_title')
        .sort({ full_name: 1 })
        .limit(500);

    return rows.map((u) => ({
        id: u._id.toString(),
        full_name: u.full_name,
        role: u.role,
        job_title: u.internal_profile?.job_title ?? null,
    }));
};
