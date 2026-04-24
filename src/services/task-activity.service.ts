import { Types } from 'mongoose';

import { TaskActivity, type TaskActivityDocument } from '../models/task-activity.model.js';
import { Task } from '../models/task.model.js';
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

    const filter: Record<string, unknown> = { task_id: task._id };
    if (query.activity_type) filter.activity_type = query.activity_type;
    if (query.actor_id) filter.actor_id = new Types.ObjectId(query.actor_id);

    const skip = (query.page - 1) * query.limit;
    const [rows, total] = await Promise.all([
        TaskActivity.find(filter).sort({ created_at: -1, _id: -1 }).skip(skip).limit(query.limit),
        TaskActivity.countDocuments(filter),
    ]);

    return {
        data: rows.map(toPublic),
        meta: {
            page: query.page,
            limit: query.limit,
            total,
            total_pages: Math.max(1, Math.ceil(total / query.limit)),
        },
    };
};
