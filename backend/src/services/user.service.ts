import { Types } from 'mongoose';

// Mongoose 9 no longer exports `FilterQuery<T>` publicly — this loose alias is
// good enough for our needs (shape-only type-check on the caller side).
type Filter = Record<string, unknown>;

import { Company } from '../models/company.model.js';
import { Project } from '../models/project.model.js';
import { User, type UserDocument } from '../models/user.model.js';
import { RefreshToken } from '../models/refresh-token.model.js';
import { AppError } from '../utils/app-error.js';
import { hashPassword } from '../utils/password.js';
import { assertPasswordPolicy } from '../utils/password-policy.js';
import { isAdminLike } from '../utils/role-check.js';
import { ERROR_CODES } from '../constants/error-codes.js';
import { PERMISSIONS } from '../constants/permissions.js';
import { CLIENT_SIDE_ROLES, ROLES, type RoleType } from '../constants/roles.js';
import { PROJECT_COMPANY_SCOPED_ROLES } from '../constants/project.js';
import { EMPLOYMENT_TYPES, USER_STATUSES } from '../constants/user-statuses.js';
import type { PaginationMeta } from '../utils/api-response.js';
import type { AssignableQuery, CreateUserBody, ListUsersQuery, UpdateUserBody } from '../validators/user.validator.js';
import { handOffPendingLeaveReviews } from './leave-reviewer-handoff.service.js';
import { initializeBalancesForUserYear } from './leave-balance.service.js';
import { notifyUserInvited } from './notification-dispatcher.service.js';
import { recordAudit, type AuditContext } from './audit.service.js';
import { withTransaction } from '../utils/with-transaction.js';
import { getSystemRoleByKey } from './role.service.js';
import { AUDIT_ACTIONS, AUDIT_TARGET_KINDS } from '../constants/audit.js';
import dayjs, { DEFAULT_TIMEZONE } from '../utils/date.js';
import { resolveProfilePhotoTtlMinutes, signProfilePhotoUrl } from './profile-photo.service.js';
import { getOrInitSettings } from './settings.service.js';
import { revokeLinksForDeactivatedClient } from './share-link.service.js';

/**
 * User management service (API_Contract §3).
 *
 *  - Single-admin rule enforced at create + change-role.
 *  - Unique email enforced at the DB layer → surfaced as `409 EMAIL_ALREADY_EXISTS`.
 *  - Deactivation / role-change revoke every active refresh token for the user.
 *  - Profile-photo CRUD lives in `profile-photo.service.ts` (Azure Blob via
 *    `utils/azure-blob.ts`).
 *  - Admin-triggered reset-password (`POST /users/:id/reset-password`) lives
 *    in `password-reset.service.adminInitiatePasswordReset` — same flow as
 *    the user-initiated forgot/reset, with the admin as the audit actor.
 */

// ─── Fields that a non-admin caller is allowed to update on their own record.
// Matches API_Contract §3 "PATCH /users/:id (ADM or self for own profile fields)".
const SELF_EDITABLE_FIELDS = new Set([
    'full_name',
    'phone',
    'timezone',
    'slack_user_id',
    'slack_notifications_enabled',
    'email_notifications_enabled',
    // internal_profile is partially self-editable; see `pickSelfInternalProfile`.
    'internal_profile',
]);
const SELF_EDITABLE_INTERNAL_PROFILE_FIELDS = new Set(['emergency_contact']);

// internal_profile fields an employment editor (user.employment_write, e.g.
// manager) may change on OTHER users — employment record only, never identity
// (name/email), role, status, or someone's own emergency contact.
const EMPLOYMENT_PROFILE_FIELDS = new Set([
    'employee_id',
    'job_title',
    'department',
    'date_of_joining',
    // Staff vs Freelancer is an employment fact, so it belongs to the same
    // editor as job title and department — not behind full `user.write`.
    'employment_type',
    'reporting_manager_id',
]);

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Public projection of a user.
 *
 *  - `toJSON` strips sensitive fields via `sensitiveToJSON` on the model.
 *  - `profile_photo_blob_key` is dropped from the public surface (it's an
 *    internal storage pointer); a freshly-minted, time-limited SAS URL
 *    is exposed as `profile_photo_url` instead — `null` when no photo
 *    is set or when Azure isn't configured. The TTL knob is
 *    `system_settings.uploads.sas_token_ttl_minutes`; pass it in via
 *    `photoTtlMinutes` so list endpoints can load settings once and
 *    re-use the value for every row instead of hitting the settings
 *    collection per user.
 */
const toPublicUser = (user: UserDocument, photoTtlMinutes: number): Record<string, unknown> => {
    const json = user.toJSON() as Record<string, unknown>;
    const blobKey = typeof json.profile_photo_blob_key === 'string' ? json.profile_photo_blob_key : null;
    delete json.profile_photo_blob_key;
    json.profile_photo_url = signProfilePhotoUrl(blobKey, photoTtlMinutes);
    return json;
};

/**
 * Resolve the read-SAS TTL once per request, clamped to the safe range.
 * Cheap (single doc lookup) but worth caching across a list page.
 */
const loadPhotoTtlMinutes = async (): Promise<number> => {
    const settings = await getOrInitSettings();
    return resolveProfilePhotoTtlMinutes(settings.uploads.sas_token_ttl_minutes);
};

/**
 * Several active admins are allowed — administration shouldn't bottleneck on
 * one person. What is NOT allowed is removing the last one: an org with zero
 * admins can't manage roles, settings or users again without database access.
 *
 * Called before anything that could take an admin out of the active admin set:
 * deactivating one, or changing their role to something else. `self` is
 * already refused upstream on both paths, so this only ever fires on the
 * "someone demoted the only other admin" case.
 */
const assertNotLastAdmin = async (target: UserDocument): Promise<void> => {
    if (target.role !== ROLES.ADMIN || target.status !== USER_STATUSES.ACTIVE) return;
    const others = await User.exists({
        role: ROLES.ADMIN,
        status: USER_STATUSES.ACTIVE,
        _id: { $ne: target._id },
    });
    if (!others) {
        throw AppError.conflict('This is the last active admin — promote someone else first', ERROR_CODES.LAST_ADMIN);
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
    await assertPasswordPolicy(input.initial_password);

    const emailInUse = await User.exists({ email: input.email });
    if (emailInUse) {
        throw AppError.conflict('Email already exists', ERROR_CODES.EMAIL_ALREADY_EXISTS);
    }

    const password_hash = await hashPassword(input.initial_password);

    const doc: Partial<UserDocument> = {
        email: input.email,
        password_hash,
        full_name: input.full_name,
        // `null` (cleared) and absent both mean "no phone" on create.
        phone: input.phone ?? undefined,
        role: input.role,
        status: USER_STATUSES.ACTIVE,
        created_by,
    };

    if (input.timezone) doc.timezone = input.timezone;
    if (input.slack_user_id) doc.slack_user_id = input.slack_user_id;

    if (input.role === ROLES.CLIENT && input.client_profile) {
        const companyId = new Types.ObjectId(input.client_profile.company_id);
        const companyExists = await Company.exists({ _id: companyId, status: 'active' });
        if (!companyExists) {
            throw AppError.unprocessable(
                'client_profile.company_id must reference an active company',
                ERROR_CODES.VALIDATION_ERROR,
                { company_id: input.client_profile.company_id }
            );
        }
        doc.client_profile = { ...input.client_profile, company_id: companyId };
    } else if (input.internal_profile) {
        const profile = input.internal_profile;
        doc.internal_profile = {
            ...profile,
            reporting_manager_id: profile.reporting_manager_id
                ? new Types.ObjectId(profile.reporting_manager_id)
                : null,
        };
        // 🔴 Drop a blank `employee_id` rather than storing `''`.
        //
        // The unique index on `internal_profile.employee_id` is SPARSE, which
        // skips documents missing the key — but an empty string is a value,
        // not a missing key, so the SECOND freelancer saved with `''` would
        // fail on E11000 duplicate key. Freelancers legitimately have no
        // employee number, so the field must be absent, not empty.
        if (!doc.internal_profile.employee_id) delete doc.internal_profile.employee_id;
    }

    // H1 — user create + leave-balance init are atomic: a balance-init
    // failure rolls back the user too, so we never leave a half-created
    // user that can't apply for leave. Pre-H1 the balance init was
    // best-effort with a warn log, which silently locked new joiners
    // out until an admin re-ran init. Email + audit happen AFTER the
    // tx commits — they're external/logging side effects that
    // shouldn't dictate atomicity.
    const created: UserDocument = await withTransaction(async (session) => {
        // Mongoose's array-form `create([doc], { session })` is
        // the only way to enrol a single-document insert in a
        // transaction (single-doc form ignores the session
        // option). Returns an array; we destructure the one
        // element we asked for.
        //
        // `session` may be null when the topology doesn't support
        // transactions (e.g. local-dev standalone Mongo or test
        // mocks); Mongoose accepts that — it just won't enrol.
        const createOpts = session ? { session } : {};
        const [user] = await User.create([doc], createOpts);
        if (!user) throw new Error('User.create returned no document');

        if (user.role !== ROLES.CLIENT && user.internal_profile?.date_of_joining) {
            const joining = user.internal_profile.date_of_joining;
            const [yStr, mStr] = joining.split('-');
            const joiningYear = Number.parseInt(yStr, 10);
            const joiningMonth = Number.parseInt(mStr, 10);
            // Derive "this year" from the IST business calendar.
            // `getUTCFullYear()` on Jan 1 IST returns last year
            // until UTC catches up 5h30m later — a Jan-1 IST
            // joiner would otherwise be seeded into the wrong year.
            const thisYear = dayjs().tz(DEFAULT_TIMEZONE).year();
            const yearsToInit = new Set<number>([joiningYear, thisYear]);
            for (const year of yearsToInit) {
                await initializeBalancesForUserYear({
                    user_id: user._id,
                    year,
                    joining_year: joiningYear,
                    joining_month: joiningMonth,
                    session: session ?? undefined,
                });
            }
        }
        return user;
    });

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
    const photoTtl = await loadPhotoTtlMinutes();

    if (audit) {
        await recordAudit(audit, {
            action: AUDIT_ACTIONS.USER_CREATE,
            target: { kind: AUDIT_TARGET_KINDS.USER, id: created._id },
            after: toPublicUser(created, photoTtl),
            metadata: { created_role: created.role },
        });
    }

    return toPublicUser(created, photoTtl);
};

// ─── GET /users ────────────────────────────────────────────────────────────

export const listUsers = async (
    query: ListUsersQuery
): Promise<{ data: Record<string, unknown>[]; meta: PaginationMeta }> => {
    const filter: Filter = {};
    if (query.role) filter.role = query.role;
    else if (query.exclude_role?.length) filter.role = { $nin: query.exclude_role };
    if (query.status) filter.status = query.status;
    // BUG-002 — soft-delete UX: hide deactivated users by default.
    // Caller can opt-in via `show_deleted=true` if they hold USER_WRITE
    // (the controller scrubs the flag for non-privileged callers).
    // An explicit `?status=` always wins (e.g. status=deactivated for a
    // permitted caller listing only the soft-deleted bucket).
    else if (!query.show_deleted) filter.status = USER_STATUSES.ACTIVE;
    if (query.employment_type) {
        // `staff` matches "not a freelancer" rather than an equality, because
        // every user created before the field existed has no
        // `internal_profile.employment_type` key at all — an equality match
        // would hide the entire pre-existing workforce from the Staff filter,
        // and a backfill script only fixes the rows that exist on the day it
        // runs. Freelancer stays an equality: it's never the implied default.
        //
        // ponytail: exact only while there are two types. A third value makes
        // `$ne: freelancer` wrong — switch to an explicit `$in` + a backfill
        // at that point.
        filter['internal_profile.employment_type'] =
            query.employment_type === EMPLOYMENT_TYPES.FREELANCER
                ? EMPLOYMENT_TYPES.FREELANCER
                : { $ne: EMPLOYMENT_TYPES.FREELANCER };
    }
    if (query.q) {
        const safe = query.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        filter.$or = [{ email: { $regex: safe, $options: 'i' } }, { full_name: { $regex: safe, $options: 'i' } }];
    }

    const skip = (query.page - 1) * query.limit;
    // BUG-033 — primary sort + `_id` tiebreaker. Without the tiebreaker
    // low-cardinality columns (e.g. `status`) leave rows within a group
    // in arbitrary storage order, which makes the same query return
    // different orderings across page-flips / refresh cycles ("shuffles").
    // Default is alphabetical by name (case-insensitive via the collation
    // below) so the directory reads A→Z out of the box.
    const sortSpec: Record<string, 1 | -1> = query.sort
        ? { [query.sort.field]: query.sort.dir === 'asc' ? 1 : -1, _id: 1 }
        : { full_name: 1, _id: 1 };

    // `strength: 2` = case-insensitive, accent-sensitive — so "alice" and
    // "Bob" order naturally instead of all-uppercase-first (Mongo's default
    // byte sort). Applied to the list query so name/email sorts read right.
    const collation = { locale: 'en', strength: 2 } as const;

    const [rows, total, photoTtl] = await Promise.all([
        User.find(filter).collation(collation).sort(sortSpec).skip(skip).limit(query.limit),
        User.countDocuments(filter).collation(collation),
        loadPhotoTtlMinutes(),
    ]);

    return {
        data: rows.map((u) => toPublicUser(u, photoTtl)),
        meta: {
            page: query.page,
            limit: query.limit,
            total,
            total_pages: Math.max(1, Math.ceil(total / query.limit)),
        },
    };
};

// ─── GET /users/:id ────────────────────────────────────────────────────────

/**
 * Signed photo URLs for the given users — the avatars on one screen. Ids
 * only, no names, and only ids the caller already holds from responses it
 * was allowed to read; users without a photo are simply absent.
 */
export const listUserPhotos = async (
    ids: string[]
): Promise<{ ttl_minutes: number; data: Array<{ id: string; profile_photo_url: string }> }> => {
    const ttl = await loadPhotoTtlMinutes();
    const rows = await User.find({
        _id: { $in: ids.map((id) => new Types.ObjectId(id)) },
        profile_photo_blob_key: { $nin: [null, ''] },
    })
        .select('_id profile_photo_blob_key')
        .lean<Array<{ _id: Types.ObjectId; profile_photo_blob_key: string }>>();
    const data = rows.flatMap((u) => {
        const url = signProfilePhotoUrl(u.profile_photo_blob_key, ttl);
        return url ? [{ id: String(u._id), profile_photo_url: url }] : [];
    });
    return { ttl_minutes: ttl, data };
};

export const getUser = async (id: Types.ObjectId): Promise<Record<string, unknown>> => {
    const user = await User.findById(id);
    if (!user) {
        throw AppError.notFound('User not found', ERROR_CODES.USER_NOT_FOUND);
    }
    return toPublicUser(user, await loadPhotoTtlMinutes());
};

// ─── PATCH /users/:id ──────────────────────────────────────────────────────

/**
 * Authorization:
 *   - Admin caller → may patch any field for any user.
 *   - Self caller  → may only patch fields in SELF_EDITABLE_FIELDS, and within
 *     `internal_profile` only `emergency_contact`.
 *   - Any other caller → already rejected at the route layer via `requirePermission`.
 */
export const updateUser = async (input: {
    target_id: Types.ObjectId;
    caller_id: Types.ObjectId;
    caller_role: RoleType;
    /**
     * Step-47 RBAC signal — controllers pass `req.user.role_keys`. R4
     * fix: a multi-role admin whose legacy `role` cache is `'manager'`
     * is still recognised as admin via `role_keys.includes('admin')`.
     */
    caller_role_keys?: readonly string[];
    /** Resolved permission set of the caller — used to grant employment-only editors. */
    caller_permissions?: readonly string[];
    patch: UpdateUserBody;
}): Promise<Record<string, unknown>> => {
    const target = await User.findById(input.target_id);
    if (!target) {
        throw AppError.notFound('User not found', ERROR_CODES.USER_NOT_FOUND);
    }

    const isAdmin = isAdminLike({ role: input.caller_role, role_keys: input.caller_role_keys });
    const isSelf = input.caller_id.equals(target._id);
    const callerPerms = input.caller_permissions ?? [];
    // An "employment editor" (manager) may edit other users' employment data
    // only. `user.write` holders implicitly qualify (admins go through the
    // isAdmin fast-path, so this only matters for non-admin user.write).
    const canEditEmployment =
        callerPerms.includes(PERMISSIONS.USER_EMPLOYMENT_WRITE) || callerPerms.includes(PERMISSIONS.USER_WRITE);

    if (!isAdmin && !isSelf && !canEditEmployment) {
        throw AppError.forbidden();
    }

    let patch = { ...input.patch };
    if (!isAdmin) {
        if (isSelf) {
            // Self-scope: strip disallowed top-level + nested fields.
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
        } else {
            // Employment editor on another user: keep ONLY the internal_profile
            // employment fields; drop identity/role/status and everything else.
            const employment = patch.internal_profile
                ? Object.fromEntries(
                      Object.entries(patch.internal_profile).filter(([k]) => EMPLOYMENT_PROFILE_FIELDS.has(k))
                  )
                : undefined;
            patch = (
                employment && Object.keys(employment).length > 0 ? { internal_profile: employment } : {}
            ) as UpdateUserBody;
        }

        if (Object.keys(patch).length === 0) {
            throw AppError.forbidden("You don't have permission to edit any of these fields.");
        }
    }

    // Role consistency: can't add internal_profile to a client or vice versa.
    // Both client-side roles (company-level client and project-scoped representative) carry a client profile.
    const clientSide = CLIENT_SIDE_ROLES.includes(target.role);
    if (patch.internal_profile && clientSide) {
        throw AppError.validation("An internal profile doesn't apply to client accounts.");
    }
    if (patch.client_profile && !clientSide) {
        throw AppError.validation('A client profile only applies to client accounts.');
    }

    // Apply shallow merges for sub-docs so unset fields remain. The validator
    // gives `reporting_manager_id` as a hex string; coerce to ObjectId here.
    // Captured BEFORE the merge below overwrites it — the hand-off needs to
    // know which manager is being replaced.
    const previousManagerId: Types.ObjectId | null = target.internal_profile?.reporting_manager_id ?? null;
    let reportingManagerChanged = false;

    if (patch.internal_profile) {
        const coerced: Record<string, unknown> = { ...patch.internal_profile };
        // `null` on a staff-only field means CLEAR it — the freelancer switch.
        // Deleting the key (rather than writing null) matters for
        // `employee_id`: its unique index is sparse, so an absent key is
        // skipped while a stored null/'' would collide across freelancers.
        for (const field of ['employee_id', 'job_title', 'department', 'date_of_joining'] as const) {
            if (field in coerced && !coerced[field]) {
                delete coerced[field];
                target.set(`internal_profile.${field}`, undefined);
            }
        }
        if ('reporting_manager_id' in coerced) {
            const raw = coerced.reporting_manager_id;
            coerced.reporting_manager_id = typeof raw === 'string' ? new Types.ObjectId(raw) : raw;
            reportingManagerChanged = String(coerced.reporting_manager_id ?? '') !== String(previousManagerId ?? '');
        }
        target.internal_profile = target.internal_profile
            ? ({ ...target.internal_profile, ...coerced } as unknown as UserDocument['internal_profile'])
            : (coerced as unknown as UserDocument['internal_profile']);
    }

    if (patch.client_profile) {
        // `company_id` arrives as a wire string; the schema stores an
        // ObjectId. Coerce here rather than letting Mongoose cast, so a
        // merge with the existing sub-doc doesn't mix the two types.
        const patched = {
            ...patch.client_profile,
            ...(patch.client_profile.company_id
                ? { company_id: new Types.ObjectId(patch.client_profile.company_id) }
                : {}),
        };
        target.client_profile = (target.client_profile
            ? { ...target.client_profile, ...patched }
            : patched) as unknown as UserDocument['client_profile'];
    }

    if (patch.full_name !== undefined) target.full_name = patch.full_name;
    // `null` is an explicit clear — `undefined` unsets the path on save,
    // where leaving the key out would keep the old number. Absent means the
    // patch never mentioned phone, so the stored value stands.
    if (patch.phone !== undefined) target.phone = patch.phone ?? undefined;
    if (patch.timezone !== undefined) target.timezone = patch.timezone;
    if (patch.slack_user_id !== undefined) target.slack_user_id = patch.slack_user_id;
    if (patch.email_notifications_enabled !== undefined) {
        target.email_notifications_enabled = patch.email_notifications_enabled;
    }
    if (patch.slack_notifications_enabled !== undefined) {
        target.slack_notifications_enabled = patch.slack_notifications_enabled;
    }

    await target.save();

    // Reporting line moved → move the pending leave reviews with it. The
    // approvals queue already follows the change on its own (it's computed
    // live), but the notifications were written at apply time and never
    // revisited: the old manager kept an unread prompt they can no longer act
    // on, and the new manager was never told the requests had become theirs.
    // Fire-and-forget — a profile edit must not fail on a notification.
    if (reportingManagerChanged) {
        void handOffPendingLeaveReviews({
            userId: target._id,
            previousManagerId,
            nextManagerId: target.internal_profile?.reporting_manager_id ?? null,
        });
    }

    return toPublicUser(target, await loadPhotoTtlMinutes());
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
        return toPublicUser(target, await loadPhotoTtlMinutes());
    }

    await assertNotLastAdmin(target);

    const beforeSnapshot = { status: target.status, deactivated_at: target.deactivated_at };

    target.status = USER_STATUSES.DEACTIVATED;
    target.deactivated_at = new Date();
    // `validateModifiedOnly` — deactivation only flips `status` /
    // `deactivated_at`. Without this, Mongoose re-validates the WHOLE
    // document, so a user carrying a legacy `extra_permissions` entry no
    // longer in `PERMISSION_VALUES` (catalog churn, pre-migration data)
    // makes the save throw a VALIDATION_ERROR about a field we never
    // touched — surfacing a baffling "Validation failed" toast to the
    // admin. Validate only what changed.
    await target.save({ validateModifiedOnly: true });

    await revokeAllRefreshTokens(target._id);

    // Step-24 cascade: a deactivated client can no longer log in, but
    // any share links they were the named owner of are still publicly
    // resolvable until revoked. Fan-out revoke before the audit fires
    // so the audit row's metadata can reflect the count and the cascade
    // is bundled with the deactivation in the timeline.
    let shareLinksRevoked = 0;
    if (target.role === ROLES.CLIENT) {
        const result = await revokeLinksForDeactivatedClient({
            client_id: target._id,
            revoked_by: input.caller_id,
            audit: input.audit,
        });
        shareLinksRevoked = result.revoked_count;
    }

    if (input.audit) {
        const metadata: Record<string, unknown> = {};
        if (input.reason) metadata.reason = input.reason;
        if (target.role === ROLES.CLIENT) metadata.share_links_revoked = shareLinksRevoked;
        await recordAudit(input.audit, {
            action: AUDIT_ACTIONS.USER_DEACTIVATE,
            target: { kind: AUDIT_TARGET_KINDS.USER, id: target._id },
            before: beforeSnapshot,
            after: { status: target.status, deactivated_at: target.deactivated_at },
            metadata,
        });
    }

    return toPublicUser(target, await loadPhotoTtlMinutes());
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
        return toPublicUser(target, await loadPhotoTtlMinutes());
    }

    const beforeSnapshot = { status: target.status, deactivated_at: target.deactivated_at };

    target.status = USER_STATUSES.ACTIVE;
    target.deactivated_at = null;
    // Symmetric with deactivate — validate only the changed status fields so a
    // stale `extra_permissions` entry can't block the flip.
    await target.save({ validateModifiedOnly: true });

    if (audit) {
        await recordAudit(audit, {
            action: AUDIT_ACTIONS.USER_REACTIVATE,
            target: { kind: AUDIT_TARGET_KINDS.USER, id: target._id },
            before: beforeSnapshot,
            after: { status: target.status, deactivated_at: target.deactivated_at },
        });
    }

    return toPublicUser(target, await loadPhotoTtlMinutes());
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
        return toPublicUser(target, await loadPhotoTtlMinutes());
    }

    // Promoting into admin is unrestricted now; demoting the last one is not.
    if (target.role === ROLES.ADMIN && input.new_role !== ROLES.ADMIN) {
        await assertNotLastAdmin(target);
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
    const previousRoleIds = target.role_ids.map((id) => id.toString());
    target.role = input.new_role;

    // Step 47: keep `role_ids` in lockstep with the legacy `role`
    // string. Without this, the legacy endpoint leaves a user with
    // `role = 'manager'` but `role_ids = [employee_role_id]` —
    // requirePermission then 403s every privileged route because the
    // resolved permission union is the OLD role's set. Resetting to a
    // single-element array containing the new role's system doc keeps
    // both paths consistent. A user assigned multiple custom roles
    // should be updated via `PATCH /users/:user_id/roles` instead;
    // this legacy endpoint is single-role-only.
    const newSystemRole = await getSystemRoleByKey(input.new_role);
    if (newSystemRole) {
        target.role_ids = [newSystemRole._id];
    }

    await target.save();

    // Deliberately do NOT revoke the target's refresh tokens here. The
    // change-role dialog promises "Sessions are not revoked", and the FE
    // self-heals: `useAuthMe` re-resolves DB-fresh permissions and, on drift
    // from the JWT, rotates the access token in place (see queries.ts) — so
    // the new role takes effect in the target's active session within a
    // couple of minutes WITHOUT logging them out. Revoking here would break
    // that rotation (it would fail against the dead tokens), stranding the
    // user with a fresh-looking UI but a stale JWT until the 8h access token
    // expired — and that's slower than the drift-heal even for a downgrade.
    // Deactivation (which DOES revoke) remains the path for killing sessions.

    if (input.audit) {
        await recordAudit(input.audit, {
            action: AUDIT_ACTIONS.USER_ROLE_CHANGE,
            target: { kind: AUDIT_TARGET_KINDS.USER, id: target._id },
            before: { role: previousRole, role_ids: previousRoleIds },
            after: {
                role: target.role,
                role_ids: target.role_ids.map((id) => id.toString()),
            },
        });
    }

    return toPublicUser(target, await loadPhotoTtlMinutes());
};

// ─── GET /users/assignable ─────────────────────────────────────────────────

/**
 * C6 — Pre-fix this returned the full non-client user directory (up to
 * 500 active users) to any authenticated caller — CLIENT-role users
 * included. Post-fix: `project_id` is required (validator level) and
 * the caller MUST have read access to that project before we return
 * its members.
 *
 * Visibility rules mirror `project.service.assertCallerCanRead`:
 *   - admin / manager: all projects
 *   - team lead / employee: only projects they're a `member_ids[]` of
 *   - client (company-level): any project of their company (`company_id`)
 *   - representative: only projects they're a `representative_ids[]` of
 *
 * Unknown project_id → 404 (the validator already rejected non-ObjectId
 * inputs, so this only fires when the project genuinely doesn't exist
 * or has been hard-deleted).
 */
export const listAssignable = async (
    query: AssignableQuery,
    caller: { id: Types.ObjectId; role: RoleType; company_id?: Types.ObjectId }
): Promise<Array<{ id: string; full_name: string; role: RoleType; job_title: string | null }>> => {
    // `.lean()` does NOT apply Mongoose schema defaults, so a document
    // predating the company migration can come back with `representative_ids`
    // absent entirely. Typed optional and defaulted below — `.some()` on
    // undefined is a 500, not merely a wrong answer.
    const project = await Project.findById(query.project_id).select('member_ids company_id representative_ids').lean<{
        member_ids?: Types.ObjectId[];
        company_id?: Types.ObjectId | null;
        representative_ids?: Types.ObjectId[];
    } | null>();
    if (!project) {
        throw AppError.notFound('Project not found', ERROR_CODES.RESOURCE_NOT_FOUND);
    }

    const memberIds = project.member_ids ?? [];
    const representativeIds = project.representative_ids ?? [];

    // Access check — mirrors `project.service.assertCallerCanRead`.
    const isAdminLike = caller.role === ROLES.ADMIN || caller.role === ROLES.MANAGER;
    const inMembers = memberIds.some((u) => u.equals(caller.id));
    // A `client` is company-scoped, not roster-scoped: they can read a
    // project of their company without appearing on its roster.
    const isCompanyScoped =
        PROJECT_COMPANY_SCOPED_ROLES.includes(caller.role) &&
        Boolean(caller.company_id) &&
        Boolean(project.company_id) &&
        project.company_id!.equals(caller.company_id!);
    const inRepresentatives = representativeIds.some((u) => u.equals(caller.id));
    if (!isAdminLike && !inMembers && !isCompanyScoped && !inRepresentatives) {
        throw AppError.forbidden('You do not have access to this project', ERROR_CODES.FORBIDDEN);
    }

    const filter: Filter = {
        status: USER_STATUSES.ACTIVE,
        _id: { $in: memberIds },
    };
    if (query.role) {
        filter.role = query.role;
    } else {
        // Default: exclude clients from assignee dropdowns.
        filter.role = { $ne: ROLES.CLIENT };
    }

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

/**
 * Batch-read cached Slack avatar URLs for a set of user ids — used by the
 * Slack Home dashboard to attach avatars to who's-out / pending rows without
 * any Slack API calls at render time.
 */
export const getSlackAvatarUrlsByIds = async (ids: Types.ObjectId[]): Promise<Map<string, string | null>> => {
    if (ids.length === 0) return new Map();
    const rows = await User.find({ _id: { $in: ids } })
        .select('_id slack_avatar_url')
        .lean<{ _id: Types.ObjectId; slack_avatar_url: string | null }[]>();
    return new Map(rows.map((r) => [r._id.toString(), r.slack_avatar_url ?? null]));
};
