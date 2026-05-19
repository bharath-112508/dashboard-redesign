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
    Task: { countDocuments: taskCountDocumentsMock },
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

const clientCaller = (id: Types.ObjectId) => ({
    id,
    role: ROLES.CLIENT,
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
    client_ids: Types.ObjectId[];
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
        client_ids: [],
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
                client_ids: this.client_ids.map((c) => c.toString()),
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
                    client_ids: [],
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
                    client_ids: [],
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

    it('rejects client_ids that are not active client users with INVALID_PROJECT_CLIENT_ROLE', async () => {
        const goodClient = new Types.ObjectId();
        const wrongRole = new Types.ObjectId();
        // members array is empty → validateMemberCandidates short-circuits
        // without calling User.find. Only the client validation hits the
        // mock, returning just the good client.
        userFindMock.mockReturnValueOnce(mkUserChain([{ _id: goodClient, role: ROLES.CLIENT }]));

        await expect(
            svc.createProject(
                {
                    name: 'A',
                    code: 'OK-2',
                    description: '',
                    start_date: '2026-01-01',
                    end_date: null,
                    member_ids: [],
                    client_ids: [goodClient.toString(), wrongRole.toString()],
                    custom_task_statuses: [],
                },
                adminCaller()
            )
        ).rejects.toMatchObject({
            code: ERROR_CODES.INVALID_PROJECT_CLIENT_ROLE,
            details: { invalid_user_ids: [wrongRole.toString()] },
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
                client_ids: [],
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

    it('client filters by client_ids = caller.id', async () => {
        stubFindChain();
        const cliId = new Types.ObjectId();
        await svc.listProjects({ page: 1, limit: 20 }, clientCaller(cliId));
        expect(projectFindMock).toHaveBeenCalledWith({ client_ids: cliId });
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

    it('client NOT in client_ids gets 403 FORBIDDEN', async () => {
        const proj = makeProject({ client_ids: [new Types.ObjectId()] });
        projectFindByIdMock.mockResolvedValueOnce(proj);
        await expect(svc.getProject(proj._id, clientCaller(new Types.ObjectId()))).rejects.toMatchObject({
            code: ERROR_CODES.FORBIDDEN,
        });
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

// ─── updateProjectClients (mirror of members, with role=client check) ────

describe('updateProjectClients', () => {
    it('rejects clients that are not role=client', async () => {
        const proj = makeProject();
        projectFindByIdMock.mockResolvedValueOnce(proj);
        const wrongRole = new Types.ObjectId();
        userFindMock.mockReturnValueOnce(mkUserChain([])); // no rows back

        await expect(
            svc.updateProjectClients(proj._id, { add: [wrongRole.toString()], remove: [] }, adminCaller())
        ).rejects.toMatchObject({ code: ERROR_CODES.INVALID_PROJECT_CLIENT_ROLE });
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
