import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Types } from 'mongoose';

/**
 * Unit tests for `company.service`.
 *
 * Coverage focus is the two things that can go badly wrong:
 *
 *  1. **Privilege escalation.** Creating a representative creates a `User`.
 *     If the role or company came from the request body, a Client holding
 *     `representative.write` could mint an admin, or plant someone in
 *     another company. Both are derived server-side; these tests pin that.
 *  2. **Cross-company access.** A `client` may only act on their OWN
 *     company — RBAC grants the verb, not the scope, so the service must
 *     enforce it.
 */

const {
    companyCreateMock,
    companyFindByIdMock,
    companyFindMock,
    companyCountMock,
    userCreateMock,
    userExistsMock,
    userFindMock,
    userFindByIdMock,
    recordAuditMock,
    hashPasswordMock,
    deactivateUserMock,
    reactivateUserMock,
    projectFindMock,
    userCountMock,
    userFindOneMock,
} = vi.hoisted(() => ({
    companyCreateMock: vi.fn(),
    companyFindByIdMock: vi.fn(),
    companyFindMock: vi.fn(),
    companyCountMock: vi.fn(),
    userCreateMock: vi.fn(),
    userExistsMock: vi.fn(),
    userFindMock: vi.fn(),
    userFindByIdMock: vi.fn(),
    recordAuditMock: vi.fn(),
    hashPasswordMock: vi.fn(),
    deactivateUserMock: vi.fn(),
    reactivateUserMock: vi.fn(),
    projectFindMock: vi.fn(),
    userCountMock: vi.fn(),
    userFindOneMock: vi.fn(),
}));

vi.mock('../models/company.model.js', () => ({
    Company: {
        create: companyCreateMock,
        findById: companyFindByIdMock,
        find: companyFindMock,
        countDocuments: companyCountMock,
    },
    COMPANY_STATUSES: ['active', 'archived'],
}));

vi.mock('../models/user.model.js', () => ({
    User: {
        create: userCreateMock,
        exists: userExistsMock,
        find: userFindMock,
        findOne: userFindOneMock,
        findById: userFindByIdMock,
        countDocuments: userCountMock,
    },
}));

vi.mock('../models/project.model.js', () => ({
    Project: { find: projectFindMock },
}));

vi.mock('./audit.service.js', () => ({
    recordAudit: recordAuditMock,
    recordSystemAudit: vi.fn(),
}));

vi.mock('./user.service.js', () => ({
    deactivateUser: deactivateUserMock,
    reactivateUser: reactivateUserMock,
}));

vi.mock('../utils/password.js', () => ({ hashPassword: hashPasswordMock }));
vi.mock('../utils/password-policy.js', () => ({ assertPasswordPolicy: vi.fn() }));

const svc = await import('./company.service.js');
import { ERROR_CODES } from '../constants/error-codes.js';
import { ROLES } from '../constants/roles.js';

// ─── Helpers ─────────────────────────────────────────────────────────────

const companyId = new Types.ObjectId();

const makeCompany = (overrides: Record<string, unknown> = {}) => ({
    _id: companyId,
    name: 'Alnarp Holding AB',
    status: 'active',
    save: vi.fn(),
    toJSON: () => ({ id: companyId.toString(), name: 'Alnarp Holding AB', status: 'active' }),
    ...overrides,
});

const adminCaller = () => ({
    id: new Types.ObjectId(),
    role: ROLES.ADMIN,
    role_keys: [ROLES.ADMIN],
    audit: undefined,
});

/** A Client of `companyId` — the company-level role. */
const clientCaller = (ofCompany: Types.ObjectId = companyId) => ({
    id: new Types.ObjectId(),
    role: ROLES.CLIENT,
    role_keys: [ROLES.CLIENT],
    company_id: ofCompany,
    audit: undefined,
});

const validBody = {
    email: 'rep@alnarp.example',
    full_name: 'Anders Alnarp',
    initial_password: 'Vilje@12345',
};

beforeEach(() => {
    vi.resetAllMocks();
    hashPasswordMock.mockResolvedValue('hashed');
    userExistsMock.mockResolvedValue(null);
});

// ─── Privilege escalation ────────────────────────────────────────────────

describe('createRepresentative — role is server-derived', () => {
    it('hard-codes role=representative', async () => {
        companyFindByIdMock.mockResolvedValueOnce(makeCompany());
        userCreateMock.mockResolvedValueOnce({ _id: new Types.ObjectId(), toJSON: () => ({}) });

        await svc.createRepresentative(companyId, validBody, adminCaller());

        expect(userCreateMock).toHaveBeenCalledWith(expect.objectContaining({ role: ROLES.REPRESENTATIVE }));
    });

    it('ignores a role smuggled through the body — never creates an admin', async () => {
        // The strict validator rejects this at the route layer; this pins
        // the service too, so the guarantee doesn't rest on one layer.
        companyFindByIdMock.mockResolvedValueOnce(makeCompany());
        userCreateMock.mockResolvedValueOnce({ _id: new Types.ObjectId(), toJSON: () => ({}) });

        await svc.createRepresentative(companyId, { ...validBody, role: ROLES.ADMIN } as never, clientCaller());

        const payload = userCreateMock.mock.calls[0][0] as { role: string };
        expect(payload.role).toBe(ROLES.REPRESENTATIVE);
        expect(payload.role).not.toBe(ROLES.ADMIN);
    });

    it('takes company_id from the URL, not the body', async () => {
        companyFindByIdMock.mockResolvedValueOnce(makeCompany());
        userCreateMock.mockResolvedValueOnce({ _id: new Types.ObjectId(), toJSON: () => ({}) });
        const otherCompany = new Types.ObjectId();

        await svc.createRepresentative(
            companyId,
            { ...validBody, company_id: otherCompany.toString() } as never,
            adminCaller()
        );

        const payload = userCreateMock.mock.calls[0][0] as {
            client_profile: { company_id: Types.ObjectId };
        };
        expect(payload.client_profile.company_id).toEqual(companyId);
        expect(payload.client_profile.company_id).not.toEqual(otherCompany);
    });
});

// ─── Cross-company scope ─────────────────────────────────────────────────

describe('createRepresentative — company scope', () => {
    it('a client of ANOTHER company is refused', async () => {
        companyFindByIdMock.mockResolvedValueOnce(makeCompany());

        await expect(
            svc.createRepresentative(companyId, validBody, clientCaller(new Types.ObjectId()))
        ).rejects.toMatchObject({ code: ERROR_CODES.FORBIDDEN });

        expect(userCreateMock).not.toHaveBeenCalled();
    });

    it('a client of THIS company is allowed', async () => {
        companyFindByIdMock.mockResolvedValueOnce(makeCompany());
        userCreateMock.mockResolvedValueOnce({ _id: new Types.ObjectId(), toJSON: () => ({}) });

        await svc.createRepresentative(companyId, validBody, clientCaller());

        expect(userCreateMock).toHaveBeenCalledOnce();
    });

    it('an admin may act on any company', async () => {
        companyFindByIdMock.mockResolvedValueOnce(makeCompany());
        userCreateMock.mockResolvedValueOnce({ _id: new Types.ObjectId(), toJSON: () => ({}) });

        await svc.createRepresentative(companyId, validBody, adminCaller());

        expect(userCreateMock).toHaveBeenCalledOnce();
    });

    it('refuses a duplicate email', async () => {
        companyFindByIdMock.mockResolvedValueOnce(makeCompany());
        userExistsMock.mockResolvedValueOnce({ _id: new Types.ObjectId() });

        await expect(svc.createRepresentative(companyId, validBody, adminCaller())).rejects.toMatchObject({
            code: ERROR_CODES.EMAIL_ALREADY_EXISTS,
        });
        expect(userCreateMock).not.toHaveBeenCalled();
    });

    it('refuses to add representatives to an archived company', async () => {
        companyFindByIdMock.mockResolvedValueOnce(makeCompany({ status: 'archived' }));

        await expect(svc.createRepresentative(companyId, validBody, adminCaller())).rejects.toMatchObject({
            code: ERROR_CODES.VALIDATION_ERROR,
        });
        expect(userCreateMock).not.toHaveBeenCalled();
    });
});

// ─── Listing ─────────────────────────────────────────────────────────────

describe('listCompanies', () => {
    const stubList = (): void => {
        companyFindMock.mockReturnValueOnce({
            collation: () => ({
                sort: () => ({ skip: () => ({ limit: () => Promise.resolve([]) }) }),
            }),
        });
        companyCountMock.mockResolvedValueOnce(0);
    };

    it('narrows a client-side caller to their own company', async () => {
        // Without this a Client would get the full customer list — every
        // other client's name.
        stubList();
        const caller = clientCaller();

        await svc.listCompanies({ page: 1, limit: 20 }, caller);

        expect(companyFindMock).toHaveBeenCalledWith(expect.objectContaining({ _id: caller.company_id }));
    });

    it('does not narrow for an admin', async () => {
        stubList();
        await svc.listCompanies({ page: 1, limit: 20 }, adminCaller());
        expect(companyFindMock).toHaveBeenCalledWith({});
    });

    it('returns nothing for a client-side caller with no company', async () => {
        const result = await svc.listCompanies(
            { page: 1, limit: 20 },
            {
                id: new Types.ObjectId(),
                role: ROLES.CLIENT,
                role_keys: [ROLES.CLIENT],
                company_id: undefined,
                audit: undefined,
            }
        );

        expect(result.data).toEqual([]);
        expect(companyFindMock).not.toHaveBeenCalled();
    });
});

describe('getCompany — client scope', () => {
    it('a client can read their OWN company', async () => {
        // This path was UNREACHABLE before the route gate was widened:
        // GET /companies/:id required company.read, which a client doesn't
        // hold, so assertCallerOwnsCompany never ran.
        companyFindByIdMock.mockResolvedValueOnce(makeCompany());

        const out = await svc.getCompany(companyId, clientCaller());

        expect(out).toMatchObject({ id: companyId.toString() });
    });

    it('a client canNOT read ANOTHER company', async () => {
        companyFindByIdMock.mockResolvedValueOnce(makeCompany());

        await expect(svc.getCompany(companyId, clientCaller(new Types.ObjectId()))).rejects.toMatchObject({
            code: ERROR_CODES.FORBIDDEN,
        });
    });
});

/**
 * Regression: a Manager holds `company.read`, could list companies, and was
 * 403'd opening every one of them.
 *
 * `assertCallerOwnsCompany` returned early only for `isAdminLike` (admin-only)
 * or a matching `caller.company_id` — which `authenticate` sets from
 * `client_profile.company_id` and is undefined for EVERY staff role. So a
 * Manager fell through to the throw on all three detail reads, while
 * `listCompanies` (which narrows by role, not ownership) worked. The frontend
 * routes Managers to `/companies/:id`, so clicking a directory row 403'd.
 *
 * The reads now use `assertCanReadCompany`, which scopes client-side callers
 * only. Authorization stays where it belongs: the route-layer gate.
 */
describe('getCompany — staff scope (regression)', () => {
    /** A staff role with no `company_id` — the shape every non-client caller has. */
    const managerCaller = () => ({
        id: new Types.ObjectId(),
        role: ROLES.MANAGER,
        role_keys: [ROLES.MANAGER],
        audit: undefined,
    });

    it('a manager can read a company detail', async () => {
        companyFindByIdMock.mockResolvedValueOnce(makeCompany());

        const out = await svc.getCompany(companyId, managerCaller());

        expect(out).toMatchObject({ id: companyId.toString() });
    });

    it('a manager can read any company, not just one', async () => {
        // `makeCompany` is pinned to `companyId`; override `_id` so this is a
        // genuinely different company and not the same row under another name.
        const other = new Types.ObjectId();
        companyFindByIdMock.mockResolvedValueOnce(makeCompany({ _id: other }));

        await expect(svc.getCompany(other, managerCaller())).resolves.toBeDefined();
    });

    it('the relaxation does NOT extend to mutations — a manager cannot add a representative', async () => {
        // The strict guard is deliberately kept on the write paths: a custom
        // role granted `representative.write` must not reach another company's
        // roster. `representative.write` is client-bundle-only today, so this
        // asserts the guard, not the route gate.
        companyFindByIdMock.mockResolvedValueOnce(makeCompany());

        await expect(svc.createRepresentative(companyId, validBody, managerCaller())).rejects.toMatchObject({
            code: ERROR_CODES.FORBIDDEN,
        });
    });
});

describe('removeRepresentative', () => {
    const userFindByIdChain = (row: unknown) => ({
        select: () => ({ lean: () => Promise.resolve(row) }),
    });

    const repRow = (overrides: Record<string, unknown> = {}) => ({
        _id: new Types.ObjectId(),
        role: ROLES.REPRESENTATIVE,
        status: 'active',
        client_profile: { company_id: companyId },
        ...overrides,
    });

    beforeEach(() => {
        deactivateUserMock.mockResolvedValue({ id: 'x', status: 'deactivated' });
    });

    it('a client can remove a representative of their own company', async () => {
        const rep = repRow();
        companyFindByIdMock.mockResolvedValueOnce(makeCompany());
        userFindByIdMock.mockReturnValueOnce(userFindByIdChain(rep));

        await svc.removeRepresentative(companyId, rep._id, clientCaller());

        expect(deactivateUserMock).toHaveBeenCalledWith(expect.objectContaining({ target_id: rep._id }));
    });

    it('a client canNOT remove a company-level client', async () => {
        // Letting them would risk locking the company out of managing its
        // own people — recoverable only by an admin.
        const other = repRow({ role: ROLES.CLIENT });
        companyFindByIdMock.mockResolvedValueOnce(makeCompany());
        userFindByIdMock.mockReturnValueOnce(userFindByIdChain(other));

        await expect(svc.removeRepresentative(companyId, other._id, clientCaller())).rejects.toMatchObject({
            code: ERROR_CODES.FORBIDDEN,
        });

        expect(deactivateUserMock).not.toHaveBeenCalled();
    });

    it('an admin CAN remove a company-level client', async () => {
        const other = repRow({ role: ROLES.CLIENT });
        companyFindByIdMock.mockResolvedValueOnce(makeCompany());
        userFindByIdMock.mockReturnValueOnce(userFindByIdChain(other));

        await svc.removeRepresentative(companyId, other._id, adminCaller());

        expect(deactivateUserMock).toHaveBeenCalledOnce();
    });

    it('refuses a target belonging to ANOTHER company', async () => {
        // The load-bearing scope check: without it, a client could
        // deactivate anyone whose id they guessed.
        const foreign = repRow({ client_profile: { company_id: new Types.ObjectId() } });
        companyFindByIdMock.mockResolvedValueOnce(makeCompany());
        userFindByIdMock.mockReturnValueOnce(userFindByIdChain(foreign));

        await expect(svc.removeRepresentative(companyId, foreign._id, clientCaller())).rejects.toMatchObject({
            code: ERROR_CODES.USER_NOT_FOUND,
        });

        expect(deactivateUserMock).not.toHaveBeenCalled();
    });

    it('refuses a STAFF target (an admin id guessed at this route)', async () => {
        const staff = repRow({ role: ROLES.ADMIN, client_profile: undefined });
        companyFindByIdMock.mockResolvedValueOnce(makeCompany());
        userFindByIdMock.mockReturnValueOnce(userFindByIdChain(staff));

        await expect(svc.removeRepresentative(companyId, staff._id, clientCaller())).rejects.toMatchObject({
            code: ERROR_CODES.USER_NOT_FOUND,
        });

        expect(deactivateUserMock).not.toHaveBeenCalled();
    });

    it("a client of ANOTHER company can't reach this company at all", async () => {
        companyFindByIdMock.mockResolvedValueOnce(makeCompany());

        await expect(
            svc.removeRepresentative(companyId, new Types.ObjectId(), clientCaller(new Types.ObjectId()))
        ).rejects.toMatchObject({ code: ERROR_CODES.FORBIDDEN });
    });
});

describe('createCompany', () => {
    it('maps a duplicate-name E11000 to 409 DUPLICATE_RESOURCE', async () => {
        // The case-insensitive unique index is what stops "TCS" and "tcs"
        // becoming two companies — free-text company_name had no such guard.
        companyCreateMock.mockRejectedValueOnce({ code: 11000, keyPattern: { name: 1 } });

        await expect(svc.createCompany({ name: 'TCS' }, adminCaller())).rejects.toMatchObject({
            code: ERROR_CODES.DUPLICATE_RESOURCE,
        });
    });
});

// ─── listRepresentatives — whose projects are whose ──────────────────────
//
// The rule this pins: a company-level `client` gets access from the
// project's `company_id`, so their list is EVERY project of the company.
// A `representative` gets access from the roster, so theirs is only the
// projects naming them. Deriving a client's list from the roster instead
// would under-report — the roster entry for a client is a denormalised
// mirror that may drift, and the UI would then contradict what they can
// actually open.

describe('listRepresentatives — project scoping per role', () => {
    const client = {
        _id: new Types.ObjectId(),
        full_name: 'Henrik',
        email: 'h@x.io',
        role: ROLES.CLIENT,
        status: 'active',
    };
    const rep = {
        _id: new Types.ObjectId(),
        full_name: 'Sofia',
        email: 's@x.io',
        role: ROLES.REPRESENTATIVE,
        status: 'active',
    };

    const projA = { _id: new Types.ObjectId(), name: 'Fleet Dashboard', code: 'NFD', representative_ids: [rep._id] };
    // Deliberately does NOT name the rep — and does not name the client
    // either, mirroring roster drift.
    const projB = { _id: new Types.ObjectId(), name: 'Depot Rollout', code: 'DEP', representative_ids: [] };

    /** `Project.find().select().sort().lean()` */
    const projectChain = (rows: unknown[]) => ({
        select: () => ({ sort: () => ({ lean: () => Promise.resolve(rows) }) }),
    });

    /** `User.find().select().sort().skip().limit().lean()` — captures the
     *  skip/limit so pagination can be asserted rather than assumed. */
    const seen: { skip?: number; limit?: number } = {};
    const userChain = (rows: unknown[]) => ({
        select: () => ({
            sort: () => ({
                skip: (n: number) => {
                    seen.skip = n;
                    return {
                        limit: (l: number) => {
                            seen.limit = l;
                            return { lean: () => Promise.resolve(rows) };
                        },
                    };
                },
            }),
        }),
    });

    const PAGE = { page: 1, limit: 20 };

    const stub = (people: unknown[], projects: unknown[], total = people.length) => {
        companyFindByIdMock.mockResolvedValueOnce(makeCompany());
        userFindMock.mockReturnValueOnce(userChain(people));
        userCountMock.mockResolvedValueOnce(total);
        projectFindMock.mockReturnValueOnce(projectChain(projects));
    };

    it('gives a company-level client EVERY company project, roster or not', async () => {
        stub([client], [projA, projB]);

        const { data } = await svc.listRepresentatives(companyId, PAGE, adminCaller());
        const row = data[0];

        expect(row.project_access).toBe('company');
        expect((row.projects as { code: string }[]).map((p) => p.code).sort()).toEqual(['DEP', 'NFD']);
    });

    it('gives a representative ONLY the projects naming them', async () => {
        stub([rep], [projA, projB]);

        const { data } = await svc.listRepresentatives(companyId, PAGE, adminCaller());
        const row = data[0];

        expect(row.project_access).toBe('assigned');
        expect((row.projects as { code: string }[]).map((p) => p.code)).toEqual(['NFD']);
    });

    it('a representative on no project gets an empty list, not every project', async () => {
        const lonely = { ...rep, _id: new Types.ObjectId() };
        stub([lonely], [projA, projB]);

        const { data } = await svc.listRepresentatives(companyId, PAGE, adminCaller());

        expect(data[0].projects).toEqual([]);
    });

    it('resolves both people from a single project query (no per-person N+1)', async () => {
        stub([client, rep], [projA, projB]);

        const { data } = await svc.listRepresentatives(companyId, PAGE, adminCaller());

        expect(projectFindMock).toHaveBeenCalledTimes(1);
        expect(data).toHaveLength(2);
        expect((data[0].projects as unknown[]).length).toBe(2); // client → all
        expect((data[1].projects as unknown[]).length).toBe(1); // rep → assigned
    });

    it("a client of ANOTHER company can't list this company's people", async () => {
        companyFindByIdMock.mockResolvedValueOnce(makeCompany());

        await expect(
            svc.listRepresentatives(companyId, PAGE, clientCaller(new Types.ObjectId()))
        ).rejects.toMatchObject({
            code: ERROR_CODES.FORBIDDEN,
        });
    });
});

// ─── listRepresentatives — pagination ────────────────────────────────────

describe('listRepresentatives — pagination', () => {
    const person = (n: number) => ({
        _id: new Types.ObjectId(),
        full_name: `Person ${n}`,
        email: `p${n}@x.io`,
        role: ROLES.REPRESENTATIVE,
        status: 'active',
    });

    let seen: { skip?: number; limit?: number };

    const stub = (rows: unknown[], total: number) => {
        seen = {};
        companyFindByIdMock.mockResolvedValueOnce(makeCompany());
        userFindMock.mockReturnValueOnce({
            select: () => ({
                sort: () => ({
                    skip: (n: number) => {
                        seen.skip = n;
                        return {
                            limit: (l: number) => {
                                seen.limit = l;
                                return { lean: () => Promise.resolve(rows) };
                            },
                        };
                    },
                }),
            }),
        });
        userCountMock.mockResolvedValueOnce(total);
        projectFindMock.mockReturnValueOnce({
            select: () => ({ sort: () => ({ lean: () => Promise.resolve([]) }) }),
        });
    };

    it('translates page/limit into skip/limit at the DB layer', async () => {
        // Slicing in memory would still "work" for the caller while loading
        // every person into the process — this pins that it's a real query.
        stub([person(11)], 24);

        await svc.listRepresentatives(companyId, { page: 2, limit: 10 }, adminCaller());

        expect(seen).toEqual({ skip: 10, limit: 10 });
    });

    it('reports total and total_pages from a count, not the page length', async () => {
        stub([person(1), person(2)], 24);

        const { meta } = await svc.listRepresentatives(companyId, { page: 1, limit: 10 }, adminCaller());

        expect(meta).toMatchObject({ page: 1, limit: 10, total: 24, total_pages: 3 });
    });

    it('reports total_pages 1 for an empty company (never 0)', async () => {
        // A 0 would make the pager render "Page 1 of 0".
        stub([], 0);

        const { meta } = await svc.listRepresentatives(companyId, { page: 1, limit: 10 }, adminCaller());

        expect(meta.total_pages).toBe(1);
        expect(meta.total).toBe(0);
    });
});

// ─── getRepresentative — the fetch-one pagination forced ─────────────────

describe('getRepresentative', () => {
    const rep = {
        _id: new Types.ObjectId(),
        full_name: 'Sofia',
        email: 's@x.io',
        role: ROLES.REPRESENTATIVE,
        status: 'active',
    };
    const proj = {
        _id: new Types.ObjectId(),
        name: 'Fleet Dashboard',
        code: 'NFD',
        representative_ids: [rep._id],
    };

    const stub = (found: unknown, projects: unknown[] = [proj]) => {
        companyFindByIdMock.mockResolvedValueOnce(makeCompany());
        userFindOneMock.mockReturnValueOnce({ select: () => ({ lean: () => Promise.resolve(found) }) });
        projectFindMock.mockReturnValueOnce({
            select: () => ({ sort: () => ({ lean: () => Promise.resolve(projects) }) }),
        });
    };

    it('returns the person with the same project scoping as the list', async () => {
        stub(rep);

        const row = await svc.getRepresentative(companyId, rep._id, adminCaller());

        expect(row).toMatchObject({ full_name: 'Sofia', project_access: 'assigned' });
        expect((row.projects as { code: string }[]).map((p) => p.code)).toEqual(['NFD']);
    });

    it('scopes the lookup to THIS company, so a foreign id is 404 not 403', async () => {
        // 403 would confirm the id exists in some other company.
        stub(null);

        await expect(svc.getRepresentative(companyId, new Types.ObjectId(), adminCaller())).rejects.toMatchObject({
            code: ERROR_CODES.USER_NOT_FOUND,
        });
    });

    it('constrains the query itself by company + client-side role', async () => {
        // Asserting the 404 above is not enough: the mock returns whatever
        // it's told regardless of the filter, so a lookup that dropped the
        // company scope would still pass it. This pins the filter, which is
        // what actually stops company A reading company B's person.
        const foreign = new Types.ObjectId();
        stub(rep);

        await svc.getRepresentative(companyId, rep._id, adminCaller());

        const filter = userFindOneMock.mock.calls[0][0] as Record<string, unknown>;
        expect(filter).toMatchObject({
            _id: rep._id,
            'client_profile.company_id': companyId,
        });
        expect(filter.role).toBeDefined(); // client-side roles only
        expect(filter['client_profile.company_id']).not.toEqual(foreign);
    });

    it("a client of ANOTHER company can't fetch a person here", async () => {
        companyFindByIdMock.mockResolvedValueOnce(makeCompany());

        await expect(
            svc.getRepresentative(companyId, rep._id, clientCaller(new Types.ObjectId()))
        ).rejects.toMatchObject({ code: ERROR_CODES.FORBIDDEN });
    });
});

// ─── listRepresentatives — search ────────────────────────────────────────

describe('listRepresentatives — search', () => {
    let captured: Record<string, unknown> | undefined;

    const stub = () => {
        captured = undefined;
        companyFindByIdMock.mockResolvedValueOnce(makeCompany());
        userFindMock.mockImplementationOnce((f: Record<string, unknown>) => {
            captured = f;
            return {
                select: () => ({
                    sort: () => ({ skip: () => ({ limit: () => ({ lean: () => Promise.resolve([]) }) }) }),
                }),
            };
        });
        userCountMock.mockResolvedValueOnce(0);
        projectFindMock.mockReturnValueOnce({
            select: () => ({ sort: () => ({ lean: () => Promise.resolve([]) }) }),
        });
    };

    it('matches name OR email at the DB layer', async () => {
        stub();

        await svc.listRepresentatives(companyId, { page: 1, limit: 10, q: 'sofia' }, adminCaller());

        expect(captured?.$or).toEqual([
            { full_name: { $regex: 'sofia', $options: 'i' } },
            { email: { $regex: 'sofia', $options: 'i' } },
        ]);
        // Still scoped to the company — search must narrow, never widen.
        expect(captured?.['client_profile.company_id']).toEqual(companyId);
    });

    it('counts the FILTERED set, not the whole company', async () => {
        // Counting unfiltered would make the pager promise pages of results
        // that don't exist for this search.
        stub();

        await svc.listRepresentatives(companyId, { page: 1, limit: 10, q: 'sofia' }, adminCaller());

        expect(userCountMock).toHaveBeenCalledWith(expect.objectContaining({ $or: expect.any(Array) }));
    });

    it('escapes regex metacharacters instead of 500ing on them', async () => {
        // `(` is an invalid regex; unescaped it makes Mongo raise.
        stub();

        await svc.listRepresentatives(companyId, { page: 1, limit: 10, q: 'a(b' }, adminCaller());

        const or = captured?.$or as { full_name: { $regex: string } }[];
        expect(or[0].full_name.$regex).toBe('a\\(b');
    });

    it('omits the $or entirely when no search is given', async () => {
        stub();

        await svc.listRepresentatives(companyId, { page: 1, limit: 10 }, adminCaller());

        expect(captured?.$or).toBeUndefined();
    });
});

// ─── restoreRepresentative ───────────────────────────────────────────────
//
// Mirrors removal deliberately. The gate is `representative.write`, NOT
// `user.deactivate`: that bit governs reactivating ANY user, so a Client
// holding it could revive a deactivated admin.

describe('restoreRepresentative', () => {
    const memberChain = (row: unknown) => ({ select: () => ({ lean: () => Promise.resolve(row) }) });

    const person = (overrides: Record<string, unknown> = {}) => ({
        _id: new Types.ObjectId(),
        role: ROLES.REPRESENTATIVE,
        status: 'deactivated',
        client_profile: { company_id: companyId },
        ...overrides,
    });

    beforeEach(() => {
        reactivateUserMock.mockResolvedValue({ id: 'x', status: 'active' });
    });

    it('reactivates a representative of this company', async () => {
        const rep = person();
        companyFindByIdMock.mockResolvedValueOnce(makeCompany());
        userFindByIdMock.mockReturnValueOnce(memberChain(rep));

        await svc.restoreRepresentative(companyId, rep._id, clientCaller());

        expect(reactivateUserMock).toHaveBeenCalledWith(rep._id, undefined);
    });

    it('a client canNOT restore a company-level client', async () => {
        // Symmetric with removal — every company-level membership change
        // stays with an admin.
        const other = person({ role: ROLES.CLIENT });
        companyFindByIdMock.mockResolvedValueOnce(makeCompany());
        userFindByIdMock.mockReturnValueOnce(memberChain(other));

        await expect(svc.restoreRepresentative(companyId, other._id, clientCaller())).rejects.toMatchObject({
            code: ERROR_CODES.FORBIDDEN,
        });
        expect(reactivateUserMock).not.toHaveBeenCalled();
    });

    it('an admin CAN restore a company-level client', async () => {
        const other = person({ role: ROLES.CLIENT });
        companyFindByIdMock.mockResolvedValueOnce(makeCompany());
        userFindByIdMock.mockReturnValueOnce(memberChain(other));

        await svc.restoreRepresentative(companyId, other._id, adminCaller());

        expect(reactivateUserMock).toHaveBeenCalledOnce();
    });

    it('refuses a target from ANOTHER company with 404, not 403', async () => {
        const foreign = person({ client_profile: { company_id: new Types.ObjectId() } });
        companyFindByIdMock.mockResolvedValueOnce(makeCompany());
        userFindByIdMock.mockReturnValueOnce(memberChain(foreign));

        await expect(svc.restoreRepresentative(companyId, foreign._id, adminCaller())).rejects.toMatchObject({
            code: ERROR_CODES.USER_NOT_FOUND,
        });
        expect(reactivateUserMock).not.toHaveBeenCalled();
    });

    it('refuses a STAFF target guessed at this route', async () => {
        const staff = person({ role: ROLES.ADMIN, client_profile: undefined });
        companyFindByIdMock.mockResolvedValueOnce(makeCompany());
        userFindByIdMock.mockReturnValueOnce(memberChain(staff));

        await expect(svc.restoreRepresentative(companyId, staff._id, clientCaller())).rejects.toMatchObject({
            code: ERROR_CODES.USER_NOT_FOUND,
        });
        expect(reactivateUserMock).not.toHaveBeenCalled();
    });

    it("a client of ANOTHER company can't reach this company", async () => {
        companyFindByIdMock.mockResolvedValueOnce(makeCompany());

        await expect(
            svc.restoreRepresentative(companyId, new Types.ObjectId(), clientCaller(new Types.ObjectId()))
        ).rejects.toMatchObject({ code: ERROR_CODES.FORBIDDEN });
    });

    it('refuses to restore into an ARCHIVED company', async () => {
        // Mirrors createRepresentative: an archived company must not gain
        // active logins.
        companyFindByIdMock.mockResolvedValueOnce(makeCompany({ status: 'archived' }));

        await expect(svc.restoreRepresentative(companyId, new Types.ObjectId(), adminCaller())).rejects.toMatchObject({
            code: ERROR_CODES.VALIDATION_ERROR,
        });
        expect(reactivateUserMock).not.toHaveBeenCalled();
    });
});
