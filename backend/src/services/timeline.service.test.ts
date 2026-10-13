import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Types } from 'mongoose';

import { ROLES } from '../constants/roles.js';
import { DEFAULT_TASK_STATUSES } from '../constants/task.js';

/**
 * Unit tests for `timeline.service` (Phase 4 Step 41).
 *
 * Coverage focus:
 *   1. **Project visibility** — service delegates to `loadProjectForCaller`
 *      so the 404 → 403 mapping is preserved.
 *   2. **Sprint overlap filter** — DB-side `start_date <= to_date AND
 *      end_date >= from_date` matches sprints whose range intersects
 *      the window.
 *   3. **Task overlap filter** — DB-side `due_date >= from_date` is
 *      the right edge anchor; JS-side `derived_start <= to_date` is
 *      the left edge anchor.
 *   4. **Derived start_date** — sprint.start_date wins; falls back to
 *      task.created_at (IST) when no sprint or sprint not in window.
 *   5. **include_completed** — when false, `status: {$ne: 'done'}` is
 *      added to the task filter.
 *   6. **Truncation** — when the row count > TIMELINE_TASK_CAP, the
 *      response carries `truncated: true` and the list is sliced.
 */

const { loadProjectForCallerMock, sprintFindMock, taskFindMock } = vi.hoisted(() => ({
    loadProjectForCallerMock: vi.fn(),
    sprintFindMock: vi.fn(),
    taskFindMock: vi.fn(),
}));

vi.mock('../models/sprint.model.js', () => ({
    Sprint: { find: sprintFindMock },
}));

vi.mock('../models/task.model.js', () => ({
    Task: { find: taskFindMock },
}));

vi.mock('./project.service.js', () => ({
    loadProjectForCaller: loadProjectForCallerMock,
}));

const svc = await import('./timeline.service.js');

// ─── Helpers ───────────────────────────────────────────────────────────

const queryStub = (rows: unknown[]) => {
    const stub: Record<string, unknown> = {
        select: () => stub,
        sort: () => stub,
        limit: () => stub,
        lean: () => Promise.resolve(rows),
        then: (r: (v: unknown) => void) => Promise.resolve(rows).then(r),
    };
    return stub;
};

const adminCaller = () => ({ id: new Types.ObjectId(), role: ROLES.ADMIN });
const baseQuery = (overrides: Record<string, unknown> = {}) => ({
    from_date: '2026-01-01',
    to_date: '2026-03-31',
    include_completed: false,
    ...overrides,
});

const projectFixture = (overrides: Record<string, unknown> = {}) => ({
    _id: new Types.ObjectId(),
    name: 'Apollo',
    start_date: '2026-01-01',
    end_date: null,
    ...overrides,
});

const taskFixture = (overrides: Record<string, unknown> = {}) => ({
    _id: new Types.ObjectId(),
    title: 'A task',
    status: DEFAULT_TASK_STATUSES.IN_PROGRESS,
    priority: 'medium',
    due_date: '2026-02-15',
    sprint_id: null,
    story_id: null,
    parent_task_id: null,
    primary_assignee_id: null,
    depends_on_task_ids: [],
    position: 0,
    created_at: new Date('2026-01-15T10:00:00Z'),
    ...overrides,
});

const sprintFixture = (overrides: Record<string, unknown> = {}) => ({
    _id: new Types.ObjectId(),
    name: 'Sprint 1',
    start_date: '2026-02-01',
    end_date: '2026-02-14',
    status: 'active',
    ...overrides,
});

beforeEach(() => {
    vi.resetAllMocks();
    sprintFindMock.mockReturnValue(queryStub([]));
    taskFindMock.mockReturnValue(queryStub([]));
});

// ─── Project visibility ────────────────────────────────────────────────

describe('buildTimeline (project visibility)', () => {
    it('delegates 404/403 mapping to loadProjectForCaller', async () => {
        loadProjectForCallerMock.mockRejectedValueOnce(Object.assign(new Error('forbidden'), { code: 'FORBIDDEN' }));

        await expect(
            svc.buildTimeline(new Types.ObjectId(), baseQuery() as never, adminCaller())
        ).rejects.toMatchObject({ code: 'FORBIDDEN' });
        // Service short-circuits before any data query.
        expect(sprintFindMock).not.toHaveBeenCalled();
        expect(taskFindMock).not.toHaveBeenCalled();
    });

    it('passes through the project document into the response', async () => {
        const project = projectFixture({ name: 'Apollo Mission' });
        loadProjectForCallerMock.mockResolvedValueOnce(project);

        const result = await svc.buildTimeline(new Types.ObjectId(), baseQuery() as never, adminCaller());

        expect(result.project.name).toBe('Apollo Mission');
        expect(result.project.start_date).toBe(project.start_date);
    });
});

// ─── Sprint + task filters ─────────────────────────────────────────────

describe('buildTimeline (filter shape)', () => {
    it('builds the sprint overlap filter (start_date <= to AND end_date >= from)', async () => {
        loadProjectForCallerMock.mockResolvedValueOnce(projectFixture());

        await svc.buildTimeline(new Types.ObjectId(), baseQuery() as never, adminCaller());

        const filter = sprintFindMock.mock.calls[0][0] as Record<string, unknown>;
        expect(filter.start_date).toEqual({ $lte: '2026-03-31' });
        expect(filter.end_date).toEqual({ $gte: '2026-01-01' });
    });

    it('builds the task right-edge filter (due_date >= from)', async () => {
        loadProjectForCallerMock.mockResolvedValueOnce(projectFixture());

        await svc.buildTimeline(new Types.ObjectId(), baseQuery() as never, adminCaller());

        const filter = taskFindMock.mock.calls[0][0] as Record<string, unknown>;
        expect(filter.due_date).toEqual({ $gte: '2026-01-01' });
    });

    it('excludes completed tasks by default (include_completed=false)', async () => {
        loadProjectForCallerMock.mockResolvedValueOnce(projectFixture());
        await svc.buildTimeline(new Types.ObjectId(), baseQuery() as never, adminCaller());
        const filter = taskFindMock.mock.calls[0][0] as Record<string, unknown>;
        expect(filter.status).toEqual({ $ne: DEFAULT_TASK_STATUSES.DONE });
    });

    it('includes completed tasks when include_completed=true', async () => {
        loadProjectForCallerMock.mockResolvedValueOnce(projectFixture());
        await svc.buildTimeline(new Types.ObjectId(), baseQuery({ include_completed: true }) as never, adminCaller());
        const filter = taskFindMock.mock.calls[0][0] as Record<string, unknown>;
        expect(filter.status).toBeUndefined();
    });

    it('sorts tasks by position ASC, created_at ASC (matches the Kanban list ordering)', async () => {
        loadProjectForCallerMock.mockResolvedValueOnce(projectFixture());
        const sortSpy = vi.fn().mockReturnThis();
        const stub: Record<string, unknown> = {
            select: () => stub,
            sort: sortSpy,
            limit: () => stub,
            lean: () => Promise.resolve([]),
            then: (r: (v: unknown) => void) => Promise.resolve([]).then(r),
        };
        taskFindMock.mockReturnValueOnce(stub);

        await svc.buildTimeline(new Types.ObjectId(), baseQuery() as never, adminCaller());

        expect(sortSpy).toHaveBeenCalledWith({ position: 1, created_at: 1 });
    });

    it('honours optional sprint_id + story_id filters', async () => {
        loadProjectForCallerMock.mockResolvedValueOnce(projectFixture());
        const sprintId = new Types.ObjectId();
        const storyId = new Types.ObjectId();

        await svc.buildTimeline(
            new Types.ObjectId(),
            baseQuery({ sprint_id: sprintId.toString(), story_id: storyId.toString() }) as never,
            adminCaller()
        );

        const filter = taskFindMock.mock.calls[0][0] as Record<string, unknown>;
        expect((filter.sprint_id as Types.ObjectId).toString()).toBe(sprintId.toString());
        expect((filter.story_id as Types.ObjectId).toString()).toBe(storyId.toString());
    });
});

// ─── Derived start_date fallback chain ─────────────────────────────────

describe('buildTimeline (derived start_date)', () => {
    it('uses sprint.start_date when the task is in a sprint that overlaps the window', async () => {
        const sprint = sprintFixture({ start_date: '2026-02-01' });
        const task = taskFixture({ sprint_id: sprint._id, due_date: '2026-02-15' });
        loadProjectForCallerMock.mockResolvedValueOnce(projectFixture());
        sprintFindMock.mockReturnValueOnce(queryStub([sprint]));
        taskFindMock.mockReturnValueOnce(queryStub([task]));

        const result = await svc.buildTimeline(new Types.ObjectId(), baseQuery() as never, adminCaller());

        expect(result.tasks).toHaveLength(1);
        expect(result.tasks[0].start_date).toBe('2026-02-01');
    });

    it('falls back to created_at (IST) when the task has no sprint', async () => {
        const task = taskFixture({
            sprint_id: null,
            // 2026-01-15 10:00 UTC = 2026-01-15 15:30 IST → IST date is 2026-01-15.
            created_at: new Date('2026-01-15T10:00:00Z'),
            due_date: '2026-02-01',
        });
        loadProjectForCallerMock.mockResolvedValueOnce(projectFixture());
        taskFindMock.mockReturnValueOnce(queryStub([task]));

        const result = await svc.buildTimeline(new Types.ObjectId(), baseQuery() as never, adminCaller());

        expect(result.tasks[0].start_date).toBe('2026-01-15');
    });

    it('falls back to created_at when the sprint is not in the window (sprintsById miss)', async () => {
        const sprintIdNotInWindow = new Types.ObjectId();
        const task = taskFixture({
            sprint_id: sprintIdNotInWindow, // sprint exists but is NOT in the loaded sprintsById
            created_at: new Date('2026-01-20T10:00:00Z'),
            due_date: '2026-02-15',
        });
        loadProjectForCallerMock.mockResolvedValueOnce(projectFixture());
        sprintFindMock.mockReturnValueOnce(queryStub([])); // no sprints in window
        taskFindMock.mockReturnValueOnce(queryStub([task]));

        const result = await svc.buildTimeline(new Types.ObjectId(), baseQuery() as never, adminCaller());

        // Falls back because the sprint isn't in the loaded subset.
        expect(result.tasks[0].start_date).toBe('2026-01-20');
    });
});

// ─── JS-side window-left filter ────────────────────────────────────────

describe('buildTimeline (left-edge overlap)', () => {
    it('drops tasks whose derived start_date is past the window (whole bar to the right)', async () => {
        // Window: 2026-01-01 → 2026-03-31. Task: starts 2026-04-15 (after
        // window), due 2026-04-30 → DB filter `due_date >= from` matches
        // (2026-04-30 >= 2026-01-01) but JS-side filter drops it.
        const task = taskFixture({
            sprint_id: null,
            created_at: new Date('2026-04-15T10:00:00Z'),
            due_date: '2026-04-30',
        });
        loadProjectForCallerMock.mockResolvedValueOnce(projectFixture());
        taskFindMock.mockReturnValueOnce(queryStub([task]));

        const result = await svc.buildTimeline(new Types.ObjectId(), baseQuery() as never, adminCaller());

        expect(result.tasks).toHaveLength(0);
    });

    it('keeps a task whose bar straddles the window (start before, due inside)', async () => {
        // Window: 2026-01-01 → 2026-03-31. Task starts 2025-12-01 (before
        // window), due 2026-02-15 (inside window) → kept.
        const task = taskFixture({
            sprint_id: null,
            created_at: new Date('2025-12-01T10:00:00Z'),
            due_date: '2026-02-15',
        });
        loadProjectForCallerMock.mockResolvedValueOnce(projectFixture());
        taskFindMock.mockReturnValueOnce(queryStub([task]));

        const result = await svc.buildTimeline(new Types.ObjectId(), baseQuery() as never, adminCaller());

        expect(result.tasks).toHaveLength(1);
        expect(result.tasks[0].start_date).toBe('2025-12-01');
    });
});

// ─── Truncation ────────────────────────────────────────────────────────

describe('buildTimeline (truncation)', () => {
    it('flips truncated=true when the row count exceeds TIMELINE_TASK_CAP', async () => {
        // Build 2001 rows — one over the cap. Service queries with
        // `limit(CAP + 1)` so this is the realistic shape.
        const tasks = Array.from({ length: 2001 }, () =>
            taskFixture({
                sprint_id: null,
                created_at: new Date('2026-01-15T10:00:00Z'),
                due_date: '2026-02-01',
            })
        );
        loadProjectForCallerMock.mockResolvedValueOnce(projectFixture());
        taskFindMock.mockReturnValueOnce(queryStub(tasks));

        const result = await svc.buildTimeline(new Types.ObjectId(), baseQuery() as never, adminCaller());

        expect(result.truncated).toBe(true);
        expect(result.tasks).toHaveLength(2000);
    });

    it('truncated=false on a normal small response', async () => {
        loadProjectForCallerMock.mockResolvedValueOnce(projectFixture());
        taskFindMock.mockReturnValueOnce(queryStub([taskFixture()]));

        const result = await svc.buildTimeline(new Types.ObjectId(), baseQuery() as never, adminCaller());

        expect(result.truncated).toBe(false);
    });
});

// ─── Undated tasks ─────────────────────────────────────────────────────

describe('buildTimeline (undated tasks)', () => {
    it('queries tasks with no due date using the same sprint/story/done filters', async () => {
        loadProjectForCallerMock.mockResolvedValueOnce(projectFixture());
        const sprintId = new Types.ObjectId().toString();

        await svc.buildTimeline(new Types.ObjectId(), baseQuery({ sprint_id: sprintId }) as never, adminCaller());

        const undatedFilter = taskFindMock.mock.calls[1][0] as Record<string, unknown>;
        expect(undatedFilter.due_date).toBeNull();
        expect(String(undatedFilter.sprint_id)).toBe(sprintId);
        expect(undatedFilter.status).toEqual({ $ne: DEFAULT_TASK_STATUSES.DONE });
    });

    it('returns them as `undated` (not as bars)', async () => {
        loadProjectForCallerMock.mockResolvedValueOnce(projectFixture());
        const undated = taskFixture({ title: 'No date yet', due_date: null });
        taskFindMock.mockReturnValueOnce(queryStub([])).mockReturnValueOnce(queryStub([undated]));

        const result = await svc.buildTimeline(new Types.ObjectId(), baseQuery() as never, adminCaller());

        expect(result.tasks).toEqual([]);
        expect(result.undated).toEqual([
            expect.objectContaining({ id: undated._id.toString(), title: 'No date yet', status: undated.status }),
        ]);
    });
});

describe('buildTimeline (undated tasks in a sprint — Jira-style)', () => {
    it('draws an undated task in an on-screen sprint as a bar across the sprint, flagged as sprint-dated', async () => {
        loadProjectForCallerMock.mockResolvedValueOnce(projectFixture());
        const sprint = sprintFixture({ start_date: '2026-02-01', end_date: '2026-02-14' });
        sprintFindMock.mockReturnValueOnce(queryStub([sprint]));
        const inSprint = taskFixture({ title: 'In the sprint', due_date: null, sprint_id: sprint._id });
        const loose = taskFixture({ title: 'No sprint', due_date: null, sprint_id: null });
        taskFindMock.mockReturnValueOnce(queryStub([])).mockReturnValueOnce(queryStub([inSprint, loose]));

        const result = await svc.buildTimeline(new Types.ObjectId(), baseQuery() as never, adminCaller() as never);

        expect(result.tasks).toEqual([
            expect.objectContaining({
                id: inSprint._id.toString(),
                start_date: '2026-02-01',
                due_date: '2026-02-14',
                dated_by_sprint: true,
            }),
        ]);
        expect(result.undated.map((u) => u.title)).toEqual(['No sprint']);
    });

    it('a dated task is not flagged as sprint-dated', async () => {
        loadProjectForCallerMock.mockResolvedValueOnce(projectFixture());
        taskFindMock.mockReturnValueOnce(queryStub([taskFixture()])).mockReturnValueOnce(queryStub([]));
        const result = await svc.buildTimeline(new Types.ObjectId(), baseQuery() as never, adminCaller() as never);
        expect(result.tasks[0]!.dated_by_sprint).toBe(false);
    });
});
