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
    taskDistinctMock,
    storyFindByIdMock,
    sprintFindByIdMock,
    userFindMock,
    userFindByIdMock,
    loadProjectForCallerMock,
    buildProjectVisibilityFilterMock,
    recordAuditMock,
    recordActivityMock,
    projectFindOneAndUpdateMock,
    sumLoggedTimeForTaskMock,
} = vi.hoisted(() => ({
    taskCreateMock: vi.fn(),
    taskFindByIdMock: vi.fn(),
    taskFindMock: vi.fn(),
    taskFindOneMock: vi.fn(),
    taskCountDocumentsMock: vi.fn(),
    taskUpdateManyMock: vi.fn(),
    taskDistinctMock: vi.fn(),
    storyFindByIdMock: vi.fn(),
    sprintFindByIdMock: vi.fn(),
    userFindMock: vi.fn(),
    userFindByIdMock: vi.fn(),
    loadProjectForCallerMock: vi.fn(),
    buildProjectVisibilityFilterMock: vi.fn(),
    recordAuditMock: vi.fn(),
    recordActivityMock: vi.fn(),
    projectFindOneAndUpdateMock: vi.fn(),
    sumLoggedTimeForTaskMock: vi.fn(),
}));

vi.mock('../models/task.model.js', () => ({
    Task: {
        create: taskCreateMock,
        findById: taskFindByIdMock,
        find: taskFindMock,
        findOne: taskFindOneMock,
        countDocuments: taskCountDocumentsMock,
        updateMany: taskUpdateManyMock,
        distinct: taskDistinctMock,
    },
}));

vi.mock('../models/story.model.js', () => ({
    Story: { findById: storyFindByIdMock },
}));

vi.mock('../models/sprint.model.js', () => ({
    Sprint: { findById: sprintFindByIdMock },
}));

vi.mock('../models/user.model.js', () => ({
    User: { find: userFindMock, findById: userFindByIdMock },
}));

vi.mock('../models/project.model.js', () => ({
    Project: {
        find: vi.fn().mockReturnValue({
            select: () => ({ limit: () => ({ lean: () => Promise.resolve([]) }) }),
        }),
        findOneAndUpdate: projectFindOneAndUpdateMock,
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

vi.mock('./timesheet.service.js', () => ({
    sumLoggedTimeForTask: sumLoggedTimeForTaskMock,
}));

// Activity hooks are best-effort fire-and-forget; stub them out so tests
// don't have to thread `TaskActivity` mocks through every fixture.
vi.mock('./task-activity.service.js', () => ({
    recordActivity: recordActivityMock,
    recordActivityIfChanged: vi.fn(),
}));

const svc = await import('./task.service.js');
import { ERROR_CODES } from '../constants/error-codes.js';
import { ROLES } from '../constants/roles.js';
import { DEFAULT_TASK_STATUSES, TASK_PRIORITIES } from '../constants/task.js';
import { TASK_ACTIVITY_TYPES } from '../constants/task-activity.js';

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
        labels: [] as string[],
        due_date: '2026-05-10',
        estimated_hours: 0,
        is_flagged: false,
        assignee_ids: [] as Types.ObjectId[],
        primary_assignee_id: null as Types.ObjectId | null,
        collaborator_ids: [] as Types.ObjectId[],
        depends_on_task_ids: [] as Types.ObjectId[],
        position: 0,
        backlog_rank: 0,
        created_by: new Types.ObjectId(),
        updated_by: null as Types.ObjectId | null,
        completed_at: null as Date | null,
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
        backlog_rank: task.backlog_rank,
    }));
    return task;
};

/** Stub `Task.findOne(...).sort().select().lean()` for nextPositionInColumn. */
const stubFindOneForLastPosition = (returns: { position: number } | null): void => {
    taskFindOneMock.mockReturnValueOnce({
        sort: () => ({ select: () => ({ lean: () => Promise.resolve(returns) }) }),
    });
};

/**
 * Stub `Task.findOne(...).sort().select().lean()` for nextBacklogRank /
 * shiftBacklogNeighbours. Same chain shape as the position stub but returns
 * a `{ backlog_rank }` row.
 */
const stubFindOneForLastRank = (returns: { backlog_rank: number } | null): void => {
    taskFindOneMock.mockReturnValueOnce({
        sort: () => ({ select: () => ({ lean: () => Promise.resolve(returns) }) }),
    });
};

/** Stub `Task.findOne(...).select().lean()` for the rank neighbour lookup. */
const stubFindOneForNeighbour = (returns: { backlog_rank: number } | null): void => {
    taskFindOneMock.mockReturnValueOnce({
        select: () => ({ lean: () => Promise.resolve(returns) }),
    });
};

/** Stub `User.find(...).select().lean()` used by `assertActiveInternalUsers`
 *  to return the given ids as ACTIVE employees (so assignee validation passes). */
const stubActiveUsers = (ids: Types.ObjectId[]): void => {
    userFindMock.mockReturnValueOnce({
        select: () => ({
            lean: () => Promise.resolve(ids.map((id) => ({ _id: id, role: ROLES.EMPLOYEE }))),
        }),
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

/**
 * Stub the atomic issue-key reservation `Project.findOneAndUpdate(...).lean()`.
 * Returns `{ task_seq }` — the post-`$inc` counter that becomes the new task's
 * `task_number`. `null` simulates the project vanishing mid-create.
 */
const stubReserveKey = (taskSeq: number | null): void => {
    projectFindOneAndUpdateMock.mockReturnValueOnce({
        lean: () => Promise.resolve(taskSeq === null ? null : { task_seq: taskSeq }),
    });
};

beforeEach(() => {
    vi.resetAllMocks();
    // Default: every create reserves key #1 unless a test overrides it.
    projectFindOneAndUpdateMock.mockReturnValue({
        lean: () => Promise.resolve({ task_seq: 1 }),
    });
    // Default: getTask's reporter lookup finds 'Rita Mehta'.
    userFindByIdMock.mockReturnValue({
        select: () => ({ lean: () => Promise.resolve({ full_name: 'Rita Mehta' }) }),
    });
    // Default: no logged time unless a getTask test overrides it.
    sumLoggedTimeForTaskMock.mockResolvedValue({
        logged_minutes: 0,
        billable_minutes: 0,
        entry_count: 0,
        contributor_count: 0,
    });
});

// ─── createTask — RBAC + cross-doc validation ────────────────────────────

describe('createTask', () => {
    const baseInput = (project_id: Types.ObjectId) => ({
        project_id: project_id.toString(),
        title: 'New task',
        description: '',
        due_date: '2026-05-10',
    });

    it('lets an employee create a task in a project they can see (scoped by loadProjectForCaller)', async () => {
        const project = makeProject();
        loadProjectForCallerMock.mockResolvedValueOnce(project);
        stubFindOneForLastPosition(null);
        stubFindOneForLastRank(null);
        taskCreateMock.mockResolvedValueOnce(makeTask({ project_id: project._id }));

        await svc.createTask(baseInput(project._id), employeeCaller());

        // The gate is gone; project visibility is what limits an employee to
        // their assigned projects (loadProjectForCaller throws otherwise).
        expect(loadProjectForCallerMock).toHaveBeenCalled();
        expect(taskCreateMock).toHaveBeenCalled();
    });

    it('rejects clients with TASK_WRITE_FORBIDDEN before any DB call', async () => {
        await expect(svc.createTask(baseInput(new Types.ObjectId()), clientCaller())).rejects.toMatchObject({
            code: ERROR_CODES.TASK_WRITE_FORBIDDEN,
        });
        expect(loadProjectForCallerMock).not.toHaveBeenCalled();
    });

    it('rejects more than one assignee — a ticket has one (Jira-style)', async () => {
        const project = makeProject();
        loadProjectForCallerMock.mockResolvedValueOnce(project);
        const a = new Types.ObjectId();
        const b = new Types.ObjectId();

        await expect(
            svc.createTask({ ...baseInput(project._id), assignee_ids: [a.toString(), b.toString()] }, adminCaller())
        ).rejects.toMatchObject({ code: ERROR_CODES.VALIDATION_ERROR });
        expect(taskCreateMock).not.toHaveBeenCalled();
    });

    it('merges a matching primary_assignee_id + assignee_ids into one assignee', async () => {
        const project = makeProject();
        loadProjectForCallerMock.mockResolvedValueOnce(project);
        const a = new Types.ObjectId();
        stubActiveUsers([a]);
        stubFindOneForLastPosition(null);
        stubFindOneForLastRank(null);
        taskCreateMock.mockResolvedValueOnce(makeTask({ project_id: project._id }));

        await svc.createTask(
            { ...baseInput(project._id), primary_assignee_id: a.toString(), assignee_ids: [a.toString()] },
            adminCaller()
        );

        const createArg = taskCreateMock.mock.calls[0][0];
        expect(createArg.assignee_ids.map(String)).toEqual([a.toString()]);
        expect(String(createArg.primary_assignee_id)).toBe(a.toString());
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
        stubFindOneForLastRank(null);
        const created = makeTask({ project_id: project._id, status: 'qa_passed', position: 0 });
        taskCreateMock.mockResolvedValueOnce(created);

        await svc.createTask({ ...baseInput(project._id), status: 'qa_passed' }, adminCaller());
        expect(taskCreateMock).toHaveBeenCalledWith(expect.objectContaining({ status: 'qa_passed' }));
    });

    it('sets completed_at when created directly in the done column', async () => {
        const project = makeProject();
        loadProjectForCallerMock.mockResolvedValueOnce(project);
        stubFindOneForLastPosition(null);
        stubFindOneForLastRank(null);
        taskCreateMock.mockResolvedValueOnce(makeTask({ project_id: project._id, status: 'done' }));

        await svc.createTask({ ...baseInput(project._id), status: 'done' }, adminCaller());

        expect(taskCreateMock).toHaveBeenCalledWith(
            expect.objectContaining({ status: 'done', completed_at: expect.any(Date) })
        );
    });

    it('leaves completed_at null when created in a non-done column', async () => {
        const project = makeProject();
        loadProjectForCallerMock.mockResolvedValueOnce(project);
        stubFindOneForLastPosition(null);
        stubFindOneForLastRank(null);
        taskCreateMock.mockResolvedValueOnce(makeTask({ project_id: project._id }));

        await svc.createTask(baseInput(project._id), adminCaller());

        expect(taskCreateMock).toHaveBeenCalledWith(expect.objectContaining({ completed_at: null }));
    });

    it('assigns task_number from the atomically reserved counter', async () => {
        const project = makeProject();
        loadProjectForCallerMock.mockResolvedValueOnce(project);
        stubFindOneForLastPosition(null);
        stubReserveKey(42);
        stubFindOneForLastRank(null);
        taskCreateMock.mockResolvedValueOnce(makeTask({ project_id: project._id }));

        await svc.createTask(baseInput(project._id), adminCaller());

        // Reserved via a single-doc atomic $inc, then written as task_number.
        expect(projectFindOneAndUpdateMock).toHaveBeenCalledWith(
            { _id: project._id },
            { $inc: { task_seq: 1 } },
            expect.objectContaining({ new: true })
        );
        expect(taskCreateMock).toHaveBeenCalledWith(expect.objectContaining({ task_number: 42 }));
    });

    it('gives concurrent creates distinct numbers (atomic counter)', async () => {
        const project = makeProject();
        // Two creates; the atomic $inc returns increasing values, so the two
        // tasks get distinct numbers even when issued back-to-back.
        loadProjectForCallerMock.mockResolvedValue(project);
        stubFindOneForLastPosition(null);
        stubFindOneForLastRank(null);
        stubReserveKey(1);
        stubFindOneForLastPosition(null);
        stubFindOneForLastRank(null);
        stubReserveKey(2);
        taskCreateMock.mockResolvedValue(makeTask({ project_id: project._id }));

        await svc.createTask(baseInput(project._id), adminCaller());
        await svc.createTask(baseInput(project._id), adminCaller());

        const numbers = taskCreateMock.mock.calls.map((c) => (c[0] as { task_number: number }).task_number);
        expect(new Set(numbers).size).toBe(2);
        expect(numbers).toEqual([1, 2]);
    });

    it('defaults issue_type to task and story_points to null', async () => {
        const project = makeProject();
        loadProjectForCallerMock.mockResolvedValueOnce(project);
        stubFindOneForLastPosition(null);
        stubFindOneForLastRank(null);
        taskCreateMock.mockResolvedValueOnce(makeTask({ project_id: project._id }));

        await svc.createTask(baseInput(project._id), adminCaller());
        expect(taskCreateMock).toHaveBeenCalledWith(
            expect.objectContaining({ issue_type: 'task', story_points: null })
        );
    });

    it('passes through issue_type and story_points when supplied', async () => {
        const project = makeProject();
        loadProjectForCallerMock.mockResolvedValueOnce(project);
        stubFindOneForLastPosition(null);
        stubFindOneForLastRank(null);
        taskCreateMock.mockResolvedValueOnce(makeTask({ project_id: project._id }));

        await svc.createTask({ ...baseInput(project._id), issue_type: 'bug', story_points: 5 }, adminCaller());
        expect(taskCreateMock).toHaveBeenCalledWith(expect.objectContaining({ issue_type: 'bug', story_points: 5 }));
    });

    it('defaults labels to [] when omitted', async () => {
        const project = makeProject();
        loadProjectForCallerMock.mockResolvedValueOnce(project);
        stubFindOneForLastPosition(null);
        stubFindOneForLastRank(null);
        taskCreateMock.mockResolvedValueOnce(makeTask({ project_id: project._id }));

        await svc.createTask(baseInput(project._id), adminCaller());
        expect(taskCreateMock).toHaveBeenCalledWith(expect.objectContaining({ labels: [] }));
    });

    it('persists labels when supplied', async () => {
        const project = makeProject();
        loadProjectForCallerMock.mockResolvedValueOnce(project);
        stubFindOneForLastPosition(null);
        stubFindOneForLastRank(null);
        taskCreateMock.mockResolvedValueOnce(makeTask({ project_id: project._id }));

        await svc.createTask({ ...baseInput(project._id), labels: ['frontend', 'bug'] }, adminCaller());
        expect(taskCreateMock).toHaveBeenCalledWith(expect.objectContaining({ labels: ['frontend', 'bug'] }));
    });

    it('throws PROJECT_NOT_FOUND when the counter reservation returns null', async () => {
        const project = makeProject();
        loadProjectForCallerMock.mockResolvedValueOnce(project);
        stubFindOneForLastPosition(null);
        stubReserveKey(null);

        await expect(svc.createTask(baseInput(project._id), adminCaller())).rejects.toMatchObject({
            code: ERROR_CODES.PROJECT_NOT_FOUND,
        });
        expect(taskCreateMock).not.toHaveBeenCalled();
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
        stubFindOneForLastRank({ backlog_rank: 4 });
        const created = makeTask({ project_id: project._id, position: 5 });
        taskCreateMock.mockResolvedValueOnce(created);

        await svc.createTask(baseInput(project._id), adminCaller());

        expect(taskCreateMock).toHaveBeenCalledWith(expect.objectContaining({ position: 5, backlog_rank: 5 }));
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

    it('lets a NON-owner employee add themselves to assignee_ids (grab an unassigned task)', async () => {
        const project = makeProject();
        const employeeId = new Types.ObjectId();
        const task = makeTask({
            project_id: project._id,
            created_by: new Types.ObjectId(), // someone else
            assignee_ids: [],
            primary_assignee_id: null,
        });
        taskFindByIdMock.mockResolvedValueOnce(task);
        loadProjectForCallerMock.mockResolvedValueOnce(project);
        stubActiveUsers([employeeId]);

        await svc.updateTask(task._id, { assignee_ids: [employeeId.toString()] }, employeeCaller(employeeId));

        expect(task.assignee_ids.map(String)).toEqual([employeeId.toString()]);
        expect(String(task.primary_assignee_id)).toBe(employeeId.toString());
        expect(task.save).toHaveBeenCalled();
    });

    it('rejects a NON-owner employee assigning someone ELSE', async () => {
        const project = makeProject();
        const employeeId = new Types.ObjectId();
        const someoneElse = new Types.ObjectId();
        const task = makeTask({
            project_id: project._id,
            created_by: new Types.ObjectId(),
            assignee_ids: [],
        });
        taskFindByIdMock.mockResolvedValueOnce(task);
        loadProjectForCallerMock.mockResolvedValueOnce(project);

        await expect(
            svc.updateTask(task._id, { assignee_ids: [someoneElse.toString()] }, employeeCaller(employeeId))
        ).rejects.toMatchObject({ code: ERROR_CODES.TASK_WRITE_FORBIDDEN });
        expect(task.save).not.toHaveBeenCalled();
    });

    it('rejects a NON-owner employee who edits another field alongside a self-assign', async () => {
        const project = makeProject();
        const employeeId = new Types.ObjectId();
        const task = makeTask({ project_id: project._id, created_by: new Types.ObjectId(), assignee_ids: [] });
        taskFindByIdMock.mockResolvedValueOnce(task);
        loadProjectForCallerMock.mockResolvedValueOnce(project);

        await expect(
            svc.updateTask(
                task._id,
                { assignee_ids: [employeeId.toString()], status: 'done' },
                employeeCaller(employeeId)
            )
        ).rejects.toMatchObject({ code: ERROR_CODES.TASK_WRITE_FORBIDDEN });
        expect(task.save).not.toHaveBeenCalled();
    });

    it('lets a NON-owner employee take over a ticket someone else holds (Jira "Assign to me")', async () => {
        const project = makeProject();
        const employeeId = new Types.ObjectId();
        const existing = new Types.ObjectId();
        const task = makeTask({
            project_id: project._id,
            created_by: new Types.ObjectId(),
            assignee_ids: [existing],
            primary_assignee_id: existing,
        });
        taskFindByIdMock.mockResolvedValueOnce(task);
        loadProjectForCallerMock.mockResolvedValueOnce(project);
        stubActiveUsers([employeeId]);

        await svc.updateTask(task._id, { assignee_ids: [employeeId.toString()] }, employeeCaller(employeeId));
        expect(task.assignee_ids.map(String)).toEqual([employeeId.toString()]);
        expect(String(task.primary_assignee_id)).toBe(employeeId.toString());
        expect(task.save).toHaveBeenCalled();
    });

    it('lets the CREATOR employee assign multiple project members', async () => {
        const project = makeProject();
        const employeeId = new Types.ObjectId();
        const teammate = new Types.ObjectId();
        const task = makeTask({
            project_id: project._id,
            created_by: employeeId, // creator
            assignee_ids: [employeeId],
            primary_assignee_id: employeeId,
        });
        taskFindByIdMock.mockResolvedValueOnce(task);
        loadProjectForCallerMock.mockResolvedValueOnce(project);
        stubActiveUsers([employeeId, teammate]);

        await svc.updateTask(
            task._id,
            { assignee_ids: [employeeId.toString(), teammate.toString()] },
            employeeCaller(employeeId)
        );

        expect(task.assignee_ids.map(String)).toEqual([employeeId.toString(), teammate.toString()]);
        expect(String(task.primary_assignee_id)).toBe(employeeId.toString());
        expect(task.save).toHaveBeenCalled();
    });

    it('lets a non-creator ASSIGNEE edit their work fields (status)', async () => {
        const project = makeProject();
        const employeeId = new Types.ObjectId();
        const task = makeTask({
            project_id: project._id,
            created_by: new Types.ObjectId(), // someone else made it
            assignee_ids: [employeeId], // but they are assigned
            primary_assignee_id: employeeId,
            status: 'to_do',
            position: 1,
        });
        taskFindByIdMock.mockResolvedValueOnce(task);
        loadProjectForCallerMock.mockResolvedValueOnce(project);
        stubFindOneForLastPosition({ position: 4 });

        await svc.updateTask(task._id, { status: 'in_progress' }, employeeCaller(employeeId));
        expect(task.status).toBe('in_progress');
        expect(task.save).toHaveBeenCalled();
    });

    it('rejects a non-creator ASSIGNEE from assigning SOMEONE ELSE', async () => {
        const project = makeProject();
        const employeeId = new Types.ObjectId();
        const teammate = new Types.ObjectId();
        const task = makeTask({
            project_id: project._id,
            created_by: new Types.ObjectId(),
            assignee_ids: [employeeId],
            primary_assignee_id: employeeId,
        });
        taskFindByIdMock.mockResolvedValueOnce(task);
        loadProjectForCallerMock.mockResolvedValueOnce(project);

        // Assigned, but NOT the creator → may not add a teammate.
        await expect(
            svc.updateTask(
                task._id,
                { assignee_ids: [employeeId.toString(), teammate.toString()] },
                employeeCaller(employeeId)
            )
        ).rejects.toMatchObject({ code: ERROR_CODES.TASK_WRITE_FORBIDDEN });
        expect(task.save).not.toHaveBeenCalled();
    });

    it('rejects a non-creator ASSIGNEE removing themselves (only creator/managers remove)', async () => {
        const project = makeProject();
        const employeeId = new Types.ObjectId();
        const other = new Types.ObjectId();
        const task = makeTask({
            project_id: project._id,
            created_by: new Types.ObjectId(),
            assignee_ids: [other, employeeId],
            primary_assignee_id: other,
        });
        taskFindByIdMock.mockResolvedValueOnce(task);
        loadProjectForCallerMock.mockResolvedValueOnce(project);

        // Tries to drop themselves — not allowed for a non-creator.
        await expect(
            svc.updateTask(task._id, { assignee_ids: [other.toString()] }, employeeCaller(employeeId))
        ).rejects.toMatchObject({ code: ERROR_CODES.TASK_WRITE_FORBIDDEN });
        expect(task.save).not.toHaveBeenCalled();
    });

    it('refuses a non-creator employee keeping someone else on the ticket alongside themselves', async () => {
        const project = makeProject();
        const employeeId = new Types.ObjectId();
        const other = new Types.ObjectId();
        const task = makeTask({
            project_id: project._id,
            created_by: new Types.ObjectId(),
            assignee_ids: [other],
            primary_assignee_id: other,
        });
        taskFindByIdMock.mockResolvedValueOnce(task);
        loadProjectForCallerMock.mockResolvedValueOnce(project);

        await expect(
            svc.updateTask(
                task._id,
                { assignee_ids: [other.toString(), employeeId.toString()] },
                employeeCaller(employeeId)
            )
        ).rejects.toMatchObject({ code: ERROR_CODES.TASK_WRITE_FORBIDDEN });
        expect(task.save).not.toHaveBeenCalled();
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

    it('stamps completed_at when a task enters the done column', async () => {
        const project = makeProject();
        const task = makeTask({ project_id: project._id, status: 'in_progress', completed_at: null });
        taskFindByIdMock.mockResolvedValueOnce(task);
        loadProjectForCallerMock.mockResolvedValueOnce(project);
        stubFindOneForLastPosition({ position: 2 });

        await svc.updateTask(task._id, { status: 'done' }, adminCaller());

        expect(task.status).toBe('done');
        expect(task.completed_at).toBeInstanceOf(Date);
    });

    it('clears completed_at when a done task is reopened', async () => {
        const project = makeProject();
        const task = makeTask({ project_id: project._id, status: 'done', completed_at: new Date('2026-06-01') });
        taskFindByIdMock.mockResolvedValueOnce(task);
        loadProjectForCallerMock.mockResolvedValueOnce(project);
        stubFindOneForLastPosition({ position: 2 });

        await svc.updateTask(task._id, { status: 'in_progress' }, adminCaller());

        expect(task.status).toBe('in_progress');
        expect(task.completed_at).toBeNull();
    });

    it('leaves completed_at untouched on a non-done status change', async () => {
        const project = makeProject();
        const stamp = new Date('2026-06-01');
        // Edge case: a task somehow done with a stamp moving between two
        // non-done columns must not touch the stamp (no done transition).
        const task = makeTask({ project_id: project._id, status: 'to_do', completed_at: stamp });
        taskFindByIdMock.mockResolvedValueOnce(task);
        loadProjectForCallerMock.mockResolvedValueOnce(project);
        stubFindOneForLastPosition({ position: 2 });

        await svc.updateTask(task._id, { status: 'in_progress' }, adminCaller());

        expect(task.completed_at).toBe(stamp);
    });
});

// ─── updateTask — labels activity (Phase 3c) ─────────────────────────────

describe('updateTask — labels', () => {
    const wasLabelsChangedEmitted = (): boolean =>
        recordActivityMock.mock.calls.some(
            (c) => (c[0] as { activity_type: string }).activity_type === TASK_ACTIVITY_TYPES.LABELS_CHANGED
        );

    it('emits LABELS_CHANGED when the label set changes', async () => {
        const project = makeProject();
        const task = makeTask({ project_id: project._id, labels: ['frontend'] });
        taskFindByIdMock.mockResolvedValueOnce(task);
        loadProjectForCallerMock.mockResolvedValueOnce(project);

        await svc.updateTask(task._id, { labels: ['frontend', 'bug'] }, adminCaller());

        expect(task.labels).toEqual(['frontend', 'bug']);
        expect(wasLabelsChangedEmitted()).toBe(true);
        expect(recordActivityMock).toHaveBeenCalledWith(
            expect.objectContaining({
                activity_type: TASK_ACTIVITY_TYPES.LABELS_CHANGED,
                from_value: ['frontend'],
                to_value: ['frontend', 'bug'],
            })
        );
    });

    // Regression: ISSUE-003 — renaming a task left no trace in Activity.
    it('emits TITLE_CHANGED when the title changes', async () => {
        const project = makeProject();
        const task = makeTask({ project_id: project._id, title: 'Old name' });
        taskFindByIdMock.mockResolvedValueOnce(task);
        loadProjectForCallerMock.mockResolvedValueOnce(project);

        await svc.updateTask(task._id, { title: 'New name' }, adminCaller());

        expect(recordActivityMock).toHaveBeenCalledWith(
            expect.objectContaining({
                activity_type: TASK_ACTIVITY_TYPES.TITLE_CHANGED,
                from_value: 'Old name',
                to_value: 'New name',
            })
        );
    });

    it('does NOT emit LABELS_CHANGED on a reorder / case-only no-op', async () => {
        const project = makeProject();
        const task = makeTask({ project_id: project._id, labels: ['UI', 'api'] });
        taskFindByIdMock.mockResolvedValueOnce(task);
        loadProjectForCallerMock.mockResolvedValueOnce(project);

        // Same set, reordered + different case — must be treated as unchanged.
        await svc.updateTask(task._id, { labels: ['api', 'ui'] }, adminCaller());

        expect(wasLabelsChangedEmitted()).toBe(false);
    });
});

// ─── listProjectTaskLabels — suggestions (Phase 3c) ──────────────────────

describe('listProjectTaskLabels', () => {
    it('returns distinct labels sorted alphabetically', async () => {
        const project = makeProject();
        loadProjectForCallerMock.mockResolvedValueOnce(project);
        taskDistinctMock.mockResolvedValueOnce(['zebra', 'apple', 'Mango', '']);

        const out = await svc.listProjectTaskLabels(project._id, adminCaller());

        expect(taskDistinctMock).toHaveBeenCalledWith('labels', { project_id: project._id });
        // Empty string filtered out; case-insensitive alpha order.
        expect(out).toEqual(['apple', 'Mango', 'zebra']);
    });

    it('propagates 403 from loadProjectForCaller (visibility gate)', async () => {
        loadProjectForCallerMock.mockRejectedValueOnce(
            Object.assign(new Error('forbidden'), { code: ERROR_CODES.FORBIDDEN })
        );
        await expect(svc.listProjectTaskLabels(new Types.ObjectId(), employeeCaller())).rejects.toMatchObject({
            code: ERROR_CODES.FORBIDDEN,
        });
        expect(taskDistinctMock).not.toHaveBeenCalled();
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

// ─── rankTask — backlog ordering (Phase 2 Backlog) ───────────────────────

describe('rankTask', () => {
    it('rejects a non-assignee employee with TASK_WRITE_FORBIDDEN', async () => {
        const project = makeProject();
        const task = makeTask({
            project_id: project._id,
            primary_assignee_id: new Types.ObjectId(),
            created_by: new Types.ObjectId(),
        });
        taskFindByIdMock.mockResolvedValueOnce(task);
        loadProjectForCallerMock.mockResolvedValueOnce(project);

        await expect(svc.rankTask(task._id, { after_task_id: null }, employeeCaller())).rejects.toMatchObject({
            code: ERROR_CODES.TASK_WRITE_FORBIDDEN,
        });
    });

    it('lands a task AFTER a lower-ranked neighbour (moving up shifts neighbours down-list)', async () => {
        const project = makeProject();
        // task at rank 0, neighbour at rank 2 → moving DOWN the list.
        const task = makeTask({ project_id: project._id, backlog_rank: 0 });
        taskFindByIdMock.mockResolvedValueOnce(task);
        loadProjectForCallerMock.mockResolvedValueOnce(project);
        stubFindOneForNeighbour({ backlog_rank: 2 }); // neighbour lookup
        stubFindOneForLastRank({ backlog_rank: 3 }); // max rank for shift clamp

        const neighbourId = new Types.ObjectId();
        await svc.rankTask(task._id, { after_task_id: neighbourId.toString() }, adminCaller());

        // movingDown && after → target = neighbour.rank = 2.
        // newRank(2) > oldRank(0) → decrement ranks in (0, 2].
        expect(taskUpdateManyMock).toHaveBeenCalledWith(
            {
                project_id: task.project_id,
                _id: { $ne: task._id },
                backlog_rank: { $gt: 0, $lte: 2 },
            },
            { $inc: { backlog_rank: -1 } }
        );
        expect(task.backlog_rank).toBe(2);
        expect(task.save).toHaveBeenCalled();
    });

    it('lands a task BEFORE a higher-ranked neighbour (moving up shifts neighbours up-list)', async () => {
        const project = makeProject();
        // task at rank 3, neighbour at rank 1 → moving UP the list.
        const task = makeTask({ project_id: project._id, backlog_rank: 3 });
        taskFindByIdMock.mockResolvedValueOnce(task);
        loadProjectForCallerMock.mockResolvedValueOnce(project);
        stubFindOneForNeighbour({ backlog_rank: 1 });
        stubFindOneForLastRank({ backlog_rank: 3 });

        const neighbourId = new Types.ObjectId();
        await svc.rankTask(task._id, { before_task_id: neighbourId.toString() }, adminCaller());

        // !movingDown && before → target = neighbour.rank = 1.
        // newRank(1) < oldRank(3) → increment ranks in [1, 3).
        expect(taskUpdateManyMock).toHaveBeenCalledWith(
            {
                project_id: task.project_id,
                _id: { $ne: task._id },
                backlog_rank: { $gte: 1, $lt: 3 },
            },
            { $inc: { backlog_rank: 1 } }
        );
        expect(task.backlog_rank).toBe(1);
    });

    it('moves the task to the top when neither neighbour is supplied', async () => {
        const project = makeProject();
        const task = makeTask({ project_id: project._id, backlog_rank: 4 });
        taskFindByIdMock.mockResolvedValueOnce(task);
        loadProjectForCallerMock.mockResolvedValueOnce(project);
        stubFindOneForLastRank({ backlog_rank: 5 }); // max rank for shift clamp

        await svc.rankTask(task._id, {}, adminCaller());

        // target = 0; newRank(0) < oldRank(4) → increment ranks in [0, 4).
        expect(taskUpdateManyMock).toHaveBeenCalledWith(
            {
                project_id: task.project_id,
                _id: { $ne: task._id },
                backlog_rank: { $gte: 0, $lt: 4 },
            },
            { $inc: { backlog_rank: 1 } }
        );
        expect(task.backlog_rank).toBe(0);
    });

    it('re-ranking a task after the neighbour it already follows is a no-op (safe retry)', async () => {
        const project = makeProject();
        // task at rank 3 already directly after the neighbour at rank 2.
        const task = makeTask({ project_id: project._id, backlog_rank: 3 });
        taskFindByIdMock.mockResolvedValueOnce(task);
        loadProjectForCallerMock.mockResolvedValueOnce(project);
        stubFindOneForNeighbour({ backlog_rank: 2 });
        stubFindOneForLastRank({ backlog_rank: 9 });

        await svc.rankTask(task._id, { after_task_id: new Types.ObjectId().toString() }, adminCaller());

        expect(taskUpdateManyMock).not.toHaveBeenCalled();
        expect(task.backlog_rank).toBe(3);
    });

    it('shifts only the rank range between the old and new slot (hidden tasks keep their order)', async () => {
        const project = makeProject();
        // rank 2 → after neighbour at rank 5 (moving down): only (2, 5] shifts.
        const task = makeTask({ project_id: project._id, backlog_rank: 2 });
        taskFindByIdMock.mockResolvedValueOnce(task);
        loadProjectForCallerMock.mockResolvedValueOnce(project);
        stubFindOneForNeighbour({ backlog_rank: 5 });
        stubFindOneForLastRank({ backlog_rank: 9 });

        await svc.rankTask(task._id, { after_task_id: new Types.ObjectId().toString() }, adminCaller());

        expect(taskUpdateManyMock).toHaveBeenCalledTimes(1);
        expect(taskUpdateManyMock).toHaveBeenCalledWith(
            { project_id: task.project_id, _id: { $ne: task._id }, backlog_rank: { $gt: 2, $lte: 5 } },
            { $inc: { backlog_rank: -1 } }
        );
        expect(task.backlog_rank).toBe(5);
    });

    it('rejects a neighbour that is not in the same project', async () => {
        const project = makeProject();
        const task = makeTask({ project_id: project._id, backlog_rank: 0 });
        taskFindByIdMock.mockResolvedValueOnce(task);
        loadProjectForCallerMock.mockResolvedValueOnce(project);
        stubFindOneForNeighbour(null); // scoped lookup finds nothing

        await expect(
            svc.rankTask(task._id, { after_task_id: new Types.ObjectId().toString() }, adminCaller())
        ).rejects.toMatchObject({ code: ERROR_CODES.TASK_NOT_FOUND });
        expect(taskUpdateManyMock).not.toHaveBeenCalled();
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
    it('an epic change on a parent carries to its subtasks', async () => {
        const project = makeProject();
        const task = makeTask({ project_id: project._id, story_id: null, parent_task_id: null });
        taskFindByIdMock.mockResolvedValueOnce(task);
        loadProjectForCallerMock.mockResolvedValueOnce(project);
        stubStoryLookup(project._id);
        const storyId = new Types.ObjectId();

        await svc.assignTaskStory(task._id, { story_id: storyId.toString() }, adminCaller());

        expect(taskUpdateManyMock).toHaveBeenCalledWith(
            { parent_task_id: task._id },
            { $set: { story_id: storyId, updated_by: expect.anything() } }
        );
    });

    it("a subtask's own epic change does not touch other tasks", async () => {
        const project = makeProject();
        const task = makeTask({ project_id: project._id, story_id: null, parent_task_id: new Types.ObjectId() });
        taskFindByIdMock.mockResolvedValueOnce(task);
        loadProjectForCallerMock.mockResolvedValueOnce(project);
        stubStoryLookup(project._id);

        await svc.assignTaskStory(task._id, { story_id: new Types.ObjectId().toString() }, adminCaller());

        expect(taskUpdateManyMock).not.toHaveBeenCalled();
    });
});

// ─── moveTaskToSprint ────────────────────────────────────────────────────

// Regression: the Sprints tab offered completed sprints as "Move to" targets,
// and the BE accepted it — the ticket vanished into a closed sprint.
describe('moving into a completed sprint', () => {
    const stubCompletedSprint = (project_id: Types.ObjectId): void => {
        sprintFindByIdMock.mockReturnValueOnce({
            select: () => ({ lean: () => Promise.resolve({ project_id, status: 'completed' }) }),
        });
    };

    it('move-sprint refuses a completed sprint', async () => {
        const project = makeProject();
        const task = makeTask({ project_id: project._id, sprint_id: null });
        taskFindByIdMock.mockResolvedValueOnce(task);
        loadProjectForCallerMock.mockResolvedValueOnce(project);
        stubCompletedSprint(project._id);

        await expect(
            svc.moveTaskToSprint(task._id, { sprint_id: new Types.ObjectId().toString() }, adminCaller())
        ).rejects.toMatchObject({ code: ERROR_CODES.SPRINT_INVALID_TRANSITION });
        expect(task.save).not.toHaveBeenCalled();
    });

    it('PATCH refuses moving into a completed sprint', async () => {
        const project = makeProject();
        const task = makeTask({ project_id: project._id, sprint_id: null });
        taskFindByIdMock.mockResolvedValueOnce(task);
        loadProjectForCallerMock.mockResolvedValueOnce(project);
        stubCompletedSprint(project._id);

        await expect(
            svc.updateTask(task._id, { sprint_id: new Types.ObjectId().toString() }, adminCaller())
        ).rejects.toMatchObject({ code: ERROR_CODES.SPRINT_INVALID_TRANSITION });
    });
});

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

    it('a parent moving sprint carries its subtasks along', async () => {
        const project = makeProject();
        const task = makeTask({ project_id: project._id, sprint_id: null, parent_task_id: null });
        taskFindByIdMock.mockResolvedValueOnce(task);
        loadProjectForCallerMock.mockResolvedValueOnce(project);
        stubSprintLookup(project._id);
        const sprintId = new Types.ObjectId();

        await svc.moveTaskToSprint(task._id, { sprint_id: sprintId.toString() }, adminCaller());

        expect(taskUpdateManyMock).toHaveBeenCalledWith(
            { parent_task_id: task._id },
            { $set: { sprint_id: sprintId, updated_by: expect.anything() } }
        );
    });

    it("a subtask's own sprint move does not touch other tasks", async () => {
        const project = makeProject();
        const task = makeTask({ project_id: project._id, sprint_id: null, parent_task_id: new Types.ObjectId() });
        taskFindByIdMock.mockResolvedValueOnce(task);
        loadProjectForCallerMock.mockResolvedValueOnce(project);
        stubSprintLookup(project._id);

        await svc.moveTaskToSprint(task._id, { sprint_id: new Types.ObjectId().toString() }, adminCaller());

        expect(taskUpdateManyMock).not.toHaveBeenCalled();
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

    it('getTask embeds time_tracking rolled up from timesheets', async () => {
        const task = makeTask();
        taskFindByIdMock.mockResolvedValueOnce(task);
        loadProjectForCallerMock.mockResolvedValueOnce(makeProject());
        sumLoggedTimeForTaskMock.mockResolvedValueOnce({
            logged_minutes: 330,
            billable_minutes: 300,
            entry_count: 4,
            contributor_count: 2,
        });

        const out = (await svc.getTask(task._id, adminCaller())) as {
            time_tracking: { logged_minutes: number; billable_minutes: number };
        };
        expect(sumLoggedTimeForTaskMock).toHaveBeenCalledWith(task._id);
        expect(out.time_tracking.logged_minutes).toBe(330);
        expect(out.time_tracking.billable_minutes).toBe(300);
    });

    // Regression: ISSUE-021 — clients can't read /users/:id, so the issue view
    // showed Reporter "—". The reporter's name now rides on the task.
    it('getTask embeds the reporter name', async () => {
        const task = makeTask();
        taskFindByIdMock.mockResolvedValueOnce(task);
        loadProjectForCallerMock.mockResolvedValueOnce(makeProject());

        const out = (await svc.getTask(task._id, adminCaller())) as { reporter: { id: string; full_name: string } };
        expect(out.reporter).toEqual({ id: task.created_by.toString(), full_name: 'Rita Mehta' });
    });
});

// ─── listTasks — read-visibility scoping ─────────────────────────────────
//
// Regression: `listTasks` reused the write-authority helper
// (`isManagerOrAdmin`, which includes TEAM_LEAD) to decide read scope, so
// team leads saw every task org-wide while the task DETAIL (which funnels
// through `loadProjectForCaller`) correctly 403'd on non-member projects —
// the FE rendered "Unknown project" rows that errored on click. Read scope
// must mirror project.service's buildVisibilityFilter: only admin/manager
// see all projects.
describe('listTasks read-visibility scoping', () => {
    const listQuery = { page: 1, limit: 20 } as never;

    const chainList = (rows: unknown[]) => ({
        sort: () => ({ skip: () => ({ limit: () => Promise.resolve(rows) }) }),
    });

    it('team lead without project_id is scoped to their visible projects', async () => {
        // beforeEach runs vi.resetAllMocks(), wiping the module factory's
        // Project.find chain — re-stub it for the scoped branch.
        const { Project } = await import('../models/project.model.js');
        vi.mocked(Project.find).mockReturnValue({
            select: () => ({ limit: () => ({ lean: () => Promise.resolve([]) }) }),
        } as never);
        buildProjectVisibilityFilterMock.mockReturnValueOnce({ member_ids: 'tl' });
        taskFindMock.mockReturnValueOnce(chainList([]) as never);
        taskCountDocumentsMock.mockResolvedValueOnce(0 as never);

        const caller = { id: new Types.ObjectId(), role: ROLES.TEAM_LEAD, audit: undefined };
        await svc.listTasks(listQuery, caller as never);

        expect(buildProjectVisibilityFilterMock).toHaveBeenCalledTimes(1);
        const filter = taskFindMock.mock.calls.at(-1)![0] as Record<string, unknown>;
        // Project.find mock resolves [] → scoped to an empty id set, never unscoped.
        expect(filter.project_id).toEqual({ $in: [] });
    });

    it('manager without project_id stays unscoped (sees all projects)', async () => {
        taskFindMock.mockReturnValueOnce(chainList([]) as never);
        taskCountDocumentsMock.mockResolvedValueOnce(0 as never);

        await svc.listTasks(listQuery, managerCaller() as never);

        expect(buildProjectVisibilityFilterMock).not.toHaveBeenCalled();
        const filter = taskFindMock.mock.calls.at(-1)![0] as Record<string, unknown>;
        expect(filter.project_id).toBeUndefined();
    });
});

// Regression: the flat cross-project `/tasks` list sorted by `position` (a
// per-(project,status) column index) + created_at ASC, so a newly created task
// — appended at the END of its column, i.e. a high position — landed on the
// LAST page and was invisible to a user viewing page 1. The flat list now sorts
// newest-first; column-scoped lists (board/sprint/story/subtask) keep position.
describe('listTasks — assignee filter', () => {
    const chain = (rows: unknown[]) => ({
        sort: () => ({ skip: () => ({ limit: () => Promise.resolve(rows) }) }),
    });

    const filterFor = async (assignee_id: string) => {
        taskFindMock.mockReturnValueOnce(chain([]) as never);
        taskCountDocumentsMock.mockResolvedValueOnce(0 as never);
        await svc.listTasks({ page: 1, limit: 20, assignee_id } as never, adminCaller() as never);
        return taskFindMock.mock.calls.at(-1)![0] as Record<string, unknown>;
    };

    it('`assignee_id=null` selects the unassigned queue via the indexed field', async () => {
        const filter = await filterFor('null');
        // `primary_assignee_id: null`, not `assignee_ids: {$size: 0}` — the two
        // are equivalent given the primary/array sync, but only this one can
        // use the {primary_assignee_id, status} index.
        expect(filter.primary_assignee_id).toBeNull();
        expect(filter.assignee_ids).toBeUndefined();
    });

    it('a real id still matches against the multi-assignee array', async () => {
        const id = new Types.ObjectId();
        const filter = await filterFor(id.toString());
        expect(filter.assignee_ids).toEqual(id);
        expect(filter.primary_assignee_id).toBeUndefined();
    });
});

describe('listTasks sort order', () => {
    const captureSort = (rows: unknown[], cap: { sort?: unknown }) => ({
        sort: (arg: unknown) => {
            cap.sort = arg;
            return { skip: () => ({ limit: () => Promise.resolve(rows) }) };
        },
    });

    it('flat cross-project list sorts newest-first (created_at desc)', async () => {
        const cap: { sort?: unknown } = {};
        taskFindMock.mockReturnValueOnce(captureSort([], cap) as never);
        taskCountDocumentsMock.mockResolvedValueOnce(0 as never);

        await svc.listTasks({ page: 1, limit: 20 } as never, managerCaller() as never);

        expect(cap.sort).toEqual({ created_at: -1, _id: -1 });
    });

    it('project-scoped list keeps position (column) order', async () => {
        loadProjectForCallerMock.mockResolvedValueOnce({ _id: new Types.ObjectId() } as never);
        const cap: { sort?: unknown } = {};
        taskFindMock.mockReturnValueOnce(captureSort([], cap) as never);
        taskCountDocumentsMock.mockResolvedValueOnce(0 as never);

        await svc.listTasks(
            { page: 1, limit: 20, project_id: new Types.ObjectId().toString() } as never,
            managerCaller() as never
        );

        expect(cap.sort).toEqual({ position: 1, created_at: 1 });
    });
});

// ─── Employee patch scope ────────────────────────────────────────────────
//
// Who may change what on a task, for an employee. A pure guard, so it is
// exercised directly rather than through the whole patch path.
describe('assertEmployeePatchScope', () => {
    const taskOwnedBy = (creator: Types.ObjectId, assignees: Types.ObjectId[] = []) =>
        ({
            created_by: creator,
            assignee_ids: assignees,
            source: 'internal',
            status: DEFAULT_TASK_STATUSES.TO_DO,
        }) as never;

    it('lets the CREATOR change priority and due date on their own task', () => {
        // Raising a task and then needing a manager to fix a date you typed
        // yourself is friction with nothing behind it.
        const me = new Types.ObjectId();
        expect(() =>
            svc.assertEmployeePatchScope(
                { priority: TASK_PRIORITIES.HIGH, due_date: '2026-10-20' } as never,
                taskOwnedBy(me),
                employeeCaller(me)
            )
        ).not.toThrow();
    });

    it('refuses priority and due date to a non-creator ASSIGNEE', () => {
        // Re-ranking someone else's task, or moving its deadline, is a
        // planning decision — not a note about your own work.
        const me = new Types.ObjectId();
        const someoneElse = new Types.ObjectId();
        expect(() =>
            svc.assertEmployeePatchScope(
                { priority: TASK_PRIORITIES.LOW } as never,
                taskOwnedBy(someoneElse, [me]),
                employeeCaller(me)
            )
        ).toThrow(/may only update/i);
    });

    it('still lets a non-creator assignee update their own work fields', () => {
        const me = new Types.ObjectId();
        const someoneElse = new Types.ObjectId();
        expect(() =>
            svc.assertEmployeePatchScope(
                { status: DEFAULT_TASK_STATUSES.IN_PROGRESS, estimated_hours: 3 } as never,
                taskOwnedBy(someoneElse, [me]),
                employeeCaller(me)
            )
        ).not.toThrow();
    });

    // Jira "Assign to me": any employee may take a ticket, even one someone
    // else holds — but may not hand it to another person or drop it.
    it('lets an employee take a ticket someone else is assigned to', () => {
        const me = new Types.ObjectId();
        const other = new Types.ObjectId();
        expect(() =>
            svc.assertEmployeePatchScope(
                { assignee_ids: [me.toString()] } as never,
                taskOwnedBy(new Types.ObjectId(), [other]),
                employeeCaller(me)
            )
        ).not.toThrow();
    });

    it('refuses an employee assigning someone else', () => {
        const me = new Types.ObjectId();
        expect(() =>
            svc.assertEmployeePatchScope(
                { assignee_ids: [new Types.ObjectId().toString()] } as never,
                taskOwnedBy(new Types.ObjectId(), []),
                employeeCaller(me)
            )
        ).toThrow(/only to yourself/i);
    });

    it('refuses a non-creator employee unassigning the ticket', () => {
        const me = new Types.ObjectId();
        expect(() =>
            svc.assertEmployeePatchScope(
                { assignee_ids: [] } as never,
                taskOwnedBy(new Types.ObjectId(), [me]),
                employeeCaller(me)
            )
        ).toThrow(/creator or a manager/i);
    });

    it('still refuses fields no employee may touch, creator or not', () => {
        const me = new Types.ObjectId();
        expect(() =>
            svc.assertEmployeePatchScope({ title: 'Renamed' } as never, taskOwnedBy(me), employeeCaller(me))
        ).toThrow(/may only update/i);
    });
});

// ─── updateTask — flag activity ──────────────────────────────────────────

describe('updateTask — flag', () => {
    it('records flag_added when a task is flagged and flag_removed when cleared', async () => {
        const project = makeProject();
        const task = makeTask({ project_id: project._id, is_flagged: false });
        taskFindByIdMock.mockResolvedValueOnce(task);
        loadProjectForCallerMock.mockResolvedValueOnce(project);

        await svc.updateTask(task._id, { is_flagged: true }, adminCaller());

        expect(task.is_flagged).toBe(true);
        expect(recordActivityMock).toHaveBeenCalledWith(
            expect.objectContaining({ activity_type: 'flag_added', from_value: false, to_value: true })
        );

        taskFindByIdMock.mockResolvedValueOnce(task);
        loadProjectForCallerMock.mockResolvedValueOnce(project);
        await svc.updateTask(task._id, { is_flagged: false }, adminCaller());
        expect(recordActivityMock).toHaveBeenCalledWith(expect.objectContaining({ activity_type: 'flag_removed' }));
    });
});

describe('listTasks — source filter', () => {
    const chain = (rows: unknown[]) => ({
        sort: () => ({ skip: () => ({ limit: () => Promise.resolve(rows) }) }),
    });

    it('`source=client` narrows to client-raised tasks; absent means no source filter', async () => {
        taskFindMock.mockReturnValueOnce(chain([]) as never);
        taskCountDocumentsMock.mockResolvedValueOnce(0 as never);
        await svc.listTasks({ page: 1, limit: 20, source: 'client' } as never, adminCaller() as never);
        expect((taskFindMock.mock.calls.at(-1)![0] as Record<string, unknown>).source).toBe('client');

        taskFindMock.mockReturnValueOnce(chain([]) as never);
        taskCountDocumentsMock.mockResolvedValueOnce(0 as never);
        await svc.listTasks({ page: 1, limit: 20 } as never, adminCaller() as never);
        expect((taskFindMock.mock.calls.at(-1)![0] as Record<string, unknown>).source).toBeUndefined();
    });
});
