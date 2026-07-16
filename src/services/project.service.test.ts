import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Types } from 'mongoose';

/**
 * Unit tests for `project.service` (Step 16).
 *
 * Coverage focus:
 *  1. Visibility scoping in `listProjects` — the role → filter mapping is the
 *     single guardrail keeping employees from seeing every project, so the
 *     admin / manager / employee / client / unknown-role matrix is exhaustive.
 *  2. `createProject` — duplicate-`code` E11000 lifts to PROJECT_CODE_TAKEN,
 *     bad member/client roles surface as 422 with the offending IDs in
 *     `details.invalid_user_ids`.
 *  3. `getProject` — non-admin/manager callers must be in the relevant array
 *     or get 403 FORBIDDEN.
 *  4. `updateProjectMembers` / `updateProjectClients` — bulk add/remove is
 *     idempotent (re-adding existing user is a no-op) and validates role
 *     before any mutation.
 *  5. Custom statuses — key collisions inside the same project surface as
 *     409 CUSTOM_STATUS_KEY_TAKEN; listing returns defaults + sorted custom.
 *
 * Mongoose chained queries (`User.find().select().lean()`) are mocked with a
 * tiny factory so the test stays declarative.
 */

const {
    projectCreateMock,
    projectFindByIdMock,
    projectFindMock,
    projectCountDocumentsMock,
    projectFindOneMock,
    userFindMock,
    recordAuditMock,
    sprintCountDocumentsMock,
    storyCountDocumentsMock,
    taskCountDocumentsMock,
    taskAggregateMock,
    projectUpdateOneMock,
} = vi.hoisted(() => ({
    projectCreateMock: vi.fn(),
    projectFindByIdMock: vi.fn(),
    projectFindMock: vi.fn(),
    projectCountDocumentsMock: vi.fn(),
    projectFindOneMock: vi.fn(),
    userFindMock: vi.fn(),
    recordAuditMock: vi.fn(),
    sprintCountDocumentsMock: vi.fn(),
    storyCountDocumentsMock: vi.fn(),
    taskCountDocumentsMock: vi.fn(),
    taskAggregateMock: vi.fn(),
    projectUpdateOneMock: vi.fn(),
}));

vi.mock('../models/project.model.js', () => ({
    Project: {
        create: projectCreateMock,
        findById: projectFindByIdMock,
        find: projectFindMock,
        countDocuments: projectCountDocumentsMock,
        findOne: projectFindOneMock,
        updateOne: projectUpdateOneMock,
    },
}));

vi.mock('../models/user.model.js', () => ({
    User: { find: userFindMock, findById: vi.fn() },
}));

vi.mock('../models/sprint.model.js', () => ({
    Sprint: { countDocuments: sprintCountDocumentsMock },
}));
vi.mock('../models/story.model.js', () => ({
    Story: { countDocuments: storyCountDocumentsMock },
}));
vi.mock('../models/task.model.js', () => ({
    Task: { countDocuments: taskCountDocumentsMock, aggregate: taskAggregateMock },
}));

vi.mock('./audit.service.js', () => ({
    recordAudit: recordAuditMock,
    recordSystemAudit: vi.fn(),
}));

const svc = await import('./project.service.js');
import { ERROR_CODES } from '../constants/error-codes.js';
import { ROLES } from '../constants/roles.js';
import { AppError } from '../utils/app-error.js';

// ─── Helpers ──────────────────────────────────────────────────────────────

const adminCaller = (overrides: Record<string, unknown> = {}) => ({
    id: new Types.ObjectId(),
    role: ROLES.ADMIN,
    audit: undefined,
    ...overrides,
});

const employeeCaller = (id: Types.ObjectId) => ({
    id,
    role: ROLES.EMPLOYEE,
    audit: undefined,
});

/**
 * A `client` is the COMPANY-level role — scoped by `company_id`, not by
 * roster containment. `authenticate` sets `company_id` from the DB row.
 */
const clientCaller = (id: Types.ObjectId, companyId: Types.ObjectId = new Types.ObjectId()) => ({
    id,
    role: ROLES.CLIENT,
    company_id: companyId,
    audit: undefined,
});

/**
 * A `representative` is the project-scoped client-side role — visible only
 * on projects whose `representative_ids` contain them. They carry a
 * `company_id` too, but it must NOT widen their access.
 */
const representativeCaller = (id: Types.ObjectId, companyId: Types.ObjectId = new Types.ObjectId()) => ({
    id,
    role: ROLES.REPRESENTATIVE,
    company_id: companyId,
    audit: undefined,
});

interface FakeSubArray<T extends { _id: Types.ObjectId }> extends Array<T> {
    id: (id: Types.ObjectId) => T | null;
    create: (data: Omit<T, '_id'>) => T;
    push: (sub: T) => number;
    pull: (criterion: { _id: Types.ObjectId }) => void;
}

const makeSubArray = <T extends { _id: Types.ObjectId }>(initial: T[] = []): FakeSubArray<T> => {
    const arr = initial.slice() as FakeSubArray<T>;
    arr.id = (id: Types.ObjectId) => arr.find((s) => s._id.equals(id)) ?? null;
    arr.create = (data: Omit<T, '_id'>): T => ({ _id: new Types.ObjectId(), ...data }) as T;
    const origPush = arr.push.bind(arr);
    arr.push = (sub: T) => origPush(sub);
    arr.pull = (criterion: { _id: Types.ObjectId }): void => {
        const idx = arr.findIndex((s) => s._id.equals(criterion._id));
        if (idx >= 0) arr.splice(idx, 1);
    };
    return arr;
};

interface FakeProject {
    _id: Types.ObjectId;
    name: string;
    code: string;
    description: string;
    start_date: string;
    end_date: string | null;
    status: string;
    is_archived: boolean;
    member_ids: Types.ObjectId[];
    company_id: Types.ObjectId | null;
    representative_ids: Types.ObjectId[];
    custom_task_statuses: FakeSubArray<{
        _id: Types.ObjectId;
        key: string;
        label: string;
        order: number;
        is_terminal: boolean;
    }>;
    created_by: Types.ObjectId;
    save: ReturnType<typeof vi.fn>;
    deleteOne: ReturnType<typeof vi.fn>;
    toJSON: () => Record<string, unknown>;
}

const makeProject = (overrides: Partial<FakeProject> = {}): FakeProject => {
    const proj: FakeProject = {
        _id: new Types.ObjectId(),
        name: 'Acme',
        code: 'ACME-001',
        description: '',
        start_date: '2026-01-01',
        end_date: null,
        status: 'active',
        is_archived: false,
        member_ids: [],
        company_id: null,
        representative_ids: [],
        custom_task_statuses: makeSubArray(),
        created_by: new Types.ObjectId(),
        save: vi.fn(),
        deleteOne: vi.fn(),
        toJSON() {
            return {
                id: this._id.toString(),
                name: this.name,
                code: this.code,
                description: this.description,
                start_date: this.start_date,
                end_date: this.end_date,
                status: this.status,
                is_archived: this.is_archived,
                member_ids: this.member_ids.map((m) => m.toString()),
                company_id: this.company_id ? this.company_id.toString() : null,
                representative_ids: this.representative_ids.map((c) => c.toString()),
                custom_task_statuses: this.custom_task_statuses.map((s) => ({
                    id: s._id.toString(),
                    key: s.key,
                    label: s.label,
                    order: s.order,
                    is_terminal: s.is_terminal,
                })),
            };
        },
        ...overrides,
    };
    proj.save.mockImplementation(async () => proj);
    return proj;
};

const mkUserChain = (rows: Array<{ _id: Types.ObjectId; role: string }>): { select: ReturnType<typeof vi.fn> } => ({
    select: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue(rows),
    }),
});

beforeEach(() => {
    vi.resetAllMocks();
    // R3 — `deleteProject` / `deleteCustomStatus` check dependant
    // counts before allowing the delete. Default to "no dependants" so
    // legacy happy-path tests pass; tests exercising the
    // dependant-refusal branch override per-call.
    sprintCountDocumentsMock.mockResolvedValue(0);
    storyCountDocumentsMock.mockResolvedValue(0);
    taskCountDocumentsMock.mockResolvedValue(0);
    // Task.aggregate used by listProjects rollup — default to empty (no tasks).
    taskAggregateMock.mockResolvedValue([]);
});

// ─── createProject ────────────────────────────────────────────────────────

describe('createProject', () => {
    it('persists the project and lifts E11000 on `code` to PROJECT_CODE_TAKEN', async () => {
        userFindMock.mockReturnValue(mkUserChain([])); // no member/client validation needed
        const dupErr = Object.assign(new Error('E11000'), { code: 11000, keyPattern: { code: 1 } });
        projectCreateMock.mockRejectedValueOnce(dupErr);

        await expect(
            svc.createProject(
                {
                    name: 'A',
                    code: 'DUPE-1',
                    description: '',
                    start_date: '2026-01-01',
                    end_date: null,
                    member_ids: [],
                    representative_ids: [],
                    custom_task_statuses: [],
                },
                adminCaller()
            )
        ).rejects.toMatchObject({ code: ERROR_CODES.PROJECT_CODE_TAKEN });
    });

    it('rejects member_ids that are not active internal users with INVALID_PROJECT_MEMBER_ROLE', async () => {
        const goodId = new Types.ObjectId();
        const badId = new Types.ObjectId();
        userFindMock.mockReturnValueOnce(mkUserChain([{ _id: goodId, role: ROLES.EMPLOYEE }]));

        try {
            await svc.createProject(
                {
                    name: 'A',
                    code: 'OK-1',
                    description: '',
                    start_date: '2026-01-01',
                    end_date: null,
                    member_ids: [goodId.toString(), badId.toString()],
                    representative_ids: [],
                    custom_task_statuses: [],
                },
                adminCaller()
            );
            throw new Error('should have thrown');
        } catch (err) {
            expect(err).toBeInstanceOf(AppError);
            expect((err as AppError).code).toBe(ERROR_CODES.INVALID_PROJECT_MEMBER_ROLE);
            expect((err as AppError).details).toMatchObject({ invalid_user_ids: [badId.toString()] });
        }
        expect(projectCreateMock).not.toHaveBeenCalled();
    });

    it('rejects representative_ids that do not belong to the project company', async () => {
        const companyId = new Types.ObjectId();
        const goodRep = new Types.ObjectId();
        const otherCompanyRep = new Types.ObjectId();
        // members array is empty → validateMemberCandidates short-circuits
        // without calling User.find. Only the representative validation hits
        // the mock; the query filters on company_id, so the rep belonging to
        // a DIFFERENT company simply isn't returned.
        userFindMock.mockReturnValueOnce(mkUserChain([{ _id: goodRep, role: ROLES.REPRESENTATIVE }]));

        await expect(
            svc.createProject(
                {
                    name: 'A',
                    code: 'OK-2',
                    description: '',
                    start_date: '2026-01-01',
                    end_date: null,
                    member_ids: [],
                    company_id: companyId.toString(),
                    representative_ids: [goodRep.toString(), otherCompanyRep.toString()],
                    custom_task_statuses: [],
                },
                adminCaller()
            )
        ).rejects.toMatchObject({
            code: ERROR_CODES.INVALID_PROJECT_CLIENT_ROLE,
            details: { invalid_user_ids: [otherCompanyRep.toString()] },
        });
    });

    it('happy path returns the public project and skips audit when none provided', async () => {
        userFindMock.mockReturnValue(mkUserChain([]));
        const created = makeProject({ code: 'NEW-1' });
        projectCreateMock.mockResolvedValueOnce(created);

        const out = await svc.createProject(
            {
                name: 'New',
                code: 'NEW-1',
                description: '',
                start_date: '2026-01-01',
                end_date: null,
                member_ids: [],
                representative_ids: [],
                custom_task_statuses: [],
            },
            adminCaller()
        );

        expect(out).toMatchObject({ code: 'NEW-1' });
        expect(recordAuditMock).not.toHaveBeenCalled();
    });
});

// ─── listProjects (visibility scoping) ───────────────────────────────────

describe('listProjects — visibility filter', () => {
    const stubFindChain = () => {
        projectFindMock.mockReturnValueOnce({
            sort: () => ({
                skip: () => ({
                    limit: () => Promise.resolve([]),
                }),
            }),
        });
        projectCountDocumentsMock.mockResolvedValueOnce(0);
    };

    it('admin sees no visibility filter applied', async () => {
        stubFindChain();
        await svc.listProjects({ page: 1, limit: 20 }, adminCaller());
        expect(projectFindMock).toHaveBeenCalledWith({});
        expect(projectCountDocumentsMock).toHaveBeenCalledWith({});
    });

    it('manager sees no visibility filter applied', async () => {
        stubFindChain();
        await svc.listProjects(
            { page: 1, limit: 20 },
            { id: new Types.ObjectId(), role: ROLES.MANAGER, audit: undefined }
        );
        expect(projectFindMock).toHaveBeenCalledWith({});
    });

    it('employee filters by member_ids = caller.id', async () => {
        stubFindChain();
        const empId = new Types.ObjectId();
        await svc.listProjects({ page: 1, limit: 20 }, employeeCaller(empId));
        expect(projectFindMock).toHaveBeenCalledWith({ member_ids: empId });
    });

    it('client filters by company_id — every project of their company', async () => {
        // NOT roster containment: a Client must see a project they aren't
        // rostered on, or they could never staff a newly created one.
        stubFindChain();
        const companyId = new Types.ObjectId();
        await svc.listProjects({ page: 1, limit: 20 }, clientCaller(new Types.ObjectId(), companyId));
        expect(projectFindMock).toHaveBeenCalledWith({ company_id: companyId });
    });

    it('representative filters by representative_ids = caller.id', async () => {
        stubFindChain();
        const repId = new Types.ObjectId();
        await svc.listProjects({ page: 1, limit: 20 }, representativeCaller(repId));
        expect(projectFindMock).toHaveBeenCalledWith({ representative_ids: repId });
    });

    it('a client with NO company sees nothing rather than everything', async () => {
        // The dangerous failure mode: falling back to `{}` would hand a
        // company-less client the entire org.
        stubFindChain();
        await svc.listProjects(
            { page: 1, limit: 20 },
            { id: new Types.ObjectId(), role: ROLES.CLIENT, company_id: undefined, audit: undefined }
        );
        const calledWith = projectFindMock.mock.calls[0][0] as Record<string, unknown>;
        expect(calledWith).not.toEqual({});
        expect(calledWith._id).toBeDefined();
    });

    it('combines status / is_archived / q on top of the visibility filter', async () => {
        stubFindChain();
        const empId = new Types.ObjectId();
        await svc.listProjects(
            { page: 1, limit: 20, status: 'active', is_archived: false, q: 'acme' },
            employeeCaller(empId)
        );
        const calledWith = projectFindMock.mock.calls[0][0] as Record<string, unknown>;
        expect(calledWith.member_ids).toEqual(empId);
        expect(calledWith.status).toBe('active');
        expect(calledWith.is_archived).toBe(false);
        expect(Array.isArray(calledWith.$or)).toBe(true);
    });
});

// ─── getProject (per-doc access check) ───────────────────────────────────

describe('getProject — read access', () => {
    it('manager always passes', async () => {
        const proj = makeProject();
        projectFindByIdMock.mockResolvedValueOnce(proj);
        const out = await svc.getProject(proj._id, {
            id: new Types.ObjectId(),
            role: ROLES.MANAGER,
            audit: undefined,
        });
        expect(out).toMatchObject({ id: proj._id.toString() });
    });

    it('employee NOT in member_ids gets 403 FORBIDDEN', async () => {
        const proj = makeProject({ member_ids: [new Types.ObjectId()] });
        projectFindByIdMock.mockResolvedValueOnce(proj);
        await expect(svc.getProject(proj._id, employeeCaller(new Types.ObjectId()))).rejects.toMatchObject({
            code: ERROR_CODES.FORBIDDEN,
        });
    });

    it('employee IN member_ids passes', async () => {
        const empId = new Types.ObjectId();
        const proj = makeProject({ member_ids: [empId] });
        projectFindByIdMock.mockResolvedValueOnce(proj);
        const out = await svc.getProject(proj._id, employeeCaller(empId));
        expect(out).toMatchObject({ id: proj._id.toString() });
    });

    it('client of ANOTHER company gets 403 FORBIDDEN', async () => {
        const proj = makeProject({ company_id: new Types.ObjectId() });
        projectFindByIdMock.mockResolvedValueOnce(proj);
        await expect(
            svc.getProject(proj._id, clientCaller(new Types.ObjectId(), new Types.ObjectId()))
        ).rejects.toMatchObject({ code: ERROR_CODES.FORBIDDEN });
    });

    it('client of the project company passes WITHOUT being on the roster', async () => {
        // Mirrors the list filter. If assertCallerCanRead and
        // buildVisibilityFilter ever disagree, a list and a get would
        // answer differently for the same caller.
        const companyId = new Types.ObjectId();
        const proj = makeProject({ company_id: companyId, representative_ids: [] });
        projectFindByIdMock.mockResolvedValueOnce(proj);
        const out = await svc.getProject(proj._id, clientCaller(new Types.ObjectId(), companyId));
        expect(out).toMatchObject({ id: proj._id.toString() });
    });

    it('representative NOT in representative_ids gets 403 FORBIDDEN', async () => {
        const companyId = new Types.ObjectId();
        // Same company — but not rostered. A representative is roster-scoped,
        // so company membership alone must NOT grant access.
        const proj = makeProject({ company_id: companyId, representative_ids: [new Types.ObjectId()] });
        projectFindByIdMock.mockResolvedValueOnce(proj);
        await expect(
            svc.getProject(proj._id, representativeCaller(new Types.ObjectId(), companyId))
        ).rejects.toMatchObject({ code: ERROR_CODES.FORBIDDEN });
    });

    it('representative IN representative_ids passes', async () => {
        const repId = new Types.ObjectId();
        const proj = makeProject({ company_id: new Types.ObjectId(), representative_ids: [repId] });
        projectFindByIdMock.mockResolvedValueOnce(proj);
        const out = await svc.getProject(proj._id, representativeCaller(repId));
        expect(out).toMatchObject({ id: proj._id.toString() });
    });

    it('missing project → 404 PROJECT_NOT_FOUND', async () => {
        projectFindByIdMock.mockResolvedValueOnce(null);
        await expect(svc.getProject(new Types.ObjectId(), adminCaller())).rejects.toMatchObject({
            code: ERROR_CODES.PROJECT_NOT_FOUND,
        });
    });
});

// ─── updateProject ───────────────────────────────────────────────────────

describe('updateProject', () => {
    it('rejects with PROJECT_DATE_INVALID when end_date < start_date after patch', async () => {
        const proj = makeProject({ start_date: '2026-06-01', end_date: '2026-12-31' });
        projectFindByIdMock.mockResolvedValueOnce(proj);

        await expect(svc.updateProject(proj._id, { end_date: '2026-01-01' }, adminCaller())).rejects.toMatchObject({
            code: ERROR_CODES.PROJECT_DATE_INVALID,
        });
        expect(proj.save).not.toHaveBeenCalled();
    });

    it('happy path saves and reflects field changes', async () => {
        const proj = makeProject({ name: 'Old', status: 'active' });
        projectFindByIdMock.mockResolvedValueOnce(proj);

        const out = await svc.updateProject(proj._id, { name: 'New', status: 'on_hold' }, adminCaller());

        expect(proj.save).toHaveBeenCalledTimes(1);
        expect(out).toMatchObject({ name: 'New', status: 'on_hold' });
    });
});

// ─── updateProjectMembers (bulk add/remove + role validation) ────────────

describe('updateProjectMembers', () => {
    it('F4 — uses atomic $pull + $addToSet (no doc.save), validates role for new adds', async () => {
        const u1 = new Types.ObjectId();
        const u2 = new Types.ObjectId();
        const u3 = new Types.ObjectId();
        const proj = makeProject({ member_ids: [u1, u2] });
        // Two findById calls now: once for before-snapshot + validation,
        // once for the post-update audit + response.
        projectFindByIdMock.mockResolvedValueOnce(proj).mockResolvedValueOnce(proj);
        userFindMock.mockReturnValueOnce(mkUserChain([{ _id: u3, role: ROLES.EMPLOYEE }]));
        projectUpdateOneMock.mockResolvedValue({ modifiedCount: 1 });

        await svc.updateProjectMembers(
            proj._id,
            { add: [u3.toString(), u1.toString()], remove: [u2.toString()] },
            adminCaller()
        );

        // Pin the atomic shape: a $pull for removes and a $addToSet for adds.
        const calls = projectUpdateOneMock.mock.calls;
        const pullCall = calls.find((c) => '$pull' in (c[1] as Record<string, unknown>));
        const addCall = calls.find((c) => '$addToSet' in (c[1] as Record<string, unknown>));
        expect(pullCall).toBeDefined();
        expect(addCall).toBeDefined();
        const pullArg = (pullCall![1] as { $pull: { member_ids: { $in: Types.ObjectId[] } } }).$pull;
        expect(pullArg.member_ids.$in.map((o) => o.toString())).toEqual([u2.toString()]);
        // doc.save MUST NOT be called.
        expect(proj.save).not.toHaveBeenCalled();
    });

    it('throws INVALID_PROJECT_MEMBER_ROLE before any updateOne fires', async () => {
        const u1 = new Types.ObjectId();
        const bad = new Types.ObjectId();
        const proj = makeProject({ member_ids: [u1] });
        projectFindByIdMock.mockResolvedValueOnce(proj);
        userFindMock.mockReturnValueOnce(mkUserChain([])); // bad doesn't come back

        await expect(
            svc.updateProjectMembers(proj._id, { add: [bad.toString()], remove: [] }, adminCaller())
        ).rejects.toMatchObject({ code: ERROR_CODES.INVALID_PROJECT_MEMBER_ROLE });
        expect(projectUpdateOneMock).not.toHaveBeenCalled();
    });

    it('skips both updateOne calls when add + remove are empty arrays (no-op idempotent)', async () => {
        const u1 = new Types.ObjectId();
        const proj = makeProject({ member_ids: [u1] });
        projectFindByIdMock.mockResolvedValueOnce(proj).mockResolvedValueOnce(proj);
        userFindMock.mockReturnValueOnce(mkUserChain([]));

        await svc.updateProjectMembers(proj._id, { add: [], remove: [] }, adminCaller());

        expect(projectUpdateOneMock).not.toHaveBeenCalled();
    });

    it('phantom removes still issue the $pull (Mongo no-op idempotent)', async () => {
        const u1 = new Types.ObjectId();
        const phantom = new Types.ObjectId();
        const proj = makeProject({ member_ids: [u1] });
        projectFindByIdMock.mockResolvedValueOnce(proj).mockResolvedValueOnce(proj);
        userFindMock.mockReturnValueOnce(mkUserChain([]));
        projectUpdateOneMock.mockResolvedValue({ modifiedCount: 0 });

        await svc.updateProjectMembers(proj._id, { add: [], remove: [phantom.toString()] }, adminCaller());

        // The $pull call still goes out; Mongo treats "remove a value not
        // in the array" as a no-op. The application doesn't need to
        // pre-check, so we don't.
        expect(projectUpdateOneMock).toHaveBeenCalledOnce();
    });
});

// ─── updateProject — company re-assignment ───────────────────────────────

describe('updateProject — company_id', () => {
    it('resets the roster when the company changes', async () => {
        // The people on the roster belong to the OLD company. Keeping them
        // would hand company A's people access to company B's project —
        // exactly what the roster invariant exists to prevent.
        const oldCompany = new Types.ObjectId();
        const newCompany = new Types.ObjectId();
        const oldRep = new Types.ObjectId();
        const newClient = new Types.ObjectId();
        const proj = makeProject({ company_id: oldCompany, representative_ids: [oldRep] });
        projectFindByIdMock.mockResolvedValueOnce(proj);
        // companyClientIds() -> the new company's client-role people
        userFindMock.mockReturnValueOnce(mkUserChain([{ _id: newClient, role: ROLES.CLIENT }]));

        await svc.updateProject(proj._id, { company_id: newCompany.toString() }, adminCaller());

        expect(proj.company_id).toEqual(newCompany);
        expect(proj.representative_ids).toEqual([newClient]);
        expect(proj.representative_ids).not.toContain(oldRep);
    });

    it('leaves the roster alone when the company is unchanged', async () => {
        const companyId = new Types.ObjectId();
        const rep = new Types.ObjectId();
        const proj = makeProject({ company_id: companyId, representative_ids: [rep] });
        projectFindByIdMock.mockResolvedValueOnce(proj);

        await svc.updateProject(proj._id, { company_id: companyId.toString() }, adminCaller());

        expect(proj.representative_ids).toEqual([rep]);
    });

    it('clearing the company empties the roster', async () => {
        const proj = makeProject({
            company_id: new Types.ObjectId(),
            representative_ids: [new Types.ObjectId()],
        });
        projectFindByIdMock.mockResolvedValueOnce(proj);

        await svc.updateProject(proj._id, { company_id: null }, adminCaller());

        expect(proj.company_id).toBeNull();
        expect(proj.representative_ids).toEqual([]);
    });
});

// ─── updateProjectRepresentatives (mirror of members + roster invariant) ──

describe('updateProjectRepresentatives', () => {
    it('rejects a candidate who is not an active client-side user of this company', async () => {
        const proj = makeProject({ company_id: new Types.ObjectId() });
        projectFindByIdMock.mockResolvedValueOnce(proj);
        const wrongRole = new Types.ObjectId();
        userFindMock.mockReturnValueOnce(mkUserChain([])); // no rows back

        await expect(
            svc.updateProjectRepresentatives(proj._id, { add: [wrongRole.toString()], remove: [] }, adminCaller())
        ).rejects.toMatchObject({ code: ERROR_CODES.INVALID_PROJECT_CLIENT_ROLE });
    });

    it('refuses to roster anyone onto a project with no client company', async () => {
        const proj = makeProject({ company_id: null });
        projectFindByIdMock.mockResolvedValueOnce(proj);

        await expect(
            svc.updateProjectRepresentatives(
                proj._id,
                { add: [new Types.ObjectId().toString()], remove: [] },
                adminCaller()
            )
        ).rejects.toMatchObject({ code: ERROR_CODES.INVALID_PROJECT_CLIENT_ROLE });
    });

    it("scopes the candidate query to THIS project's company", async () => {
        // The load-bearing half of the invariant: without the company
        // filter, company B's person could be rostered onto company A's
        // project.
        const companyId = new Types.ObjectId();
        const rep = new Types.ObjectId();
        const proj = makeProject({ company_id: companyId });
        projectFindByIdMock.mockResolvedValueOnce(proj).mockResolvedValueOnce(proj);
        userFindMock.mockReturnValueOnce(mkUserChain([{ _id: rep, role: ROLES.REPRESENTATIVE }]));
        projectUpdateOneMock.mockResolvedValue({ modifiedCount: 1 });

        await svc.updateProjectRepresentatives(proj._id, { add: [rep.toString()], remove: [] }, adminCaller());

        expect(userFindMock).toHaveBeenCalledWith(expect.objectContaining({ 'client_profile.company_id': companyId }));
    });

    it('a client of ANOTHER company cannot staff this project', async () => {
        // RBAC says a Client "may assign representatives"; it does not say
        // "anywhere". That scope check lives in the service.
        const proj = makeProject({ company_id: new Types.ObjectId() });
        projectFindByIdMock.mockResolvedValueOnce(proj);

        await expect(
            svc.updateProjectRepresentatives(
                proj._id,
                { add: [new Types.ObjectId().toString()], remove: [] },
                clientCaller(new Types.ObjectId(), new Types.ObjectId())
            )
        ).rejects.toMatchObject({ code: ERROR_CODES.FORBIDDEN });
    });
});

// ─── Custom statuses ─────────────────────────────────────────────────────

describe('custom statuses', () => {
    it('listCustomStatuses returns defaults + sorted custom for an admin', async () => {
        const proj = makeProject();
        proj.custom_task_statuses = makeSubArray([
            {
                _id: new Types.ObjectId(),
                key: 'qa_passed',
                label: 'QA Passed',
                order: 5,
                is_terminal: false as boolean,
            },
            { _id: new Types.ObjectId(), key: 'shipped', label: 'Shipped', order: 1, is_terminal: true as boolean },
        ]);
        projectFindByIdMock.mockResolvedValueOnce(proj);

        const out = await svc.listCustomStatuses(proj._id, adminCaller());
        expect(out.defaults.map((d) => d.key)).toEqual(['to_do', 'in_progress', 'review', 'done']);
        expect(out.custom.map((c) => c.key)).toEqual(['shipped', 'qa_passed']);
    });

    it('addCustomStatus rejects key collision with CUSTOM_STATUS_KEY_TAKEN', async () => {
        const proj = makeProject();
        proj.custom_task_statuses = makeSubArray([
            {
                _id: new Types.ObjectId(),
                key: 'qa_passed',
                label: 'QA Passed',
                order: 5,
                is_terminal: false as boolean,
            },
        ]);
        projectFindByIdMock.mockResolvedValueOnce(proj);

        await expect(
            svc.addCustomStatus(
                proj._id,
                {
                    key: 'qa_passed',
                    label: 'QA Again',
                    order: 6,
                    is_terminal: false,
                    is_active: true,
                },
                adminCaller()
            )
        ).rejects.toMatchObject({ code: ERROR_CODES.CUSTOM_STATUS_KEY_TAKEN });
        expect(proj.save).not.toHaveBeenCalled();
    });

    it('addCustomStatus pushes a new sub-doc on success', async () => {
        const proj = makeProject();
        projectFindByIdMock.mockResolvedValueOnce(proj);

        const out = await svc.addCustomStatus(
            proj._id,
            {
                key: 'qa_passed',
                label: 'QA Passed',
                order: 5,
                is_terminal: false,
                is_active: true,
            },
            adminCaller()
        );

        expect(proj.save).toHaveBeenCalled();
        expect(out).toMatchObject({ key: 'qa_passed', label: 'QA Passed', order: 5, is_terminal: false });
        expect(proj.custom_task_statuses.length).toBe(1);
    });

    it('deleteCustomStatus pulls the sub-doc from the owning project', async () => {
        const proj = makeProject();
        const subId = new Types.ObjectId();
        proj.custom_task_statuses = makeSubArray([
            { _id: subId, key: 'qa_passed', label: 'QA Passed', order: 5, is_terminal: false as boolean },
        ]);
        projectFindOneMock.mockResolvedValueOnce(proj);

        await svc.deleteCustomStatus(subId, adminCaller());

        expect(proj.save).toHaveBeenCalled();
        expect(proj.custom_task_statuses.length).toBe(0);
    });

    it('deleteCustomStatus refuses when tasks still use the status (R3)', async () => {
        const proj = makeProject();
        const subId = new Types.ObjectId();
        proj.custom_task_statuses = makeSubArray([
            { _id: subId, key: 'qa_passed', label: 'QA Passed', order: 5, is_terminal: false as boolean },
        ]);
        projectFindOneMock.mockResolvedValueOnce(proj);
        taskCountDocumentsMock.mockResolvedValueOnce(7);

        await expect(svc.deleteCustomStatus(subId, adminCaller())).rejects.toMatchObject({
            code: ERROR_CODES.RESOURCE_HAS_DEPENDENTS,
            details: { tasks: 7, status_key: 'qa_passed' },
        });
        // Sub-doc must still be intact + project not saved.
        expect(proj.custom_task_statuses.length).toBe(1);
        expect(proj.save).not.toHaveBeenCalled();
    });
});

// ─── listProjects — task-completion rollup ───────────────────────────────

describe('listProjects — task-completion rollup', () => {
    /** Minimal Mongoose doc fake: toPublic/toJSON returns the plain object. */
    const makeRowDoc = (
        overrides: Partial<{
            _id: Types.ObjectId;
            custom_task_statuses: { key: string; is_terminal: boolean }[];
        }> = {}
    ) => {
        const id = overrides._id ?? new Types.ObjectId();
        const cts = overrides.custom_task_statuses ?? [];
        return {
            _id: id,
            name: 'P',
            code: 'P-1',
            description: '',
            start_date: '2026-01-01',
            end_date: null,
            status: 'active',
            is_archived: false,
            member_ids: [],
            representative_ids: [],
            custom_task_statuses: cts,
            toJSON() {
                return {
                    id: this._id.toString(),
                    name: this.name,
                    code: this.code,
                    custom_task_statuses: cts,
                    task_count: (this as Record<string, unknown>).task_count ?? 0,
                    done_task_count: (this as Record<string, unknown>).done_task_count ?? 0,
                };
            },
        };
    };

    const stubFindWithRows = (rows: ReturnType<typeof makeRowDoc>[]) => {
        projectFindMock.mockReturnValueOnce({
            sort: () => ({
                skip: () => ({
                    limit: () => Promise.resolve(rows),
                }),
            }),
        });
        projectCountDocumentsMock.mockResolvedValueOnce(rows.length);
    };

    it('attaches task_count and done_task_count from Task.aggregate rollup', async () => {
        const projId = new Types.ObjectId();
        const row = makeRowDoc({ _id: projId });
        stubFindWithRows([row]);

        // Aggregate returns per-status buckets: 5 total, 3 in 'done' (terminal)
        taskAggregateMock.mockResolvedValueOnce([
            { _id: { project: projId, status: 'done' }, count: 3 },
            { _id: { project: projId, status: 'in_progress' }, count: 2 },
        ]);

        const result = await svc.listProjects({ page: 1, limit: 20 }, adminCaller());
        expect(result.data[0]).toMatchObject({ task_count: 5, done_task_count: 3 });
    });

    it('honours custom is_terminal statuses for done_task_count', async () => {
        const projId = new Types.ObjectId();
        const row = makeRowDoc({
            _id: projId,
            custom_task_statuses: [{ key: 'shipped', is_terminal: true }],
        });
        stubFindWithRows([row]);

        // 4 total: 2 'done' (default terminal) + 1 'shipped' (custom terminal) + 1 'in_progress'
        taskAggregateMock.mockResolvedValueOnce([
            { _id: { project: projId, status: 'done' }, count: 2 },
            { _id: { project: projId, status: 'shipped' }, count: 1 },
            { _id: { project: projId, status: 'in_progress' }, count: 1 },
        ]);

        const result = await svc.listProjects({ page: 1, limit: 20 }, adminCaller());
        expect(result.data[0]).toMatchObject({ task_count: 4, done_task_count: 3 });
    });

    it('returns 0/0 for a zero-task project', async () => {
        const projId = new Types.ObjectId();
        const row = makeRowDoc({ _id: projId });
        stubFindWithRows([row]);
        // taskAggregateMock already defaults to [] in beforeEach

        const result = await svc.listProjects({ page: 1, limit: 20 }, adminCaller());
        expect(result.data[0]).toMatchObject({ task_count: 0, done_task_count: 0 });
    });

    it('falls back to 0/0 for all rows when Task.aggregate throws', async () => {
        const projId = new Types.ObjectId();
        const row = makeRowDoc({ _id: projId });
        stubFindWithRows([row]);
        taskAggregateMock.mockRejectedValueOnce(new Error('DB timeout'));

        // Should NOT throw — failure-isolation wraps the rollup
        const result = await svc.listProjects({ page: 1, limit: 20 }, adminCaller());
        expect(result.data[0]).toMatchObject({ task_count: 0, done_task_count: 0 });
    });
});

// ─── deleteProject (R3 dependant guard) ─────────────────────────────────

describe('deleteProject', () => {
    it('refuses with RESOURCE_HAS_DEPENDENTS when tasks/stories/sprints exist', async () => {
        const proj = makeProject();
        projectFindByIdMock.mockResolvedValueOnce(proj);
        taskCountDocumentsMock.mockResolvedValueOnce(2);
        storyCountDocumentsMock.mockResolvedValueOnce(1);
        sprintCountDocumentsMock.mockResolvedValueOnce(0);

        await expect(svc.deleteProject(proj._id, adminCaller())).rejects.toMatchObject({
            code: ERROR_CODES.RESOURCE_HAS_DEPENDENTS,
            details: { tasks: 2, stories: 1, sprints: 0 },
        });
        expect(proj.deleteOne).not.toHaveBeenCalled();
    });

    it('proceeds with the delete when no dependants exist', async () => {
        const proj = makeProject();
        projectFindByIdMock.mockResolvedValueOnce(proj);
        // The default beforeEach 0/0/0 is in effect.

        await svc.deleteProject(proj._id, adminCaller());

        expect(proj.deleteOne).toHaveBeenCalled();
    });
});
