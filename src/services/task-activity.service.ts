import { Types } from 'mongoose';

import { TaskActivity, type TaskActivityDocument } from '../models/task-activity.model.js';
import { Task } from '../models/task.model.js';
import { User } from '../models/user.model.js';
import { AppError } from '../utils/app-error.js';
import { ERROR_CODES } from '../constants/error-codes.js';
import { type TaskActivityType } from '../constants/task-activity.js';
import { loadProjectForCaller } from './project.service.js';
import type { ProjectCaller } from './project.service.js';
import logger from '../utils/logger.js';
import type { PaginationMeta } from '../utils/api-response.js';
import type { ListActivitiesQuery } from '../validators/task-activity.validator.js';

/**
 * Task-activity service — Data_Model.md §5.7 / API_Contract.md §8.6.
 *
 * Two surfaces:
 *
 *   1. `recordActivity(...)` — internal API used by `task.service` and
 *      `task-comment.service` to log lifecycle events. **Never throws.**
 *      DB failures are caught and logged at warn with the canonical
 *      `ACTIVITY_WRITE_FAILED` log code so the primary task action
 *      always succeeds (mirrors the audit + notification policy).
 *
 *   2. `listActivities(...)` — public read endpoint, scoped through
 *      `loadProjectForCaller` for visibility.
 *
 * Why a separate "best-effort" recorder rather than reusing the audit
 * service:
 *   - Audit captures *all* sensitive system actions for compliance.
 *     Activity captures only task-domain events, with a value-typed
 *     `from`/`to` pair the FE renders directly ("status: to_do → done").
 *   - The two enums + collections evolve independently: adding an
 *     activity type doesn't bloat the audit action whitelist (which is
 *     also limited in size for practical reasons).
 *   - Activity payloads are very small (single value pair); audit
 *     snapshots are large doc diffs. Storing them in the same
 *     collection would mix two very different access patterns.
 */

// ─── Types ────────────────────────────────────────────────────────────────

export interface RecordActivityInput {
    task_id: Types.ObjectId;
    actor_id: Types.ObjectId;
    activity_type: TaskActivityType;
    from_value?: unknown;
    to_value?: unknown;
    metadata?: Record<string, unknown>;
}

const toPublic = (doc: TaskActivityDocument): Record<string, unknown> => doc.toJSON() as Record<string, unknown>;

/**
 * M38 — batch-load `{ id, full_name }` for the unique actor ids on a
 * page so the FE doesn't fan out per-row `GET /users/:id` requests.
 * Mirrors the M36 comment hydration and the original
 * `loadActorDisplays` in `audit-log.service.ts`.
 */
interface ActorDisplay {
    id: string;
    full_name: string | null;
}

const loadActorDisplays = async (ids: Types.ObjectId[]): Promise<Map<string, ActorDisplay>> => {
    if (ids.length === 0) return new Map();
    const rows = await User.find({ _id: { $in: ids } })
        .select('_id full_name')
        .lean<{ _id: Types.ObjectId; full_name: string }[]>();
    return new Map(rows.map((r) => [r._id.toString(), { id: r._id.toString(), full_name: r.full_name }]));
};

const stampActor = (row: Record<string, unknown>, actorMap: Map<string, ActorDisplay>): Record<string, unknown> => {
    // `toJSON()` leaves `actor_id` as an ObjectId, so normalise to its hex
    // string (the actorMap key) — a raw `typeof === 'string'` check skipped
    // every row and left `actor` null, which clients (no member roster to fall
    // back on) saw as a bare id.
    const actorId = row.actor_id == null ? null : String(row.actor_id);
    if (!actorId) return row;
    return {
        ...row,
        actor: actorMap.get(actorId) ?? { id: actorId, full_name: null },
    };
};

// ─── Internal: best-effort recorder ──────────────────────────────────────
//
// Identical contract to `recordAudit`: never throws, logs on failure
// with a stable code so operators can grep dropped events.

export const recordActivity = async (input: RecordActivityInput): Promise<void> => {
    try {
        await TaskActivity.create({
            task_id: input.task_id,
            actor_id: input.actor_id,
            activity_type: input.activity_type,
            from_value: input.from_value ?? null,
            to_value: input.to_value ?? null,
            metadata: input.metadata ?? {},
        });
    } catch (err) {
        logger.warn(
            {
                err,
                code: 'ACTIVITY_WRITE_FAILED',
                task_id: input.task_id.toString(),
                activity_type: input.activity_type,
            },
            'Task activity write failed'
        );
    }
};

/**
 * Convenience wrapper for diff-driven recorders that want to skip the
 * write entirely when `before === after`. Returns `false` when the call
 * is suppressed; `true` when the row was queued. Equality is "ObjectId-
 * aware" — two ObjectIds compare via `.equals`, everything else uses
 * strict `===`.
 */
export const recordActivityIfChanged = async (input: RecordActivityInput): Promise<boolean> => {
    const a = input.from_value;
    const b = input.to_value;
    if (a === b) return false;
    if (a instanceof Types.ObjectId && b instanceof Types.ObjectId && a.equals(b)) return false;
    if (a == null && b == null) return false;
    await recordActivity(input);
    return true;
};

// ─── GET /tasks/:task_id/activity ────────────────────────────────────────

export const listActivities = async (
    taskId: Types.ObjectId,
    query: ListActivitiesQuery,
    caller: ProjectCaller
): Promise<{ data: Record<string, unknown>[]; meta: PaginationMeta }> => {
    const task = await Task.findById(taskId)
        .select('_id project_id')
        .lean<{ _id: Types.ObjectId; project_id: Types.ObjectId } | null>();
    if (!task) throw AppError.notFound('Task not found', ERROR_CODES.TASK_NOT_FOUND);

    // Project visibility — propagates 403 from `loadProjectForCaller`
    // unchanged so the FE sees the canonical error.
    await loadProjectForCaller(task.project_id, caller);

    // Opt-in roll-up: include activities for direct subtasks of this task.
    // Nesting is capped at one level (matches the FE / model cap), so a
    // single `$in` on `parent_task_id = task._id` is enough — no recursion.
    let taskIds: Types.ObjectId[] = [task._id];
    if (query.include_subtasks) {
        const subtaskIds = await Task.find({ parent_task_id: task._id })
            .select('_id')
            .lean<{ _id: Types.ObjectId }[]>();
        if (subtaskIds.length > 0) {
            taskIds = [task._id, ...subtaskIds.map((s) => s._id)];
        }
    }

    const filter: Record<string, unknown> =
        taskIds.length === 1 ? { task_id: task._id } : { task_id: { $in: taskIds } };
    if (query.activity_type) filter.activity_type = query.activity_type;
    if (query.actor_id) filter.actor_id = new Types.ObjectId(query.actor_id);

    const skip = (query.page - 1) * query.limit;
    const [rows, total] = await Promise.all([
        TaskActivity.find(filter).sort({ created_at: -1, _id: -1 }).skip(skip).limit(query.limit),
        TaskActivity.countDocuments(filter),
    ]);

    // M38 — hydrate actor display fields (same pattern as M36 + the
    // audit-log read service). One round-trip for the page instead of
    // N from the FE.
    const uniqueActorIds = Array.from(new Set(rows.map((r) => r.actor_id.toString()))).map(
        (id) => new Types.ObjectId(id)
    );
    const actorMap = await loadActorDisplays(uniqueActorIds);

    return {
        data: rows.map((r) => stampActor(toPublic(r), actorMap)),
        meta: {
            page: query.page,
            limit: query.limit,
            total,
            total_pages: Math.max(1, Math.ceil(total / query.limit)),
        },
    };
};
