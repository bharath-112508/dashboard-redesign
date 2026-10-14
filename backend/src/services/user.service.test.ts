import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Types } from 'mongoose';

/**
 * Unit tests for `user.service` (F7).
 *
 * Coverage focus — the security-sensitive lifecycle invariants:
 *   - createUser: a second admin is allowed (was single-admin, R6; AND
 *     E11000 backstop), email-exists 409, password-policy gate.
 *   - updateUser: R4 admin recognition via `role_keys` (multi-role
 *     admin who's `role_keys` contains 'admin' but legacy `role` is
 *     'manager' still passes the admin branch).
 *   - deactivateUser: self-block, idempotent on already-deactivated.
 *   - reactivateUser: no admin ceiling; the last-admin floor instead.
 *   - changeUserRole: self-block, last-admin floor, role_ids
 *     re-sync.
 */

const {
    userExistsMock,
    userCreateMock,
    userFindByIdMock,
    userFindMock,
    userCountMock,
    userUpdateOneMock,
    userFindOneMock,
    projectFindByIdMock,
    companyExistsMock,
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
    userCountMock: vi.fn(),
    userUpdateOneMock: vi.fn(),
    userFindOneMock: vi.fn(),
    projectFindByIdMock: vi.fn(),
    companyExistsMock: vi.fn(),
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
        countDocuments: userCountMock,
    },
}));

vi.mock('../models/company.model.js', () => ({
    Company: { exists: companyExistsMock },
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

const roleKeysByIdsMock = vi.hoisted(() => vi.fn(async () => new Map<string, string>()));
vi.mock('./role.service.js', () => ({
    getSystemRoleByKey: getSystemRoleByKeyMock,
    roleKeysByIds: roleKeysByIdsMock,
}));

const { issuePasswordSetupLinkMock, revokePendingPasswordLinksMock } = vi.hoisted(() => ({
    issuePasswordSetupLinkMock: vi.fn(),
    revokePendingPasswordLinksMock: vi.fn(),
}));
vi.mock('./password-reset.service.js', () => ({
    issuePasswordSetupLink: issuePasswordSetupLinkMock,
    revokePendingPasswordLinks: revokePendingPasswordLinksMock,
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
import { PERMISSIONS } from '../constants/permissions.js';

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

describe('createUser — admin creation', () => {
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

    // The old ceiling ("exactly one active admin") is gone: administration
    // shouldn't bottleneck on one person. Creating another admin is now an
    // ordinary create, and the only remaining check is the email.
    it('creates a second admin without complaint', async () => {
        userExistsMock.mockResolvedValueOnce(null); // email free
        userCreateMock.mockResolvedValueOnce([sampleUser({ role: ROLES.ADMIN })]);

        await svc.createUser(baseInput as never, new Types.ObjectId());

        expect(userCreateMock).toHaveBeenCalled();
    });

    it('rejects with EMAIL_ALREADY_EXISTS when the email is taken', async () => {
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

// ─── H1: user-create + leave-balance-init atomicity ──────────────────────

describe('createUser — H1 atomicity (balance-init failure aborts user create)', () => {
    // Pre-H1 contract: balance-init failure was caught + logged as a
    // warning; the user was created anyway. Net effect: silent lockout
    // for new joiners.
    //
    // H1 contract: balance-init failure propagates out of
    // `withTransaction`, callers see a rejection. In production (replica
    // set) the user document is also rolled back; in test environments
    // (no Mongo connection) `withTransaction` runs the callback with a
    // null session, so we can verify the error path but not the
    // transactional rollback itself — that's a Mongo concern that
    // belongs in an integration test against a real replica set.
    const employeeInput = {
        email: 'newhire@example.com',
        full_name: 'New Hire',
        role: ROLES.EMPLOYEE,
        initial_password: 'Aa1!aaaaaa',
        internal_profile: {
            employee_id: 'E-101',
            job_title: 'Engineer',
            department: 'Engineering',
            date_of_joining: '2026-05-01',
        },
    };

    it('propagates the rejection when initializeBalancesForUserYear throws', async () => {
        userExistsMock.mockResolvedValueOnce(null); // no email collision
        userCreateMock.mockResolvedValueOnce([
            {
                _id: new Types.ObjectId(),
                email: 'newhire@example.com',
                full_name: 'New Hire',
                role: ROLES.EMPLOYEE,
                status: 'active',
                internal_profile: { date_of_joining: '2026-05-01' },
                toJSON() {
                    return { id: 'x' };
                },
            },
        ]);
        const balanceErr = new Error('seed failed');
        initBalancesMock.mockRejectedValueOnce(balanceErr);

        await expect(svc.createUser(employeeInput as never, new Types.ObjectId())).rejects.toBe(balanceErr);
        // Pre-H1 the email + audit ran AFTER balance init even when
        // balance init failed (the warning swallowed the error).
        // Post-H1, the rejection short-circuits the whole flow.
        expect(notifyUserInvitedMock).not.toHaveBeenCalled();
        expect(recordAuditMock).not.toHaveBeenCalled();
    });

    it('skips balance init for client users (and therefore cannot fail this way)', async () => {
        // Defensive coverage of the role-check inside the tx: if the
        // caller-supplied profile happens to be a client, the balance
        // init branch is skipped and the user create commits cleanly.
        userExistsMock.mockResolvedValueOnce(null);
        userCreateMock.mockResolvedValueOnce([
            {
                _id: new Types.ObjectId(),
                email: 'client@example.com',
                full_name: 'External Client',
                role: ROLES.CLIENT,
                status: 'active',
                client_profile: { company_id: new Types.ObjectId() },
                toJSON() {
                    return { id: 'x' };
                },
            },
        ]);

        const clientInput = {
            ...employeeInput,
            email: 'client@example.com',
            role: ROLES.CLIENT,
            client_profile: { company_id: new Types.ObjectId().toHexString() },
            internal_profile: undefined,
        };
        // The service verifies the company exists + is active before
        // attaching it — a client pointed at a dead company would see
        // nothing.
        companyExistsMock.mockResolvedValueOnce({ _id: new Types.ObjectId() });

        await expect(svc.createUser(clientInput as never, new Types.ObjectId())).resolves.toBeDefined();
        expect(initBalancesMock).not.toHaveBeenCalled();
    });

    it('refuses a client whose company_id does not resolve to an active company', async () => {
        // company_name used to be free text, which is exactly how two
        // people at one company became unrelated records. Pointing at a
        // real company is now checked, not typed.
        userExistsMock.mockResolvedValueOnce(null);
        companyExistsMock.mockResolvedValueOnce(null);

        await expect(
            svc.createUser(
                {
                    ...employeeInput,
                    email: 'ghost@example.com',
                    role: ROLES.CLIENT,
                    client_profile: { company_id: new Types.ObjectId().toHexString() },
                    internal_profile: undefined,
                } as never,
                new Types.ObjectId()
            )
        ).rejects.toMatchObject({ code: ERROR_CODES.VALIDATION_ERROR });

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

    it('reactivates a deactivated admin even when another admin is active', async () => {
        const target = sampleUser({ status: 'deactivated', role: ROLES.ADMIN });
        userFindByIdMock.mockResolvedValueOnce(target);

        await svc.reactivateUser(target._id as Types.ObjectId);

        expect(target.save).toHaveBeenCalled();
        expect(target.status).toBe('active');
    });
});

// ─── the last-admin floor ──────────────────────────────────────────────
//
// Several admins are allowed; zero are not. An org with no admin can't manage
// roles, settings or users again without database access, so both paths that
// could empty the set refuse to take the final one.

describe('assertNotLastAdmin', () => {
    it('refuses to deactivate the last active admin', async () => {
        const target = sampleUser({ role: ROLES.ADMIN });
        userFindByIdMock.mockResolvedValueOnce(target);
        userExistsMock.mockResolvedValueOnce(null); // no other active admin

        await expect(
            svc.deactivateUser({
                target_id: target._id as Types.ObjectId,
                caller_id: new Types.ObjectId(),
            })
        ).rejects.toMatchObject({ code: ERROR_CODES.LAST_ADMIN });
        expect(target.save).not.toHaveBeenCalled();
    });

    it('allows deactivating an admin while another one is active', async () => {
        const target = sampleUser({ role: ROLES.ADMIN });
        userFindByIdMock.mockResolvedValueOnce(target);
        userExistsMock.mockResolvedValueOnce({ _id: new Types.ObjectId() }); // another admin

        await svc.deactivateUser({
            target_id: target._id as Types.ObjectId,
            caller_id: new Types.ObjectId(),
        });

        expect(target.save).toHaveBeenCalled();
    });

    it('refuses to demote the last active admin', async () => {
        const target = sampleUser({ role: ROLES.ADMIN });
        userFindByIdMock.mockResolvedValueOnce(target);
        userExistsMock.mockResolvedValueOnce(null); // no other active admin

        await expect(
            svc.changeUserRole({
                target_id: target._id as Types.ObjectId,
                caller_id: new Types.ObjectId(),
                new_role: ROLES.MANAGER,
            })
        ).rejects.toMatchObject({ code: ERROR_CODES.LAST_ADMIN });
        expect(target.save).not.toHaveBeenCalled();
    });

    // Promotion is unrestricted — that's the whole point of the change.
    it('promotes another user to admin with no ceiling check', async () => {
        const target = sampleUser({ role: ROLES.MANAGER });
        userFindByIdMock.mockResolvedValueOnce(target);
        getSystemRoleByKeyMock.mockResolvedValueOnce({ _id: new Types.ObjectId(), key: ROLES.ADMIN });

        await svc.changeUserRole({
            target_id: target._id as Types.ObjectId,
            caller_id: new Types.ObjectId(),
            new_role: ROLES.ADMIN,
        });

        expect(target.role).toBe(ROLES.ADMIN);
        expect(userExistsMock).not.toHaveBeenCalled();
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

    // C6 — `project_id` is now required by the validator, AND the
    // service verifies the caller has read access to that project
    // before returning members. Pre-C6 the route returned the full
    // non-client user directory (up to 500 active users) to any
    // authenticated caller — CLIENT-role users included.

    it('admin caller: returns the project members regardless of project membership', async () => {
        const projectId = new Types.ObjectId();
        const memberA = new Types.ObjectId();
        const memberB = new Types.ObjectId();
        const adminId = new Types.ObjectId();
        projectFindByIdMock.mockReturnValueOnce({
            select: () => ({
                lean: () =>
                    Promise.resolve({ member_ids: [memberA, memberB], company_id: null, representative_ids: [] }),
            }),
        });
        userFindMock.mockReturnValueOnce(buildUserChain([]));

        await svc.listAssignable({ project_id: projectId.toString() }, { id: adminId, role: ROLES.ADMIN });

        const [filter] = userFindMock.mock.calls[0]!;
        expect(filter).toMatchObject({
            status: 'active',
            _id: { $in: [memberA, memberB] },
            role: { $ne: ROLES.CLIENT },
        });
    });

    it('employee caller who is NOT a project member: throws FORBIDDEN', async () => {
        const projectId = new Types.ObjectId();
        const otherMember = new Types.ObjectId();
        const outsider = new Types.ObjectId();
        projectFindByIdMock.mockReturnValueOnce({
            select: () => ({
                lean: () => Promise.resolve({ member_ids: [otherMember], company_id: null, representative_ids: [] }),
            }),
        });

        await expect(
            svc.listAssignable({ project_id: projectId.toString() }, { id: outsider, role: ROLES.EMPLOYEE })
        ).rejects.toMatchObject({ statusCode: 403, code: 'FORBIDDEN' });

        // User.find MUST NOT have run — access denied before query.
        expect(userFindMock).not.toHaveBeenCalled();
    });

    it('employee caller who IS a project member: returns the project members', async () => {
        const projectId = new Types.ObjectId();
        const me = new Types.ObjectId();
        const other = new Types.ObjectId();
        projectFindByIdMock.mockReturnValueOnce({
            select: () => ({
                lean: () => Promise.resolve({ member_ids: [me, other], company_id: null, representative_ids: [] }),
            }),
        });
        userFindMock.mockReturnValueOnce(buildUserChain([]));

        await svc.listAssignable({ project_id: projectId.toString() }, { id: me, role: ROLES.EMPLOYEE });

        expect(userFindMock).toHaveBeenCalled();
    });

    it('client caller of the project company: gets the project members', async () => {
        // Client-side users can use the picker — e.g. to @-mention members
        // in comments. A `client` is COMPANY-scoped, so company match is
        // what grants access; they need not be on the roster.
        const projectId = new Types.ObjectId();
        const companyId = new Types.ObjectId();
        const me = new Types.ObjectId();
        const member = new Types.ObjectId();
        projectFindByIdMock.mockReturnValueOnce({
            select: () => ({
                lean: () => Promise.resolve({ member_ids: [member], company_id: companyId, representative_ids: [] }),
            }),
        });
        userFindMock.mockReturnValueOnce(buildUserChain([]));

        await svc.listAssignable(
            { project_id: projectId.toString() },
            { id: me, role: ROLES.CLIENT, company_id: companyId }
        );

        expect(userFindMock).toHaveBeenCalled();
    });

    it('client caller of ANOTHER company: throws FORBIDDEN', async () => {
        const projectId = new Types.ObjectId();
        const me = new Types.ObjectId();
        projectFindByIdMock.mockReturnValueOnce({
            select: () => ({
                lean: () =>
                    Promise.resolve({
                        member_ids: [],
                        company_id: new Types.ObjectId(),
                        representative_ids: [],
                    }),
            }),
        });

        await expect(
            svc.listAssignable(
                { project_id: projectId.toString() },
                { id: me, role: ROLES.CLIENT, company_id: new Types.ObjectId() }
            )
        ).rejects.toMatchObject({ code: ERROR_CODES.FORBIDDEN });
    });

    it('representative caller NOT on the roster: throws FORBIDDEN even in the same company', async () => {
        // A representative is roster-scoped — company membership alone
        // must not grant access, or they'd see every project of their
        // company like a `client` does.
        const projectId = new Types.ObjectId();
        const companyId = new Types.ObjectId();
        projectFindByIdMock.mockReturnValueOnce({
            select: () => ({
                lean: () => Promise.resolve({ member_ids: [], company_id: companyId, representative_ids: [] }),
            }),
        });

        await expect(
            svc.listAssignable(
                { project_id: projectId.toString() },
                { id: new Types.ObjectId(), role: ROLES.REPRESENTATIVE, company_id: companyId }
            )
        ).rejects.toMatchObject({ code: ERROR_CODES.FORBIDDEN });
    });

    it('unknown project_id: throws 404 (no enumeration of project existence)', async () => {
        projectFindByIdMock.mockReturnValueOnce({
            select: () => ({ lean: () => Promise.resolve(null) }),
        });

        await expect(
            svc.listAssignable(
                { project_id: new Types.ObjectId().toString() },
                { id: new Types.ObjectId(), role: ROLES.ADMIN }
            )
        ).rejects.toMatchObject({ statusCode: 404 });

        expect(userFindMock).not.toHaveBeenCalled();
    });

    it('honours an explicit `role` filter alongside `project_id`', async () => {
        const projectId = new Types.ObjectId();
        const member = new Types.ObjectId();
        projectFindByIdMock.mockReturnValueOnce({
            select: () => ({
                lean: () => Promise.resolve({ member_ids: [member], company_id: null, representative_ids: [] }),
            }),
        });
        userFindMock.mockReturnValueOnce(buildUserChain([]));

        await svc.listAssignable(
            { project_id: projectId.toString(), role: ROLES.MANAGER },
            { id: new Types.ObjectId(), role: ROLES.ADMIN }
        );

        const [filter] = userFindMock.mock.calls[0]!;
        expect(filter).toMatchObject({
            status: 'active',
            role: ROLES.MANAGER,
            _id: { $in: [member] },
        });
    });
});

// ─── updateUser — employment-editor authorization (user.employment_write) ───

describe('updateUser — employment-editor (user.employment_write)', () => {
    const makeTarget = () =>
        sampleUser({
            role: 'employee',
            internal_profile: {
                employee_id: 'E-1',
                job_title: 'Engineer',
                department: 'Engineering',
                date_of_joining: '2026-01-01',
                emergency_contact: { name: 'Kin', phone: '1', relation: 'parent' },
            },
        });

    const managerCaller = (target: ReturnType<typeof sampleUser>) => ({
        target_id: target._id as Types.ObjectId,
        caller_id: new Types.ObjectId(), // not self
        caller_role: ROLES.MANAGER,
        caller_role_keys: [ROLES.MANAGER],
        caller_permissions: [PERMISSIONS.USER_EMPLOYMENT_WRITE],
    });

    it('lets a manager edit employment fields on another user (merged onto existing)', async () => {
        const t = makeTarget();
        userFindByIdMock.mockResolvedValueOnce(t);

        await svc.updateUser({
            ...managerCaller(t),
            patch: { internal_profile: { job_title: 'Senior Engineer', department: 'Platform' } } as never,
        });

        expect(t.save).toHaveBeenCalled();
        const ip = t.internal_profile as Record<string, unknown>;
        expect(ip.job_title).toBe('Senior Engineer');
        expect(ip.department).toBe('Platform');
        expect(ip.employee_id).toBe('E-1'); // untouched field preserved
    });

    it('strips identity + non-employment nested fields from an employment-editor patch', async () => {
        const t = makeTarget();
        userFindByIdMock.mockResolvedValueOnce(t);

        await svc.updateUser({
            ...managerCaller(t),
            patch: {
                full_name: 'Hacked Name',
                internal_profile: { job_title: 'Lead', emergency_contact: { name: 'Evil' } },
            } as never,
        });

        expect(t.full_name).toBe('Jane Doe'); // identity not changed
        const ip = t.internal_profile as Record<string, unknown>;
        expect(ip.job_title).toBe('Lead');
        // emergency_contact is not an employment field → editor can't overwrite it
        expect(ip.emergency_contact).toEqual({ name: 'Kin', phone: '1', relation: 'parent' });
    });

    it('forbids an employment editor whose patch carries no employment fields', async () => {
        const t = makeTarget();
        userFindByIdMock.mockResolvedValueOnce(t);

        await expect(
            svc.updateUser({ ...managerCaller(t), patch: { full_name: 'Hacked' } as never })
        ).rejects.toMatchObject({ code: ERROR_CODES.FORBIDDEN });
        expect(t.save).not.toHaveBeenCalled();
    });

    it('forbids a caller with neither admin, self, nor employment permission', async () => {
        const t = makeTarget();
        userFindByIdMock.mockResolvedValueOnce(t);

        await expect(
            svc.updateUser({
                target_id: t._id as Types.ObjectId,
                caller_id: new Types.ObjectId(),
                caller_role: ROLES.EMPLOYEE,
                caller_role_keys: [ROLES.EMPLOYEE],
                caller_permissions: [],
                patch: { internal_profile: { job_title: 'X' } } as never,
            })
        ).rejects.toMatchObject({ code: ERROR_CODES.FORBIDDEN });
        expect(t.save).not.toHaveBeenCalled();
    });
});

describe('listUsers — employment_type filter', () => {
    // The Staff filter must not be an equality match: every user created
    // before `internal_profile.employment_type` existed carries no such key,
    // and an equality would hide the whole pre-existing workforce behind a
    // filter that reads like it should show everyone.
    const listChain = (rows: unknown[]) => ({
        collation: () => ({
            sort: () => ({
                skip: () => ({
                    limit: () => Promise.resolve(rows),
                }),
            }),
        }),
    });

    const runList = async (employment_type?: 'staff' | 'freelancer') => {
        userFindMock.mockReturnValueOnce(listChain([]));
        userCountMock.mockReturnValueOnce({ collation: () => Promise.resolve(0) });
        settingsMock.mockResolvedValueOnce({ uploads: { sas_token_ttl_minutes: 15 } });
        photoTtlMock.mockReturnValueOnce(15);
        await svc.listUsers({ page: 1, limit: 20, employment_type } as never);
        return userFindMock.mock.calls[0]![0] as Record<string, unknown>;
    };

    it('matches "not a freelancer" for staff, so pre-existing users are included', async () => {
        const filter = await runList('staff');
        expect(filter['internal_profile.employment_type']).toEqual({ $ne: 'freelancer' });
    });

    it('matches freelancer exactly — it is never the implied default', async () => {
        const filter = await runList('freelancer');
        expect(filter['internal_profile.employment_type']).toBe('freelancer');
    });

    it('omits the predicate entirely when no employment_type is asked for', async () => {
        const filter = await runList();
        expect(filter).not.toHaveProperty('internal_profile.employment_type');
    });
});

describe('listUsers — role keys (redesign)', () => {
    it('gives each person their role keys, so a DevOps engineer is recognised', async () => {
        const devopsRole = new Types.ObjectId();
        const employeeRole = new Types.ObjectId();
        const row = { _id: new Types.ObjectId(), role_ids: [employeeRole, devopsRole], toJSON() { return { id: String(this._id), role_ids: this.role_ids } } };
        userFindMock.mockReturnValueOnce({ collation: () => ({ sort: () => ({ skip: () => ({ limit: () => Promise.resolve([row]) }) }) }) });
        userCountMock.mockReturnValueOnce({ collation: () => Promise.resolve(1) });
        settingsMock.mockResolvedValueOnce({ uploads: { sas_token_ttl_minutes: 15 } });
        photoTtlMock.mockReturnValueOnce(15);
        roleKeysByIdsMock.mockResolvedValueOnce(new Map([[employeeRole.toString(), 'employee'], [devopsRole.toString(), 'devops']]));
        const out = await svc.listUsers({ page: 1, limit: 20 } as never);
        expect(out.data[0]).toMatchObject({ role_keys: ['employee', 'devops'] });
    });
});

describe('getUser — role keys (redesign)', () => {
    it('gives the person their role keys', async () => {
        const devopsRole = new Types.ObjectId();
        const row = { _id: new Types.ObjectId(), role_ids: [devopsRole], toJSON() { return { id: String(this._id) } } };
        userFindByIdMock.mockResolvedValueOnce(row);
        settingsMock.mockResolvedValueOnce({ uploads: { sas_token_ttl_minutes: 15 } });
        photoTtlMock.mockReturnValueOnce(15);
        roleKeysByIdsMock.mockResolvedValueOnce(new Map([[devopsRole.toString(), 'devops']]));
        expect(await svc.getUser(row._id)).toMatchObject({ role_keys: ['devops'] });
    });
});

describe('listUserPhotos', () => {
    const chain = (rows: unknown[]) => ({ select: () => ({ lean: () => Promise.resolve(rows) }) });

    it('signs a URL for each asked-for user with a photo, and skips the rest', async () => {
        const a = new Types.ObjectId();
        const b = new Types.ObjectId();
        userFindMock.mockReturnValueOnce(chain([{ _id: a, profile_photo_blob_key: 'k/a.png' }]));
        photoSignMock.mockReturnValueOnce('https://blob/a.png?sas');

        const out = await svc.listUserPhotos([a.toString(), b.toString()]);

        expect(userFindMock.mock.calls[0]![0]).toEqual({
            _id: { $in: [a, b] },
            profile_photo_blob_key: { $nin: [null, ''] },
        });
        expect(out).toEqual({
            ttl_minutes: 15,
            data: [{ id: a.toString(), profile_photo_url: 'https://blob/a.png?sas' }],
        });
    });

    it('drops a user whose URL could not be signed (Azure off)', async () => {
        const a = new Types.ObjectId();
        userFindMock.mockReturnValueOnce(chain([{ _id: a, profile_photo_blob_key: 'k/a.png' }]));
        photoSignMock.mockReturnValueOnce(null);
        expect((await svc.listUserPhotos([a.toString()])).data).toEqual([]);
    });
});

// ─── Redesign: a client contact's title ──────────────────────────────────

describe('updateUser — client contact title', () => {
    const adminPatch = (target: ReturnType<typeof sampleUser>, patch: unknown) => ({
        target_id: target._id as Types.ObjectId,
        caller_id: new Types.ObjectId(),
        caller_role: ROLES.ADMIN,
        caller_role_keys: [ROLES.ADMIN],
        caller_permissions: [],
        patch: patch as never,
    });

    it("lets an admin set a representative's title, keeping the rest of the client profile", async () => {
        const companyId = new Types.ObjectId();
        const t = sampleUser({ role: ROLES.REPRESENTATIVE, client_profile: { company_id: companyId, access_type: 'login' } });
        userFindByIdMock.mockResolvedValueOnce(t);

        await svc.updateUser(adminPatch(t, { client_profile: { title: 'Product owner' } }));

        const cp = t.client_profile as Record<string, unknown>;
        expect(cp.title).toBe('Product owner');
        expect(String(cp.company_id)).toBe(String(companyId));
        expect(cp.access_type).toBe('login');
    });

    it('still refuses a client profile on internal staff', async () => {
        const t = sampleUser({ role: ROLES.EMPLOYEE });
        userFindByIdMock.mockResolvedValueOnce(t);

        await expect(svc.updateUser(adminPatch(t, { client_profile: { title: 'CTO' } }))).rejects.toMatchObject({ statusCode: 400 });
    });
});

// ─── Redesign: an admin can correct a user's email ───────────────────────

describe('updateUser — email', () => {
    const asAdmin = (target: ReturnType<typeof sampleUser>, patch: unknown) => ({
        target_id: target._id as Types.ObjectId,
        caller_id: new Types.ObjectId(),
        caller_role: ROLES.ADMIN,
        caller_role_keys: [ROLES.ADMIN],
        caller_permissions: [],
        patch: patch as never,
    });

    it('lets an admin change the email when nobody else has it', async () => {
        const t = sampleUser({ role: ROLES.REPRESENTATIVE, email: 'old@x.io' });
        userFindByIdMock.mockResolvedValueOnce(t);
        userExistsMock.mockResolvedValueOnce(null);

        await svc.updateUser(asAdmin(t, { email: 'new@x.io' }));

        expect(t.email).toBe('new@x.io');
        expect(userExistsMock).toHaveBeenCalledWith({ email: 'new@x.io', _id: { $ne: t._id } });
    });

    it('refuses an email another account already uses', async () => {
        const t = sampleUser({ email: 'old@x.io' });
        userFindByIdMock.mockResolvedValueOnce(t);
        userExistsMock.mockResolvedValueOnce({ _id: new Types.ObjectId() });

        await expect(svc.updateUser(asAdmin(t, { email: 'taken@x.io' }))).rejects.toMatchObject({ code: 'EMAIL_ALREADY_EXISTS' });
        expect(t.email).toBe('old@x.io');
    });

    it('ignores an email change from someone editing their own profile', async () => {
        const t = sampleUser({ email: 'me@x.io' });
        userFindByIdMock.mockResolvedValueOnce(t);

        await svc.updateUser({
            target_id: t._id as Types.ObjectId,
            caller_id: t._id as Types.ObjectId,
            caller_role: ROLES.EMPLOYEE,
            caller_role_keys: [ROLES.EMPLOYEE],
            caller_permissions: [],
            patch: { email: 'hijack@x.io', full_name: 'Me' } as never,
        });

        expect(t.email).toBe('me@x.io');
    });
});

describe('updateUser — email change safety', () => {
    const asAdmin = (target: ReturnType<typeof sampleUser>, patch: unknown) => ({
        target_id: target._id as Types.ObjectId,
        caller_id: new Types.ObjectId(),
        caller_role: ROLES.ADMIN,
        caller_role_keys: [ROLES.ADMIN],
        caller_permissions: [],
        patch: patch as never,
    });

    it('revokes pending password links and sends a fresh invite to the new address of a client contact', async () => {
        const t = sampleUser({ role: ROLES.REPRESENTATIVE, email: 'typo@clinet.com' });
        userFindByIdMock.mockResolvedValueOnce(t);
        userExistsMock.mockResolvedValueOnce(null);

        await svc.updateUser(asAdmin(t, { email: 'jon@client.com' }));

        expect(revokePendingPasswordLinksMock).toHaveBeenCalledWith(t._id);
        expect(issuePasswordSetupLinkMock).toHaveBeenCalledWith(expect.objectContaining({ email: 'jon@client.com' }));
    });

    it('only revokes the links for internal staff (no invite)', async () => {
        const t = sampleUser({ role: ROLES.EMPLOYEE, email: 'old@x.io' });
        userFindByIdMock.mockResolvedValueOnce(t);
        userExistsMock.mockResolvedValueOnce(null);

        await svc.updateUser(asAdmin(t, { email: 'new@x.io' }));

        expect(revokePendingPasswordLinksMock).toHaveBeenCalledWith(t._id);
        expect(issuePasswordSetupLinkMock).not.toHaveBeenCalled();
    });

    it("refuses to change another admin's email (it would let one admin take over another's account)", async () => {
        const t = sampleUser({ role: ROLES.ADMIN, email: 'b@x.io' });
        userFindByIdMock.mockResolvedValueOnce(t);

        await expect(svc.updateUser(asAdmin(t, { email: 'a@x.io' }))).rejects.toMatchObject({ statusCode: 403 });
        expect(t.email).toBe('b@x.io');
    });

    it("also protects an admin whose admin role comes from extra roles (legacy role says manager)", async () => {
        const adminRole = new Types.ObjectId();
        const t = sampleUser({ role: ROLES.MANAGER, role_ids: [adminRole], email: 'b@x.io' });
        userFindByIdMock.mockResolvedValueOnce(t);
        roleKeysByIdsMock.mockResolvedValueOnce(new Map([[adminRole.toString(), 'admin']]));

        await expect(svc.updateUser(asAdmin(t, { email: 'a@x.io' }))).rejects.toMatchObject({ statusCode: 403 });
        expect(t.email).toBe('b@x.io');
    });

    it('records the change in the audit log and signs the account out everywhere', async () => {
        const t = sampleUser({ role: ROLES.EMPLOYEE, email: 'old@x.io' });
        userFindByIdMock.mockResolvedValueOnce(t);
        userExistsMock.mockResolvedValueOnce(null);
        const audit = { actor_id: new Types.ObjectId(), actor_role: 'admin' } as never;

        await svc.updateUser({ ...asAdmin(t, { email: 'new@x.io' }), audit });

        expect(recordAuditMock).toHaveBeenCalledWith(
            audit,
            expect.objectContaining({ action: 'user.email_change', before: { email: 'old@x.io' }, after: { email: 'new@x.io' } })
        );
        expect(refreshUpdateManyMock).toHaveBeenCalledWith({ user_id: t._id, revoked_at: null }, expect.anything());
    });

    it('turns a duplicate-key race on save into 409 EMAIL_ALREADY_EXISTS', async () => {
        const t = sampleUser({ role: ROLES.EMPLOYEE, email: 'old@x.io' });
        (t as unknown as { save: () => Promise<unknown> }).save = vi.fn().mockRejectedValueOnce({ code: 11000, keyPattern: { email: 1 } });
        userFindByIdMock.mockResolvedValueOnce(t);
        userExistsMock.mockResolvedValueOnce(null);

        await expect(svc.updateUser(asAdmin(t, { email: 'race@x.io' }))).rejects.toMatchObject({ code: 'EMAIL_ALREADY_EXISTS' });
    });
});
