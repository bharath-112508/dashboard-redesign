import { describe, expect, it, vi, beforeEach } from 'vitest';
import dayjs, { DEFAULT_TIMEZONE } from '../utils/date.js';
import { PROJECT_STATUSES } from '../constants/project.js';
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
    timesheetCountDocumentsMock,
    taskAggregateMock,
    projectUpdateOneMock,
    companyFindMock,
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
    timesheetCountDocumentsMock: vi.fn(),
    taskAggregateMock: vi.fn(),
    projectUpdateOneMock: vi.fn(),
    companyFindMock: vi.fn(),
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

// listProjects/getProject resolve `company_id` → `{id, name}` for the
// response. Unmocked, the chainable stub never settles and the test times
// out rather than failing loudly — hence an explicit default in beforeEach.
vi.mock('../models/company.model.js', () => ({
    Company: { find: companyFindMock },
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

vi.mock('../models/timesheet-entry.model.js', () => ({
    TimesheetEntry: { countDocuments: timesheetCountDocumentsMock },
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
    completed_at: Date | null;
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
        completed_at: null,
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
    timesheetCountDocumentsMock.mockResolvedValue(0);
    // Task.aggregate used by listProjects rollup — default to empty (no tasks).
    taskAggregateMock.mockResolvedValue([]);
    // Company.find backs the `company_id` → `{id, name}` resolution on
    // listProjects/getProject. Default to "no companies found", which is the
    // internal-project shape; tests that care override per-call.
    companyFindMock.mockReturnValue(mkUserChain([]));
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

    it('back-fills the delivery date from completed_on instead of stamping now', async () => {
        // The bug: creating a project already `completed` stamped
        // `completed_at = new Date()`, so entering work that finished in May
        // during September produced a "Late 120d" badge. The arithmetic was
        // right; the input was invented.
        userFindMock.mockReturnValue(mkUserChain([]));
        projectCreateMock.mockImplementationOnce(async (doc: Record<string, unknown>) => ({
            ...doc,
            _id: new Types.ObjectId(),
            toJSON: () => ({}),
        }));

        await svc.createProject(
            {
                name: 'Backfilled',
                code: 'BACK-1',
                description: '',
                status: PROJECT_STATUSES.COMPLETED,
                start_date: '2026-04-22',
                end_date: '2026-05-11',
                completed_on: '2026-05-11',
                member_ids: [],
                representative_ids: [],
                custom_task_statuses: [],
            } as never,
            adminCaller()
        );

        const persisted = projectCreateMock.mock.calls[0]![0] as { completed_at: Date };
        // Stored as the supplied day in IST, NOT today.
        expect(dayjs(persisted.completed_at).tz(DEFAULT_TIMEZONE).format('YYYY-MM-DD')).toBe('2026-05-11');
    });

    it('still stamps now when completed_on is omitted', async () => {
        userFindMock.mockReturnValue(mkUserChain([]));
        projectCreateMock.mockImplementationOnce(async (doc: Record<string, unknown>) => ({
            ...doc,
            _id: new Types.ObjectId(),
            toJSON: () => ({}),
        }));

        await svc.createProject(
            {
                name: 'Finished today',
                code: 'BACK-2',
                description: '',
                status: PROJECT_STATUSES.COMPLETED,
                start_date: '2026-04-22',
                end_date: '2026-05-11',
                member_ids: [],
                representative_ids: [],
                custom_task_statuses: [],
            } as never,
            adminCaller()
        );

        const persisted = projectCreateMock.mock.calls[0]![0] as { completed_at: Date };
        const today = dayjs().tz(DEFAULT_TIMEZONE).format('YYYY-MM-DD');
        expect(dayjs(persisted.completed_at).tz(DEFAULT_TIMEZONE).format('YYYY-MM-DD')).toBe(today);
    });

    it('refuses a completion date in the future', async () => {
        // Otherwise a caller could manufacture an "On time" verdict for work
        // that has not been delivered.
        userFindMock.mockReturnValue(mkUserChain([]));
        const future = dayjs().tz(DEFAULT_TIMEZONE).add(30, 'day').format('YYYY-MM-DD');

        await expect(
            svc.createProject(
                {
                    name: 'Future',
                    code: 'BACK-3',
                    description: '',
                    status: PROJECT_STATUSES.COMPLETED,
                    start_date: '2026-04-22',
                    end_date: '2026-05-11',
                    completed_on: future,
                    member_ids: [],
                    representative_ids: [],
                    custom_task_statuses: [],
                } as never,
                adminCaller()
            )
        ).rejects.toMatchObject({ statusCode: 422 });
        expect(projectCreateMock).not.toHaveBeenCalled();
    });

    it('refuses a completed project with no end date', async () => {
        userFindMock.mockReturnValue(mkUserChain([]));

        await expect(
            svc.createProject(
                {
                    name: 'A',
                    code: 'DONE-1',
                    description: '',
                    start_date: '2026-01-01',
                    end_date: null,
                    status: 'completed',
                    member_ids: [],
                    representative_ids: [],
                    custom_task_statuses: [],
                },
                adminCaller()
            )
        ).rejects.toMatchObject({ code: ERROR_CODES.PROJECT_DATE_INVALID });
        expect(projectCreateMock).not.toHaveBeenCalled();
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

    // `overdue` powers the Overdue tile on the projects list. It is a server
    // -side flag rather than a client-supplied date range on purpose: the
    // comparison is against *today*, and two browsers in different timezones
    // would otherwise disagree about which projects are late.
    it('overdue filters on end_date < today, unfinished, and not archived', async () => {
        stubFindChain();
        await svc.listProjects({ page: 1, limit: 20, overdue: true } as never, adminCaller());

        const [filter] = projectFindMock.mock.calls[0]!;
        const f = filter as Record<string, unknown>;
        expect(f.status).toEqual({ $ne: 'completed' });
        expect(f.is_archived).toBe(false);
        // A `$lt` on an existing value — never a null sweep, because a project
        // with no end_date had no deadline to miss.
        expect(f.end_date).toHaveProperty('$lt');
        expect(String((f.end_date as { $lt: string }).$lt)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('omits the overdue predicate entirely when the flag is absent', async () => {
        stubFindChain();
        await svc.listProjects({ page: 1, limit: 20 }, adminCaller());

        const [filter] = projectFindMock.mock.calls[0]!;
        expect(filter).not.toHaveProperty('end_date');
    });

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

    it('refuses a status flip to completed when the project has no end date', async () => {
        const proj = makeProject({ start_date: '2026-06-01', end_date: null, status: 'active' });
        projectFindByIdMock.mockResolvedValueOnce(proj);

        await expect(svc.updateProject(proj._id, { status: 'completed' }, adminCaller())).rejects.toMatchObject({
            code: ERROR_CODES.PROJECT_DATE_INVALID,
        });
        expect(proj.save).not.toHaveBeenCalled();
    });

    it('refuses clearing the end date on an already-completed project', async () => {
        const proj = makeProject({ start_date: '2026-06-01', end_date: '2026-12-31', status: 'completed' });
        projectFindByIdMock.mockResolvedValueOnce(proj);

        await expect(svc.updateProject(proj._id, { end_date: null }, adminCaller())).rejects.toMatchObject({
            code: ERROR_CODES.PROJECT_DATE_INVALID,
        });
        expect(proj.save).not.toHaveBeenCalled();
    });

    it('lets a pre-existing completed/no-end-date project still be archived', async () => {
        const proj = makeProject({ start_date: '2026-06-01', end_date: null, status: 'completed' });
        projectFindByIdMock.mockResolvedValueOnce(proj);

        await svc.updateProject(proj._id, { is_archived: true }, adminCaller());

        expect(proj.save).toHaveBeenCalledTimes(1);
    });

    it('allows completed when the patch supplies the end date', async () => {
        const proj = makeProject({ start_date: '2026-06-01', end_date: null, status: 'active' });
        projectFindByIdMock.mockResolvedValueOnce(proj);

        const out = await svc.updateProject(proj._id, { status: 'completed', end_date: '2026-12-31' }, adminCaller());

        expect(proj.save).toHaveBeenCalledTimes(1);
        expect(out).toMatchObject({ status: 'completed', end_date: '2026-12-31' });
    });

    it('happy path saves and reflects field changes', async () => {
        const proj = makeProject({ name: 'Old', status: 'active' });
        projectFindByIdMock.mockResolvedValueOnce(proj);

        const out = await svc.updateProject(proj._id, { name: 'New', status: 'on_hold' }, adminCaller());

        expect(proj.save).toHaveBeenCalledTimes(1);
        expect(out).toMatchObject({ name: 'New', status: 'on_hold' });
    });

    // ── completed_at: the delivery moment the on-time verdict measures ──
    //
    // It must be stamped on the TRANSITION and never re-stamped, because
    // `end_date` (the target) is compared against it. A later edit that moved
    // the stamp would silently rewrite whether the project shipped on time.

    it('stamps completed_at when the status flips to completed', async () => {
        const proj = makeProject({ status: 'active', end_date: '2026-12-31' });
        projectFindByIdMock.mockResolvedValueOnce(proj);

        await svc.updateProject(proj._id, { status: 'completed' }, adminCaller());

        expect(proj.completed_at).toBeInstanceOf(Date);
    });

    it('does NOT re-stamp completed_at when an already-completed project is edited', async () => {
        const shippedAt = new Date('2026-03-01T10:00:00Z');
        const proj = makeProject({ status: 'completed', end_date: '2026-12-31', completed_at: shippedAt });
        projectFindByIdMock.mockResolvedValueOnce(proj);

        await svc.updateProject(proj._id, { name: 'Renamed' }, adminCaller());

        expect(proj.completed_at).toBe(shippedAt);
    });

    it('clears completed_at when a completed project is re-opened', async () => {
        const proj = makeProject({
            status: 'completed',
            end_date: '2026-12-31',
            completed_at: new Date('2026-03-01T10:00:00Z'),
        });
        projectFindByIdMock.mockResolvedValueOnce(proj);

        await svc.updateProject(proj._id, { status: 'active' }, adminCaller());

        expect(proj.completed_at).toBeNull();
    });

    it('exposes completed_on as the IST calendar date of completed_at', async () => {
        // 18:45 UTC on the 1st is already the 2nd in IST (+05:30) — the
        // off-by-one this field exists to keep out of the browser.
        const proj = makeProject({
            status: 'completed',
            end_date: '2026-12-31',
            completed_at: new Date('2026-03-01T18:45:00Z'),
        });
        projectFindByIdMock.mockResolvedValueOnce(proj);

        const out = await svc.updateProject(proj._id, { name: 'Renamed' }, adminCaller());

        expect(out).toMatchObject({ completed_on: '2026-03-02' });
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
            company_id: Types.ObjectId | null;
            completed_at: Date | null;
        }> = {}
    ) => {
        const id = overrides._id ?? new Types.ObjectId();
        const cts = overrides.custom_task_statuses ?? [];
        return {
            _id: id,
            company_id: overrides.company_id ?? null,
            completed_at: overrides.completed_at ?? null,
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

    // ── Timeliness + post-delivery scope ────────────────────────────────
    //
    // The load-bearing assertion is the LAST one: a delivered project that has
    // since collected a client-reported bug must still read 100%. If someone
    // later folds post-delivery work back into the denominator, this fails.

    it('splits on-time / late / overdue and keeps post-delivery work out of delivery scope', async () => {
        const projId = new Types.ObjectId();
        const row = makeRowDoc({ _id: projId, completed_at: new Date('2026-03-01T10:00:00Z') });
        stubFindWithRows([row]);

        taskAggregateMock.mockResolvedValueOnce([
            // Delivery scope, terminal: 2 finished on time, 1 late.
            { _id: { project: projId, status: 'done', post: false }, count: 3, on_time: 2, late: 1, overdue: 0 },
            // Delivery scope, open: 1 of them is past its due date.
            {
                _id: { project: projId, status: 'in_progress', post: false },
                count: 2,
                on_time: 0,
                late: 0,
                overdue: 1,
            },
            // Post-delivery: a client-filed bug, still open. Its own `overdue`
            // is deliberately non-zero to prove it is not credited anywhere —
            // an untriaged report is due "today" and goes overdue by itself.
            { _id: { project: projId, status: 'to_do', post: true }, count: 1, on_time: 0, late: 0, overdue: 1 },
        ]);

        const result = await svc.listProjects({ page: 1, limit: 20 }, adminCaller());

        expect(result.data[0]).toMatchObject({
            task_count: 5,
            done_task_count: 3,
            on_time_task_count: 2,
            late_task_count: 1,
            overdue_task_count: 1,
            post_delivery_task_count: 1,
            post_delivery_open_count: 1,
        });
    });

    it('counts a terminal task with no completed_at as done but neither on-time nor late', async () => {
        // Rows written before Task.completed_at existed carry no stamp. They
        // are evidence in neither direction, so on_time + late < done_count.
        const projId = new Types.ObjectId();
        stubFindWithRows([makeRowDoc({ _id: projId })]);

        taskAggregateMock.mockResolvedValueOnce([
            { _id: { project: projId, status: 'done', post: false }, count: 4, on_time: 1, late: 1, overdue: 0 },
        ]);

        const result = await svc.listProjects({ page: 1, limit: 20 }, adminCaller());

        expect(result.data[0]).toMatchObject({
            done_task_count: 4,
            on_time_task_count: 1,
            late_task_count: 1,
        });
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

    // ─── company resolution ──────────────────────────────────────────────
    //
    // The list is the only place that can distinguish a client project from
    // internal work, because `company.read` is Manager+ — a Team Lead or
    // Employee cannot resolve the name themselves.

    it('resolves company_id to {id, name} on the row', async () => {
        const companyId = new Types.ObjectId();
        stubFindWithRows([makeRowDoc({ company_id: companyId })]);
        companyFindMock.mockReturnValueOnce(mkUserChain([{ _id: companyId, name: 'Nordmark Logistics AS' } as never]));

        const result = await svc.listProjects({ page: 1, limit: 20 }, adminCaller());
        expect(result.data[0]).toMatchObject({
            company: { id: companyId.toString(), name: 'Nordmark Logistics AS' },
        });
    });

    it('returns company: null for an internal project (no company_id)', async () => {
        stubFindWithRows([makeRowDoc({ company_id: null })]);

        const result = await svc.listProjects({ page: 1, limit: 20 }, adminCaller());
        expect(result.data[0]).toMatchObject({ company: null });
        // No company_ids on the page → no lookup at all.
        expect(companyFindMock).not.toHaveBeenCalled();
    });

    it('batches one lookup for a page sharing a company (no N+1)', async () => {
        const companyId = new Types.ObjectId();
        stubFindWithRows([
            makeRowDoc({ company_id: companyId }),
            makeRowDoc({ company_id: companyId }),
            makeRowDoc({ company_id: null }),
        ]);
        companyFindMock.mockReturnValueOnce(mkUserChain([{ _id: companyId, name: 'Aurora Foods AB' } as never]));

        const result = await svc.listProjects({ page: 1, limit: 20 }, adminCaller());
        expect(companyFindMock).toHaveBeenCalledTimes(1);
        expect(result.data[0]).toMatchObject({ company: { name: 'Aurora Foods AB' } });
        expect(result.data[1]).toMatchObject({ company: { name: 'Aurora Foods AB' } });
        expect(result.data[2]).toMatchObject({ company: null });
    });

    it('degrades a dangling company_id to null rather than throwing', async () => {
        // Companies are archived, never hard-deleted, so this shouldn't
        // happen — but a stale pointer must not take down the whole list.
        stubFindWithRows([makeRowDoc({ company_id: new Types.ObjectId() })]);
        companyFindMock.mockReturnValueOnce(mkUserChain([]));

        const result = await svc.listProjects({ page: 1, limit: 20 }, adminCaller());
        expect(result.data[0]).toMatchObject({ company: null });
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
            details: { tasks: 2, stories: 1, sprints: 0, timesheets: 0 },
        });
        expect(proj.deleteOne).not.toHaveBeenCalled();
    });

    it('refuses when only timesheet hours exist — a task-less project can still hold work', async () => {
        // Logging time no longer requires a task, so the task count alone
        // stopped covering this: the delete used to succeed and orphan the
        // entries onto an id that resolves to nothing.
        const proj = makeProject();
        projectFindByIdMock.mockResolvedValueOnce(proj);
        timesheetCountDocumentsMock.mockResolvedValueOnce(3);

        await expect(svc.deleteProject(proj._id, adminCaller())).rejects.toMatchObject({
            code: ERROR_CODES.RESOURCE_HAS_DEPENDENTS,
            details: { tasks: 0, stories: 0, sprints: 0, timesheets: 3 },
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

// ─── can_write — the per-row verdict shipped to the frontend ────────────

/**
 * `can_write` is what lets the FE hide an edit/delete button that would 403.
 * It MUST come from the same predicate the guard uses — a second copy of the
 * tier ladder is exactly the drift this field exists to prevent — so these
 * tests assert the flag agrees with `assertCallerCanWrite` row by row.
 *
 * It is a display hint, never authorization. See `toPublicFor`.
 */
describe('can_write on project reads', () => {
    it('is true for the employee who created the project, false for a mere member', async () => {
        const author = new Types.ObjectId();
        const member = new Types.ObjectId();
        const proj = makeProject({ created_by: author, member_ids: [author, member] });

        projectFindByIdMock.mockResolvedValueOnce(proj);
        expect(await svc.getProject(proj._id, employeeCaller(author))).toMatchObject({ can_write: true });

        projectFindByIdMock.mockResolvedValueOnce(proj);
        expect(await svc.getProject(proj._id, employeeCaller(member))).toMatchObject({ can_write: false });
    });

    it('is true for an admin on a project they had nothing to do with', async () => {
        const proj = makeProject();
        projectFindByIdMock.mockResolvedValueOnce(proj);

        expect(await svc.getProject(proj._id, adminCaller())).toMatchObject({ can_write: true });
    });

    it('agrees with assertCallerCanWrite — a false flag means the write really is refused', async () => {
        // The only caller who can see `can_write: false` is one who can READ
        // the row but not write it: a member of someone else's project.
        // A true outsider never gets a payload at all.
        const member = new Types.ObjectId();
        const proj = makeProject({ created_by: new Types.ObjectId(), member_ids: [member] });
        const caller = employeeCaller(member);

        projectFindByIdMock.mockResolvedValueOnce(proj);
        expect(await svc.getProject(proj._id, caller)).toMatchObject({ can_write: false });

        projectFindByIdMock.mockResolvedValueOnce(proj);
        await expect(svc.updateProject(proj._id, { name: 'Renamed' }, caller)).rejects.toMatchObject({
            code: ERROR_CODES.PROJECT_WRITE_FORBIDDEN,
        });
    });
});

// ─── assertCallerCanWrite — per-row authorization on project writes ──────

describe('project writes — per-row authorization', () => {
    // These six paths previously did `findById` and wrote with NO per-row
    // check: the route's requirePermission was the only gate, so any holder
    // of project.write could rename, restaff or delete any project by id —
    // including ones the visibility filter hides from them.
    const teamLeadCaller = (id: Types.ObjectId) => ({ id, role: ROLES.TEAM_LEAD, audit: undefined });

    const expectForbidden = (p: Promise<unknown>) =>
        expect(p).rejects.toMatchObject({ code: ERROR_CODES.PROJECT_WRITE_FORBIDDEN });

    describe('employee', () => {
        it('may patch a project they created', async () => {
            const me = new Types.ObjectId();
            const proj = makeProject({ created_by: me, member_ids: [me] });
            projectFindByIdMock.mockResolvedValueOnce(proj);

            await svc.updateProject(proj._id, { name: 'Renamed' }, employeeCaller(me));
            expect(proj.save).toHaveBeenCalled();
        });

        it('may NOT patch a project they were merely added to', async () => {
            const me = new Types.ObjectId();
            const proj = makeProject({ created_by: new Types.ObjectId(), member_ids: [me] });
            projectFindByIdMock.mockResolvedValueOnce(proj);

            await expectForbidden(svc.updateProject(proj._id, { name: 'Renamed' }, employeeCaller(me)));
            expect(proj.save).not.toHaveBeenCalled();
        });

        it('may NOT patch a project they have nothing to do with', async () => {
            const proj = makeProject();
            projectFindByIdMock.mockResolvedValueOnce(proj);

            await expectForbidden(
                svc.updateProject(proj._id, { name: 'Renamed' }, employeeCaller(new Types.ObjectId()))
            );
        });

        it('may delete a project they created', async () => {
            const me = new Types.ObjectId();
            const proj = makeProject({ created_by: me });
            projectFindByIdMock.mockResolvedValueOnce(proj);

            await svc.deleteProject(proj._id, employeeCaller(me));
            expect(proj.deleteOne).toHaveBeenCalled();
        });

        it('may NOT delete a project they were merely added to', async () => {
            const me = new Types.ObjectId();
            const proj = makeProject({ created_by: new Types.ObjectId(), member_ids: [me] });
            projectFindByIdMock.mockResolvedValueOnce(proj);

            await expectForbidden(svc.deleteProject(proj._id, employeeCaller(me)));
            expect(proj.deleteOne).not.toHaveBeenCalled();
        });
    });

    describe('team lead', () => {
        it('may patch a project they are a member of', async () => {
            const me = new Types.ObjectId();
            const proj = makeProject({ member_ids: [me] });
            projectFindByIdMock.mockResolvedValueOnce(proj);

            await svc.updateProject(proj._id, { name: 'Renamed' }, teamLeadCaller(me));
            expect(proj.save).toHaveBeenCalled();
        });

        it('may NOT patch a project they are not on — the hole this closes', async () => {
            const proj = makeProject();
            projectFindByIdMock.mockResolvedValueOnce(proj);

            await expectForbidden(
                svc.updateProject(proj._id, { name: 'Renamed' }, teamLeadCaller(new Types.ObjectId()))
            );
            expect(proj.save).not.toHaveBeenCalled();
        });
    });

    it('admin may patch any project', async () => {
        const proj = makeProject();
        projectFindByIdMock.mockResolvedValueOnce(proj);

        await svc.updateProject(proj._id, { name: 'Renamed' }, adminCaller());
        expect(proj.save).toHaveBeenCalled();
    });
});
