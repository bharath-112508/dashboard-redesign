import { Types } from 'mongoose';

import { Role, type RoleDocument } from '../models/role.model.js';
import { User } from '../models/user.model.js';
import { SYSTEM_ROLE_DEFINITIONS } from '../constants/system-role-definitions.js';
import { SYSTEM_ROLE_KEYS, type SystemRoleKey } from '../constants/role-keys.js';
import { PERMISSIONS, type Permission } from '../constants/permissions.js';
import { ERROR_CODES } from '../constants/error-codes.js';
import { AUDIT_ACTIONS, AUDIT_TARGET_KINDS } from '../constants/audit.js';
import { AppError } from '../utils/app-error.js';
import { notifyRoleChanged } from './notification-dispatcher.service.js';
import { recordAudit, type AuditContext } from './audit.service.js';
import type {
    AssignRolesBody,
    CreateRoleBody,
    ListRolesQuery,
    PatchRoleBody,
    UpdateExtraPermissionsBody,
} from '../validators/role.validator.js';
import logger from '../utils/logger.js';

/**
 * Role service (Phase 4 Step 47 — all phases).
 *
 *  1. **System-role seeder** — `seedSystemRoles()` upserts the six
 *     pre-defined system roles from `SYSTEM_ROLE_DEFINITIONS`.
 *     Idempotent: re-running on an already-seeded DB is a no-op.
 *     Called from the boot path AND lazily from the bootstrap-
 *     migration path so a fresh-DB integration test doesn't need
 *     a separate setup step.
 *  2. **System-role lookup** — `getSystemRoleByKey(key)` returns the
 *     role document for one of the six system roles, seeding on the
 *     fly if missing (race-safe via the unique-key index). Used by
 *     `auth.service.login` to translate the legacy `users.role`
 *     string into a `role_ids` array, and by the bootstrap migration.
 *  3. **Permission resolution** — `resolvePermissionsForUser(user_id)`
 *     reads the user's `role_ids`, joins to roles, returns the
 *     deduped union of `permissions[]`. Called once per login so the
 *     resulting JWT carries the resolved set.
 *  4. **Bootstrap migration** — `bootstrapRolesMigration()` runs on
 *     boot, seeding system roles + back-assigning `role_ids` to any
 *     pre-Step-47 users still carrying only the legacy `role` string.
 *  5. **Custom-role CRUD** (Phase C) — `createCustomRole`,
 *     `listRoles`, `getRole`, `updateRole`, `deleteRole`. System-role
 *     immutability + `system.admin` wildcard rejection + in-use guard
 *     are enforced here, not at the model layer (so error codes are
 *     stable + auditable).
 *  6. **User-role assignment** (Phase C) — `assignRolesToUser`
 *     replaces a user's `role_ids` array and syncs the legacy `role`
 *     cache when the new primary role's key matches the legacy enum.
 */

// ─── Seeder ────────────────────────────────────────────────────────────

let systemSeedPromise: Promise<void> | null = null;

/**
 * Idempotently seed the five system roles. Concurrent callers share
 * a single in-flight promise so two parallel `getSystemRoleByKey`
 * calls during a cold start don't duplicate-write.
 */
export const seedSystemRoles = async (): Promise<void> => {
    if (systemSeedPromise) return systemSeedPromise;
    systemSeedPromise = (async () => {
        for (const def of SYSTEM_ROLE_DEFINITIONS) {
            try {
                await Role.updateOne(
                    { key: def.key },
                    {
                        $setOnInsert: {
                            key: def.key,
                            is_system: true,
                            created_by: null,
                        },
                        $set: {
                            display_name: def.display_name,
                            description: def.description,
                            // We DO update `permissions` on every seed run so
                            // adding a new permission to `SYSTEM_ROLE_DEFINITIONS`
                            // takes effect on next boot without a manual migration.
                            // Customer-amended overrides on system roles (Phase B
                            // PATCH) live alongside the defaults — operators who
                            // tune a system role's permissions accept that the
                            // next code-deploy may re-tune them. Document.
                            permissions: def.permissions,
                            updated_by: null,
                        },
                    },
                    { upsert: true }
                );
            } catch (err) {
                logger.warn({ err, role_key: def.key }, 'System role seed write failed; will retry on next call');
                // Don't propagate — one bad role shouldn't block the rest of
                // the seed (or the boot path that called us).
            }
        }
    })();
    try {
        await systemSeedPromise;
    } finally {
        // Clear the cached promise so a subsequent failure-recovery call
        // re-runs the seed instead of returning the cached resolved value.
        // (If the seed succeeded, re-running it is still idempotent.)
        systemSeedPromise = null;
    }
};

// ─── Redesign: the DevOps engineer role ─────────────────────────────────

/** A custom role: a DevOps engineer is a staff member (employee) who also holds this key. */
export const DEVOPS_ROLE_KEY = 'devops';

/** Creates the `devops` custom role with the employee permissions if it is missing; never overwrites it. */
export const ensureDevopsRole = async (): Promise<void> => {
    const employee = SYSTEM_ROLE_DEFINITIONS.find((d) => d.key === 'employee');
    await Role.updateOne(
        { key: DEVOPS_ROLE_KEY },
        {
            $setOnInsert: {
                key: DEVOPS_ROLE_KEY,
                is_system: false,
                display_name: 'DevOps engineer',
                description: 'Staff who run deployments and infrastructure (redesign).',
                permissions: employee?.permissions ?? [],
                created_by: null,
                updated_by: null,
            },
        },
        { upsert: true }
    );
};

/** Role id → key, for showing people's roles in a list. */
export const roleKeysByIds = async (ids: Types.ObjectId[]): Promise<Map<string, string>> => {
    if (!ids.length) return new Map();
    const roles = await Role.find({ _id: { $in: ids } })
        .select('_id key')
        .lean<{ _id: Types.ObjectId; key: string }[]>();
    return new Map(roles.map((r) => [r._id.toString(), r.key]));
};

// ─── System-role lookup ────────────────────────────────────────────────

/**
 * Resolve a system role by its key. If missing, seeds first, then
 * looks up. Used by `auth.service` to translate the legacy
 * `users.role` field into a `role_ids` array on login + by the
 * bootstrap migration to backfill existing users.
 */
export const getSystemRoleByKey = async (key: SystemRoleKey): Promise<RoleDocument | null> => {
    let role = await Role.findOne({ key });
    if (role) return role;
    // Seed and retry — covers the cold-start case where the boot
    // hook hasn't run yet (e.g. a vitest harness that imports the
    // service directly).
    await seedSystemRoles();
    role = await Role.findOne({ key });
    return role;
};

// ─── Permission resolution ─────────────────────────────────────────────

export interface ResolvedPermissions {
    role_keys: string[];
    permissions: Permission[];
}

/**
 * Resolve the (role_keys, permissions) tuple for a given user, used
 * by `auth.service.login` to populate the JWT and by future role-
 * change paths to refresh the cached set.
 *
 * Permission union order (each step deduped against the prior):
 *  1. Every assigned role's `permissions[]` (Pattern A)
 *  2. The user's `extra_permissions[]` (Pattern B — Step 47 follow-up)
 *
 * Empty `role_keys` is allowed (a brand-new user pre-bootstrap-
 * migration); the auth layer upstream rejects empty-permission JWTs
 * from doing anything substantive. A user with `role_ids: []` but
 * non-empty `extra_permissions` would still get a permissions array
 * here — `requirePermission` is the gate, and an admin who grants
 * `extra_permissions` to an otherwise-roleless user is opting into
 * exactly that.
 */
export const resolvePermissionsForUser = async (userId: Types.ObjectId): Promise<ResolvedPermissions> => {
    const user = await User.findById(userId)
        .select('role_ids extra_permissions')
        .lean<{ role_ids: Types.ObjectId[]; extra_permissions?: string[] } | null>();
    if (!user) return { role_keys: [], permissions: [] };

    const extras = (user.extra_permissions ?? []) as Permission[];

    // Fast path: no roles AND no extras → empty result, skip the role
    // join entirely.
    if (user.role_ids.length === 0 && extras.length === 0) {
        return { role_keys: [], permissions: [] };
    }

    const permSet = new Set<Permission>();
    let role_keys: string[] = [];

    if (user.role_ids.length > 0) {
        const roles = await Role.find({ _id: { $in: user.role_ids } })
            .select('key permissions')
            .lean<{ key: string; permissions: Permission[] }[]>();
        role_keys = roles.map((r) => r.key);
        for (const r of roles) {
            for (const p of r.permissions) permSet.add(p);
        }
    }

    for (const p of extras) permSet.add(p);

    return { role_keys, permissions: Array.from(permSet) };
};

// ─── Helper for bootstrap migration + auth.service back-compat ─────────

/**
 * Best-effort: ensure a user's `role_ids` array contains the system
 * role matching their legacy `role` string. Used by the bootstrap
 * migration on first boot and by `auth.service.login` as a self-
 * heal — if a user logs in with `role_ids: []` (legacy data not yet
 * migrated), we backfill on the fly.
 *
 * Idempotent: a user whose `role_ids` already includes the matching
 * system role gets a no-op update.
 */
export const ensureLegacyRoleAssigned = async (userId: Types.ObjectId, legacyRole: SystemRoleKey): Promise<void> => {
    const role = await getSystemRoleByKey(legacyRole);
    if (!role) {
        logger.warn(
            { user_id: userId.toString(), legacy_role: legacyRole },
            'Cannot back-assign legacy role: system role not found'
        );
        return;
    }
    await User.updateOne({ _id: userId, role_ids: { $ne: role._id } }, { $addToSet: { role_ids: role._id } });
};

// ─── Bootstrap migration ───────────────────────────────────────────────

/**
 * Boot-time migration: ensure the five system roles exist AND every
 * legacy user (`role_ids: []`) has their legacy `role` string mapped
 * onto a `role_ids` entry.
 *
 * Idempotent. Safe to run on every boot — already-migrated users get a
 * single indexed read each. Designed to be a no-op on a fresh-DB
 * deployment (no users yet, but the system roles still get seeded).
 *
 * The lazy on-login self-heal in `auth.service.resolveAuthContext`
 * covers the edge case where a user logs in BEFORE this migration
 * has finished (e.g. a request lands during boot); this batch path
 * is the eager catch-all so admin views, audits, and reports don't
 * depend on every user having logged in once.
 */
export const bootstrapRolesMigration = async (): Promise<{ seeded: true; backfilled: number }> => {
    await seedSystemRoles();

    // Read minimal fields. The legacy `role` string is what we map
    // from; `role_ids: { $size: 0 }` filters to users who haven't
    // been migrated yet.
    const legacyUsers = await User.find({ role_ids: { $size: 0 } })
        .select('_id role')
        .lean<{ _id: Types.ObjectId; role: string }[]>();

    let backfilled = 0;
    for (const u of legacyUsers) {
        // Guard: a user whose legacy `role` doesn't map to a system
        // role (shouldn't happen — `users.role` is enum-validated)
        // gets skipped with a warning. The on-login resolver will
        // 403-equivalent until an admin fixes the row by hand.
        if (!systemKeyValues.has(u.role)) {
            logger.warn(
                { user_id: u._id.toString(), legacy_role: u.role },
                'Bootstrap migration: user has unknown legacy role, skipping'
            );
            continue;
        }
        await ensureLegacyRoleAssigned(u._id, u.role as SystemRoleKey);
        backfilled += 1;
    }

    if (backfilled > 0) {
        logger.info({ backfilled }, 'Bootstrap migration: back-assigned role_ids on legacy users');
    }

    return { seeded: true, backfilled };
};

const systemKeyValues = new Set<string>(Object.values(SYSTEM_ROLE_KEYS));

// ─── Phase C: custom-role CRUD + user assignment ───────────────────────

/**
 * Convert a `RoleDocument` (or its `.lean()` counterpart) into the
 * public JSON shape returned by every role endpoint.
 */
const toPublicRole = (doc: {
    _id: Types.ObjectId;
    key: string;
    display_name: string;
    description: string;
    permissions: Permission[];
    is_system: boolean;
    created_by: Types.ObjectId | null;
    updated_by: Types.ObjectId | null;
    created_at: Date;
    updated_at: Date;
}): Record<string, unknown> => ({
    id: doc._id.toString(),
    key: doc.key,
    display_name: doc.display_name,
    description: doc.description,
    permissions: doc.permissions,
    is_system: doc.is_system,
    created_by: doc.created_by ? doc.created_by.toString() : null,
    updated_by: doc.updated_by ? doc.updated_by.toString() : null,
    created_at: doc.created_at,
    updated_at: doc.updated_at,
});

/**
 * Reject the `system.admin` wildcard in the supplied permission list.
 * Only the seeded Admin role holds it; granting it to any other role
 * (system OR custom) would silently bypass every `requirePermission`
 * check, which is the entire reason the wildcard exists in the first
 * place.
 *
 * Returns nothing on success; throws `ROLE_INVALID_PERMISSIONS` (422)
 * if the wildcard is present.
 */
const assertNoWildcard = (perms: readonly Permission[]): void => {
    if (perms.includes(PERMISSIONS.SYSTEM_ADMIN)) {
        throw AppError.unprocessable(
            'The `system.admin` wildcard cannot be granted to user-defined roles. ' +
                'Only the seeded Admin system role holds it.',
            ERROR_CODES.ROLE_INVALID_PERMISSIONS
        );
    }
};

const isDuplicateKeyError = (err: unknown): boolean =>
    err instanceof Error && 'code' in err && (err as { code: number }).code === 11000;

/**
 * Slugify a role's display name into a valid role key: lowercase, non-
 * alphanumeric runs collapsed to `_`, trimmed, guaranteed to start with a
 * letter (the model regex requires it) and capped at the 40-char limit.
 * Falls back to `role` for a name with no usable characters (e.g. "!!!").
 */
export const slugifyRoleKey = (displayName: string): string => {
    let base = displayName
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_') // non-alphanumeric runs → underscore
        .replace(/^[_-]+|[_-]+$/g, ''); // trim leading/trailing separators
    // The key regex requires a leading letter; prefix if it starts with a digit.
    if (!/^[a-z]/.test(base)) base = base ? `role_${base}` : 'role';
    // Cap at 40 chars, then re-trim any separator left dangling at the cut.
    base = base.slice(0, 40).replace(/[_-]+$/g, '');
    return base || 'role';
};

/**
 * Derive a role key from `display_name` that doesn't collide with any
 * existing role (system or custom). On a clash the base slug is suffixed
 * `-2`, `-3`, … (respecting the 40-char cap). A pre-write query can still
 * race two concurrent creates, so the create path also retries on the
 * unique-index `E11000` — this just keeps the common case suffix-clean.
 */
export const generateUniqueRoleKey = async (displayName: string): Promise<string> => {
    const base = slugifyRoleKey(displayName);
    const rows = await Role.find({}).select('key').lean<{ key: string }[]>();
    const taken = new Set(rows.map((r) => r.key));
    if (!taken.has(base)) return base;
    for (let i = 2; i < 1000; i++) {
        const suffix = `-${i}`;
        const trimmed = base.slice(0, 40 - suffix.length).replace(/[_-]+$/g, '');
        const candidate = `${trimmed}${suffix}`;
        if (!taken.has(candidate)) return candidate;
    }
    // Practically unreachable (999 same-named roles); let the unique index catch it.
    return `${base.slice(0, 36)}-${taken.size}`;
};

/**
 * `POST /roles` — admin creates a custom role.
 *
 * Custom roles are non-system by construction: `is_system: false`. The
 * `key` is normally auto-derived from `display_name` (the UI doesn't ask
 * for it); an explicit `input.key` is honoured when supplied. Either way
 * the unique-`key` index is the source of truth for collisions — we map
 * `E11000` to `DUPLICATE_RESOURCE`, and for a generated key we retry with
 * a fresh suffix so a create-race resolves itself instead of erroring.
 */
export const createCustomRole = async (
    input: CreateRoleBody,
    actor_id: Types.ObjectId,
    audit?: AuditContext
): Promise<Record<string, unknown>> => {
    assertNoWildcard(input.permissions);

    const MAX_ATTEMPTS = 5;
    let doc: RoleDocument | undefined;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const key = input.key ?? (await generateUniqueRoleKey(input.display_name));
        try {
            doc = await Role.create({
                key,
                display_name: input.display_name,
                description: input.description,
                permissions: input.permissions,
                is_system: false,
                created_by: actor_id,
                updated_by: actor_id,
            });
            break;
        } catch (err) {
            if (isDuplicateKeyError(err)) {
                // An explicit key that clashes is a user error — surface it.
                // A generated key that raced another create just retries.
                if (input.key) {
                    throw AppError.conflict(`Role key "${input.key}" already exists`, ERROR_CODES.DUPLICATE_RESOURCE);
                }
                continue;
            }
            throw err;
        }
    }

    if (!doc) {
        throw AppError.conflict(
            'Could not generate a unique role key — please try again',
            ERROR_CODES.DUPLICATE_RESOURCE
        );
    }

    if (audit) {
        await recordAudit(audit, {
            action: AUDIT_ACTIONS.ROLE_CREATE,
            target: { kind: AUDIT_TARGET_KINDS.ROLE, id: doc._id },
            metadata: { key: doc.key, permission_count: doc.permissions.length },
            after: toPublicRole(doc),
        });
    }

    return toPublicRole(doc);
};

/**
 * `GET /roles` — list every role. Optional `is_system` filter.
 * No pagination — the cap is small (5 system roles + however many
 * custom roles an admin defines, typically < 20).
 */
export const listRoles = async (query: ListRolesQuery): Promise<{ data: Record<string, unknown>[] }> => {
    const filter: Record<string, unknown> = {};
    if (query.is_system !== undefined) filter.is_system = query.is_system;

    const docs = await Role.find(filter).sort({ is_system: -1, key: 1 }).lean<RoleDocument[]>();
    return { data: docs.map(toPublicRole) };
};

/**
 * `GET /roles/:id` — single-role detail.
 */
export const getRole = async (id: Types.ObjectId): Promise<Record<string, unknown>> => {
    const doc = await Role.findById(id).lean<RoleDocument | null>();
    if (!doc) throw AppError.notFound('Role not found', ERROR_CODES.ROLE_NOT_FOUND);
    return toPublicRole(doc);
};

/**
 * `PATCH /roles/:id`.
 *
 * Three layers of protection on system roles:
 *  - `key` and `is_system` are unconditionally locked (the validator
 *    doesn't accept either field, but defence-in-depth check here).
 *  - `display_name`, `description`, and `permissions` MAY be patched
 *    on system roles — operators can broaden / narrow what a system
 *    role grants without forking the role-key namespace. The boot
 *    seeder will reconcile permissions on next deploy unless the
 *    operator wants to keep the override (in which case they need to
 *    edit `system-role-definitions.ts` to match).
 *  - Custom roles are fully patchable (within the same field
 *    allowlist).
 *
 * `system.admin` wildcard is rejected on patch for any role except
 * the seeded Admin (which already holds it; we don't strip it).
 */
export const updateRole = async (
    id: Types.ObjectId,
    input: PatchRoleBody,
    actor_id: Types.ObjectId,
    audit?: AuditContext
): Promise<Record<string, unknown>> => {
    const before = await Role.findById(id);
    if (!before) throw AppError.notFound('Role not found', ERROR_CODES.ROLE_NOT_FOUND);

    if (input.permissions !== undefined) {
        if (before.key === SYSTEM_ROLE_KEYS.ADMIN) {
            // Lockout-prevention: an admin who patches the Admin role
            // and forgets to include `system.admin` would strip the
            // wildcard, leaving the system with no working admin until
            // the next boot (when the seeder re-applies it). Force the
            // wildcard back in instead of failing — this is purely
            // additive, since the wildcard already grants everything.
            // Also reject the *removal* path explicitly via the comment
            // path: if an operator wants to REDUCE Admin's permission
            // set, they edit `system-role-definitions.ts` and redeploy.
            if (!input.permissions.includes(PERMISSIONS.SYSTEM_ADMIN)) {
                throw AppError.unprocessable(
                    'The seeded Admin role must retain the `system.admin` wildcard. ' +
                        'To narrow Admin grants, edit `system-role-definitions.ts` and redeploy.',
                    ERROR_CODES.ROLE_INVALID_PERMISSIONS
                );
            }
        } else {
            // Any role OTHER than the seeded Admin (system or custom)
            // cannot be granted the wildcard. The check is symmetric
            // with `createCustomRole`.
            assertNoWildcard(input.permissions);
        }
    }

    const set: Record<string, unknown> = { updated_by: actor_id };
    if (input.display_name !== undefined) set.display_name = input.display_name;
    if (input.description !== undefined) set.description = input.description;
    if (input.permissions !== undefined) set.permissions = input.permissions;

    const after = await Role.findByIdAndUpdate(id, { $set: set }, { new: true, runValidators: true });
    if (!after) {
        // Concurrent delete between findById + findByIdAndUpdate.
        throw AppError.notFound('Role not found', ERROR_CODES.ROLE_NOT_FOUND);
    }

    if (audit) {
        await recordAudit(audit, {
            action: AUDIT_ACTIONS.ROLE_UPDATE,
            target: { kind: AUDIT_TARGET_KINDS.ROLE, id: after._id },
            metadata: {
                key: after.key,
                is_system: after.is_system,
                fields_changed: Object.keys(input),
            },
            before: toPublicRole(before),
            after: toPublicRole(after),
        });
    }

    return toPublicRole(after);
};

/**
 * `DELETE /roles/:id`.
 *
 * Two invariants:
 *  1. System roles cannot be deleted — `ROLE_IS_SYSTEM` (404? 422?
 *     We use 404-aliased semantics via `AppError.unprocessable` at
 *     422 because the role *exists* but cannot be removed; 404 would
 *     lie).
 *  2. A role currently assigned to any user cannot be deleted —
 *     `ROLE_IN_USE` (422). The admin must reassign affected users
 *     before retrying.
 */
export const deleteRole = async (id: Types.ObjectId, audit?: AuditContext): Promise<{ deleted: true; id: string }> => {
    const role = await Role.findById(id);
    if (!role) throw AppError.notFound('Role not found', ERROR_CODES.ROLE_NOT_FOUND);

    if (role.is_system) {
        throw AppError.unprocessable(`System role "${role.key}" cannot be deleted`, ERROR_CODES.ROLE_IS_SYSTEM);
    }

    const inUse = await User.countDocuments({ role_ids: role._id }).limit(1);
    if (inUse > 0) {
        throw AppError.unprocessable(
            `Role "${role.key}" is assigned to one or more users — reassign them before deleting`,
            ERROR_CODES.ROLE_IN_USE
        );
    }

    const beforeSnapshot = toPublicRole(role);
    const res = await Role.deleteOne({ _id: id, is_system: false });
    if (res.deletedCount === 0) {
        // Race: someone flipped is_system or deleted concurrently.
        throw AppError.notFound('Role not found', ERROR_CODES.ROLE_NOT_FOUND);
    }

    if (audit) {
        await recordAudit(audit, {
            action: AUDIT_ACTIONS.ROLE_DELETE,
            target: { kind: AUDIT_TARGET_KINDS.ROLE, id },
            metadata: { key: role.key },
            before: beforeSnapshot,
        });
    }

    return { deleted: true, id: id.toString() };
};

/**
 * `PATCH /users/:user_id/roles` — replace a user's `role_ids` array.
 *
 * Replacement (not merge) semantics: the supplied list IS the new
 * assignment. To grant or revoke a single role, the FE submits the
 * full new list. This matches the Step-15 user-PATCH posture and is
 * cheaper to reason about than computed diffs.
 *
 * Defense layers:
 *  - All supplied IDs must resolve to existing role documents.
 *    Missing IDs surface as `ROLE_NOT_FOUND` so the FE gets a clear
 *    error instead of a silent no-op.
 *  - The target user must exist (`USER_NOT_FOUND`).
 *  - The legacy `users.role` field is updated to the **first**
 *    role's key (the denormalized cache the project / attendance
 *    services still branch on). If the first role is a custom role
 *    whose key isn't in `ROLES`, we leave the legacy field alone —
 *    callers using the legacy enum check fall through to "not
 *    privileged" which is the safe default.
 */
export const assignRolesToUser = async (
    user_id: Types.ObjectId,
    input: AssignRolesBody,
    actor_id: Types.ObjectId,
    audit?: AuditContext
): Promise<Record<string, unknown>> => {
    const user = await User.findById(user_id).select('role role_ids');
    if (!user) throw AppError.notFound('User not found', ERROR_CODES.USER_NOT_FOUND);

    const roleIds = input.role_ids.map((id) => new Types.ObjectId(id));
    const roles = await Role.find({ _id: { $in: roleIds } })
        .select('_id key')
        .lean<{ _id: Types.ObjectId; key: string }[]>();

    if (roles.length !== roleIds.length) {
        const found = new Set(roles.map((r) => r._id.toString()));
        const missing = roleIds.filter((id) => !found.has(id.toString())).map((id) => id.toString());
        throw AppError.notFound(`One or more roles not found: ${missing.join(', ')}`, ERROR_CODES.ROLE_NOT_FOUND);
    }

    // Preserve the order the client requested (mongoose `find` returns in
    // arbitrary order) — used for the audit metadata below.
    const orderedKeys = roleIds.map((id) => roles.find((r) => r._id.equals(id))?.key ?? '');
    const before = {
        role: user.role,
        role_ids: user.role_ids.map((id) => id.toString()),
    };

    const set: Record<string, unknown> = { role_ids: roleIds };
    // Sync the denormalised legacy `role` to the HIGHEST-privilege system
    // role in the selection. Service-layer authorization (task create,
    // project author, team reads, etc.) still branches on this single
    // `caller.role` field, so picking the first-selected role would leave a
    // user promoted to e.g. Team Lead — but with Employee also ticked and
    // listed first — stuck behaving as an Employee (can't create tasks).
    // Custom (non-system) roles aren't legacy-enum values; their permissions
    // still apply via the role_ids union, they just don't drive `role`.
    const legacyEnumValues = new Set<string>(Object.values(SYSTEM_ROLE_KEYS));
    const LEGACY_ROLE_RANK: Record<string, number> = {
        [SYSTEM_ROLE_KEYS.ADMIN]: 4,
        [SYSTEM_ROLE_KEYS.MANAGER]: 3,
        [SYSTEM_ROLE_KEYS.TEAM_LEAD]: 2,
        [SYSTEM_ROLE_KEYS.EMPLOYEE]: 1,
        [SYSTEM_ROLE_KEYS.CLIENT]: 0,
    };
    const primaryKey = orderedKeys
        .filter((k) => legacyEnumValues.has(k))
        .reduce((best, k) => ((LEGACY_ROLE_RANK[k] ?? -1) > (best ? LEGACY_ROLE_RANK[best] : -1) ? k : best), '');
    if (primaryKey) {
        set.role = primaryKey;
    }

    await User.updateOne({ _id: user_id }, { $set: set });

    if (audit) {
        await recordAudit(audit, {
            action: AUDIT_ACTIONS.USER_ROLES_ASSIGN,
            target: { kind: AUDIT_TARGET_KINDS.USER, id: user_id },
            metadata: {
                actor_id: actor_id.toString(),
                role_keys: orderedKeys,
            },
            before,
            after: {
                role: set.role ?? user.role,
                role_ids: roleIds.map((id) => id.toString()),
            },
        });
    }

    // A role change silently alters what the person can see and do — and
    // their JWT keeps the old permission set until it rotates, so telling
    // them also explains why the UI may lag until they sign in again.
    void notifyRoleChanged({
        user_id,
        actor_id,
        role_labels: orderedKeys.filter(Boolean),
    });

    return {
        user_id: user_id.toString(),
        role_ids: roleIds.map((id) => id.toString()),
        role_keys: orderedKeys,
    };
};

/**
 * `PATCH /users/:user_id/extra-permissions` — Pattern B replacement.
 *
 * Replaces the user's `extra_permissions[]` with the supplied list.
 * Use `{ extra_permissions: [] }` to clear. The supplied list is
 * union-deduped against the user's role-derived permissions at JWT
 * mint time — there's no need for the caller to subtract role perms
 * before sending.
 *
 * `system.admin` wildcard is rejected here for the same reason it's
 * rejected on custom roles: granting it via Pattern B would silently
 * make the user a super-admin without any record on the role layer.
 */
export const updateUserExtraPermissions = async (
    user_id: Types.ObjectId,
    input: UpdateExtraPermissionsBody,
    actor_id: Types.ObjectId,
    audit?: AuditContext
): Promise<Record<string, unknown>> => {
    assertNoWildcard(input.extra_permissions);

    const user = await User.findById(user_id).select('extra_permissions');
    if (!user) throw AppError.notFound('User not found', ERROR_CODES.USER_NOT_FOUND);

    const before = [...(user.extra_permissions ?? [])];
    user.extra_permissions = input.extra_permissions;
    await user.save();

    if (audit) {
        const beforeSet = new Set<string>(before);
        const afterSet = new Set<string>(input.extra_permissions);
        await recordAudit(audit, {
            action: AUDIT_ACTIONS.USER_EXTRA_PERMISSIONS_UPDATE,
            target: { kind: AUDIT_TARGET_KINDS.USER, id: user_id },
            metadata: {
                actor_id: actor_id.toString(),
                added: input.extra_permissions.filter((p) => !beforeSet.has(p)),
                removed: before.filter((p) => !afterSet.has(p)),
            },
            before: { extra_permissions: before },
            after: { extra_permissions: input.extra_permissions },
        });
    }

    return {
        user_id: user_id.toString(),
        extra_permissions: input.extra_permissions,
    };
};

// ─── Re-export for external readability ────────────────────────────────

export { SYSTEM_ROLE_KEYS, PERMISSIONS };
