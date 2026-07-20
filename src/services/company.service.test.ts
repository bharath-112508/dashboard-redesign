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
    recordAuditMock,
    hashPasswordMock,
} = vi.hoisted(() => ({
    companyCreateMock: vi.fn(),
    companyFindByIdMock: vi.fn(),
    companyFindMock: vi.fn(),
    companyCountMock: vi.fn(),
    userCreateMock: vi.fn(),
    userExistsMock: vi.fn(),
    userFindMock: vi.fn(),
    recordAuditMock: vi.fn(),
    hashPasswordMock: vi.fn(),
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
    User: { create: userCreateMock, exists: userExistsMock, find: userFindMock },
}));

vi.mock('./audit.service.js', () => ({
    recordAudit: recordAuditMock,
    recordSystemAudit: vi.fn(),
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
