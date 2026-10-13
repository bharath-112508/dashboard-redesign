import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Types } from 'mongoose';

/**
 * Story-side `story-task-queries` helpers — three accessors, each with
 * a small but contract-bearing query:
 *
 *   1. `aggregateStoryDerivedRows` — short-circuits on empty
 *      storyIds, passes the right `$match` (project_id + story_id ∈ storyIds),
 *      and the `$project` strips null sprint_ids so backlog tasks
 *      don't surface as a phantom sprint on the story board.
 *   2. `findTasksByStoryId` — narrow projection only (id, title,
 *      status, sprint_id, primary_assignee_id). A regression that
 *      returned the full doc would leak fields the story endpoint
 *      isn't supposed to surface.
 *   3. `detachStoryFromTasks` — two-phase find→updateMany so the
 *      audit log gets an accurate task_ids list even under concurrent
 *      writers. Returns `{ task_ids: [], modified_count: 0 }` when
 *      no matching tasks exist.
 */

const aggregateMock = vi.fn();
const findMock = vi.fn();
const updateManyMock = vi.fn();

vi.mock('../models/task.model.js', () => ({
    Task: {
        aggregate: aggregateMock,
        find: findMock,
        updateMany: updateManyMock,
    },
}));

const utils = await import('./story-task-queries.js');

/**
 * Legacy chain — `Task.find({...}).select({...}).lean<T>()`.
 * `detachStoryFromTasks` (two-phase find→updateMany) still uses this
 * minimal shape.
 */
const findChain = (rows: unknown[]) => ({
    select: () => ({
        lean: () => Promise.resolve(rows),
    }),
});

/**
 * M11-capped chain — `Task.find({...}).select({...}).sort({...}).limit(N).lean<T>()`.
 * `findTasksByStoryId` uses this after M11 (defensive cap + deterministic sort).
 */
const findChainCapped = (rows: unknown[]) => ({
    select: () => ({
        sort: () => ({
            limit: () => ({
                lean: () => Promise.resolve(rows),
            }),
        }),
    }),
});

beforeEach(() => {
    vi.clearAllMocks();
});

// ─── aggregateStoryDerivedRows ───────────────────────────────────────────

describe('aggregateStoryDerivedRows', () => {
    it('short-circuits on empty storyIds — no DB call, returns []', async () => {
        // Defensive: the FE hits `GET /projects/:id/stories` with paging,
        // and the empty page case must NOT issue a `$match: { story_id:
        // { $in: [] } }` (which mongo evaluates to "match nothing" but
        // still costs a round-trip).
        const result = await utils.aggregateStoryDerivedRows(new Types.ObjectId(), [], ['done']);
        expect(result).toEqual([]);
        expect(aggregateMock).not.toHaveBeenCalled();
    });

    it('passes project_id + story_id $in filter into the pipeline', async () => {
        aggregateMock.mockResolvedValueOnce([]);

        const projectId = new Types.ObjectId();
        const storyIds = [new Types.ObjectId(), new Types.ObjectId()];
        await utils.aggregateStoryDerivedRows(projectId, storyIds, ['done']);

        expect(aggregateMock).toHaveBeenCalledTimes(1);
        const pipeline = aggregateMock.mock.calls[0]![0] as Array<Record<string, unknown>>;
        expect(pipeline[0]).toEqual({
            $match: { project_id: projectId, story_id: { $in: storyIds } },
        });
    });

    it('substitutes a sentinel when terminalStatusKeys is empty so $in does not throw', async () => {
        // Pin the implementation detail: `terminalArr = keys.length > 0
        // ? keys : ['__none__']`. Without this, an empty `$in: []` in
        // the `$cond` evaluates to false for every doc — the result is
        // the same (done_count = 0), but the tactical fallback to
        // `['__none__']` is the explicit pinned behaviour.
        aggregateMock.mockResolvedValueOnce([]);

        await utils.aggregateStoryDerivedRows(new Types.ObjectId(), [new Types.ObjectId()], []);

        const pipeline = aggregateMock.mock.calls[0]![0] as Array<Record<string, unknown>>;
        const groupStage = pipeline[1] as { $group: { done_count: { $sum: { $cond: unknown[] } } } };
        const condArgs = groupStage.$group.done_count.$sum.$cond;
        // condArgs[0] is `{ $in: ['$status', terminalArr] }` — drill in.
        const inExpr = condArgs[0] as { $in: [string, string[]] };
        expect(inExpr.$in[1]).toEqual(['__none__']);
    });

    it('returns the aggregated rows verbatim from Task.aggregate', async () => {
        const rows = [
            {
                _id: new Types.ObjectId(),
                task_count: 5,
                sprint_ids: [new Types.ObjectId()],
                statuses: ['todo', 'done'],
                done_count: 1,
            },
        ];
        aggregateMock.mockResolvedValueOnce(rows);

        const result = await utils.aggregateStoryDerivedRows(new Types.ObjectId(), [new Types.ObjectId()], ['done']);
        expect(result).toBe(rows);
    });
});

// ─── findTasksByStoryId ──────────────────────────────────────────────────

describe('findTasksByStoryId', () => {
    it('queries with the narrow projection + cap via Task.find().select().sort().limit().lean() (no full-doc leak)', async () => {
        // The story endpoint surfaces only id / title / status /
        // sprint_id / primary_assignee_id. A regression that dropped
        // the projection would leak description / created_by / etc.
        // M11 — added `.sort({created_at, _id})` + `.limit(500)`
        // (defensive cap) on the production chain.
        const limitMock = vi.fn(() => ({ lean: () => Promise.resolve([]) }));
        const sortMock = vi.fn(() => ({ limit: limitMock }));
        const selectMock = vi.fn(() => ({ sort: sortMock }));
        findMock.mockReturnValueOnce({ select: selectMock });

        const storyId = new Types.ObjectId();
        await utils.findTasksByStoryId(storyId);

        expect(findMock).toHaveBeenCalledWith({ story_id: storyId });
        expect(selectMock).toHaveBeenCalledWith({
            _id: 1,
            title: 1,
            status: 1,
            sprint_id: 1,
            primary_assignee_id: 1,
        });
        expect(sortMock).toHaveBeenCalledWith({ created_at: 1, _id: 1 });
        expect(limitMock).toHaveBeenCalledWith(500);
    });

    it('returns the rows verbatim from `.lean()`', async () => {
        const tasks = [
            {
                _id: new Types.ObjectId(),
                title: 'Implement login',
                status: 'in_progress',
                sprint_id: null,
                primary_assignee_id: new Types.ObjectId(),
            },
        ];
        findMock.mockReturnValueOnce(findChainCapped(tasks));

        const result = await utils.findTasksByStoryId(new Types.ObjectId());
        expect(result).toBe(tasks);
    });
});

// ─── detachStoryFromTasks ────────────────────────────────────────────────

describe('detachStoryFromTasks', () => {
    it('two-phase: find first, then updateMany — returns the EXACT task_ids found', async () => {
        // The two-phase pattern is the contract: a concurrent writer
        // could touch story_id between phases, so the audit log must
        // record what we FOUND, not what we speculatively might have
        // detached. Pin that the returned `task_ids` come from the
        // pre-update find.
        const a = new Types.ObjectId();
        const b = new Types.ObjectId();
        const selectMock = vi.fn(() => ({ lean: () => Promise.resolve([{ _id: a }, { _id: b }]) }));
        findMock.mockReturnValueOnce({ select: selectMock });
        updateManyMock.mockResolvedValueOnce({ modifiedCount: 2 });

        const storyId = new Types.ObjectId();
        const result = await utils.detachStoryFromTasks(storyId);

        // Find was called with the projection-only narrow shape.
        expect(findMock).toHaveBeenCalledWith({ story_id: storyId });
        expect(selectMock).toHaveBeenCalledWith({ _id: 1 });
        // updateMany was called with $set: { story_id: null }.
        expect(updateManyMock).toHaveBeenCalledWith({ story_id: storyId }, { $set: { story_id: null } });
        // Returned ids match the find's snapshot, not whatever updateMany
        // happened to touch.
        expect(result).toEqual({ task_ids: [a, b], modified_count: 2 });
    });

    it('short-circuits when no tasks reference the story — no updateMany issued', async () => {
        // Avoids a wasted round-trip when a story is deleted that had
        // no tasks. Pin that updateMany is not called.
        findMock.mockReturnValueOnce(findChain([]));

        const result = await utils.detachStoryFromTasks(new Types.ObjectId());

        expect(result).toEqual({ task_ids: [], modified_count: 0 });
        expect(updateManyMock).not.toHaveBeenCalled();
    });

    it('falls back to modified_count: 0 when updateMany returns a non-number (driver-version drift defence)', async () => {
        findMock.mockReturnValueOnce(findChain([{ _id: new Types.ObjectId() }]));
        // Some driver versions / driver mocks return undefined here —
        // the helper treats that as 0 rather than letting `undefined`
        // leak into the audit row's metadata.
        updateManyMock.mockResolvedValueOnce({ modifiedCount: undefined });

        const result = await utils.detachStoryFromTasks(new Types.ObjectId());
        expect(result.modified_count).toBe(0);
    });
});
