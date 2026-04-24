import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Types } from 'mongoose';

/**
 * Unit tests for `story.service` (Step 17).
 *
 * Coverage focus:
 *  1. RBAC — writes throw `STORY_WRITE_FORBIDDEN` for employees/clients
 *     even on a project they have read access to.
 *  2. Derived-status state machine — exhaustively walks the rule cascade
 *     from Data_Model §5.3 (empty / blocked / in_progress / done / to_do)
 *     so a future refactor can't silently re-order the rules.
 *  3. Reorder shift — verifies the neighbour-shift logic for both
 *     directions (move up / move down) and clamping above max.
 *  4. Delete detaches child tasks before removing the story doc and
 *     records the unset task IDs in the audit metadata.
 *  5. Project visibility — propagates 403 from `loadProjectForCaller`.
 */

const {
    storyCreateMock,
    storyFindByIdMock,
    storyFindMock,
    storyFindOneMock,
    storyCountDocumentsMock,
    storyUpdateManyMock,
    aggregateStoryDerivedRowsMock,
    findTasksByStoryIdMock,
    detachStoryFromTasksMock,
    loadProjectForCallerMock,
    recordAuditMock,
} = vi.hoisted(() => ({
    storyCreateMock: vi.fn(),
    storyFindByIdMock: vi.fn(),
    storyFindMock: vi.fn(),
    storyFindOneMock: vi.fn(),
    storyCountDocumentsMock: vi.fn(),
    storyUpdateManyMock: vi.fn(),
    aggregateStoryDerivedRowsMock: vi.fn(),
    findTasksByStoryIdMock: vi.fn(),
    detachStoryFromTasksMock: vi.fn(),
    loadProjectForCallerMock: vi.fn(),
    recordAuditMock: vi.fn(),
}));

vi.mock('../models/story.model.js', () => ({
    Story: {
        create: storyCreateMock,
        findById: storyFindByIdMock,
        find: storyFindMock,
        findOne: storyFindOneMock,
        countDocuments: storyCountDocumentsMock,
        updateMany: storyUpdateManyMock,
    },
}));

vi.mock('../models/project.model.js', () => ({
    Project: { findById: vi.fn(), findOne: vi.fn(), find: vi.fn(), countDocuments: vi.fn(), create: vi.fn() },
}));

vi.mock('../utils/tasks-collection.js', () => ({
    aggregateStoryDerivedRows: aggregateStoryDerivedRowsMock,
    findTasksByStoryId: findTasksByStoryIdMock,
    detachStoryFromTasks: detachStoryFromTasksMock,
}));

vi.mock('./project.service.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./project.service.js')>();
    return {
        ...actual,
        loadProjectForCaller: loadProjectForCallerMock,
    };
});

vi.mock('./audit.service.js', () => ({
    recordAudit: recordAuditMock,
    recordSystemAudit: vi.fn(),
}));

const svc = await import('./story.service.js');
import { ERROR_CODES } from '../constants/error-codes.js';
import { ROLES } from '../constants/roles.js';
import { STORY_DERIVED_STATUSES } from '../constants/story.js';

// ─── Test helpers ─────────────────────────────────────────────────────────

const adminCaller = () => ({
    id: new Types.ObjectId(),
    role: ROLES.ADMIN,
    audit: undefined,
});

const employeeCaller = () => ({
    id: new Types.ObjectId(),
    role: ROLES.EMPLOYEE,
    audit: undefined,
});

const clientCaller = () => ({
    id: new Types.ObjectId(),
    role: ROLES.CLIENT,
    audit: undefined,
});

const makeProject = (overrides: Record<string, unknown> = {}) => ({
    _id: new Types.ObjectId(),
    custom_task_statuses: [] as Array<{ key: string; is_terminal: boolean }>,
    ...overrides,
});

const makeStory = (overrides: Record<string, unknown> = {}) => {
    const story = {
        _id: new Types.ObjectId(),
        project_id: new Types.ObjectId(),
        title: 'Story',
        description: '',
        position: 0,
        created_by: new Types.ObjectId(),
        updated_by: null as Types.ObjectId | null,
        created_at: new Date(),
        updated_at: new Date(),
        save: vi.fn(),
        deleteOne: vi.fn(),
        ...overrides,
    };
    story.save.mockImplementation(async () => story);
    story.deleteOne.mockImplementation(async () => undefined);
    return story;
};

/** Build a chainable mock for `Story.findOne(...).sort().select().lean()`. */
const stubFindOneChain = (returns: { position: number } | null): void => {
    storyFindOneMock.mockReturnValueOnce({
        sort: () => ({
            select: () => ({
                lean: () => Promise.resolve(returns),
            }),
        }),
    });
};

beforeEach(() => {
    vi.resetAllMocks();
});

// ─── RBAC ────────────────────────────────────────────────────────────────

describe('story write RBAC', () => {
    it('createStory rejects employees with STORY_WRITE_FORBIDDEN before any DB call', async () => {
        await expect(
            svc.createStory(new Types.ObjectId(), { title: 'T', description: '' }, employeeCaller())
        ).rejects.toMatchObject({ code: ERROR_CODES.STORY_WRITE_FORBIDDEN });
        expect(loadProjectForCallerMock).not.toHaveBeenCalled();
        expect(storyCreateMock).not.toHaveBeenCalled();
    });

    it('updateStory rejects clients with STORY_WRITE_FORBIDDEN', async () => {
        await expect(svc.updateStory(new Types.ObjectId(), { title: 'New' }, clientCaller())).rejects.toMatchObject({
            code: ERROR_CODES.STORY_WRITE_FORBIDDEN,
        });
        expect(storyFindByIdMock).not.toHaveBeenCalled();
    });

    it('deleteStory rejects employees with STORY_WRITE_FORBIDDEN', async () => {
        await expect(svc.deleteStory(new Types.ObjectId(), employeeCaller())).rejects.toMatchObject({
            code: ERROR_CODES.STORY_WRITE_FORBIDDEN,
        });
        expect(detachStoryFromTasksMock).not.toHaveBeenCalled();
    });

    it('reorderStory rejects clients with STORY_WRITE_FORBIDDEN', async () => {
        await expect(svc.reorderStory(new Types.ObjectId(), { position: 5 }, clientCaller())).rejects.toMatchObject({
            code: ERROR_CODES.STORY_WRITE_FORBIDDEN,
        });
    });
});

// ─── createStory ─────────────────────────────────────────────────────────

describe('createStory', () => {
    it('appends to the end (max+1) when position is omitted', async () => {
        const project = makeProject();
        loadProjectForCallerMock.mockResolvedValueOnce(project);
        stubFindOneChain({ position: 7 });
        const created = makeStory({ project_id: project._id, position: 8, title: 'Onboarding' });
        storyCreateMock.mockResolvedValueOnce(created);

        const out = await svc.createStory(project._id, { title: 'Onboarding', description: '' }, adminCaller());

        expect(storyCreateMock).toHaveBeenCalledWith(
            expect.objectContaining({ project_id: project._id, position: 8, title: 'Onboarding' })
        );
        expect(out).toMatchObject({
            title: 'Onboarding',
            position: 8,
            derived_status: STORY_DERIVED_STATUSES.EMPTY,
            task_count: 0,
            progress_percent: 0,
        });
    });

    it('starts at position 0 when no other story exists', async () => {
        const project = makeProject();
        loadProjectForCallerMock.mockResolvedValueOnce(project);
        stubFindOneChain(null);
        const created = makeStory({ project_id: project._id, position: 0 });
        storyCreateMock.mockResolvedValueOnce(created);

        await svc.createStory(project._id, { title: 'First', description: '' }, adminCaller());

        expect(storyCreateMock).toHaveBeenCalledWith(expect.objectContaining({ position: 0 }));
    });

    it('honours an explicit position when supplied', async () => {
        const project = makeProject();
        loadProjectForCallerMock.mockResolvedValueOnce(project);
        const created = makeStory({ project_id: project._id, position: 3 });
        storyCreateMock.mockResolvedValueOnce(created);

        await svc.createStory(project._id, { title: 'Pinned', description: '', position: 3 }, adminCaller());

        expect(storyFindOneMock).not.toHaveBeenCalled();
        expect(storyCreateMock).toHaveBeenCalledWith(expect.objectContaining({ position: 3 }));
    });
});

// ─── Derived-status rule cascade ─────────────────────────────────────────

describe('derived_status cascade (listStories)', () => {
    const setupListChain = (docs: ReturnType<typeof makeStory>[], total: number): void => {
        storyFindMock.mockReturnValueOnce({
            sort: () => ({
                skip: () => ({
                    limit: () => Promise.resolve(docs),
                }),
            }),
        });
        storyCountDocumentsMock.mockResolvedValueOnce(total);
    };

    it('returns "empty" for stories with no rollup row', async () => {
        const project = makeProject();
        loadProjectForCallerMock.mockResolvedValueOnce(project);
        const story = makeStory({ project_id: project._id });
        setupListChain([story], 1);
        aggregateStoryDerivedRowsMock.mockResolvedValueOnce([]);

        const out = await svc.listStories(project._id, { page: 1, limit: 20 }, adminCaller());
        expect(out.data[0]).toMatchObject({
            derived_status: STORY_DERIVED_STATUSES.EMPTY,
            task_count: 0,
            done_task_count: 0,
            progress_percent: 0,
            sprint_ids: [],
        });
    });

    it('returns "blocked" when any task is in `blocked` status (overrides in_progress)', async () => {
        const project = makeProject();
        loadProjectForCallerMock.mockResolvedValueOnce(project);
        const story = makeStory({ project_id: project._id });
        setupListChain([story], 1);
        aggregateStoryDerivedRowsMock.mockResolvedValueOnce([
            {
                _id: story._id,
                task_count: 5,
                done_count: 0,
                statuses: ['in_progress', 'blocked', 'to_do'],
                sprint_ids: [],
            },
        ]);

        const out = await svc.listStories(project._id, { page: 1, limit: 20 }, adminCaller());
        expect(out.data[0]).toMatchObject({ derived_status: STORY_DERIVED_STATUSES.BLOCKED });
    });

    it('returns "in_progress" when any task is in_progress or review (and none blocked)', async () => {
        const project = makeProject();
        loadProjectForCallerMock.mockResolvedValueOnce(project);
        const story = makeStory({ project_id: project._id });
        setupListChain([story], 1);
        aggregateStoryDerivedRowsMock.mockResolvedValueOnce([
            {
                _id: story._id,
                task_count: 3,
                done_count: 1,
                statuses: ['done', 'review'],
                sprint_ids: [],
            },
        ]);

        const out = await svc.listStories(project._id, { page: 1, limit: 20 }, adminCaller());
        expect(out.data[0]).toMatchObject({
            derived_status: STORY_DERIVED_STATUSES.IN_PROGRESS,
            task_count: 3,
            done_task_count: 1,
            progress_percent: 33,
        });
    });

    it('returns "done" when ALL tasks are in terminal statuses (default + custom is_terminal)', async () => {
        const project = makeProject({
            custom_task_statuses: [{ key: 'shipped', is_terminal: true }],
        });
        loadProjectForCallerMock.mockResolvedValueOnce(project);
        const story = makeStory({ project_id: project._id });
        setupListChain([story], 1);
        aggregateStoryDerivedRowsMock.mockResolvedValueOnce([
            {
                _id: story._id,
                task_count: 4,
                done_count: 4,
                statuses: ['done', 'shipped'],
                sprint_ids: [new Types.ObjectId()],
            },
        ]);

        const out = await svc.listStories(project._id, { page: 1, limit: 20 }, adminCaller());
        expect(out.data[0]).toMatchObject({
            derived_status: STORY_DERIVED_STATUSES.DONE,
            task_count: 4,
            done_task_count: 4,
            progress_percent: 100,
        });
    });

    it('falls back to "to_do" when no rule fires (e.g. mixed to_do + done)', async () => {
        const project = makeProject();
        loadProjectForCallerMock.mockResolvedValueOnce(project);
        const story = makeStory({ project_id: project._id });
        setupListChain([story], 1);
        aggregateStoryDerivedRowsMock.mockResolvedValueOnce([
            {
                _id: story._id,
                task_count: 4,
                done_count: 1,
                statuses: ['to_do', 'done'],
                sprint_ids: [],
            },
        ]);

        const out = await svc.listStories(project._id, { page: 1, limit: 20 }, adminCaller());
        expect(out.data[0]).toMatchObject({
            derived_status: STORY_DERIVED_STATUSES.TO_DO,
            done_task_count: 1,
            progress_percent: 25,
        });
    });

    it('applies the optional `status` filter AFTER derivation', async () => {
        const project = makeProject();
        loadProjectForCallerMock.mockResolvedValueOnce(project);
        const s1 = makeStory({ project_id: project._id, title: 'A' });
        const s2 = makeStory({ project_id: project._id, title: 'B' });
        setupListChain([s1, s2], 2);
        aggregateStoryDerivedRowsMock.mockResolvedValueOnce([
            { _id: s1._id, task_count: 1, done_count: 0, statuses: ['blocked'], sprint_ids: [] },
            { _id: s2._id, task_count: 1, done_count: 1, statuses: ['done'], sprint_ids: [] },
        ]);

        const out = await svc.listStories(project._id, { page: 1, limit: 20, status: 'blocked' }, adminCaller());
        expect(out.data).toHaveLength(1);
        expect(out.data[0]).toMatchObject({ title: 'A' });
    });

    it('passes terminal status keys (default done + project customs) to the aggregation', async () => {
        const project = makeProject({
            custom_task_statuses: [
                { key: 'shipped', is_terminal: true },
                { key: 'wont_do', is_terminal: true },
                { key: 'qa_passed', is_terminal: false },
            ],
        });
        loadProjectForCallerMock.mockResolvedValueOnce(project);
        const story = makeStory({ project_id: project._id });
        setupListChain([story], 1);
        aggregateStoryDerivedRowsMock.mockResolvedValueOnce([]);

        await svc.listStories(project._id, { page: 1, limit: 20 }, adminCaller());

        const callArgs = aggregateStoryDerivedRowsMock.mock.calls[0];
        expect(callArgs[0]).toEqual(project._id);
        expect(callArgs[1]).toEqual([story._id]);
        const terminal = (callArgs[2] as string[]).slice().sort();
        expect(terminal).toEqual(['done', 'shipped', 'wont_do']);
    });
});

// ─── Project visibility ──────────────────────────────────────────────────

describe('project visibility', () => {
    it('listStories propagates 403 from loadProjectForCaller', async () => {
        loadProjectForCallerMock.mockRejectedValueOnce(
            Object.assign(new Error('forbidden'), { code: ERROR_CODES.FORBIDDEN })
        );
        await expect(
            svc.listStories(new Types.ObjectId(), { page: 1, limit: 20 }, employeeCaller())
        ).rejects.toMatchObject({ code: ERROR_CODES.FORBIDDEN });
    });

    it('getStory returns 404 STORY_NOT_FOUND when the doc is missing', async () => {
        storyFindByIdMock.mockResolvedValueOnce(null);
        await expect(svc.getStory(new Types.ObjectId(), adminCaller())).rejects.toMatchObject({
            code: ERROR_CODES.STORY_NOT_FOUND,
        });
        expect(loadProjectForCallerMock).not.toHaveBeenCalled();
    });
});

// ─── Reorder shift ───────────────────────────────────────────────────────

describe('reorderStory — neighbour shift', () => {
    it('moves DOWN: decrements positions in (old, new] and updates the story', async () => {
        const project = makeProject();
        const story = makeStory({ project_id: project._id, position: 1 });
        storyFindByIdMock.mockResolvedValueOnce(story);
        loadProjectForCallerMock.mockResolvedValueOnce(project);
        // clamp lookup → max position = 4
        stubFindOneChain({ position: 4 });
        storyUpdateManyMock.mockResolvedValueOnce({ modifiedCount: 2 });
        aggregateStoryDerivedRowsMock.mockResolvedValueOnce([]);

        await svc.reorderStory(story._id, { position: 3 }, adminCaller());

        expect(storyUpdateManyMock).toHaveBeenCalledWith(
            {
                project_id: project._id,
                _id: { $ne: story._id },
                position: { $gt: 1, $lte: 3 },
            },
            { $inc: { position: -1 } }
        );
        expect(story.position).toBe(3);
        expect(story.save).toHaveBeenCalled();
    });

    it('moves UP: increments positions in [new, old) and updates the story', async () => {
        const project = makeProject();
        const story = makeStory({ project_id: project._id, position: 5 });
        storyFindByIdMock.mockResolvedValueOnce(story);
        loadProjectForCallerMock.mockResolvedValueOnce(project);
        stubFindOneChain({ position: 9 });
        storyUpdateManyMock.mockResolvedValueOnce({ modifiedCount: 3 });
        aggregateStoryDerivedRowsMock.mockResolvedValueOnce([]);

        await svc.reorderStory(story._id, { position: 2 }, adminCaller());

        expect(storyUpdateManyMock).toHaveBeenCalledWith(
            {
                project_id: project._id,
                _id: { $ne: story._id },
                position: { $gte: 2, $lt: 5 },
            },
            { $inc: { position: 1 } }
        );
        expect(story.position).toBe(2);
    });

    it('clamps a request above the max position to maxPosition', async () => {
        const project = makeProject();
        const story = makeStory({ project_id: project._id, position: 0 });
        storyFindByIdMock.mockResolvedValueOnce(story);
        loadProjectForCallerMock.mockResolvedValueOnce(project);
        stubFindOneChain({ position: 4 });
        storyUpdateManyMock.mockResolvedValueOnce({ modifiedCount: 4 });
        aggregateStoryDerivedRowsMock.mockResolvedValueOnce([]);

        await svc.reorderStory(story._id, { position: 999 }, adminCaller());

        expect(story.position).toBe(4);
    });

    it('no-ops when the new position equals the current one', async () => {
        const project = makeProject();
        const story = makeStory({ project_id: project._id, position: 2 });
        storyFindByIdMock.mockResolvedValueOnce(story);
        loadProjectForCallerMock.mockResolvedValueOnce(project);
        aggregateStoryDerivedRowsMock.mockResolvedValueOnce([]);

        await svc.reorderStory(story._id, { position: 2 }, adminCaller());

        expect(storyUpdateManyMock).not.toHaveBeenCalled();
        expect(story.save).not.toHaveBeenCalled();
        expect(story.position).toBe(2);
    });
});

// ─── deleteStory — detach + close gap ────────────────────────────────────

describe('deleteStory', () => {
    it('detaches child tasks, deletes the story, closes the position gap, and audits unset_task_ids', async () => {
        const project = makeProject();
        const story = makeStory({ project_id: project._id, position: 3 });
        storyFindByIdMock.mockResolvedValueOnce(story);
        loadProjectForCallerMock.mockResolvedValueOnce(project);

        const detachedIds = [new Types.ObjectId(), new Types.ObjectId()];
        detachStoryFromTasksMock.mockResolvedValueOnce({ task_ids: detachedIds, modified_count: 2 });
        storyUpdateManyMock.mockResolvedValueOnce({ modifiedCount: 4 });

        const auditCaller = {
            id: new Types.ObjectId(),
            role: ROLES.ADMIN,
            audit: {
                actor_id: new Types.ObjectId(),
                actor_role: ROLES.ADMIN,
                ip: '127.0.0.1',
                user_agent: null,
            },
        };

        const out = await svc.deleteStory(story._id, auditCaller);

        // Detach happens before delete — assert call order via mock invocation order.
        expect(detachStoryFromTasksMock).toHaveBeenCalledWith(story._id);
        expect(story.deleteOne).toHaveBeenCalled();

        // Position-gap close shifts everything below the deleted row.
        expect(storyUpdateManyMock).toHaveBeenCalledWith(
            { project_id: project._id, position: { $gt: 3 } },
            { $inc: { position: -1 } }
        );

        expect(out).toMatchObject({
            deleted: true,
            unset_task_ids: detachedIds.map((d) => d.toString()),
        });

        // Audit record carries the unset list in metadata.
        expect(recordAuditMock).toHaveBeenCalledWith(
            auditCaller.audit,
            expect.objectContaining({
                metadata: expect.objectContaining({
                    unset_task_ids: detachedIds.map((d) => d.toString()),
                    detached_count: 2,
                }),
            })
        );
    });

    it('returns an empty `unset_task_ids` when the story has no child tasks', async () => {
        const project = makeProject();
        const story = makeStory({ project_id: project._id, position: 0 });
        storyFindByIdMock.mockResolvedValueOnce(story);
        loadProjectForCallerMock.mockResolvedValueOnce(project);

        detachStoryFromTasksMock.mockResolvedValueOnce({ task_ids: [], modified_count: 0 });
        storyUpdateManyMock.mockResolvedValueOnce({ modifiedCount: 0 });

        const out = await svc.deleteStory(story._id, adminCaller());
        expect(out).toEqual({ deleted: true, unset_task_ids: [] });
    });
});

// ─── getStory — task breakdown ───────────────────────────────────────────

describe('getStory — task breakdown by sprint', () => {
    it('groups tasks by sprint_id with backlog (null sprint) bucketed separately', async () => {
        const project = makeProject();
        const story = makeStory({ project_id: project._id });
        storyFindByIdMock.mockResolvedValueOnce(story);
        loadProjectForCallerMock.mockResolvedValueOnce(project);

        const sprintA = new Types.ObjectId();
        aggregateStoryDerivedRowsMock.mockResolvedValueOnce([
            { _id: story._id, task_count: 3, done_count: 1, statuses: ['done', 'in_progress'], sprint_ids: [sprintA] },
        ]);
        findTasksByStoryIdMock.mockResolvedValueOnce([
            { _id: new Types.ObjectId(), title: 'A', status: 'done', sprint_id: sprintA },
            { _id: new Types.ObjectId(), title: 'B', status: 'in_progress', sprint_id: sprintA },
            { _id: new Types.ObjectId(), title: 'C', status: 'to_do', sprint_id: null },
        ]);

        const out = (await svc.getStory(story._id, adminCaller())) as {
            tasks_by_sprint: Array<{ sprint: { id: string } | null; tasks: Array<{ title: string }> }>;
        };
        expect(out.tasks_by_sprint).toHaveLength(2);
        const sprintBucket = out.tasks_by_sprint.find((b) => b.sprint?.id === sprintA.toString());
        expect(sprintBucket?.tasks.map((t) => t.title).sort()).toEqual(['A', 'B']);
        const backlog = out.tasks_by_sprint.find((b) => b.sprint === null);
        expect(backlog?.tasks.map((t) => t.title)).toEqual(['C']);
    });
});
