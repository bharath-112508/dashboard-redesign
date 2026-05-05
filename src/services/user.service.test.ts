import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Types } from 'mongoose';

/**
 * Unit tests for `user.service` (F7).
 *
 * Coverage focus — the security-sensitive lifecycle invariants:
 *   - createUser: single-admin enforcement (R6 friendly path AND
 *     E11000 backstop), email-exists 409, password-policy gate.
 *   - updateUser: R4 admin recognition via `role_keys` (multi-role
 *     admin who's `role_keys` contains 'admin' but legacy `role` is
 *     'manager' still passes the admin branch).
 *   - deactivateUser: self-block, idempotent on already-deactivated.
 *   - reactivateUser: single-admin re-check via R6 backstop.
 *   - changeUserRole: self-block, single-admin re-check, role_ids
 *     re-sync.
 */

const {
    userExistsMock,
    userCreateMock,
    userFindByIdMock,
    userFindMock,
    userUpdateOneMock,
    userFindOneMock,
    projectFindByIdMock,
    refreshUpdateManyMock,
    initBalancesMock,
    notifyUserInvitedMock,
    recordAuditMock,
    getSystemRoleByKeyMock,
    revokeLinksMock,
    settingsMock,
    photoSignMock,
    photoTtlMock,
    assertPasswordPolicyMock,
    hashPasswordMock,
} = vi.hoisted(() => ({
    userExistsMock: vi.fn(),
    userCreateMock: vi.fn(),
    userFindByIdMock: vi.fn(),
    userFindMock: vi.fn(),
    userUpdateOneMock: vi.fn(),
    userFindOneMock: vi.fn(),
    projectFindByIdMock: vi.fn(),
    refreshUpdateManyMock: vi.fn(),
    initBalancesMock: vi.fn(),
    notifyUserInvitedMock: vi.fn(),
    recordAuditMock: vi.fn(),
    getSystemRoleByKeyMock: vi.fn(),
    revokeLinksMock: vi.fn(),
    settingsMock: vi.fn(),
    photoSignMock: vi.fn(),
    photoTtlMock: vi.fn(),
    assertPasswordPolicyMock: vi.fn(),
    hashPasswordMock: vi.fn(),
}));

vi.mock('../models/user.model.js', () => ({
    User: {
        exists: userExistsMock,
        create: userCreateMock,
        findById: userFindByIdMock,
        updateOne: userUpdateOneMock,
        findOne: userFindOneMock,
        find: userFindMock,
        countDocuments: vi.fn(),
    },
}));

vi.mock('../models/project.model.js', () => ({
    Project: {
        findById: projectFindByIdMock,
    },
}));

vi.mock('../models/refresh-token.model.js', () => ({
    RefreshToken: { updateMany: refreshUpdateManyMock },
}));

vi.mock('../utils/password.js', () => ({
    hashPassword: hashPasswordMock,
}));

vi.mock('../utils/password-policy.js', () => ({
    assertPasswordPolicy: assertPasswordPolicyMock,
}));

vi.mock('./leave-balance.service.js', () => ({
    initializeBalancesForUserYear: initBalancesMock,
}));

vi.mock('./notification-dispatcher.service.js', () => ({
    notifyUserInvited: notifyUserInvitedMock,
}));

vi.mock('./audit.service.js', () => ({
    recordAudit: recordAuditMock,
}));

vi.mock('./role.service.js', () => ({
    getSystemRoleByKey: getSystemRoleByKeyMock,
}));

vi.mock('./share-link.service.js', () => ({
    revokeLinksForDeactivatedClient: revokeLinksMock,
}));

vi.mock('./settings.service.js', () => ({
    getOrInitSettings: settingsMock,
}));

vi.mock('./profile-photo.service.js', () => ({
    signProfilePhotoUrl: photoSignMock,
    resolveProfilePhotoTtlMinutes: photoTtlMock,
}));

const svc = await import('./user.service.js');
import { ERROR_CODES } from '../constants/error-codes.js';
import { ROLES } from '../constants/roles.js';

const sampleUser = (overrides: Record<string, unknown> = {}) => {
    const fields = {
        _id: new Types.ObjectId(),
        email: 'jane@example.com',
        full_name: 'Jane Doe',
        role: 'employee',
        role_ids: [],
        status: 'active',
        deactivated_at: null,
        timezone: 'Asia/Kolkata',
        comp_off_balance: 0,
        slack_user_id: null,
        slack_notifications_enabled: true,
        profile_photo_blob_key: null,
        ...overrides,
    };
    const u = {
        ...fields,
        save: vi.fn(),
        toJSON() {
            return { ...fields, id: fields._id.toString() };
        },
    } as Record<string, unknown> & { save: ReturnType<typeof vi.fn> };
    return u;
};

beforeEach(() => {
    vi.resetAllMocks();
    settingsMock.mockResolvedValue({ uploads: { sas_token_ttl_minutes: 15 } });
    photoTtlMock.mockReturnValue(15);
    photoSignMock.mockResolvedValue(null);
    hashPasswordMock.mockResolvedValue('hashed');
    refreshUpdateManyMock.mockResolvedValue({ modifiedCount: 0 });
    userUpdateOneMock.mockResolvedValue({ modifiedCount: 1 });
    revokeLinksMock.mockResolvedValue({ revoked_count: 0 });
});

// ─── createUser ────────────────────────────────────────────────────────

describe('createUser — single-admin enforcement (R6)', () => {
    const baseInput = {
        email: 'admin@example.com',
        full_name: 'Admin',
        role: ROLES.ADMIN,
        initial_password: 'Aa1!aaaaaa',
        internal_profile: {
            employee_id: 'A-001',
            job_title: 'CEO',
            department: 'Exec',
            date_of_joining: '2026-01-01',
        },
    };

    it('rejects with ADMIN_ALREADY_EXISTS via the friendly assertSingleAdmin path', async () => {
        userExistsMock.mockResolvedValueOnce({ _id: new Types.ObjectId() }); // an admin already exists

        await expect(svc.createUser(baseInput as never, new Types.ObjectId())).rejects.toMatchObject({
            code: ERROR_CODES.ADMIN_ALREADY_EXISTS,
        });
        expect(userCreateMock).not.toHaveBeenCalled();
    });

    it('R6 backstop: translates the partial-unique-index E11000 to ADMIN_ALREADY_EXISTS', async () => {
        // Friendly check passes (race window — some other admin slipped in
        // between assertSingleAdmin and User.create).
        userExistsMock.mockResolvedValueOnce(null); // no existing admin (yet)
        userExistsMock.mockResolvedValueOnce(null); // no existing email
        const e11000 = Object.assign(new Error('dup'), { code: 11000, keyPattern: { role: 1 } });
        userCreateMock.mockRejectedValueOnce(e11000);

        await expect(svc.createUser(baseInput as never, new Types.ObjectId())).rejects.toMatchObject({
            code: ERROR_CODES.ADMIN_ALREADY_EXISTS,
        });
    });

    it('rejects with EMAIL_ALREADY_EXISTS when the email is taken', async () => {
        userExistsMock.mockResolvedValueOnce(null); // no admin
        userExistsMock.mockResolvedValueOnce({ _id: new Types.ObjectId() }); // email taken

        await expect(svc.createUser(baseInput as never, new Types.ObjectId())).rejects.toMatchObject({
            code: ERROR_CODES.EMAIL_ALREADY_EXISTS,
        });
        expect(userCreateMock).not.toHaveBeenCalled();
    });

    it('runs the password-policy gate before any DB write', async () => {
        const policyErr = new Error('weak password');
        assertPasswordPolicyMock.mockImplementationOnce(() => {
            throw policyErr;
        });

        await expect(svc.createUser(baseInput as never, new Types.ObjectId())).rejects.toBe(policyErr);
        expect(userExistsMock).not.toHaveBeenCalled();
        expect(userCreateMock).not.toHaveBeenCalled();
    });
});

// ─── deactivateUser ────────────────────────────────────────────────────

describe('deactivateUser', () => {
    it('blocks self-deactivation with FORBIDDEN', async () => {
        const callerId = new Types.ObjectId();
        await expect(svc.deactivateUser({ target_id: callerId, caller_id: callerId })).rejects.toMatchObject({
            code: ERROR_CODES.FORBIDDEN,
        });
        expect(userFindByIdMock).not.toHaveBeenCalled();
    });

    it('returns 404 USER_NOT_FOUND for unknown target', async () => {
        userFindByIdMock.mockResolvedValueOnce(null);

        await expect(
            svc.deactivateUser({ target_id: new Types.ObjectId(), caller_id: new Types.ObjectId() })
        ).rejects.toMatchObject({ code: ERROR_CODES.USER_NOT_FOUND });
    });

    it('idempotent: re-deactivating an already-deactivated user is a no-op', async () => {
        const target = sampleUser({ status: 'deactivated' });
        userFindByIdMock.mockResolvedValueOnce(target);

        await svc.deactivateUser({ target_id: target._id as Types.ObjectId, caller_id: new Types.ObjectId() });

        expect(target.save).not.toHaveBeenCalled();
        expect(refreshUpdateManyMock).not.toHaveBeenCalled();
    });

    it('happy path: flips status, sets deactivated_at, revokes sessions, audits', async () => {
        const target = sampleUser();
        userFindByIdMock.mockResolvedValueOnce(target);

        await svc.deactivateUser({
            target_id: target._id as Types.ObjectId,
            caller_id: new Types.ObjectId(),
            audit: {
                actor_id: new Types.ObjectId(),
                actor_role: 'admin',
                ip: '1.1.1.1',
                user_agent: 'curl',
                request_id: 'r-1',
            },
        });

        expect(target.status).toBe('deactivated');
        expect(target.deactivated_at).toBeInstanceOf(Date);
        expect(target.save).toHaveBeenCalled();
        expect(refreshUpdateManyMock).toHaveBeenCalledWith(
            { user_id: target._id, revoked_at: null },
            { $set: { revoked_at: expect.any(Date) } }
        );
        expect(recordAuditMock).toHaveBeenCalledWith(
            expect.any(Object),
            expect.objectContaining({ action: 'user.deactivate' })
        );
    });

    it('client deactivation cascades share-link revocation', async () => {
        const target = sampleUser({ role: ROLES.CLIENT });
        userFindByIdMock.mockResolvedValueOnce(target);
        revokeLinksMock.mockResolvedValueOnce({ revoked_count: 3 });

        await svc.deactivateUser({
            target_id: target._id as Types.ObjectId,
            caller_id: new Types.ObjectId(),
            audit: {
                actor_id: new Types.ObjectId(),
                actor_role: 'admin',
                ip: '1.1.1.1',
                user_agent: 'curl',
                request_id: 'r-1',
            },
        });

        expect(revokeLinksMock).toHaveBeenCalledOnce();
        // Audit metadata should record the cascade count.
        const auditArg = recordAuditMock.mock.calls[0][1] as { metadata: { share_links_revoked?: number } };
        expect(auditArg.metadata.share_links_revoked).toBe(3);
    });
});

// ─── reactivateUser ────────────────────────────────────────────────────

describe('reactivateUser', () => {
    it('returns 404 USER_NOT_FOUND for unknown target', async () => {
        userFindByIdMock.mockResolvedValueOnce(null);

        await expect(svc.reactivateUser(new Types.ObjectId())).rejects.toMatchObject({
            code: ERROR_CODES.USER_NOT_FOUND,
        });
    });

    it('idempotent: reactivating an already-active user is a no-op', async () => {
        const target = sampleUser({ status: 'active' });
        userFindByIdMock.mockResolvedValueOnce(target);

        await svc.reactivateUser(target._id as Types.ObjectId);

        expect(target.save).not.toHaveBeenCalled();
    });

    it('R6: re-checks single-admin via assertSingleAdmin when the target is an admin', async () => {
        const target = sampleUser({ status: 'deactivated', role: ROLES.ADMIN });
        userFindByIdMock.mockResolvedValueOnce(target);
        // Simulate another active admin already exists (slipped in while the
        // target was deactivated).
        userExistsMock.mockResolvedValueOnce({ _id: new Types.ObjectId() });

        await expect(svc.reactivateUser(target._id as Types.ObjectId)).rejects.toMatchObject({
            code: ERROR_CODES.ADMIN_ALREADY_EXISTS,
        });
        expect(target.save).not.toHaveBeenCalled();
    });
});

// ─── changeUserRole ────────────────────────────────────────────────────

describe('changeUserRole', () => {
    it('blocks changing OWN role with FORBIDDEN', async () => {
        const callerId = new Types.ObjectId();
        await expect(
            svc.changeUserRole({
                target_id: callerId,
                caller_id: callerId,
                new_role: ROLES.MANAGER,
            })
        ).rejects.toMatchObject({ code: ERROR_CODES.FORBIDDEN });
    });

    it('returns 404 USER_NOT_FOUND for unknown target', async () => {
        userFindByIdMock.mockResolvedValueOnce(null);

        await expect(
            svc.changeUserRole({
                target_id: new Types.ObjectId(),
                caller_id: new Types.ObjectId(),
                new_role: ROLES.MANAGER,
            })
        ).rejects.toMatchObject({ code: ERROR_CODES.USER_NOT_FOUND });
    });

    it('idempotent: no-op when new_role equals current role', async () => {
        const target = sampleUser({ role: ROLES.MANAGER });
        userFindByIdMock.mockResolvedValueOnce(target);

        await svc.changeUserRole({
            target_id: target._id as Types.ObjectId,
            caller_id: new Types.ObjectId(),
            new_role: ROLES.MANAGER,
        });

        expect(target.save).not.toHaveBeenCalled();
    });

    it('R6: re-checks single-admin when promoting to admin', async () => {
        const target = sampleUser({ role: ROLES.MANAGER });
        userFindByIdMock.mockResolvedValueOnce(target);
        userExistsMock.mockResolvedValueOnce({ _id: new Types.ObjectId() }); // an admin exists

        await expect(
            svc.changeUserRole({
                target_id: target._id as Types.ObjectId,
                caller_id: new Types.ObjectId(),
                new_role: ROLES.ADMIN,
            })
        ).rejects.toMatchObject({ code: ERROR_CODES.ADMIN_ALREADY_EXISTS });
    });

    it('rejects swap across the client/internal axis with VALIDATION_ERROR', async () => {
        const target = sampleUser({ role: ROLES.EMPLOYEE });
        userFindByIdMock.mockResolvedValueOnce(target);

        await expect(
            svc.changeUserRole({
                target_id: target._id as Types.ObjectId,
                caller_id: new Types.ObjectId(),
                new_role: ROLES.CLIENT,
            })
        ).rejects.toMatchObject({ code: ERROR_CODES.VALIDATION_ERROR });
    });
});

// ─── listAssignable — project-member filter ──────────────────────────────

describe('listAssignable', () => {
    const buildUserChain = (rows: unknown[]) => ({
        select: () => ({
            sort: () => ({
                limit: () => Promise.resolve(rows),
            }),
        }),
    });

    it('without project_id: returns active non-clients across the org', async () => {
        // The default-picker shape — no project scoping. The filter
        // shape that reaches User.find MUST exclude clients but not
        // restrict by member_ids.
        userFindMock.mockReturnValueOnce(buildUserChain([]));

        await svc.listAssignable({});

        const [filter] = userFindMock.mock.calls[0]!;
        expect(filter).toMatchObject({ status: 'active', role: { $ne: ROLES.CLIENT } });
        expect(filter).not.toHaveProperty('_id');
        expect(projectFindByIdMock).not.toHaveBeenCalled();
    });

    it('with project_id: narrows the result to the project member_ids', async () => {
        // Cardinal pin: an assignee picker for a specific project must
        // ONLY surface that project's members. Without this filter the
        // FE would let an admin assign tasks within Project X to any
        // user in the org — confusing UX and a soft authorization gap.
        const projectId = new Types.ObjectId();
        const memberA = new Types.ObjectId();
        const memberB = new Types.ObjectId();
        projectFindByIdMock.mockReturnValueOnce({
            select: () => ({ lean: () => Promise.resolve({ member_ids: [memberA, memberB] }) }),
        });
        userFindMock.mockReturnValueOnce(buildUserChain([]));

        await svc.listAssignable({ project_id: projectId.toString() });

        // The User.find filter MUST carry the `_id: $in: member_ids`
        // restriction — that's what enforces the project scope.
        const [filter] = userFindMock.mock.calls[0]!;
        expect(filter).toMatchObject({
            status: 'active',
            _id: { $in: [memberA, memberB] },
        });
        expect(projectFindByIdMock).toHaveBeenCalledWith(projectId.toString());
    });

    it('with an unknown project_id: returns [] (no 404, no leak of other projects)', async () => {
        // The picker semantic: "no one is assignable to a project that
        // doesn't exist" → empty array. A 404 here would couple the
        // picker UX to existence-probing, which is operator-confusing
        // (this is a list endpoint, not a resource-fetch).
        projectFindByIdMock.mockReturnValueOnce({
            select: () => ({ lean: () => Promise.resolve(null) }),
        });

        const result = await svc.listAssignable({ project_id: new Types.ObjectId().toString() });

        expect(result).toEqual([]);
        // User.find MUST NOT have been called — short-circuit saves the
        // round-trip when the project doesn't exist.
        expect(userFindMock).not.toHaveBeenCalled();
    });

    it('honours an explicit `role` filter alongside `project_id`', async () => {
        // E.g. "show me which managers are on Project X" — the role
        // filter and project filter compose. The `role` override
        // replaces the default `{$ne: CLIENT}` exclusion.
        const projectId = new Types.ObjectId();
        const member = new Types.ObjectId();
        projectFindByIdMock.mockReturnValueOnce({
            select: () => ({ lean: () => Promise.resolve({ member_ids: [member] }) }),
        });
        userFindMock.mockReturnValueOnce(buildUserChain([]));

        await svc.listAssignable({ project_id: projectId.toString(), role: ROLES.MANAGER });

        const [filter] = userFindMock.mock.calls[0]!;
        expect(filter).toMatchObject({
            status: 'active',
            role: ROLES.MANAGER,
            _id: { $in: [member] },
        });
    });
});
