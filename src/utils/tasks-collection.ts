import mongoose, { Types } from 'mongoose';

import { COLLECTIONS } from '../constants/collections.js';

/**
 * Raw-collection accessors for the `tasks` collection.
 *
 * Why raw collection (and not a Mongoose model)?
 *  - The full `tasks` schema lands in **Step 18**. Step 17 (stories) only
 *    needs to *read* a handful of fields (`story_id`, `sprint_id`, `status`)
 *    plus `updateMany({ story_id }, { $set: { story_id: null } })` when a
 *    story is deleted. Defining a partial model here would force us to
 *    rewrite it in Step 18 and risk schema drift.
 *  - The `mongoose.connection.collection()` accessor returns a node-mongo
 *    `Collection` that's safe to call before the collection physically
 *    exists — empty pipelines just return `[]`.
 *
 * Centralising this lookup behind a tiny module also lets unit tests stub
 * everything via `vi.mock('./tasks-collection.js')` without having to mock
 * mongoose itself (which is fragile when other code in the same test file
 * imports `Types`).
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

// ─── Collection accessor (single, mockable) ──────────────────────────────

const tasksCollection = (): ReturnType<typeof mongoose.connection.collection> =>
    mongoose.connection.collection(COLLECTIONS.TASKS);

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
    const rows = await tasksCollection()
        .aggregate<TaskDerivedRow>([
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
        ])
        .toArray();
    return rows;
};

/**
 * Tasks belonging to a story, projected to the small shape the
 * `GET /stories/:id` and `GET /stories/:id/tasks` endpoints render.
 * Step 18 will replace this with a richer Task service call; until then
 * we keep the projection narrow to keep the contract honest.
 */
export const findTasksByStoryId = async (storyId: Types.ObjectId): Promise<StoryTaskRow[]> => {
    const rows = await tasksCollection()
        .find<StoryTaskRow>(
            { story_id: storyId },
            {
                projection: {
                    _id: 1,
                    title: 1,
                    status: 1,
                    sprint_id: 1,
                    primary_assignee_id: 1,
                },
            }
        )
        .toArray();
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
    const docs = await tasksCollection()
        .find<{ _id: Types.ObjectId }>({ story_id: storyId }, { projection: { _id: 1 } })
        .toArray();
    if (docs.length === 0) return { task_ids: [], modified_count: 0 };
    const result = await tasksCollection().updateMany({ story_id: storyId }, { $set: { story_id: null } });
    return {
        task_ids: docs.map((d) => d._id),
        modified_count: typeof result.modifiedCount === 'number' ? result.modifiedCount : 0,
    };
};
