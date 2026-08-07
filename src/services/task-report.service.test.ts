import { Types } from 'mongoose';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Client-side issue reporting (`createTaskReport` + the client PATCH scope).
 *
 * This is a WRITE granted to people outside the company, so the tests that
 * matter are the ones about what a client CANNOT do. The feature would look
 * like it works with none of them passing:
 *
 *   1. Only client-side roles may file — the `source: 'client'` marker has to
 *      be true, and an internal caller filing here would make it a lie.
 *   2. The project comes from `loadProjectForCaller`, so a client cannot name
 *      a project id they can't already open.
 *   3. Every field except title/description/priority is decided server-side —
 *      in particular `sprint_id: null`, so a report lands in the BACKLOG and
 *      never inserts itself into committed sprint scope.
 *   4. On PATCH, a client may touch only their OWN report, and only the three
 *      whitelisted fields. Status is deliberately absent — they cannot close
 *      or reopen anything.
 */

const {
    taskCreateMock,
    taskFindByIdMock,
    taskFindOneMock,
    projectFindOneAndUpdateMock,
    loadProjectForCallerMock,
    recordAuditMock,
    recordActivityMock,
} = vi.hoisted(() => ({
    taskCreateMock: vi.fn(),
    taskFindByIdMock: vi.fn(),
    taskFindOneMock: vi.fn(),
    projectFindOneAndUpdateMock: vi.fn(),
    loadProjectForCallerMock: vi.fn(),
    recordAuditMock: vi.fn(),
    recordActivityMock: vi.fn(),
}));

vi.mock('../models/task.model.js', () => ({
    Task: {
        create: taskCreateMock,
        findById: taskFindByIdMock,
        findOne: taskFindOneMock,
        find: vi.fn(),
        countDocuments: vi.fn(),
        updateMany: vi.fn(),
        distinct: vi.fn(),
    },
}));
vi.mock('../models/story.model.js', () => ({ Story: { findById: vi.fn() } }));
vi.mock('../models/sprint.model.js', () => ({ Sprint: { findById: vi.fn() } }));
vi.mock('../models/user.model.js', () => ({ User: { find: vi.fn() } }));
vi.mock('../models/project.model.js', () => ({
    Project: {
        find: vi.fn().mockReturnValue({ select: () => ({ limit: () => ({ lean: () => Promise.resolve([]) }) }) }),
        findOneAndUpdate: projectFindOneAndUpdateMock,
    },
}));
vi.mock('./project.service.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./project.service.js')>();
    return { ...actual, loadProjectForCaller: loadProjectForCallerMock, buildProjectVisibilityFilter: vi.fn() };
});
vi.mock('./audit.service.js', () => ({ recordAudit: recordAuditMock, recordSystemAudit: vi.fn() }));
vi.mock('./timesheet.service.js', () => ({ sumLoggedTimeForTask: vi.fn() }));
vi.mock('./task-activity.service.js', () => ({
    recordActivity: recordActivityMock,
    recordActivityIfChanged: vi.fn(),
}));
vi.mock('./notification-dispatcher.service.js', () => ({ notifyTaskAssigned: vi.fn() }));

const svc = await import('./task.service.js');
import { ERROR_CODES } from '../constants/error-codes.js';
import { ROLES, type RoleType } from '../constants/roles.js';
import { DEFAULT_TASK_STATUSES, TASK_ISSUE_TYPES, TASK_PRIORITIES } from '../constants/task.js';

const projectId = new Types.ObjectId();

const caller = (role: RoleType, id?: Types.ObjectId) => ({
    id: id ?? new Types.ObjectId(),
    role,
    audit: undefined,
});

/** `nextPositionInColumn` then `nextBacklogRank` both read this chain. */
const stubOrderingLookups = (): void => {
    taskFindOneMock.mockReturnValue({
        sort: () => ({ select: () => ({ lean: () => Promise.resolve(null) }) }),
    });
};

const validReport = () => ({
    project_id: projectId.toString(),
    title: 'Checkout page 500s',
    description: 'Since today.',
});

beforeEach(() => {
    vi.clearAllMocks();
    loadProjectForCallerMock.mockResolvedValue({ _id: projectId, custom_task_statuses: [] });
    projectFindOneAndUpdateMock.mockReturnValue({ lean: () => Promise.resolve({ task_seq: 7 }) });
    stubOrderingLookups();
    taskCreateMock.mockImplementation(async (doc: Record<string, unknown>) => ({
        ...doc,
        _id: new Types.ObjectId(),
        toJSON: () => doc,
    }));
});

describe('createTaskReport — who may file', () => {
    it.each([ROLES.ADMIN, ROLES.MANAGER, ROLES.TEAM_LEAD, ROLES.EMPLOYEE])(
        'refuses %s — internal staff use createTask, so the client marker stays truthful',
        async (role) => {
            await expect(svc.createTaskReport(validReport(), caller(role))).rejects.toMatchObject({
                statusCode: 403,
                code: ERROR_CODES.TASK_WRITE_FORBIDDEN,
            });
            expect(taskCreateMock).not.toHaveBeenCalled();
        }
    );

    it.each([ROLES.CLIENT, ROLES.REPRESENTATIVE])('accepts %s', async (role) => {
        await expect(svc.createTaskReport(validReport(), caller(role))).resolves.toBeDefined();
        expect(taskCreateMock).toHaveBeenCalledTimes(1);
    });

    it('propagates the visibility refusal — a client cannot name a project they cannot open', async () => {
        loadProjectForCallerMock.mockRejectedValueOnce(
            Object.assign(new Error('nope'), { statusCode: 403, code: ERROR_CODES.PROJECT_NOT_FOUND })
        );
        await expect(svc.createTaskReport(validReport(), caller(ROLES.CLIENT))).rejects.toMatchObject({
            statusCode: 403,
        });
        expect(taskCreateMock).not.toHaveBeenCalled();
    });
});

describe('createTaskReport — the server decides everything except three fields', () => {
    const fileIt = async (extra: Record<string, unknown> = {}) => {
        await svc.createTaskReport({ ...validReport(), ...extra }, caller(ROLES.CLIENT));
        // LAST call, not the first — one test files twice to compare defaults.
        const calls = taskCreateMock.mock.calls;
        return calls[calls.length - 1][0] as Record<string, unknown>;
    };

    it('lands in the BACKLOG — sprint_id null, never straight onto the board', async () => {
        expect((await fileIt()).sprint_id).toBeNull();
    });

    it('carries no story, parent, assignee or collaborator chosen by an outsider', async () => {
        const doc = await fileIt();
        expect(doc.story_id).toBeNull();
        expect(doc.parent_task_id).toBeNull();
        expect(doc.assignee_ids).toEqual([]);
        expect(doc.primary_assignee_id).toBeNull();
        expect(doc.collaborator_ids).toEqual([]);
        expect(doc.depends_on_task_ids).toEqual([]);
    });

    it('opens at the entry status and is typed as a bug', async () => {
        const doc = await fileIt();
        expect(doc.status).toBe(DEFAULT_TASK_STATUSES.TO_DO);
        expect(doc.issue_type).toBe(TASK_ISSUE_TYPES.BUG);
        expect(doc.completed_at).toBeNull();
    });

    it("stamps source: 'client' so the origin survives later status changes", async () => {
        expect((await fileIt()).source).toBe('client');
    });

    it('honours the priority suggestion, defaulting to medium', async () => {
        expect((await fileIt()).priority).toBe(TASK_PRIORITIES.MEDIUM);
        expect((await fileIt({ priority: TASK_PRIORITIES.HIGH })).priority).toBe(TASK_PRIORITIES.HIGH);
    });

    it('attributes the report to the caller and reserves an issue number', async () => {
        const reporter = new Types.ObjectId();
        await svc.createTaskReport(validReport(), caller(ROLES.CLIENT, reporter));
        const doc = taskCreateMock.mock.calls[0][0] as Record<string, unknown>;
        expect((doc.created_by as Types.ObjectId).equals(reporter)).toBe(true);
        expect(doc.task_number).toBe(7);
    });
});

describe('client PATCH scope — the narrowing that keeps this safe', () => {
    const ownReport = (owner: Types.ObjectId) => ({
        _id: new Types.ObjectId(),
        project_id: projectId,
        source: 'client',
        created_by: owner,
        status: DEFAULT_TASK_STATUSES.TO_DO,
        assignee_ids: [] as Types.ObjectId[],
        save: vi.fn(),
        toJSON: () => ({}),
    });

    const patchAs = async (
        task: Record<string, unknown>,
        who: ReturnType<typeof caller>,
        patch: Record<string, unknown>
    ) => {
        (task as { save: ReturnType<typeof vi.fn> }).save.mockResolvedValue(task);
        taskFindByIdMock.mockResolvedValue(task);
        return svc.updateTask(task._id as Types.ObjectId, patch, who);
    };

    it('refuses a client editing a task they did not report', async () => {
        const me = new Types.ObjectId();
        const someoneElses = ownReport(new Types.ObjectId());
        await expect(patchAs(someoneElses, caller(ROLES.CLIENT, me), { title: 'mine now' })).rejects.toMatchObject({
            statusCode: 403,
            code: ERROR_CODES.TASK_WRITE_FORBIDDEN,
        });
    });

    it('refuses a client editing an internal task, even one they can see', async () => {
        const me = new Types.ObjectId();
        const internal = { ...ownReport(me), source: null };
        await expect(patchAs(internal, caller(ROLES.CLIENT, me), { title: 'x' })).rejects.toMatchObject({
            statusCode: 403,
        });
    });

    it('refuses a client changing status — they cannot close or reopen', async () => {
        const me = new Types.ObjectId();
        await expect(
            patchAs(ownReport(me), caller(ROLES.CLIENT, me), { status: DEFAULT_TASK_STATUSES.DONE })
        ).rejects.toMatchObject({ statusCode: 403, code: ERROR_CODES.TASK_WRITE_FORBIDDEN });
    });

    it('refuses a client assigning the work to someone', async () => {
        const me = new Types.ObjectId();
        await expect(
            patchAs(ownReport(me), caller(ROLES.CLIENT, me), { assignee_ids: [new Types.ObjectId().toString()] })
        ).rejects.toMatchObject({ statusCode: 403 });
    });
});
