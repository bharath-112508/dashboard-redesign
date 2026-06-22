import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Types } from 'mongoose';

/**
 * Unit tests for `role.service` — Step 47 Phase A.
 *
 * The service has four moving parts and we test each one in isolation:
 *   1. `seedSystemRoles()` — idempotent upsert of the five system roles.
 *      The cached-promise dedupe keeps two parallel callers from
 *      duplicate-writing on cold start. We assert the call count, not
 *      just the result, so a regression that drops the dedupe surfaces.
 *   2. `getSystemRoleByKey(key)` — find-or-seed lookup.
 *   3. `resolvePermissionsForUser(userId)` — joins role_ids → role docs,
 *      returns the deduped union. Covers the empty-role_ids fast path.
 *   4. `ensureLegacyRoleAssigned(userId, legacyRole)` — `$addToSet` only
 *      when missing.
 *   5. `bootstrapRolesMigration()` — boot-time wrapper that seeds + scans
 *      for legacy users and back-assigns.
 *
 * Mongoose is fully mocked — the service is pure data-layer glue, so
 * exercising it against a real Mongo would test the driver, not us.
 */

const {
    roleUpdateOneMock,
    roleFindOneMock,
    roleFindMock,
    roleFindByIdMock,
    roleFindByIdAndUpdateMock,
    roleCreateMock,
    roleDeleteOneMock,
    userFindByIdMock,
    userFindMock,
    userUpdateOneMock,
    userCountDocumentsMock,
    recordAuditMock,
} = vi.hoisted(() => ({
    roleUpdateOneMock: vi.fn(),
    roleFindOneMock: vi.fn(),
    roleFindMock: vi.fn(),
    roleFindByIdMock: vi.fn(),
    roleFindByIdAndUpdateMock: vi.fn(),
    roleCreateMock: vi.fn(),
    roleDeleteOneMock: vi.fn(),
    userFindByIdMock: vi.fn(),
    userFindMock: vi.fn(),
    userUpdateOneMock: vi.fn(),
    userCountDocumentsMock: vi.fn(),
    recordAuditMock: vi.fn(),
}));

vi.mock('../models/role.model.js', () => ({
    Role: {
        updateOne: roleUpdateOneMock,
        findOne: roleFindOneMock,
        find: roleFindMock,
        findById: roleFindByIdMock,
        findByIdAndUpdate: roleFindByIdAndUpdateMock,
        create: roleCreateMock,
        deleteOne: roleDeleteOneMock,
    },
}));

vi.mock('../models/user.model.js', () => ({
    User: {
        findById: userFindByIdMock,
        find: userFindMock,
        updateOne: userUpdateOneMock,
        countDocuments: userCountDocumentsMock,
    },
}));

vi.mock('./audit.service.js', () => ({
    recordAudit: recordAuditMock,
}));

const service = await import('./role.service.js');
import { SYSTEM_ROLE_DEFINITIONS } from '../constants/system-role-definitions.js';
import { SYSTEM_ROLE_KEYS } from '../constants/role-keys.js';
import { PERMISSIONS } from '../constants/permissions.js';

beforeEach(() => {
    vi.resetAllMocks();
});

// Helpers — the find().select() lean() chains return the value passed in.
const findChain = <T>(value: T) => ({
    select: () => ({ lean: () => Promise.resolve(value) }),
});

// ─── seedSystemRoles ─────────────────────────────────────────────────────

describe('seedSystemRoles', () => {
    it('upserts every definition exactly once per call', async () => {
        roleUpdateOneMock.mockResolvedValue({ upsertedCount: 1, modifiedCount: 0 });

        await service.seedSystemRoles();

        expect(roleUpdateOneMock).toHaveBeenCalledTimes(SYSTEM_ROLE_DEFINITIONS.length);
        // Every call must be an upsert keyed on `key` — losing the upsert
        // flag would mean fresh DBs never get seeded.
        for (const call of roleUpdateOneMock.mock.calls) {
            const [filter, update, options] = call;
            expect(filter).toMatchObject({ key: expect.any(String) });
            expect(options).toMatchObject({ upsert: true });
            expect(update).toHaveProperty('$setOnInsert');
            expect(update).toHaveProperty('$set');
            // Permissions are re-set on every seed so a new permission
            // added to the definitions takes effect on next boot.
            expect(update.$set).toHaveProperty('permissions');
        }
    });

    it('keeps `is_system: true` and `key` in the $setOnInsert clause (immutability)', async () => {
        // System roles must NEVER have their `key` or `is_system` flag
        // patched — that's the invariant the model docstring promises.
        // The seeder enforces this by only touching them on insert.
        roleUpdateOneMock.mockResolvedValue({ upsertedCount: 0, modifiedCount: 0 });

        await service.seedSystemRoles();

        for (const call of roleUpdateOneMock.mock.calls) {
            const [, update] = call;
            expect(update.$setOnInsert).toHaveProperty('is_system', true);
            expect(update.$setOnInsert).toHaveProperty('key');
            // Defensive: $set must NOT touch key/is_system — pin it so a
            // refactor that moves them under $set fails the test.
            expect(update.$set).not.toHaveProperty('key');
            expect(update.$set).not.toHaveProperty('is_system');
        }
    });

    it('swallows per-role write errors so one bad role does not block the rest', async () => {
        // The seeder runs on the boot path; a transient Mongo blip on
        // one role MUST NOT take down the whole server. Verify the loop
        // continues past a rejected promise.
        roleUpdateOneMock
            .mockRejectedValueOnce(new Error('transient'))
            .mockResolvedValue({ upsertedCount: 1, modifiedCount: 0 });

        await expect(service.seedSystemRoles()).resolves.toBeUndefined();
        expect(roleUpdateOneMock).toHaveBeenCalledTimes(SYSTEM_ROLE_DEFINITIONS.length);
    });
});

// ─── getSystemRoleByKey ──────────────────────────────────────────────────

describe('getSystemRoleByKey', () => {
    it('returns the role doc on first hit without re-seeding', async () => {
        const roleDoc = { _id: new Types.ObjectId(), key: SYSTEM_ROLE_KEYS.ADMIN };
        roleFindOneMock.mockResolvedValueOnce(roleDoc);

        const out = await service.getSystemRoleByKey(SYSTEM_ROLE_KEYS.ADMIN);

        expect(out).toBe(roleDoc);
        // The fast path must not seed — that would cost N upserts on
        // every login.
        expect(roleUpdateOneMock).not.toHaveBeenCalled();
    });

    it('seeds and retries when the role is missing (cold-start path)', async () => {
        const roleDoc = { _id: new Types.ObjectId(), key: SYSTEM_ROLE_KEYS.MANAGER };
        roleFindOneMock
            .mockResolvedValueOnce(null) // miss
            .mockResolvedValueOnce(roleDoc); // post-seed
        roleUpdateOneMock.mockResolvedValue({ upsertedCount: 1, modifiedCount: 0 });

        const out = await service.getSystemRoleByKey(SYSTEM_ROLE_KEYS.MANAGER);

        expect(out).toBe(roleDoc);
        expect(roleUpdateOneMock).toHaveBeenCalledTimes(SYSTEM_ROLE_DEFINITIONS.length);
        expect(roleFindOneMock).toHaveBeenCalledTimes(2);
    });
});

// ─── resolvePermissionsForUser ───────────────────────────────────────────

describe('resolvePermissionsForUser', () => {
    it('returns empty arrays when the user has no role_ids (pre-bootstrap user)', async () => {
        const userId = new Types.ObjectId();
        userFindByIdMock.mockReturnValueOnce(findChain({ role_ids: [] }));

        const out = await service.resolvePermissionsForUser(userId);

        expect(out).toEqual({ role_keys: [], permissions: [] });
        // Empty role_ids must short-circuit before the role.find — a
        // regression that always queries roles is a wasted round-trip on
        // every login of a brand-new user.
        expect(roleFindMock).not.toHaveBeenCalled();
    });

    it('returns empty arrays when the user is missing entirely', async () => {
        const userId = new Types.ObjectId();
        userFindByIdMock.mockReturnValueOnce(findChain(null));

        const out = await service.resolvePermissionsForUser(userId);

        expect(out).toEqual({ role_keys: [], permissions: [] });
    });

    it('dedupes permissions across multiple roles', async () => {
        // Two roles where the second's permission set partially overlaps
        // the first. The output must contain each permission exactly
        // once — otherwise the JWT bloats and downstream `.includes()`
        // checks pay an O(n) penalty per permission per route.
        const userId = new Types.ObjectId();
        const roleIds = [new Types.ObjectId(), new Types.ObjectId()];
        userFindByIdMock.mockReturnValueOnce(findChain({ role_ids: roleIds }));
        roleFindMock.mockReturnValueOnce(
            findChain([
                { key: 'a', permissions: [PERMISSIONS.PROJECT_READ, PERMISSIONS.TASK_READ] },
                { key: 'b', permissions: [PERMISSIONS.TASK_READ, PERMISSIONS.TASK_WRITE] },
            ])
        );

        const out = await service.resolvePermissionsForUser(userId);

        expect(out.role_keys).toEqual(['a', 'b']);
        // Order is insertion order across roles; the value is irrelevant
        // to the gate but stable assertion makes regressions easier to
        // diagnose.
        expect(out.permissions).toEqual([PERMISSIONS.PROJECT_READ, PERMISSIONS.TASK_READ, PERMISSIONS.TASK_WRITE]);
    });
});

// ─── ensureLegacyRoleAssigned ────────────────────────────────────────────

describe('ensureLegacyRoleAssigned', () => {
    it('uses $addToSet so a second call is a no-op (idempotent)', async () => {
        const userId = new Types.ObjectId();
        const roleDoc = { _id: new Types.ObjectId(), key: SYSTEM_ROLE_KEYS.EMPLOYEE };
        roleFindOneMock.mockResolvedValueOnce(roleDoc);
        userUpdateOneMock.mockResolvedValueOnce({ matchedCount: 0, modifiedCount: 0 });

        await service.ensureLegacyRoleAssigned(userId, SYSTEM_ROLE_KEYS.EMPLOYEE);

        expect(userUpdateOneMock).toHaveBeenCalledTimes(1);
        const [filter, update] = userUpdateOneMock.mock.calls[0];
        // Predicate guards on `role_ids: { $ne: role._id }` — pin it so
        // a regression that drops the guard (and races with a concurrent
        // assignment) doesn't double-write.
        expect(filter).toMatchObject({ _id: userId, role_ids: { $ne: roleDoc._id } });
        expect(update).toEqual({ $addToSet: { role_ids: roleDoc._id } });
    });

    it('logs and returns silently when the system role is missing (defensive)', async () => {
        // Should never happen in practice (the lookup auto-seeds), but
        // if `getSystemRoleByKey` returns null for any reason we must
        // not throw — that would 500 the login path.
        const userId = new Types.ObjectId();
        roleFindOneMock.mockResolvedValue(null);
        // Seeder retry path also returns null, so the function falls
        // through to the warn branch.
        roleUpdateOneMock.mockResolvedValue({ upsertedCount: 0 });

        await expect(service.ensureLegacyRoleAssigned(userId, SYSTEM_ROLE_KEYS.EMPLOYEE)).resolves.toBeUndefined();
        expect(userUpdateOneMock).not.toHaveBeenCalled();
    });
});

// ─── bootstrapRolesMigration ─────────────────────────────────────────────

describe('bootstrapRolesMigration', () => {
    it('seeds, then back-fills every legacy user with empty role_ids', async () => {
        roleUpdateOneMock.mockResolvedValue({ upsertedCount: 1, modifiedCount: 0 });

        const userA = { _id: new Types.ObjectId(), role: 'employee' };
        const userB = { _id: new Types.ObjectId(), role: 'manager' };
        userFindMock.mockReturnValueOnce(findChain([userA, userB]));

        // ensureLegacyRoleAssigned will call findOne + updateOne once per user.
        roleFindOneMock.mockResolvedValue({ _id: new Types.ObjectId(), key: 'placeholder' });
        userUpdateOneMock.mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });

        const result = await service.bootstrapRolesMigration();

        expect(result).toEqual({ seeded: true, backfilled: 2 });
        expect(roleUpdateOneMock).toHaveBeenCalledTimes(SYSTEM_ROLE_DEFINITIONS.length);
        expect(userUpdateOneMock).toHaveBeenCalledTimes(2);
    });

    it('skips users with an unknown legacy role rather than throwing', async () => {
        // Defence-in-depth: `users.role` IS enum-validated, but if a
        // hand-edit ever inserts an unknown value the migration must
        // not crash the boot path. Skip + warn is the contract.
        roleUpdateOneMock.mockResolvedValue({ upsertedCount: 1, modifiedCount: 0 });
        userFindMock.mockReturnValueOnce(findChain([{ _id: new Types.ObjectId(), role: 'galaxy_brain' }]));

        const result = await service.bootstrapRolesMigration();

        expect(result.backfilled).toBe(0);
        expect(userUpdateOneMock).not.toHaveBeenCalled();
    });

    it('returns backfilled=0 on a fully-migrated DB (idempotent re-run)', async () => {
        // Most boots: all users already have role_ids, the find returns
        // []. The seeder still runs (cheap upserts), but no users are
        // touched. This is the steady-state cost of the migration.
        roleUpdateOneMock.mockResolvedValue({ upsertedCount: 0, modifiedCount: 0 });
        userFindMock.mockReturnValueOnce(findChain([]));

        const result = await service.bootstrapRolesMigration();

        expect(result).toEqual({ seeded: true, backfilled: 0 });
        expect(userUpdateOneMock).not.toHaveBeenCalled();
    });
});

// ─── Phase C: createCustomRole ───────────────────────────────────────────

describe('createCustomRole', () => {
    const actorId = new Types.ObjectId();

    const validInput = {
        key: 'auditor',
        display_name: 'Auditor',
        description: 'Read-only auditor',
        permissions: [PERMISSIONS.AUDIT_LOG_READ, PERMISSIONS.PROJECT_READ],
    };

    it('rejects the system.admin wildcard with ROLE_INVALID_PERMISSIONS', async () => {
        // Hard invariant: only the seeded Admin role holds the
        // wildcard. Granting it to a custom role would silently
        // bypass every requirePermission gate.
        await expect(
            service.createCustomRole({ ...validInput, permissions: [PERMISSIONS.SYSTEM_ADMIN] }, actorId)
        ).rejects.toMatchObject({
            statusCode: 422,
            code: 'ROLE_INVALID_PERMISSIONS',
        });
        // The DB write must NOT have happened — wildcard rejection is
        // pre-write so a malicious payload can't even reach mongo.
        expect(roleCreateMock).not.toHaveBeenCalled();
    });

    it('persists with is_system=false and stamps created_by/updated_by to the actor', async () => {
        // Custom roles are non-system by construction. The actor id
        // shows up in both audit fields on first write so future
        // PATCH audits can attribute the change vs. the create.
        const fakeDoc = {
            _id: new Types.ObjectId(),
            ...validInput,
            is_system: false,
            created_by: actorId,
            updated_by: actorId,
            created_at: new Date(),
            updated_at: new Date(),
        };
        roleCreateMock.mockResolvedValueOnce(fakeDoc);

        const out = await service.createCustomRole(validInput, actorId);

        expect(roleCreateMock).toHaveBeenCalledTimes(1);
        const args = roleCreateMock.mock.calls[0][0];
        expect(args).toMatchObject({
            key: 'auditor',
            is_system: false,
            created_by: actorId,
            updated_by: actorId,
        });
        expect(out).toMatchObject({ key: 'auditor', is_system: false });
    });

    it('maps Mongo E11000 (duplicate key) to DUPLICATE_RESOURCE 409', async () => {
        // The unique-key index races against pre-write existence checks,
        // so we let mongo be the source of truth and translate its
        // error code at the boundary. A 409 with `key` in the message
        // tells the FE which field collided without leaking the doc.
        const dup = Object.assign(new Error('dup'), { code: 11000 });
        roleCreateMock.mockRejectedValueOnce(dup);

        await expect(service.createCustomRole(validInput, actorId)).rejects.toMatchObject({
            statusCode: 409,
            code: 'DUPLICATE_RESOURCE',
        });
    });
});

// ─── Phase C: updateRole ─────────────────────────────────────────────────

describe('updateRole', () => {
    const actorId = new Types.ObjectId();
    const roleId = new Types.ObjectId();

    const customRoleDoc = {
        _id: roleId,
        key: 'auditor',
        display_name: 'Auditor',
        description: '',
        permissions: [PERMISSIONS.AUDIT_LOG_READ],
        is_system: false,
        created_by: actorId,
        updated_by: actorId,
        created_at: new Date(),
        updated_at: new Date(),
    };

    const adminSystemRoleDoc = {
        ...customRoleDoc,
        key: SYSTEM_ROLE_KEYS.ADMIN,
        permissions: [PERMISSIONS.SYSTEM_ADMIN],
        is_system: true,
    };

    it('404s when the role does not exist', async () => {
        roleFindByIdMock.mockResolvedValueOnce(null);
        await expect(service.updateRole(roleId, { display_name: 'X' }, actorId)).rejects.toMatchObject({
            statusCode: 404,
            code: 'ROLE_NOT_FOUND',
        });
    });

    it('rejects system.admin wildcard on patch unless the target IS the seeded Admin', async () => {
        // A custom role being patched to include the wildcard is the
        // attack we explicitly guard against. The seeded Admin role
        // already holds the wildcard; we don't strip it on patch (so
        // the legitimate Admin can edit display_name without losing
        // the wildcard).
        roleFindByIdMock.mockResolvedValueOnce(customRoleDoc);
        await expect(
            service.updateRole(roleId, { permissions: [PERMISSIONS.PROJECT_READ, PERMISSIONS.SYSTEM_ADMIN] }, actorId)
        ).rejects.toMatchObject({ statusCode: 422, code: 'ROLE_INVALID_PERMISSIONS' });
        // findByIdAndUpdate must not run — wildcard rejection is pre-write.
        expect(roleFindByIdAndUpdateMock).not.toHaveBeenCalled();
    });

    it('allows system.admin to remain when patching the seeded Admin role itself', async () => {
        // Sanity test for the "unless target is Admin" carve-out: an
        // admin renaming the Admin role's display_name shouldn't lose
        // the wildcard or hit the validator.
        roleFindByIdMock.mockResolvedValueOnce(adminSystemRoleDoc);
        roleFindByIdAndUpdateMock.mockResolvedValueOnce({ ...adminSystemRoleDoc, display_name: 'Super Admin' });

        const out = await service.updateRole(roleId, { display_name: 'Super Admin' }, actorId);

        expect(out).toMatchObject({ display_name: 'Super Admin', key: SYSTEM_ROLE_KEYS.ADMIN });
    });

    it('only patches whitelisted fields (display_name, description, permissions, updated_by)', async () => {
        // Defense in depth: the validator already strips key/is_system,
        // but if a future controller bug let them through, the service
        // must not propagate them. Pin the $set keys.
        roleFindByIdMock.mockResolvedValueOnce(customRoleDoc);
        roleFindByIdAndUpdateMock.mockResolvedValueOnce(customRoleDoc);

        await service.updateRole(roleId, { display_name: 'New' }, actorId);

        const updateArg = roleFindByIdAndUpdateMock.mock.calls[0][1] as { $set: Record<string, unknown> };
        expect(Object.keys(updateArg.$set).sort()).toEqual(['display_name', 'updated_by']);
        expect(updateArg.$set.updated_by).toBe(actorId);
    });

    it('refuses to strip system.admin from the seeded Admin role (lockout prevention)', async () => {
        // The footgun: an admin patches the Admin role's permissions
        // to `[project.read]` (or any list that omits the wildcard) —
        // until the next deploy the system has no working admin. The
        // service rejects this with ROLE_INVALID_PERMISSIONS instead
        // of silently letting the write through. To narrow Admin's
        // grants, an operator edits `system-role-definitions.ts`.
        roleFindByIdMock.mockResolvedValueOnce(adminSystemRoleDoc);

        await expect(
            service.updateRole(roleId, { permissions: [PERMISSIONS.PROJECT_READ] }, actorId)
        ).rejects.toMatchObject({ statusCode: 422, code: 'ROLE_INVALID_PERMISSIONS' });
        expect(roleFindByIdAndUpdateMock).not.toHaveBeenCalled();
    });

    it('allows broadening Admin permissions as long as system.admin stays (purely additive)', async () => {
        // Mirror image of the lockout test: an admin can ADD other
        // permissions to Admin (harmless — the wildcard already
        // matches everything) as long as they keep the wildcard.
        // This keeps the door open for "Admin also has project.read"-
        // style organisational quirks without forcing a redeploy.
        roleFindByIdMock.mockResolvedValueOnce(adminSystemRoleDoc);
        roleFindByIdAndUpdateMock.mockResolvedValueOnce({
            ...adminSystemRoleDoc,
            permissions: [PERMISSIONS.SYSTEM_ADMIN, PERMISSIONS.PROJECT_READ],
        });

        const out = await service.updateRole(
            roleId,
            { permissions: [PERMISSIONS.SYSTEM_ADMIN, PERMISSIONS.PROJECT_READ] },
            actorId
        );

        expect(out.permissions).toContain(PERMISSIONS.SYSTEM_ADMIN);
        expect(out.permissions).toContain(PERMISSIONS.PROJECT_READ);
    });
});

// ─── Phase C: deleteRole ─────────────────────────────────────────────────

describe('deleteRole', () => {
    const roleId = new Types.ObjectId();

    it('refuses to delete a system role with ROLE_IS_SYSTEM 422', async () => {
        roleFindByIdMock.mockResolvedValueOnce({
            _id: roleId,
            key: SYSTEM_ROLE_KEYS.MANAGER,
            is_system: true,
        });

        await expect(service.deleteRole(roleId)).rejects.toMatchObject({
            statusCode: 422,
            code: 'ROLE_IS_SYSTEM',
        });
        expect(userCountDocumentsMock).not.toHaveBeenCalled();
        expect(roleDeleteOneMock).not.toHaveBeenCalled();
    });

    it('refuses to delete an in-use role with ROLE_IN_USE 422', async () => {
        // Pin the contract: the admin must reassign affected users
        // FIRST, then retry the delete. Returning 422 (vs. cascading)
        // makes the dependency explicit.
        roleFindByIdMock.mockResolvedValueOnce({
            _id: roleId,
            key: 'auditor',
            is_system: false,
        });
        userCountDocumentsMock.mockReturnValueOnce({ limit: () => Promise.resolve(3) });

        await expect(service.deleteRole(roleId)).rejects.toMatchObject({
            statusCode: 422,
            code: 'ROLE_IN_USE',
        });
        expect(roleDeleteOneMock).not.toHaveBeenCalled();
    });

    it('deletes a non-system, unused role and reports the id back', async () => {
        roleFindByIdMock.mockResolvedValueOnce({
            _id: roleId,
            key: 'auditor',
            display_name: 'Auditor',
            description: '',
            permissions: [],
            is_system: false,
            created_by: null,
            updated_by: null,
            created_at: new Date(),
            updated_at: new Date(),
        });
        userCountDocumentsMock.mockReturnValueOnce({ limit: () => Promise.resolve(0) });
        roleDeleteOneMock.mockResolvedValueOnce({ deletedCount: 1 });

        const out = await service.deleteRole(roleId);

        expect(out).toEqual({ deleted: true, id: roleId.toString() });
        // The delete predicate guards on `is_system: false` so a TOCTOU
        // race that flips is_system to true between findById and
        // deleteOne falls through to the not-found path rather than
        // wiping a system role.
        expect(roleDeleteOneMock).toHaveBeenCalledWith({ _id: roleId, is_system: false });
    });
});

// ─── Phase C: assignRolesToUser ──────────────────────────────────────────

describe('assignRolesToUser', () => {
    const userId = new Types.ObjectId();
    const actorId = new Types.ObjectId();
    const managerRoleId = new Types.ObjectId();
    const customRoleId = new Types.ObjectId();

    it('404s when the target user does not exist', async () => {
        userFindByIdMock.mockReturnValueOnce({ select: () => Promise.resolve(null) });
        await expect(
            service.assignRolesToUser(userId, { role_ids: [managerRoleId.toString()] }, actorId)
        ).rejects.toMatchObject({ statusCode: 404, code: 'USER_NOT_FOUND' });
    });

    it('404s when one or more role_ids do not resolve', async () => {
        // The error message lists the missing IDs so the FE can mark
        // the offending tokens — pin that contract.
        userFindByIdMock.mockReturnValueOnce({
            select: () => Promise.resolve({ role: 'employee', role_ids: [] }),
        });
        roleFindMock.mockReturnValueOnce(findChain([])); // none of the IDs resolve

        await expect(
            service.assignRolesToUser(userId, { role_ids: [managerRoleId.toString()] }, actorId)
        ).rejects.toMatchObject({ statusCode: 404, code: 'ROLE_NOT_FOUND' });
        expect(userUpdateOneMock).not.toHaveBeenCalled();
    });

    it('replaces role_ids and syncs the legacy `role` cache to the assigned system-key', async () => {
        // The legacy denormalized `role` field still drives some
        // service-level branching (project visibility, attendance).
        // When the new primary role's key matches a legacy enum
        // value, we sync it. Custom-role-only assignments leave the
        // legacy cache alone — verified by the next test.
        userFindByIdMock.mockReturnValueOnce({
            select: () => Promise.resolve({ role: 'employee', role_ids: [] }),
        });
        roleFindMock.mockReturnValueOnce(findChain([{ _id: managerRoleId, key: SYSTEM_ROLE_KEYS.MANAGER }]));
        userUpdateOneMock.mockResolvedValueOnce({ matchedCount: 1, modifiedCount: 1 });

        const out = await service.assignRolesToUser(userId, { role_ids: [managerRoleId.toString()] }, actorId);

        const updateArg = userUpdateOneMock.mock.calls[0][1] as { $set: Record<string, unknown> };
        expect(updateArg.$set).toMatchObject({ role: SYSTEM_ROLE_KEYS.MANAGER });
        // role_ids set is an array of ObjectIds — assert by length and
        // toString equality so we don't pin instance identity.
        expect((updateArg.$set.role_ids as Types.ObjectId[]).map((i) => i.toString())).toEqual([
            managerRoleId.toString(),
        ]);
        expect(out.role_keys).toEqual([SYSTEM_ROLE_KEYS.MANAGER]);
    });

    it('syncs the legacy `role` to the HIGHEST-privilege system role when several are assigned', async () => {
        // Regression: promoting Employee → Team Lead with BOTH boxes ticked
        // (Employee listed first) must leave the user as `team_lead`, not
        // `employee`. Service-layer authz (task create, project author, team
        // reads) branches on the single legacy `role`, so the denorm must be
        // the most-privileged selected role — independent of selection order.
        const employeeRoleId = new Types.ObjectId();
        const teamLeadRoleId = new Types.ObjectId();
        userFindByIdMock.mockReturnValueOnce({
            select: () => Promise.resolve({ role: 'employee', role_ids: [employeeRoleId] }),
        });
        roleFindMock.mockReturnValueOnce(
            findChain([
                { _id: employeeRoleId, key: SYSTEM_ROLE_KEYS.EMPLOYEE },
                { _id: teamLeadRoleId, key: SYSTEM_ROLE_KEYS.TEAM_LEAD },
            ]),
        );
        userUpdateOneMock.mockResolvedValueOnce({ matchedCount: 1, modifiedCount: 1 });

        await service.assignRolesToUser(
            userId,
            { role_ids: [employeeRoleId.toString(), teamLeadRoleId.toString()] },
            actorId,
        );

        const updateArg = userUpdateOneMock.mock.calls[0][1] as { $set: Record<string, unknown> };
        expect(updateArg.$set).toMatchObject({ role: SYSTEM_ROLE_KEYS.TEAM_LEAD });
    });

    it('does NOT touch the legacy `role` field when the primary role is a custom (non-enum) key', async () => {
        // The legacy enum check (e.g. `caller.role === 'manager'`) at
        // the service layer would mis-fire on a custom key. Leaving
        // the cache as-is means custom-role users fall through to
        // "not privileged" — which is the correct fail-closed default
        // until the legacy field is removed entirely.
        userFindByIdMock.mockReturnValueOnce({
            select: () => Promise.resolve({ role: 'employee', role_ids: [] }),
        });
        roleFindMock.mockReturnValueOnce(findChain([{ _id: customRoleId, key: 'auditor' }]));
        userUpdateOneMock.mockResolvedValueOnce({ matchedCount: 1, modifiedCount: 1 });

        await service.assignRolesToUser(userId, { role_ids: [customRoleId.toString()] }, actorId);

        const updateArg = userUpdateOneMock.mock.calls[0][1] as { $set: Record<string, unknown> };
        expect(updateArg.$set).not.toHaveProperty('role');
        expect(updateArg.$set).toHaveProperty('role_ids');
    });
});

// ─── Pattern B: extra_permissions union in resolvePermissionsForUser ─────

describe('resolvePermissionsForUser — Pattern B (extra_permissions)', () => {
    it('unions role permissions with extra_permissions, deduped', async () => {
        // The whole point of Pattern B: an admin grants a one-off
        // permission to a user without spinning up a custom role.
        // The resolver's contract is that the JWT permission union
        // already includes Pattern B grants — call sites just check
        // `permissions.includes(X)` and don't care WHICH layer
        // granted it.
        const userId = new Types.ObjectId();
        const roleIds = [new Types.ObjectId()];
        userFindByIdMock.mockReturnValueOnce(
            findChain({
                role_ids: roleIds,
                extra_permissions: [PERMISSIONS.REPORT_READ, PERMISSIONS.PROJECT_READ],
            })
        );
        roleFindMock.mockReturnValueOnce(
            findChain([{ key: 'employee', permissions: [PERMISSIONS.PROJECT_READ, PERMISSIONS.TASK_READ] }])
        );

        const out = await service.resolvePermissionsForUser(userId);

        // PROJECT_READ appears in both layers — must show up exactly once.
        expect(out.permissions.sort()).toEqual(
            [PERMISSIONS.PROJECT_READ, PERMISSIONS.TASK_READ, PERMISSIONS.REPORT_READ].sort()
        );
        expect(out.role_keys).toEqual(['employee']);
    });

    it('returns Pattern B permissions even when role_ids is empty', async () => {
        // Edge case: an admin grants extras to a user with no roles
        // assigned (perhaps they're being staged for a role).
        // `requirePermission` is the gate — if the admin opted into
        // this state, the permissions should be honoured.
        const userId = new Types.ObjectId();
        userFindByIdMock.mockReturnValueOnce(findChain({ role_ids: [], extra_permissions: [PERMISSIONS.REPORT_READ] }));

        const out = await service.resolvePermissionsForUser(userId);

        expect(out.permissions).toEqual([PERMISSIONS.REPORT_READ]);
        expect(out.role_keys).toEqual([]);
        // Optimisation: no roles → don't bother joining the role
        // collection. Pin so a refactor doesn't waste a round-trip.
        expect(roleFindMock).not.toHaveBeenCalled();
    });

    it('handles missing extra_permissions field gracefully (legacy users)', async () => {
        // Pre-Pattern-B users won't have the field at all (defaulted
        // to [] by the schema, but the lean read could hand back
        // undefined for users created before the schema change).
        const userId = new Types.ObjectId();
        userFindByIdMock.mockReturnValueOnce(findChain({ role_ids: [new Types.ObjectId()] }));
        roleFindMock.mockReturnValueOnce(findChain([{ key: 'employee', permissions: [PERMISSIONS.PROJECT_READ] }]));

        const out = await service.resolvePermissionsForUser(userId);

        expect(out.permissions).toEqual([PERMISSIONS.PROJECT_READ]);
    });
});

// ─── Pattern B: updateUserExtraPermissions ───────────────────────────────

describe('updateUserExtraPermissions', () => {
    const userId = new Types.ObjectId();
    const actorId = new Types.ObjectId();

    it('rejects the system.admin wildcard (same posture as custom roles)', async () => {
        // If we let Pattern B grant `system.admin`, an admin could
        // silently make any user a super-admin by patching their
        // extras — defeating the wildcard's invariant. Reject before
        // any DB read.
        await expect(
            service.updateUserExtraPermissions(userId, { extra_permissions: [PERMISSIONS.SYSTEM_ADMIN] }, actorId)
        ).rejects.toMatchObject({ statusCode: 422, code: 'ROLE_INVALID_PERMISSIONS' });
        expect(userFindByIdMock).not.toHaveBeenCalled();
    });

    it('404s when the target user does not exist', async () => {
        userFindByIdMock.mockReturnValueOnce({ select: () => Promise.resolve(null) });
        await expect(
            service.updateUserExtraPermissions(userId, { extra_permissions: [] }, actorId)
        ).rejects.toMatchObject({ statusCode: 404, code: 'USER_NOT_FOUND' });
    });

    it('replaces extras and triggers user.save with the new list', async () => {
        // Replacement (not merge) semantics — sending [a, b] sets
        // extras to exactly [a, b]. The full doc is fetched (not
        // `.lean()`) because we call `.save()` on it.
        const saveMock = vi.fn().mockResolvedValue(undefined);
        const userDoc = {
            extra_permissions: [PERMISSIONS.PROJECT_READ],
            save: saveMock,
        };
        userFindByIdMock.mockReturnValueOnce({ select: () => Promise.resolve(userDoc) });

        const out = await service.updateUserExtraPermissions(
            userId,
            { extra_permissions: [PERMISSIONS.REPORT_READ, PERMISSIONS.AUDIT_LOG_READ] },
            actorId
        );

        expect(saveMock).toHaveBeenCalledTimes(1);
        expect(userDoc.extra_permissions).toEqual([PERMISSIONS.REPORT_READ, PERMISSIONS.AUDIT_LOG_READ]);
        expect(out).toMatchObject({
            user_id: userId.toString(),
            extra_permissions: [PERMISSIONS.REPORT_READ, PERMISSIONS.AUDIT_LOG_READ],
        });
    });

    it('passes accurate added/removed diff to the audit row', async () => {
        // The diff in `metadata.added` / `metadata.removed` is the
        // most useful signal for a security review — it tells the
        // operator what specifically changed without forcing a
        // diff of before vs after by hand.
        const userDoc = {
            extra_permissions: [PERMISSIONS.PROJECT_READ, PERMISSIONS.REPORT_READ],
            save: vi.fn().mockResolvedValue(undefined),
        };
        userFindByIdMock.mockReturnValueOnce({ select: () => Promise.resolve(userDoc) });

        const auditCtx = {
            actor_id: actorId,
            actor_role: 'admin' as const,
            ip: null,
            user_agent: null,
            request_id: null,
        };

        await service.updateUserExtraPermissions(
            userId,
            { extra_permissions: [PERMISSIONS.REPORT_READ, PERMISSIONS.AUDIT_LOG_READ] },
            actorId,
            auditCtx
        );

        expect(recordAuditMock).toHaveBeenCalledTimes(1);
        const auditCall = recordAuditMock.mock.calls[0][1];
        expect(auditCall.action).toBe('user.extra_permissions_update');
        expect(auditCall.metadata.added).toEqual([PERMISSIONS.AUDIT_LOG_READ]);
        expect(auditCall.metadata.removed).toEqual([PERMISSIONS.PROJECT_READ]);
    });
});
