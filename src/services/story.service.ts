import { Types } from 'mongoose';

import { Story, type StoryDocument } from '../models/story.model.js';
import { type ProjectDocument } from '../models/project.model.js';
import { AppError } from '../utils/app-error.js';
import { ERROR_CODES } from '../constants/error-codes.js';
import { isProjectAuthor } from '../utils/role-check.js';
import {
    BLOCKED_TASK_STATUS_KEY,
    DEFAULT_DONE_TASK_STATUS_KEY,
    IN_PROGRESS_TASK_STATUS_KEYS,
    STORY_DERIVED_STATUSES,
    type StoryDerivedStatus,
} from '../constants/story.js';
import { AUDIT_ACTIONS, AUDIT_TARGET_KINDS } from '../constants/audit.js';
import { recordAudit } from './audit.service.js';
import { loadProjectForCaller } from './project.service.js';
import type { ProjectCaller } from './project.service.js';
import {
    aggregateStoryDerivedRows,
    detachStoryFromTasks,
    findTasksByStoryId,
    findTasksByStoryIdPaginated,
    type StoryTaskRow,
    type TaskDerivedRow,
} from '../utils/story-task-queries.js';
import type { PaginationMeta } from '../utils/api-response.js';
import type {
    CreateStoryBody,
    ListStoriesQuery,
    ListStoryTasksQuery,
    PatchStoryBody,
    ReorderStoryBody,
} from '../validators/story.validator.js';

/**
 * Story service — Data_Model.md §5.3 / API_Contract.md §7.4.
 *
 * Architecture notes:
 *  - **Reads** delegate project visibility to `loadProjectForCaller` so the
 *    role → access rule lives in exactly one place.
 *  - **Writes** require the `story.write` permission (held by admin /
 *    manager / team_lead). The route already gates this with
 *    `requirePermission(story.write)`, but the service re-checks
 *    (defence in depth) and throws `STORY_WRITE_FORBIDDEN` per
 *    API_Contract §7.4.
 *  - **Derived fields** are computed at read time via a single aggregation
 *    over the `tasks` collection (`utils/story-task-queries.ts`). The
 *    aggregation is one round-trip indexed by `{project_id, story_id}`,
 *    so the Story-board's perf target (200 tasks < 200ms P95) holds.
 *  - **Reorder** shifts neighbours rather than using fractional ranks. For
 *    Phase 1's hundreds-per-project target this is fine. The shift is a
 *    single `bulkWrite` so a 200-story reorder is one round trip.
 */

// ─── Helpers ─────────────────────────────────────────────────────────────

// H2 — Team Lead holds `story.write` per the Step-47 system-role bundle
// (`system-role-definitions.ts`). Pre-H2 this gate compared role-string
// against admin/manager only, contradicting the bundle and 403'ing Team
// Leads who'd already passed the route's `requirePermission(STORY_WRITE)`.
const requireWriter = (caller: ProjectCaller): void => {
    if (!isProjectAuthor(caller)) {
        throw AppError.forbidden(
            'Only admins, managers, and team leads can create, update, or delete stories',
            ERROR_CODES.STORY_WRITE_FORBIDDEN
        );
    }
};

const terminalStatusKeysFor = (project: ProjectDocument): Set<string> => {
    const out = new Set<string>([DEFAULT_DONE_TASK_STATUS_KEY]);
    for (const s of project.custom_task_statuses) if (s.is_terminal) out.add(s.key);
    return out;
};

/**
 * Apply Data_Model §5.3's rule cascade to one story's task rollup.
 * Returns `done_count` alongside `derived_status` so `progress_percent`
 * can be computed without re-iterating.
 */
const evaluateDerivedStatus = (
    row: TaskDerivedRow | undefined,
    terminal: Set<string>
): {
    task_count: number;
    done_task_count: number;
    derived_status: StoryDerivedStatus;
    sprint_ids: Types.ObjectId[];
} => {
    if (!row || row.task_count === 0) {
        return {
            task_count: 0,
            done_task_count: 0,
            derived_status: STORY_DERIVED_STATUSES.EMPTY,
            sprint_ids: [],
        };
    }
    const statuses = row.statuses ?? [];
    const sprintIds = row.sprint_ids ?? [];

    const allTerminal = statuses.length > 0 && statuses.every((s) => terminal.has(s));
    const anyBlocked = statuses.includes(BLOCKED_TASK_STATUS_KEY);
    const anyInProgress = statuses.some((s) => IN_PROGRESS_TASK_STATUS_KEYS.includes(s));

    let derived: StoryDerivedStatus;
    if (anyBlocked) derived = STORY_DERIVED_STATUSES.BLOCKED;
    else if (anyInProgress) derived = STORY_DERIVED_STATUSES.IN_PROGRESS;
    else if (allTerminal) derived = STORY_DERIVED_STATUSES.DONE;
    else derived = STORY_DERIVED_STATUSES.TO_DO;

    return {
        task_count: row.task_count,
        done_task_count: row.done_count ?? 0,
        derived_status: derived,
        sprint_ids: sprintIds,
    };
};

const buildPublicStory = (
    doc: StoryDocument,
    derived: ReturnType<typeof evaluateDerivedStatus>
): Record<string, unknown> => ({
    id: doc._id.toString(),
    project_id: doc.project_id.toString(),
    title: doc.title,
    description: doc.description,
    position: doc.position,
    derived_status: derived.derived_status,
    task_count: derived.task_count,
    done_task_count: derived.done_task_count,
    sprint_ids: derived.sprint_ids.map((s) => s.toString()),
    progress_percent: derived.task_count === 0 ? 0 : Math.round((100 * derived.done_task_count) / derived.task_count),
    created_at: doc.created_at,
    updated_at: doc.updated_at,
    created_by: doc.created_by.toString(),
    updated_by: doc.updated_by ? doc.updated_by.toString() : null,
});

// ─── POST /projects/:project_id/stories ──────────────────────────────────

export const createStory = async (
    projectId: Types.ObjectId,
    input: CreateStoryBody,
    caller: ProjectCaller
): Promise<Record<string, unknown>> => {
    requireWriter(caller);
    const project = await loadProjectForCaller(projectId, caller);

    // Default position = current max + 1 (append). We avoid `count` here
    // because a deletion-induced gap would let two `count`-based callers
    // collide on the same position. `findOne(...).sort({position:-1})` is
    // a single-document read that's race-tolerant in the common case; on
    // the rare collision the unique-position constraint isn't violated
    // (positions aren't unique by design — equal-position rows just sort
    // by created_at as a tiebreaker on the FE).
    let position = input.position;
    if (position === undefined) {
        const last = await Story.findOne({ project_id: project._id })
            .sort({ position: -1 })
            .select('position')
            .lean<{ position: number } | null>();
        position = last ? last.position + 1 : 0;
    }

    const created = await Story.create({
        project_id: project._id,
        title: input.title,
        description: input.description,
        position,
        created_by: caller.id,
        updated_by: caller.id,
    });

    if (caller.audit) {
        await recordAudit(caller.audit, {
            action: AUDIT_ACTIONS.STORY_CREATE,
            target: { kind: AUDIT_TARGET_KINDS.STORY, id: created._id },
            after: {
                id: created._id.toString(),
                project_id: project._id.toString(),
                title: created.title,
                position: created.position,
            },
            metadata: { project_id: project._id.toString() },
        });
    }

    // No tasks yet on a freshly created story → derived = empty.
    return buildPublicStory(created, evaluateDerivedStatus(undefined, new Set()));
};

// ─── GET /projects/:project_id/stories ───────────────────────────────────

export const listStories = async (
    projectId: Types.ObjectId,
    query: ListStoriesQuery,
    caller: ProjectCaller
): Promise<{ data: Record<string, unknown>[]; meta: PaginationMeta }> => {
    const project = await loadProjectForCaller(projectId, caller);

    // We page over the model, then derive in-memory; filtering by
    // `derived_status` happens AFTER derivation so the cap/pagination
    // numbers reflect the *raw* set. The Story board's perf target (200
    // tasks < 200ms P95) is comfortably within reach because the
    // aggregation is one round-trip indexed by `{project_id, story_id}`.
    const filter: Record<string, unknown> = { project_id: project._id };
    if (query.q) {
        const safe = query.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        filter.$or = [{ title: { $regex: safe, $options: 'i' } }, { description: { $regex: safe, $options: 'i' } }];
    }

    const skip = (query.page - 1) * query.limit;
    const [docs, total] = await Promise.all([
        Story.find(filter).sort({ position: 1, created_at: 1 }).skip(skip).limit(query.limit),
        Story.countDocuments(filter),
    ]);

    const ids = docs.map((d) => d._id);
    const terminal = terminalStatusKeysFor(project);
    const rows = await aggregateStoryDerivedRows(project._id, ids, [...terminal]);
    const byId = new Map<string, TaskDerivedRow>();
    for (const r of rows) byId.set(String(r._id), r);

    let data = docs.map((d) => buildPublicStory(d, evaluateDerivedStatus(byId.get(String(d._id)), terminal)));

    if (query.status) {
        data = data.filter((s) => s.derived_status === query.status);
    }

    return {
        data,
        meta: {
            page: query.page,
            limit: query.limit,
            total,
            total_pages: Math.max(1, Math.ceil(total / query.limit)),
        },
    };
};

// ─── GET /stories/:id ────────────────────────────────────────────────────

const loadStoryAndProject = async (
    storyId: Types.ObjectId,
    caller: ProjectCaller
): Promise<{ story: StoryDocument; project: ProjectDocument }> => {
    const story = await Story.findById(storyId);
    if (!story) throw AppError.notFound('Story not found', ERROR_CODES.STORY_NOT_FOUND);
    const project = await loadProjectForCaller(story.project_id, caller);
    return { story, project };
};

export const getStory = async (storyId: Types.ObjectId, caller: ProjectCaller): Promise<Record<string, unknown>> => {
    const { story, project } = await loadStoryAndProject(storyId, caller);

    const terminal = terminalStatusKeysFor(project);
    const [rows, tasks] = await Promise.all([
        aggregateStoryDerivedRows(project._id, [story._id], [...terminal]),
        findTasksByStoryId(story._id),
    ]);
    const derived = evaluateDerivedStatus(rows[0], terminal);

    // Group tasks by sprint id (null bucket = backlog).
    const buckets = new Map<string, StoryTaskRow[]>();
    for (const t of tasks) {
        const key = t.sprint_id ? t.sprint_id.toString() : '__none__';
        const arr = buckets.get(key) ?? [];
        arr.push(t);
        buckets.set(key, arr);
    }

    const tasks_by_sprint = Array.from(buckets.entries()).map(([key, items]) => ({
        sprint: key === '__none__' ? null : { id: key },
        tasks: items.map((t) => ({
            id: t._id.toString(),
            title: t.title,
            status: t.status,
            primary_assignee_id: t.primary_assignee_id ? t.primary_assignee_id.toString() : null,
        })),
    }));

    return {
        ...buildPublicStory(story, derived),
        tasks_by_sprint,
    };
};

// ─── PATCH /stories/:id ──────────────────────────────────────────────────

export const updateStory = async (
    storyId: Types.ObjectId,
    patch: PatchStoryBody,
    caller: ProjectCaller
): Promise<Record<string, unknown>> => {
    requireWriter(caller);
    const { story, project } = await loadStoryAndProject(storyId, caller);

    const before = {
        id: story._id.toString(),
        title: story.title,
        description: story.description,
        position: story.position,
    };

    if (patch.title !== undefined) story.title = patch.title;
    if (patch.description !== undefined) story.description = patch.description;
    story.updated_by = caller.id;

    // Position changes go through the shift helper so PATCH and
    // POST /reorder share one mutation path. Everything else can save in
    // a single round-trip.
    if (patch.position !== undefined && patch.position !== story.position) {
        await reorderInternal(story, project._id, patch.position);
    }
    await story.save();

    if (caller.audit) {
        await recordAudit(caller.audit, {
            action: AUDIT_ACTIONS.STORY_UPDATE,
            target: { kind: AUDIT_TARGET_KINDS.STORY, id: story._id },
            before,
            after: {
                id: story._id.toString(),
                title: story.title,
                description: story.description,
                position: story.position,
            },
            metadata: { project_id: project._id.toString() },
        });
    }

    const terminal = terminalStatusKeysFor(project);
    const rows = await aggregateStoryDerivedRows(project._id, [story._id], [...terminal]);
    return buildPublicStory(story, evaluateDerivedStatus(rows[0], terminal));
};

// ─── POST /stories/:id/reorder ───────────────────────────────────────────

export const reorderStory = async (
    storyId: Types.ObjectId,
    body: ReorderStoryBody,
    caller: ProjectCaller
): Promise<Record<string, unknown>> => {
    requireWriter(caller);
    const { story, project } = await loadStoryAndProject(storyId, caller);

    const before = { id: story._id.toString(), position: story.position };

    if (body.position !== story.position) {
        await reorderInternal(story, project._id, body.position);
        await story.save();
    }

    if (caller.audit) {
        await recordAudit(caller.audit, {
            action: AUDIT_ACTIONS.STORY_REORDER,
            target: { kind: AUDIT_TARGET_KINDS.STORY, id: story._id },
            before,
            after: { id: story._id.toString(), position: story.position },
            metadata: { project_id: project._id.toString() },
        });
    }

    const terminal = terminalStatusKeysFor(project);
    const rows = await aggregateStoryDerivedRows(project._id, [story._id], [...terminal]);
    return buildPublicStory(story, evaluateDerivedStatus(rows[0], terminal));
};

/**
 * Shift neighbouring positions to make room at `newPosition`, then assign
 * `story.position = newPosition` (mutates the doc; caller saves).
 *
 *   moving DOWN  (old → new where new > old):
 *     decrement positions in (old, new] by 1
 *   moving UP    (old → new where new < old):
 *     increment positions in [new, old) by 1
 *
 * The new position is clamped to [0, maxPosition+1] so a caller can't
 * leave a gap by asking for position 999 in a 5-story project.
 */
const reorderInternal = async (
    story: StoryDocument,
    projectId: Types.ObjectId,
    newPositionRaw: number
): Promise<void> => {
    // Clamp to the current valid range.
    const lastDoc = await Story.findOne({ project_id: projectId })
        .sort({ position: -1 })
        .select('position')
        .lean<{ position: number } | null>();
    const maxPos = lastDoc ? lastDoc.position : 0;
    const newPosition = Math.max(0, Math.min(newPositionRaw, maxPos));
    const oldPosition = story.position;
    if (newPosition === oldPosition) return;

    if (newPosition > oldPosition) {
        await Story.updateMany(
            {
                project_id: projectId,
                _id: { $ne: story._id },
                position: { $gt: oldPosition, $lte: newPosition },
            },
            { $inc: { position: -1 } }
        );
    } else {
        await Story.updateMany(
            {
                project_id: projectId,
                _id: { $ne: story._id },
                position: { $gte: newPosition, $lt: oldPosition },
            },
            { $inc: { position: 1 } }
        );
    }
    story.position = newPosition;
};

// ─── DELETE /stories/:id ─────────────────────────────────────────────────

export const deleteStory = async (
    storyId: Types.ObjectId,
    caller: ProjectCaller
): Promise<{ deleted: true; unset_task_ids: string[] }> => {
    requireWriter(caller);
    const { story, project } = await loadStoryAndProject(storyId, caller);

    // Detach FIRST so a task is never orphaned with a dangling story_id
    // reference (the story doc disappears next).
    const detach = await detachStoryFromTasks(story._id);

    const before = {
        id: story._id.toString(),
        project_id: project._id.toString(),
        title: story.title,
        position: story.position,
    };

    await story.deleteOne();

    // Close the position gap left behind so the next reorder doesn't have
    // to guess. Idempotent: a re-run shifts nothing if the gap is gone.
    await Story.updateMany({ project_id: project._id, position: { $gt: story.position } }, { $inc: { position: -1 } });

    const unsetTaskIds = detach.task_ids.map((t) => t.toString());

    if (caller.audit) {
        await recordAudit(caller.audit, {
            action: AUDIT_ACTIONS.STORY_DELETE,
            target: { kind: AUDIT_TARGET_KINDS.STORY, id: story._id },
            before,
            metadata: {
                project_id: project._id.toString(),
                unset_task_ids: unsetTaskIds,
                detached_count: detach.modified_count,
            },
        });
    }

    return { deleted: true, unset_task_ids: unsetTaskIds };
};

// ─── GET /stories/:id/tasks ──────────────────────────────────────────────

export const listStoryTasks = async (
    storyId: Types.ObjectId,
    query: ListStoryTasksQuery,
    caller: ProjectCaller
): Promise<{ data: Record<string, unknown>[]; meta: PaginationMeta }> => {
    const { story } = await loadStoryAndProject(storyId, caller);

    // M11 — DB-level pagination (was: fetch-all + in-memory slice).
    // Pre-M11 a story with N tasks pulled N rows into memory on every
    // `?page=K` hit; now Mongo handles skip/limit and a parallel
    // `countDocuments` gives the wire envelope a real total without
    // materialising the unread rows.
    const skip = (query.page - 1) * query.limit;
    const { rows, total } = await findTasksByStoryIdPaginated(story._id, { skip, limit: query.limit });

    return {
        data: rows.map((t) => ({
            id: t._id.toString(),
            story_id: story._id.toString(),
            sprint_id: t.sprint_id ? t.sprint_id.toString() : null,
            title: t.title,
            status: t.status,
            primary_assignee_id: t.primary_assignee_id ? t.primary_assignee_id.toString() : null,
        })),
        meta: {
            page: query.page,
            limit: query.limit,
            total,
            total_pages: Math.max(1, Math.ceil(total / query.limit)),
        },
    };
};
