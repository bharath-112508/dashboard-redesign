import { Types } from 'mongoose';

import { Task } from '../models/task.model.js';

/**
 * Story-side data accessors over the `tasks` collection.
 *
 * These three helpers exist because the **story** domain needs to run
 * queries against tasks (rollup-by-story, narrow-projection-by-story,
 * detach-on-story-delete) that aren't task API use cases. They live
 * here — outside both `story.service.ts` and `task.service.ts` — for
 * three reasons:
 *
 *   1. Keeps `task.service.ts` from accumulating cross-domain queries.
 *      The task domain owns task use cases; queries other domains run
 *      against the tasks collection don't belong there.
 *
 *   2. Keeps `story.service.ts` focused on business logic. The
 *      aggregation pipeline + narrow projections + two-phase detach
 *      are data-access plumbing, not story rules.
 *
 *   3. Gives tests a clean mock boundary —
 *      `vi.mock('./story-task-queries.js')` stubs the three functions
 *      in a single line, instead of mocking the Task model surface.
 *
 * Historical note: originally written with
 * `mongoose.connection.collection(...)` because the Task model didn't
 * exist when stories shipped (Step 17 vs Step 18). Now backed by the
 * proper `Task` model.
 */

// ─── Shared shape for the read-only fields the story service touches ─────

export interface TaskDerivedRow {
    /**
     * The `_id` of the story whose tasks were folded into this row.
     * `null` is excluded by the pipeline match — this should always be set.
     */
    _id: Types.ObjectId;
    task_count: number;
    /** Distinct sprint IDs (nulls filtered out). */
    sprint_ids: Types.ObjectId[];
    /** Number of tasks whose `status` is in the project's terminal set. */
    done_count: number;
    /** Set of distinct task statuses present, used to evaluate the rule cascade. */
    statuses: string[];
}

export interface StoryTaskRow {
    _id: Types.ObjectId;
    title: string;
    status: string;
    sprint_id: Types.ObjectId | null;
    primary_assignee_id?: Types.ObjectId | null;
}

// ─── Aggregations exposed to the story service ───────────────────────────

/**
 * One aggregation pass that returns the per-story rollup the derived-status
 * rule cascade needs. Stories with zero matching tasks are absent from the
 * result (the caller fills them in as `empty`). This is the single
 * round-trip that powers the Story-board read.
 *
 * `terminalStatusKeys` is project-specific (default `done` plus any custom
 * status with `is_terminal: true`); we pass it in so `done_count` can be
 * computed in-pipeline without a second round-trip.
 */
export const aggregateStoryDerivedRows = async (
    projectId: Types.ObjectId,
    storyIds: Types.ObjectId[],
    terminalStatusKeys: readonly string[]
): Promise<TaskDerivedRow[]> => {
    if (storyIds.length === 0) return [];
    const terminalArr = terminalStatusKeys.length > 0 ? terminalStatusKeys : ['__none__'];
    const rows = await Task.aggregate<TaskDerivedRow>([
        { $match: { project_id: projectId, story_id: { $in: storyIds } } },
        {
            $group: {
                _id: '$story_id',
                task_count: { $sum: 1 },
                sprint_ids: { $addToSet: '$sprint_id' },
                statuses: { $addToSet: '$status' },
                done_count: {
                    $sum: { $cond: [{ $in: ['$status', terminalArr] }, 1, 0] },
                },
            },
        },
        // Strip nulls from `sprint_ids` so backlog tasks (sprint_id=null)
        // don't surface as a phantom sprint id on the Story board.
        {
            $project: {
                task_count: 1,
                statuses: 1,
                done_count: 1,
                sprint_ids: {
                    $filter: {
                        input: '$sprint_ids',
                        as: 'sid',
                        cond: { $ne: ['$$sid', null] },
                    },
                },
            },
        },
    ]);
    return rows;
};

/**
 * Tasks belonging to a story, projected to the small shape the
 * `GET /stories/:id` and `GET /stories/:id/tasks` endpoints render.
 * The narrow projection is deliberate — these endpoints intentionally
 * surface only the fields the story-board UI renders.
 */
export const findTasksByStoryId = async (storyId: Types.ObjectId): Promise<StoryTaskRow[]> => {
    const rows = await Task.find({ story_id: storyId })
        .select({ _id: 1, title: 1, status: 1, sprint_id: 1, primary_assignee_id: 1 })
        .lean<StoryTaskRow[]>();
    return rows;
};

/**
 * Detach a story from its tasks: returns the IDs whose `story_id` was
 * cleared so the audit log can record the exact list. Two-phase (find →
 * update) keeps the audit accurate even if the same task is touched by a
 * concurrent writer between phases — we record what we found, not what we
 * speculatively might have detached.
 */
export const detachStoryFromTasks = async (
    storyId: Types.ObjectId
): Promise<{ task_ids: Types.ObjectId[]; modified_count: number }> => {
    const docs = await Task.find({ story_id: storyId }).select({ _id: 1 }).lean<{ _id: Types.ObjectId }[]>();
    if (docs.length === 0) return { task_ids: [], modified_count: 0 };
    const result = await Task.updateMany({ story_id: storyId }, { $set: { story_id: null } });
    return {
        task_ids: docs.map((d) => d._id),
        modified_count: typeof result.modifiedCount === 'number' ? result.modifiedCount : 0,
    };
};
