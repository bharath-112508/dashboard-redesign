import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Types } from 'mongoose';

/**
 * Unit tests for `task.service` (Step 18).
 *
 * Coverage focus:
 *  1. Cross-document validation — STORY_PROJECT_MISMATCH /
 *     TASK_SPRINT_PROJECT_MISMATCH / TASK_PARENT_PROJECT_MISMATCH /
 *     TASK_SUBTASK_DEPTH_EXCEEDED / TASK_INVALID_STATUS / etc.
 *  2. RBAC — Admin/Manager required for create/delete/move-sprint/assign-
 *     story/dependency; PATCH allows owner-employee but only on the
 *     whitelisted field set; reorder additionally allows the assignee.
 *  3. Position state machine — append-on-create, neighbour-shift on
 *     reorder, cross-column moves push to end + close source gap.
 *  4. Dependency add — self / duplicate / project-mismatch / cycle all
 *     rejected with the right code; happy path persists.
 *  5. Project visibility — propagates 403 from `loadProjectForCaller`.
 */

const {
    taskCreateMock,
    taskFindByIdMock,
    taskFindMock,
    taskFindOneMock,
    taskCountDocumentsMock,
    taskUpdateManyMock,
    storyFindByIdMock,
    sprintFindByIdMock,
    userFindMock,
    loadProjectForCallerMock,
    buildProjectVisibilityFilterMock,
    recordAuditMock,
} = vi.hoisted(() => ({
    taskCreateMock: vi.fn(),
    taskFindByIdMock: vi.fn(),
    taskFindMock: vi.fn(),
    taskFindOneMock: vi.fn(),
    taskCountDocumentsMock: vi.fn(),
    taskUpdateManyMock: vi.fn(),
    storyFindByIdMock: vi.fn(),
    sprintFindByIdMock: vi.fn(),
    userFindMock: vi.fn(),
    loadProjectForCallerMock: vi.fn(),
    buildProjectVisibilityFilterMock: vi.fn(),
    recordAuditMock: vi.fn(),
}));

vi.mock('../models/task.model.js', () => ({
    Task: {
        create: taskCreateMock,
        findById: taskFindByIdMock,
        find: taskFindMock,
        findOne: taskFindOneMock,
        countDocuments: taskCountDocumentsMock,
        updateMany: taskUpdateManyMock,
    },
}));

vi.mock('../models/story.model.js', () => ({
    Story: { findById: storyFindByIdMock },
}));

vi.mock('../models/sprint.model.js', () => ({
    Sprint: { findById: sprintFindByIdMock },
}));

vi.mock('../models/user.model.js', () => ({
    User: { find: userFindMock },
}));

vi.mock('../models/project.model.js', () => ({
    Project: {
        find: vi.fn().mockReturnValue({
            select: () => ({ limit: () => ({ lean: () => Promise.resolve([]) }) }),
        }),
    },
}));

vi.mock('./project.service.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./project.service.js')>();
    return {
        ...actual,
        loadProjectForCaller: loadProjectForCallerMock,
        buildProjectVisibilityFilter: buildProjectVisibilityFilterMock,
    };
});

vi.mock('./audit.service.js', () => ({
    recordAudit: recordAuditMock,
    recordSystemAudit: vi.fn(),
}));

// Activity hooks are best-effort fire-and-forget; stub them out so tests
// don't have to thread `TaskActivity` mocks through every fixture.
vi.mock('./task-activity.service.js', () => ({
    recordActivity: vi.fn(),
    recordActivityIfChanged: vi.fn(),
}));

const svc = await import('./task.service.js');
import { ERROR_CODES } from '../constants/error-codes.js';
import { ROLES } from '../constants/roles.js';
import { DEFAULT_TASK_STATUSES, TASK_PRIORITIES } from '../constants/task.js';

// ─── Helpers ─────────────────────────────────────────────────────────────

const adminCaller = () => ({ id: new Types.ObjectId(), role: ROLES.ADMIN, audit: undefined });
const managerCaller = () => ({ id: new Types.ObjectId(), role: ROLES.MANAGER, audit: undefined });
const employeeCaller = (id?: Types.ObjectId) => ({
    id: id ?? new Types.ObjectId(),
    role: ROLES.EMPLOYEE,
    audit: undefined,
});
const clientCaller = () => ({ id: new Types.ObjectId(), role: ROLES.CLIENT, audit: undefined });

const makeProject = (overrides: Record<string, unknown> = {}) => ({
    _id: new Types.ObjectId(),
    custom_task_statuses: [] as Array<{ key: string; is_terminal: boolean }>,
    ...overrides,
});

const makeTask = (overrides: Record<string, unknown> = {}) => {
    const task = {
        _id: new Types.ObjectId(),
        project_id: new Types.ObjectId(),
        sprint_id: null as Types.ObjectId | null,
        story_id: null as Types.ObjectId | null,
        parent_task_id: null as Types.ObjectId | null,
        title: 'Task',
        description: '',
        status: DEFAULT_TASK_STATUSES.TO_DO as string,
        priority: TASK_PRIORITIES.MEDIUM as string,
        due_date: '2026-05-10',
        estimated_hours: 0,
        primary_assignee_id: null as Types.ObjectId | null,
        collaborator_ids: [] as Types.ObjectId[],
        depends_on_task_ids: [] as Types.ObjectId[],
        position: 0,
        created_by: new Types.ObjectId(),
        updated_by: null as Types.ObjectId | null,
        created_at: new Date(),
        updated_at: new Date(),
        save: vi.fn(),
        deleteOne: vi.fn(),
        toJSON: vi.fn(),
        ...overrides,
    };
    task.save.mockImplementation(async () => task);
    task.deleteOne.mockImplementation(async () => undefined);
    task.toJSON.mockImplementation(() => ({
        id: task._id.toString(),
        project_id: task.project_id.toString(),
        title: task.title,
        status: task.status,
        position: task.position,
    }));
    return task;
};

/** Stub `Task.findOne(...).sort().select().lean()` for nextPositionInColumn. */
const stubFindOneForLastPosition = (returns: { position: number } | null): void => {
    taskFindOneMock.mockReturnValueOnce({
        sort: () => ({ select: () => ({ lean: () => Promise.resolve(returns) }) }),
    });
};

/** Stub `Story.findById(...).select().lean()`. */
const stubStoryLookup = (project_id: Types.ObjectId | null): void => {
    storyFindByIdMock.mockReturnValueOnce({
        select: () => ({ lean: () => Promise.resolve(project_id ? { project_id } : null) }),
    });
};

/** Stub `Sprint.findById(...).select().lean()`. */
const stubSprintLookup = (project_id: Types.ObjectId | null): void => {
    sprintFindByIdMock.mockReturnValueOnce({
        select: () => ({ lean: () => Promise.resolve(project_id ? { project_id } : null) }),
    });
};

beforeEach(() => {
    vi.resetAllMocks();
});

// ─── createTask — RBAC + cross-doc validation ────────────────────────────

describe('createTask', () => {
    const baseInput = (project_id: Types.ObjectId) => ({
        project_id: project_id.toString(),
        title: 'New task',
        description: '',
        due_date: '2026-05-10',
    });

    it('rejects employees with TASK_WRITE_FORBIDDEN before any DB call', async () => {
        await expect(svc.createTask(baseInput(new Types.ObjectId()), employeeCaller())).rejects.toMatchObject({
            code: ERROR_CODES.TASK_WRITE_FORBIDDEN,
        });
        expect(loadProjectForCallerMock).not.toHaveBeenCalled();
    });

    it('rejects clients with TASK_WRITE_FORBIDDEN', async () => {
        await expect(svc.createTask(baseInput(new Types.ObjectId()), clientCaller())).rejects.toMatchObject({
            code: ERROR_CODES.TASK_WRITE_FORBIDDEN,
        });
    });

    it('rejects status not in defaults+customs with TASK_INVALID_STATUS', async () => {
        const project = makeProject();
        loadProjectForCallerMock.mockResolvedValueOnce(project);
        await expect(
            svc.createTask({ ...baseInput(project._id), status: 'totally_made_up' }, adminCaller())
        ).rejects.toMatchObject({ code: ERROR_CODES.TASK_INVALID_STATUS });
        expect(taskCreateMock).not.toHaveBeenCalled();
    });

    it('accepts a project-custom status key', async () => {
        const project = makeProject({
            custom_task_statuses: [{ key: 'qa_passed', is_terminal: false }],
        });
        loadProjectForCallerMock.mockResolvedValueOnce(project);
        stubFindOneForLastPosition(null);
        const created = makeTask({ project_id: project._id, status: 'qa_passed', position: 0 });
        taskCreateMock.mockResolvedValueOnce(created);

        await svc.createTask({ ...baseInput(project._id), status: 'qa_passed' }, adminCaller());
        expect(taskCreateMock).toHaveBeenCalledWith(expect.objectContaining({ status: 'qa_passed' }));
    });

    it('rejects sprint from a different project with TASK_SPRINT_PROJECT_MISMATCH', async () => {
        const project = makeProject();
        const wrongProjectId = new Types.ObjectId();
        loadProjectForCallerMock.mockResolvedValueOnce(project);
        stubSprintLookup(wrongProjectId);

        await expect(
            svc.createTask({ ...baseInput(project._id), sprint_id: new Types.ObjectId().toString() }, adminCaller())
        ).rejects.toMatchObject({ code: ERROR_CODES.TASK_SPRINT_PROJECT_MISMATCH });
    });

    it('rejects story from a different project with STORY_PROJECT_MISMATCH', async () => {
        const project = makeProject();
        const wrongProjectId = new Types.ObjectId();
        loadProjectForCallerMock.mockResolvedValueOnce(project);
        stubStoryLookup(wrongProjectId);

        await expect(
            svc.createTask({ ...baseInput(project._id), story_id: new Types.ObjectId().toString() }, adminCaller())
        ).rejects.toMatchObject({ code: ERROR_CODES.STORY_PROJECT_MISMATCH });
    });

    it('rejects parent that is itself a subtask with TASK_SUBTASK_DEPTH_EXCEEDED', async () => {
        const project = makeProject();
        loadProjectForCallerMock.mockResolvedValueOnce(project);
        const grandparentId = new Types.ObjectId();
        const parent = makeTask({ project_id: project._id, parent_task_id: grandparentId });
        taskFindByIdMock.mockResolvedValueOnce(parent);

        await expect(
            svc.createTask({ ...baseInput(project._id), parent_task_id: parent._id.toString() }, adminCaller())
        ).rejects.toMatchObject({ code: ERROR_CODES.TASK_SUBTASK_DEPTH_EXCEEDED });
    });

    it('rejects parent in a different project with TASK_PARENT_PROJECT_MISMATCH', async () => {
        const project = makeProject();
        loadProjectForCallerMock.mockResolvedValueOnce(project);
        const otherProjectId = new Types.ObjectId();
        const parent = makeTask({ project_id: otherProjectId, parent_task_id: null });
        taskFindByIdMock.mockResolvedValueOnce(parent);

        await expect(
            svc.createTask({ ...baseInput(project._id), parent_task_id: parent._id.toString() }, adminCaller())
        ).rejects.toMatchObject({ code: ERROR_CODES.TASK_PARENT_PROJECT_MISMATCH });
    });

    it('appends to end of (project,status) column when position is omitted', async () => {
        const project = makeProject();
        loadProjectForCallerMock.mockResolvedValueOnce(project);
        stubFindOneForLastPosition({ position: 4 });
        const created = makeTask({ project_id: project._id, position: 5 });
        taskCreateMock.mockResolvedValueOnce(created);

        await svc.createTask(baseInput(project._id), adminCaller());

        expect(taskCreateMock).toHaveBeenCalledWith(expect.objectContaining({ position: 5 }));
    });

    it('rejects unknown assignee with TASK_INVALID_ASSIGNEE', async () => {
        const project = makeProject();
        loadProjectForCallerMock.mockResolvedValueOnce(project);
        userFindMock.mockReturnValueOnce({
            select: () => ({ lean: () => Promise.resolve([]) }),
        });

        await expect(
            svc.createTask(
                { ...baseInput(project._id), primary_assignee_id: new Types.ObjectId().toString() },
                adminCaller()
            )
        ).rejects.toMatchObject({ code: ERROR_CODES.TASK_INVALID_ASSIGNEE });
    });
});

// ─── updateTask — employee scope + status column move ────────────────────

describe('updateTask', () => {
    it('rejects employee patching a task they do NOT own', async () => {
        const project = makeProject();
        const task = makeTask({
            project_id: project._id,
            primary_assignee_id: new Types.ObjectId(),
            created_by: new Types.ObjectId(),
        });
        taskFindByIdMock.mockResolvedValueOnce(task);
        loadProjectForCallerMock.mockResolvedValueOnce(project);

        await expect(svc.updateTask(task._id, { description: 'x' }, employeeCaller())).rejects.toMatchObject({
            code: ERROR_CODES.TASK_WRITE_FORBIDDEN,
        });
        expect(task.save).not.toHaveBeenCalled();
    });

    it('rejects employee touching a field outside the whitelist', async () => {
        const project = makeProject();
        const employeeId = new Types.ObjectId();
        const task = makeTask({ project_id: project._id, primary_assignee_id: employeeId });
        taskFindByIdMock.mockResolvedValueOnce(task);
        loadProjectForCallerMock.mockResolvedValueOnce(project);

        await expect(svc.updateTask(task._id, { title: 'rename' }, employeeCaller(employeeId))).rejects.toMatchObject({
            code: ERROR_CODES.TASK_WRITE_FORBIDDEN,
        });
    });

    it('lets the owner-assignee employee update status (whitelisted field)', async () => {
        const project = makeProject();
        const employeeId = new Types.ObjectId();
        const task = makeTask({
            project_id: project._id,
            primary_assignee_id: employeeId,
            status: 'to_do',
            position: 2,
        });
        taskFindByIdMock.mockResolvedValueOnce(task);
        loadProjectForCallerMock.mockResolvedValueOnce(project);
        stubFindOneForLastPosition({ position: 7 });

        const out = await svc.updateTask(task._id, { status: 'in_progress' }, employeeCaller(employeeId));
        expect(task.status).toBe('in_progress');
        expect(task.position).toBe(8);
        expect(task.save).toHaveBeenCalled();
        expect((out as { status: string }).status).toBe('in_progress');
    });

    it('rejects clients with TASK_WRITE_FORBIDDEN even for whitelisted fields', async () => {
        const project = makeProject();
        const task = makeTask({ project_id: project._id });
        taskFindByIdMock.mockResolvedValueOnce(task);
        loadProjectForCallerMock.mockResolvedValueOnce(project);

        await expect(svc.updateTask(task._id, { status: 'done' }, clientCaller())).rejects.toMatchObject({
            code: ERROR_CODES.TASK_WRITE_FORBIDDEN,
        });
    });

    it('moves task to END of new column on status change (admin)', async () => {
        const project = makeProject();
        const task = makeTask({ project_id: project._id, status: 'to_do', position: 1 });
        taskFindByIdMock.mockResolvedValueOnce(task);
        loadProjectForCallerMock.mockResolvedValueOnce(project);
        stubFindOneForLastPosition({ position: 5 });

        await svc.updateTask(task._id, { status: 'in_progress' }, adminCaller());

        expect(task.status).toBe('in_progress');
        expect(task.position).toBe(6);
        // Status change short-circuits the within-column shift call.
        expect(taskUpdateManyMock).not.toHaveBeenCalled();
    });

    it('rejects status not in defaults+customs', async () => {
        const project = makeProject();
        const task = makeTask({ project_id: project._id, status: 'to_do' });
        taskFindByIdMock.mockResolvedValueOnce(task);
        loadProjectForCallerMock.mockResolvedValueOnce(project);

        await expect(svc.updateTask(task._id, { status: 'nope' }, adminCaller())).rejects.toMatchObject({
            code: ERROR_CODES.TASK_INVALID_STATUS,
        });
    });
});

// ─── reorderTask — assignee carve-out + neighbour shift ──────────────────

describe('reorderTask', () => {
    it('allows the assignee to reorder', async () => {
        const project = makeProject();
        const employeeId = new Types.ObjectId();
        const task = makeTask({
            project_id: project._id,
            primary_assignee_id: employeeId,
            status: 'to_do',
            position: 0,
        });
        taskFindByIdMock.mockResolvedValueOnce(task);
        loadProjectForCallerMock.mockResolvedValueOnce(project);
        stubFindOneForLastPosition({ position: 4 });

        await svc.reorderTask(task._id, { position: 2 }, employeeCaller(employeeId));

        expect(taskUpdateManyMock).toHaveBeenCalledWith(
            {
                project_id: task.project_id,
                status: 'to_do',
                _id: { $ne: task._id },
                position: { $gt: 0, $lte: 2 },
            },
            { $inc: { position: -1 } }
        );
        expect(task.position).toBe(2);
    });

    it('rejects a non-assignee employee', async () => {
        const project = makeProject();
        const task = makeTask({
            project_id: project._id,
            primary_assignee_id: new Types.ObjectId(),
            created_by: new Types.ObjectId(),
        });
        taskFindByIdMock.mockResolvedValueOnce(task);
        loadProjectForCallerMock.mockResolvedValueOnce(project);

        await expect(svc.reorderTask(task._id, { position: 1 }, employeeCaller())).rejects.toMatchObject({
            code: ERROR_CODES.TASK_WRITE_FORBIDDEN,
        });
    });

    it('cross-column move pushes to end of destination AND closes source gap', async () => {
        const project = makeProject();
        const task = makeTask({ project_id: project._id, status: 'to_do', position: 1 });
        taskFindByIdMock.mockResolvedValueOnce(task);
        loadProjectForCallerMock.mockResolvedValueOnce(project);
        // First findOne for nextPositionInColumn(in_progress)
        stubFindOneForLastPosition({ position: 2 });
        // Second findOne for shiftNeighboursInColumn called when body.position
        // differs from the new "end" position. Stub another lookup.
        stubFindOneForLastPosition({ position: 3 });

        await svc.reorderTask(task._id, { position: 0, status: 'in_progress' }, adminCaller());

        expect(task.status).toBe('in_progress');
        // After cross-column move task.position was set to 3 (end+1=3), then
        // shifted to 0 inside the new column.
        expect(task.position).toBe(0);
        // Source-column gap close fired exactly once.
        expect(taskUpdateManyMock).toHaveBeenCalledWith(
            { project_id: task.project_id, status: 'to_do', position: { $gt: 1 } },
            { $inc: { position: -1 } }
        );
    });
});

// ─── assignTaskStory — STORY_WRITE_FORBIDDEN ─────────────────────────────

describe('assignTaskStory', () => {
    it('rejects employees with STORY_WRITE_FORBIDDEN (per API_Contract §8.2a)', async () => {
        await expect(
            svc.assignTaskStory(new Types.ObjectId(), { story_id: new Types.ObjectId().toString() }, employeeCaller())
        ).rejects.toMatchObject({ code: ERROR_CODES.STORY_WRITE_FORBIDDEN });
        expect(taskFindByIdMock).not.toHaveBeenCalled();
    });

    it('rejects clients with STORY_WRITE_FORBIDDEN', async () => {
        await expect(
            svc.assignTaskStory(new Types.ObjectId(), { story_id: null }, clientCaller())
        ).rejects.toMatchObject({ code: ERROR_CODES.STORY_WRITE_FORBIDDEN });
    });

    it('rejects story from a different project with STORY_PROJECT_MISMATCH', async () => {
        const project = makeProject();
        const task = makeTask({ project_id: project._id });
        taskFindByIdMock.mockResolvedValueOnce(task);
        loadProjectForCallerMock.mockResolvedValueOnce(project);
        stubStoryLookup(new Types.ObjectId());

        await expect(
            svc.assignTaskStory(task._id, { story_id: new Types.ObjectId().toString() }, managerCaller())
        ).rejects.toMatchObject({ code: ERROR_CODES.STORY_PROJECT_MISMATCH });
    });

    it('detaches story when story_id is null', async () => {
        const project = makeProject();
        const task = makeTask({ project_id: project._id, story_id: new Types.ObjectId() });
        taskFindByIdMock.mockResolvedValueOnce(task);
        loadProjectForCallerMock.mockResolvedValueOnce(project);

        await svc.assignTaskStory(task._id, { story_id: null }, adminCaller());
        expect(task.story_id).toBeNull();
        expect(task.save).toHaveBeenCalled();
    });
});

// ─── moveTaskToSprint ────────────────────────────────────────────────────

describe('moveTaskToSprint', () => {
    it('rejects employees with TASK_WRITE_FORBIDDEN', async () => {
        await expect(
            svc.moveTaskToSprint(new Types.ObjectId(), { sprint_id: null }, employeeCaller())
        ).rejects.toMatchObject({ code: ERROR_CODES.TASK_WRITE_FORBIDDEN });
    });

    it('rejects sprint from another project', async () => {
        const project = makeProject();
        const task = makeTask({ project_id: project._id });
        taskFindByIdMock.mockResolvedValueOnce(task);
        loadProjectForCallerMock.mockResolvedValueOnce(project);
        stubSprintLookup(new Types.ObjectId());

        await expect(
            svc.moveTaskToSprint(task._id, { sprint_id: new Types.ObjectId().toString() }, adminCaller())
        ).rejects.toMatchObject({ code: ERROR_CODES.TASK_SPRINT_PROJECT_MISMATCH });
    });

    it('moves task to backlog when sprint_id is null', async () => {
        const project = makeProject();
        const task = makeTask({ project_id: project._id, sprint_id: new Types.ObjectId() });
        taskFindByIdMock.mockResolvedValueOnce(task);
        loadProjectForCallerMock.mockResolvedValueOnce(project);

        await svc.moveTaskToSprint(task._id, { sprint_id: null }, managerCaller());
        expect(task.sprint_id).toBeNull();
    });
});

// ─── addTaskDependency — self / dup / cycle / project mismatch ───────────

describe('addTaskDependency', () => {
    it('rejects self-dependency with TASK_DEPENDENCY_SELF', async () => {
        const project = makeProject();
        const task = makeTask({ project_id: project._id });
        taskFindByIdMock.mockResolvedValueOnce(task);
        loadProjectForCallerMock.mockResolvedValueOnce(project);

        await expect(
            svc.addTaskDependency(task._id, { depends_on_task_id: task._id.toString() }, adminCaller())
        ).rejects.toMatchObject({ code: ERROR_CODES.TASK_DEPENDENCY_SELF });
    });

    it('rejects duplicate dependency with TASK_DEPENDENCY_EXISTS', async () => {
        const project = makeProject();
        const depId = new Types.ObjectId();
        const task = makeTask({ project_id: project._id, depends_on_task_ids: [depId] });
        taskFindByIdMock.mockResolvedValueOnce(task);
        loadProjectForCallerMock.mockResolvedValueOnce(project);

        await expect(
            svc.addTaskDependency(task._id, { depends_on_task_id: depId.toString() }, adminCaller())
        ).rejects.toMatchObject({ code: ERROR_CODES.TASK_DEPENDENCY_EXISTS });
    });

    it('rejects dependency in a different project with TASK_DEPENDENCY_PROJECT_MISMATCH', async () => {
        const project = makeProject();
        const task = makeTask({ project_id: project._id });
        taskFindByIdMock.mockResolvedValueOnce(task);
        loadProjectForCallerMock.mockResolvedValueOnce(project);
        // Task.findById(depId).select().lean() → returns project_id elsewhere
        taskFindByIdMock.mockReturnValueOnce({
            select: () => ({ lean: () => Promise.resolve({ project_id: new Types.ObjectId() }) }),
        });

        await expect(
            svc.addTaskDependency(task._id, { depends_on_task_id: new Types.ObjectId().toString() }, adminCaller())
        ).rejects.toMatchObject({ code: ERROR_CODES.TASK_DEPENDENCY_PROJECT_MISMATCH });
    });

    it('rejects circular dependency: A depends on B, B already (transitively) depends on A', async () => {
        const project = makeProject();
        const taskA = makeTask({ project_id: project._id });
        const depBId = new Types.ObjectId();

        taskFindByIdMock.mockResolvedValueOnce(taskA);
        loadProjectForCallerMock.mockResolvedValueOnce(project);
        // depB lookup (.select().lean()) — same project
        taskFindByIdMock.mockReturnValueOnce({
            select: () => ({ lean: () => Promise.resolve({ project_id: project._id }) }),
        });
        // BFS round 1: Task.find({ _id: { $in: [depB] }}).select().lean() →
        // depB depends on taskA  → cycle.
        taskFindMock.mockReturnValueOnce({
            select: () => ({
                lean: () => Promise.resolve([{ depends_on_task_ids: [taskA._id] }]),
            }),
        });

        await expect(
            svc.addTaskDependency(taskA._id, { depends_on_task_id: depBId.toString() }, adminCaller())
        ).rejects.toMatchObject({ code: ERROR_CODES.TASK_DEPENDENCY_CIRCULAR });
        expect(taskA.save).not.toHaveBeenCalled();
    });

    it('happy path: persists the new dependency and audits', async () => {
        const project = makeProject();
        const taskA = makeTask({ project_id: project._id });
        const depBId = new Types.ObjectId();

        taskFindByIdMock.mockResolvedValueOnce(taskA);
        loadProjectForCallerMock.mockResolvedValueOnce(project);
        taskFindByIdMock.mockReturnValueOnce({
            select: () => ({ lean: () => Promise.resolve({ project_id: project._id }) }),
        });
        // BFS round 1: depB has no deps → empty graph → no cycle.
        taskFindMock.mockReturnValueOnce({
            select: () => ({ lean: () => Promise.resolve([{ depends_on_task_ids: [] }]) }),
        });

        const auditCaller = {
            id: new Types.ObjectId(),
            role: ROLES.ADMIN,
            audit: { actor_id: new Types.ObjectId(), actor_role: ROLES.ADMIN, ip: '1.1.1.1', user_agent: null },
        };

        await svc.addTaskDependency(taskA._id, { depends_on_task_id: depBId.toString() }, auditCaller);
        expect(taskA.depends_on_task_ids.map((d) => d.toString())).toEqual([depBId.toString()]);
        expect(taskA.save).toHaveBeenCalled();
        expect(recordAuditMock).toHaveBeenCalledWith(
            auditCaller.audit,
            expect.objectContaining({
                metadata: expect.objectContaining({ depends_on_task_id: depBId.toString() }),
            })
        );
    });
});

// ─── removeTaskDependency ────────────────────────────────────────────────

describe('removeTaskDependency', () => {
    it('returns 404 when the dependency edge does not exist', async () => {
        const project = makeProject();
        const task = makeTask({ project_id: project._id, depends_on_task_ids: [new Types.ObjectId()] });
        taskFindByIdMock.mockResolvedValueOnce(task);
        loadProjectForCallerMock.mockResolvedValueOnce(project);

        await expect(svc.removeTaskDependency(task._id, new Types.ObjectId(), adminCaller())).rejects.toMatchObject({
            code: ERROR_CODES.TASK_DEPENDENCY_NOT_FOUND,
        });
    });

    it('removes the matching id and saves', async () => {
        const project = makeProject();
        const keep = new Types.ObjectId();
        const drop = new Types.ObjectId();
        const task = makeTask({ project_id: project._id, depends_on_task_ids: [keep, drop] });
        taskFindByIdMock.mockResolvedValueOnce(task);
        loadProjectForCallerMock.mockResolvedValueOnce(project);

        await svc.removeTaskDependency(task._id, drop, adminCaller());
        expect(task.depends_on_task_ids.map((d) => d.toString())).toEqual([keep.toString()]);
        expect(task.save).toHaveBeenCalled();
    });
});

// ─── deleteTask ──────────────────────────────────────────────────────────

describe('deleteTask', () => {
    it('rejects employees with TASK_WRITE_FORBIDDEN', async () => {
        await expect(svc.deleteTask(new Types.ObjectId(), employeeCaller())).rejects.toMatchObject({
            code: ERROR_CODES.TASK_WRITE_FORBIDDEN,
        });
    });

    it('detaches subtasks, strips deps, deletes the doc, and closes the column gap', async () => {
        const project = makeProject();
        const task = makeTask({ project_id: project._id, status: 'to_do', position: 2 });
        taskFindByIdMock.mockResolvedValueOnce(task);
        loadProjectForCallerMock.mockResolvedValueOnce(project);
        // Three updateMany calls: detach subtasks, strip deps, close gap.
        taskUpdateManyMock
            .mockResolvedValueOnce({ modifiedCount: 0 })
            .mockResolvedValueOnce({ modifiedCount: 0 })
            .mockResolvedValueOnce({ modifiedCount: 3 });

        const out = await svc.deleteTask(task._id, adminCaller());

        expect(taskUpdateManyMock).toHaveBeenNthCalledWith(
            1,
            { parent_task_id: task._id },
            { $set: { parent_task_id: null } }
        );
        expect(taskUpdateManyMock).toHaveBeenNthCalledWith(
            2,
            { depends_on_task_ids: task._id },
            { $pull: { depends_on_task_ids: task._id } }
        );
        expect(task.deleteOne).toHaveBeenCalled();
        expect(taskUpdateManyMock).toHaveBeenNthCalledWith(
            3,
            { project_id: project._id, status: 'to_do', position: { $gt: 2 } },
            { $inc: { position: -1 } }
        );
        expect(out).toEqual({ deleted: true });
    });
});

// ─── Project visibility ──────────────────────────────────────────────────

describe('project visibility', () => {
    it('getTask propagates 403 from loadProjectForCaller', async () => {
        taskFindByIdMock.mockResolvedValueOnce(makeTask());
        loadProjectForCallerMock.mockRejectedValueOnce(
            Object.assign(new Error('forbidden'), { code: ERROR_CODES.FORBIDDEN })
        );
        await expect(svc.getTask(new Types.ObjectId(), employeeCaller())).rejects.toMatchObject({
            code: ERROR_CODES.FORBIDDEN,
        });
    });

    it('getTask returns 404 TASK_NOT_FOUND when the doc is missing', async () => {
        taskFindByIdMock.mockResolvedValueOnce(null);
        await expect(svc.getTask(new Types.ObjectId(), adminCaller())).rejects.toMatchObject({
            code: ERROR_CODES.TASK_NOT_FOUND,
        });
        expect(loadProjectForCallerMock).not.toHaveBeenCalled();
    });
});
