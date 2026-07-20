import { Types } from 'mongoose';

import { Task, type TaskDocument } from '../models/task.model.js';
import { Story } from '../models/story.model.js';
import { Sprint } from '../models/sprint.model.js';
import { User } from '../models/user.model.js';
import { Project, type ProjectDocument } from '../models/project.model.js';
import { AppError } from '../utils/app-error.js';
import { isAdminLike } from '../utils/role-check.js';
import { ERROR_CODES } from '../constants/error-codes.js';
import { ROLES } from '../constants/roles.js';
import { USER_STATUSES } from '../constants/user-statuses.js';
import {
    DEFAULT_TASK_STATUSES,
    DEFAULT_TASK_STATUS_VALUES,
    TASK_DEPENDENCIES_MAX,
    TASK_EMPLOYEE_PATCH_FIELDS,
    TASK_ISSUE_TYPES,
    TASK_MAX_SUBTASK_DEPTH,
    TASK_PRIORITIES,
} from '../constants/task.js';
import { AUDIT_ACTIONS, AUDIT_TARGET_KINDS } from '../constants/audit.js';
import { TASK_ACTIVITY_TYPES } from '../constants/task-activity.js';
import { recordAudit } from './audit.service.js';
import { recordActivity } from './task-activity.service.js';
import { buildProjectVisibilityFilter, loadProjectForCaller } from './project.service.js';
import type { ProjectCaller } from './project.service.js';
import type { PaginationMeta } from '../utils/api-response.js';
import type {
    AddDependencyBody,
    AssignStoryBody,
    CreateTaskBody,
    ListTasksQuery,
    MoveSprintBody,
    PatchTaskBody,
    ReorderTaskBody,
} from '../validators/task.validator.js';

/**
 * Task service — Data_Model.md §5.4 / API_Contract.md §8.
 *
 * Architecture:
 *  - **Reads**: project visibility delegated to `loadProjectForCaller` for
 *    single-project queries, and to `buildProjectVisibilityFilter` for the
 *    cross-project list endpoint. Either way the service never trusts the
 *    caller's role beyond what the visibility layer permits.
 *  - **Writes**: defence-in-depth — the route gates by role, the service
 *    re-checks. Employees can PATCH only tasks they "own" (assignee or
 *    creator) and only the fields in `TASK_EMPLOYEE_PATCH_FIELDS`.
 *  - **Status**: validated against (defaults ∪ project.custom_task_statuses)
 *    so a custom status added in Step 16 actually works here, while a typo
 *    is rejected.
 *  - **Position**: dense integer per (project_id, status). Reorder shifts
 *    neighbours; status changes (PATCH or reorder-with-status) move the task
 *    to the END of the destination column to avoid colliding with existing
 *    rows. The shift logic mirrors `story.service`'s reorderInternal.
 *  - **Dependencies**: embedded array. Add/remove are their own endpoints
 *    so the audit log can record per-edge events. Cycle detection is BFS
 *    over the existing graph in the same project — capped to a few hundred
 *    nodes by `TASK_DEPENDENCIES_MAX`, so the BFS is bounded.
 *  - **Subtasks**: `parent_task_id` set at create or PATCH-disallowed for
 *    Phase 1 (we don't allow re-parenting). Depth capped at 1 — a subtask
 *    cannot itself be a parent.
 */

// ─── RBAC helpers ────────────────────────────────────────────────────────

/**
 * Step 47: "task writer" now spans Admin / Manager / **Team Lead**.
 * Team Leads have `task.write` in their permission bundle and the
 * project.author bundle (`project.write`, `sprint.write`, `story.write`,
 * `task_template.write`), so they create / delete / reassign tasks
 * within projects they are members of — same per-row scoping that
 * limits an Employee's task writes to their own.
 */
/**
 * `isAdminLike` (BACKEND_AUDIT.md R4) recognises a multi-role admin via
 * `role_keys.includes('admin')` even when the legacy `role` cache is a
 * different role. The MANAGER / TEAM_LEAD branches still consult the
 * legacy `role` directly — those are not currently distinguished in
 * `role_keys` (the system-role keys are admin/manager/team_lead/employee/client,
 * so a manager-only caller's `role` and `role_keys[0]` agree).
 */
const isManagerOrAdmin = (caller: ProjectCaller): boolean => {
    if (isAdminLike(caller)) return true;
    return caller.role === ROLES.MANAGER || caller.role === ROLES.TEAM_LEAD;
};

const requireWriter = (caller: ProjectCaller): void => {
    if (!isManagerOrAdmin(caller)) {
        throw AppError.forbidden(
            'Only admins, managers, and team leads can create, delete, or reassign tasks',
            ERROR_CODES.TASK_WRITE_FORBIDDEN
        );
    }
};

const isOwnerEmployee = (task: TaskDocument, caller: ProjectCaller): boolean => {
    if (caller.role !== ROLES.EMPLOYEE) return false;
    if (task.created_by.equals(caller.id)) return true;
    if (task.primary_assignee_id && task.primary_assignee_id.equals(caller.id)) return true;
    return false;
};

const assertEmployeePatchScope = (patch: PatchTaskBody, task: TaskDocument, caller: ProjectCaller): void => {
    if (isManagerOrAdmin(caller)) return;
    if (caller.role === ROLES.CLIENT) {
        // Clients have read-only project access; PATCH is never theirs.
        throw AppError.forbidden('Clients cannot update tasks', ERROR_CODES.TASK_WRITE_FORBIDDEN);
    }
    if (!isOwnerEmployee(task, caller)) {
        throw AppError.forbidden(
            'Employees can only update tasks they created or are assigned to',
            ERROR_CODES.TASK_WRITE_FORBIDDEN
        );
    }
    const offending = Object.keys(patch).filter((k) => !TASK_EMPLOYEE_PATCH_FIELDS.includes(k));
    if (offending.length > 0) {
        throw AppError.forbidden(
            `Employees may only update: ${TASK_EMPLOYEE_PATCH_FIELDS.join(', ')}`,
            ERROR_CODES.TASK_WRITE_FORBIDDEN
        );
    }
};

// ─── Status / assignee / collaborator validation ─────────────────────────

const allowedStatusKeys = (project: ProjectDocument): Set<string> => {
    const out = new Set<string>(DEFAULT_TASK_STATUS_VALUES);
    for (const s of project.custom_task_statuses) out.add(s.key);
    return out;
};

const assertValidStatus = (status: string, project: ProjectDocument): void => {
    if (!allowedStatusKeys(project).has(status)) {
        throw AppError.unprocessable(
            `Status "${status}" is not valid for this project`,
            ERROR_CODES.TASK_INVALID_STATUS,
            { allowed: [...allowedStatusKeys(project)] }
        );
    }
};

const INTERNAL_ROLES: readonly string[] = [ROLES.ADMIN, ROLES.MANAGER, ROLES.TEAM_LEAD, ROLES.EMPLOYEE];

const assertActiveInternalUsers = async (
    ids: Types.ObjectId[],
    code: typeof ERROR_CODES.TASK_INVALID_ASSIGNEE | typeof ERROR_CODES.TASK_INVALID_COLLABORATOR
): Promise<void> => {
    if (ids.length === 0) return;
    const found = await User.find({ _id: { $in: ids }, status: USER_STATUSES.ACTIVE })
        .select('_id role')
        .lean<{ _id: Types.ObjectId; role: string }[]>();
    const ok = new Set<string>();
    for (const u of found) if (INTERNAL_ROLES.includes(u.role)) ok.add(String(u._id));
    const bad = ids.filter((id) => !ok.has(String(id))).map((id) => id.toString());
    if (bad.length > 0) {
        throw AppError.unprocessable("One or more of the selected people aren't active team members.", code, {
            invalid_user_ids: bad,
        });
    }
};

// ─── Sprint / Story / Parent task validation ─────────────────────────────

const assertSprintBelongsToProject = async (sprintId: Types.ObjectId, projectId: Types.ObjectId): Promise<void> => {
    const sprint = await Sprint.findById(sprintId).select('project_id').lean<{ project_id: Types.ObjectId } | null>();
    if (!sprint || !sprint.project_id.equals(projectId)) {
        throw AppError.unprocessable(
            'Sprint does not belong to the task project',
            ERROR_CODES.TASK_SPRINT_PROJECT_MISMATCH
        );
    }
};

const assertStoryBelongsToProject = async (storyId: Types.ObjectId, projectId: Types.ObjectId): Promise<void> => {
    const story = await Story.findById(storyId).select('project_id').lean<{ project_id: Types.ObjectId } | null>();
    if (!story || !story.project_id.equals(projectId)) {
        throw AppError.unprocessable('Story does not belong to the task project', ERROR_CODES.STORY_PROJECT_MISMATCH);
    }
};

/**
 * Validate parent reference — same project AND not itself a subtask
 * (depth = 1 cap). Returns the parent doc so the caller can copy any
 * inheritable fields if it ever wants to (Phase 1 doesn't).
 */
const assertParentTaskUsable = async (parentId: Types.ObjectId, projectId: Types.ObjectId): Promise<TaskDocument> => {
    const parent = await Task.findById(parentId);
    if (!parent) {
        throw AppError.unprocessable('Parent task not found', ERROR_CODES.TASK_PARENT_NOT_FOUND);
    }
    if (!parent.project_id.equals(projectId)) {
        throw AppError.unprocessable(
            'Parent task belongs to a different project',
            ERROR_CODES.TASK_PARENT_PROJECT_MISMATCH
        );
    }
    if (parent.parent_task_id !== null && TASK_MAX_SUBTASK_DEPTH === 1) {
        // Adding a child to a task that itself has a parent would create a
        // depth-2 subtask. Reject to keep the activity feed + UI simple.
        throw AppError.unprocessable('Subtasks can only go one level deep.', ERROR_CODES.TASK_SUBTASK_DEPTH_EXCEEDED);
    }
    return parent;
};

// ─── Dependency cycle detection ──────────────────────────────────────────
//
// BFS forward over the dependency graph: start at `candidate` (the task we
// would depend on), walk its `depends_on_task_ids`, and so on. If we ever
// reach `taskId`, adding the edge would close a cycle. Capped by node count
// to keep the worst case bounded; a depth-N chain is at most N reads.

const wouldCreateCycle = async (taskId: Types.ObjectId, candidateId: Types.ObjectId): Promise<boolean> => {
    const seen = new Set<string>([candidateId.toString()]);
    let frontier: Types.ObjectId[] = [candidateId];
    while (frontier.length > 0) {
        const rows = await Task.find({ _id: { $in: frontier } })
            .select('depends_on_task_ids')
            .lean<{ depends_on_task_ids: Types.ObjectId[] }[]>();
        const next: Types.ObjectId[] = [];
        for (const r of rows) {
            for (const dep of r.depends_on_task_ids) {
                if (dep.equals(taskId)) return true;
                const key = dep.toString();
                if (!seen.has(key)) {
                    seen.add(key);
                    next.push(dep);
                }
            }
        }
        frontier = next;
    }
    return false;
};

// ─── Position helpers ────────────────────────────────────────────────────

/**
 * Append a task at the end of its (project_id, status) column. Returns the
 * next dense integer. Used by create and by status-changing PATCHes so the
 * task lands at the bottom of the destination column rather than colliding
 * with an existing row.
 */
const nextPositionInColumn = async (projectId: Types.ObjectId, status: string): Promise<number> => {
    const last = await Task.findOne({ project_id: projectId, status })
        .sort({ position: -1 })
        .select('position')
        .lean<{ position: number } | null>();
    return last ? last.position + 1 : 0;
};

/**
 * Shift neighbours in the same (project_id, status) column to make room
 * for `task` at `newPositionRaw`. Mutates `task.position`; caller saves.
 * Mirrors `story.service`'s reorderInternal.
 */
const shiftNeighboursInColumn = async (task: TaskDocument, newPositionRaw: number): Promise<void> => {
    const last = await Task.findOne({ project_id: task.project_id, status: task.status })
        .sort({ position: -1 })
        .select('position')
        .lean<{ position: number } | null>();
    const maxPos = last ? last.position : 0;
    const newPosition = Math.max(0, Math.min(newPositionRaw, maxPos));
    const oldPosition = task.position;
    if (newPosition === oldPosition) return;

    if (newPosition > oldPosition) {
        await Task.updateMany(
            {
                project_id: task.project_id,
                status: task.status,
                _id: { $ne: task._id },
                position: { $gt: oldPosition, $lte: newPosition },
            },
            { $inc: { position: -1 } }
        );
    } else {
        await Task.updateMany(
            {
                project_id: task.project_id,
                status: task.status,
                _id: { $ne: task._id },
                position: { $gte: newPosition, $lt: oldPosition },
            },
            { $inc: { position: 1 } }
        );
    }
    task.position = newPosition;
};

// ─── Serialisation ───────────────────────────────────────────────────────

const toPublic = (doc: TaskDocument): Record<string, unknown> => doc.toJSON() as Record<string, unknown>;

// ─── Loaders ─────────────────────────────────────────────────────────────

const loadTaskAndProject = async (
    taskId: Types.ObjectId,
    caller: ProjectCaller
): Promise<{ task: TaskDocument; project: ProjectDocument }> => {
    const task = await Task.findById(taskId);
    if (!task) throw AppError.notFound('Task not found', ERROR_CODES.TASK_NOT_FOUND);
    const project = await loadProjectForCaller(task.project_id, caller);
    return { task, project };
};

// ─── POST /tasks ─────────────────────────────────────────────────────────

export const createTask = async (input: CreateTaskBody, caller: ProjectCaller): Promise<Record<string, unknown>> => {
    requireWriter(caller);
    const projectId = new Types.ObjectId(input.project_id);
    const project = await loadProjectForCaller(projectId, caller);

    const status = input.status ?? DEFAULT_TASK_STATUSES.TO_DO;
    assertValidStatus(status, project);

    const sprintId = input.sprint_id ? new Types.ObjectId(input.sprint_id) : null;
    if (sprintId) await assertSprintBelongsToProject(sprintId, projectId);

    const storyId = input.story_id ? new Types.ObjectId(input.story_id) : null;
    if (storyId) await assertStoryBelongsToProject(storyId, projectId);

    const parentId = input.parent_task_id ? new Types.ObjectId(input.parent_task_id) : null;
    if (parentId) await assertParentTaskUsable(parentId, projectId);

    const assigneeId = input.primary_assignee_id ? new Types.ObjectId(input.primary_assignee_id) : null;
    if (assigneeId) await assertActiveInternalUsers([assigneeId], ERROR_CODES.TASK_INVALID_ASSIGNEE);

    const collabIds = (input.collaborator_ids ?? []).map((id) => new Types.ObjectId(id));
    if (collabIds.length > 0) await assertActiveInternalUsers(collabIds, ERROR_CODES.TASK_INVALID_COLLABORATOR);

    // Dependencies on create: validated as a batch — same project + no
    // self-reference. Cycle detection isn't needed here because the new
    // task has no in-edges yet (nothing else can depend on it).
    const depIds = (input.depends_on_task_ids ?? []).map((id) => new Types.ObjectId(id));
    if (depIds.length > TASK_DEPENDENCIES_MAX) {
        throw AppError.unprocessable(
            `Too many dependencies (max ${TASK_DEPENDENCIES_MAX})`,
            ERROR_CODES.TASK_DEPENDENCY_EXISTS
        );
    }
    if (depIds.length > 0) {
        const found = await Task.find({ _id: { $in: depIds }, project_id: projectId })
            .select('_id')
            .lean<{ _id: Types.ObjectId }[]>();
        const okSet = new Set(found.map((d) => String(d._id)));
        const missing = depIds.filter((d) => !okSet.has(String(d))).map((d) => d.toString());
        if (missing.length > 0) {
            throw AppError.unprocessable(
                'One or more dependency tasks were not found in this project',
                ERROR_CODES.TASK_DEPENDENCY_PROJECT_MISMATCH,
                { invalid_task_ids: missing }
            );
        }
    }

    const position = input.position ?? (await nextPositionInColumn(projectId, status));

    // Reserve the issue-key number atomically BEFORE creating the task. The
    // `$inc` is a single-document atomic op, so two concurrent creates get
    // distinct numbers with no transaction. `new: true` returns the
    // post-increment value, which becomes this task's `task_number`.
    const counter = await Project.findOneAndUpdate(
        { _id: projectId },
        { $inc: { task_seq: 1 } },
        { new: true, projection: { task_seq: 1 } }
    ).lean<{ task_seq: number } | null>();
    if (!counter) {
        // Project was deleted between the visibility load and here — treat as
        // not-found rather than minting an orphan task.
        throw AppError.notFound('Project not found', ERROR_CODES.PROJECT_NOT_FOUND);
    }

    const created = await Task.create({
        project_id: projectId,
        task_number: counter.task_seq,
        sprint_id: sprintId,
        story_id: storyId,
        parent_task_id: parentId,
        title: input.title,
        description: input.description,
        status,
        priority: input.priority ?? TASK_PRIORITIES.MEDIUM,
        issue_type: input.issue_type ?? TASK_ISSUE_TYPES.TASK,
        story_points: input.story_points ?? null,
        due_date: input.due_date,
        estimated_hours: input.estimated_hours ?? 0,
        primary_assignee_id: assigneeId,
        collaborator_ids: collabIds,
        depends_on_task_ids: depIds,
        position,
        created_by: caller.id,
        updated_by: caller.id,
    });

    if (caller.audit) {
        await recordAudit(caller.audit, {
            action: AUDIT_ACTIONS.TASK_CREATE,
            target: { kind: AUDIT_TARGET_KINDS.TASK, id: created._id },
            after: toPublic(created),
            metadata: { project_id: projectId.toString() },
        });
    }

    // Activity feed: a `created` row on the new task itself, plus a
    // `subtask_added` row on the parent (if any) so the parent's feed
    // shows "John created subtask X".
    await recordActivity({
        task_id: created._id,
        actor_id: caller.id,
        activity_type: TASK_ACTIVITY_TYPES.CREATED,
        to_value: { title: created.title, status: created.status },
    });
    if (parentId) {
        await recordActivity({
            task_id: parentId,
            actor_id: caller.id,
            activity_type: TASK_ACTIVITY_TYPES.SUBTASK_ADDED,
            to_value: created._id,
            metadata: { subtask_id: created._id.toString(), title: created.title },
        });
    }

    return toPublic(created);
};

// ─── GET /tasks ──────────────────────────────────────────────────────────

export const listTasks = async (
    query: ListTasksQuery,
    caller: ProjectCaller
): Promise<{ data: Record<string, unknown>[]; meta: PaginationMeta }> => {
    const filter: Record<string, unknown> = {};

    // Project scoping: when query.project_id is supplied, validate caller
    // can read it (404 → 403). Otherwise scope to all visible projects.
    //
    // Read scope must mirror project.service's buildVisibilityFilter: only
    // admins and managers see every project. `isManagerOrAdmin` is a WRITE-
    // authority helper that includes TEAM_LEAD — reusing it here let team
    // leads list tasks from projects they aren't members of, which the task
    // DETAIL endpoint then 403'd ("Unknown project" rows on the FE).
    const seesAllProjects = isAdminLike(caller) || caller.role === ROLES.MANAGER;
    if (query.project_id) {
        const project = await loadProjectForCaller(new Types.ObjectId(query.project_id), caller);
        filter.project_id = project._id;
    } else if (!seesAllProjects) {
        const visible = buildProjectVisibilityFilter(caller);
        // Resolve to project IDs once so the task query stays simple. The
        // project list is small in practice (low hundreds at most for any
        // single user); we cap at 1k to avoid pathological scans.
        const { Project } = await import('../models/project.model.js');
        const ids = await Project.find(visible).select('_id').limit(1_000).lean<{ _id: Types.ObjectId }[]>();
        filter.project_id = { $in: ids.map((p) => p._id) };
    }

    if (query.sprint_id) filter.sprint_id = new Types.ObjectId(query.sprint_id);
    if (query.assignee_id) filter.primary_assignee_id = new Types.ObjectId(query.assignee_id);
    if (query.status) filter.status = query.status;
    if (query.priority) filter.priority = query.priority;
    if (query.due_before) filter.due_date = { $lte: query.due_before };

    if (query.story_id !== undefined) {
        filter.story_id = query.story_id === 'null' ? null : new Types.ObjectId(query.story_id);
    }
    if (query.parent_task_id !== undefined) {
        filter.parent_task_id = query.parent_task_id === 'null' ? null : new Types.ObjectId(query.parent_task_id);
    }

    if (query.q) {
        const safe = query.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        filter.$or = [{ title: { $regex: safe, $options: 'i' } }, { description: { $regex: safe, $options: 'i' } }];
    }

    // Sort order depends on how the list is scoped:
    //  - A single-column context (a project board / sprint / story / subtask
    //    list) wants `position` order — that's the manual, drag-reorder order
    //    within a status column.
    //  - The flat cross-project list (`/tasks`, "My Tasks") spans many
    //    projects, where `position` is a per-(project,status) index and thus
    //    meaningless as a global sort — and worse, a newly created task is
    //    appended at the END of its column (a high position), so a position-asc
    //    sort buries it on the last page where the user never sees it. Sort
    //    that list newest-first so a just-created task shows up top.
    const isColumnScoped = Boolean(
        query.project_id || query.sprint_id || query.story_id !== undefined || query.parent_task_id !== undefined
    );
    const sort: Record<string, 1 | -1> = isColumnScoped ? { position: 1, created_at: 1 } : { created_at: -1, _id: -1 };

    const skip = (query.page - 1) * query.limit;
    const [rows, total] = await Promise.all([
        Task.find(filter).sort(sort).skip(skip).limit(query.limit),
        Task.countDocuments(filter),
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

// ─── GET /tasks/:id ──────────────────────────────────────────────────────

/**
 * M35 — embed the minimal project shape on the task-detail response.
 *
 * Pre-M35 the FE did a waterfall: `useTask(id)` → wait → `useProject(task.project_id)`.
 * The second query was disabled until the first resolved, so the
 * project-hero (name + code + custom statuses) sat on a Suspense
 * fallback until both round-trips completed.
 *
 * `loadTaskAndProject` already loads the project for the visibility
 * check on every call. Including its minimal shape on the response
 * is a zero-extra-query change for the BE and collapses the FE
 * waterfall into a single read. The shape mirrors what
 * `task-detail-page.tsx` actually consumes: `id, name, code,
 * custom_task_statuses`.
 */
export const getTask = async (taskId: Types.ObjectId, caller: ProjectCaller): Promise<Record<string, unknown>> => {
    const { task, project } = await loadTaskAndProject(taskId, caller);
    return {
        ...toPublic(task),
        project: {
            id: project._id.toString(),
            name: project.name,
            code: project.code,
            custom_task_statuses: (project.custom_task_statuses ?? []).map((s) => ({
                id: s._id.toString(),
                key: s.key,
                label: s.label,
                order: s.order,
                is_terminal: s.is_terminal,
                is_active: s.is_active,
            })),
        },
    };
};

// ─── PATCH /tasks/:id ────────────────────────────────────────────────────

export const updateTask = async (
    taskId: Types.ObjectId,
    patch: PatchTaskBody,
    caller: ProjectCaller
): Promise<Record<string, unknown>> => {
    const { task, project } = await loadTaskAndProject(taskId, caller);
    assertEmployeePatchScope(patch, task, caller);

    const before = toPublic(task);
    // Snapshot the fields the activity feed cares about BEFORE we mutate
    // — Mongoose docs are reference types, so reading `task.priority`
    // after the assignment would give us the new value.
    const prev = {
        status: task.status,
        priority: task.priority,
        issue_type: task.issue_type,
        story_points: task.story_points,
        due_date: task.due_date,
        estimated_hours: task.estimated_hours,
        sprint_id: task.sprint_id,
        story_id: task.story_id,
        primary_assignee_id: task.primary_assignee_id,
        collaborator_ids: task.collaborator_ids.map((id) => id.toString()),
    };

    if (patch.title !== undefined) task.title = patch.title;
    if (patch.description !== undefined) task.description = patch.description;
    if (patch.priority !== undefined) task.priority = patch.priority as TaskDocument['priority'];
    if (patch.issue_type !== undefined) task.issue_type = patch.issue_type as TaskDocument['issue_type'];
    if (patch.story_points !== undefined) task.story_points = patch.story_points;
    if (patch.due_date !== undefined) task.due_date = patch.due_date;
    if (patch.estimated_hours !== undefined) task.estimated_hours = patch.estimated_hours;

    if (patch.sprint_id !== undefined) {
        const sid = patch.sprint_id ? new Types.ObjectId(patch.sprint_id) : null;
        if (sid) await assertSprintBelongsToProject(sid, project._id);
        task.sprint_id = sid;
    }

    if (patch.story_id !== undefined) {
        const sid = patch.story_id ? new Types.ObjectId(patch.story_id) : null;
        if (sid) await assertStoryBelongsToProject(sid, project._id);
        task.story_id = sid;
    }

    if (patch.primary_assignee_id !== undefined) {
        const aid = patch.primary_assignee_id ? new Types.ObjectId(patch.primary_assignee_id) : null;
        if (aid) await assertActiveInternalUsers([aid], ERROR_CODES.TASK_INVALID_ASSIGNEE);
        task.primary_assignee_id = aid;
    }

    if (patch.collaborator_ids !== undefined) {
        const ids = patch.collaborator_ids.map((id) => new Types.ObjectId(id));
        if (ids.length > 0) await assertActiveInternalUsers(ids, ERROR_CODES.TASK_INVALID_COLLABORATOR);
        task.collaborator_ids = ids;
    }

    // Status change → validate the new key, then move the task to the END
    // of the destination column. This avoids stomping on an existing
    // (status, position) and keeps neighbour-shift logic out of cross-
    // column moves.
    let statusChanged = false;
    if (patch.status !== undefined && patch.status !== task.status) {
        assertValidStatus(patch.status, project);
        task.status = patch.status;
        task.position = await nextPositionInColumn(task.project_id, patch.status);
        statusChanged = true;
    }

    // Position change within current column — only meaningful if status
    // didn't already move us to the end.
    if (!statusChanged && patch.position !== undefined && patch.position !== task.position) {
        await shiftNeighboursInColumn(task, patch.position);
    }

    task.updated_by = caller.id;
    await task.save();

    // M3 — task.save() runs WITHOUT a transaction by design. Audit +
    // activity-feed writes that follow are *both* explicitly
    // best-effort: `recordAudit` and `recordActivity` each wrap their
    // Mongo write in try/catch + log on failure (see
    // [audit.service.ts](recordAudit) + [task-activity.service.ts]).
    // Wrapping this whole flow in `withTransaction` would change
    // "task always saves; trail eventually consistent" to "task
    // fails if the activity collection hiccups" — wrong trade-off
    // for UX-fluff feeds. The audit log is the durable record;
    // activity rows are the bell/feed renderer's source.
    if (caller.audit) {
        await recordAudit(caller.audit, {
            action: AUDIT_ACTIONS.TASK_UPDATE,
            target: { kind: AUDIT_TARGET_KINDS.TASK, id: task._id },
            before,
            after: toPublic(task),
            metadata: { project_id: project._id.toString() },
        });
    }

    // Activity feed: one row per *meaningfully changed* field. We don't
    // emit a row for `title`/`description` because the spec enum has no
    // matching type and re-rendering "title changed" is noisy on the
    // feed. Position-only changes are also intentionally silent (they
    // don't carry semantic meaning).
    await emitPatchActivities(task, prev, caller.id);

    return toPublic(task);
};

/**
 * Diff `task` against the pre-mutation snapshot and write one activity
 * row per changed field. Best-effort — recordActivity swallows errors.
 */
const emitPatchActivities = async (
    task: TaskDocument,
    prev: {
        status: string;
        priority: string;
        issue_type: string;
        story_points: number | null;
        due_date: string;
        estimated_hours: number;
        sprint_id: Types.ObjectId | null;
        story_id: Types.ObjectId | null;
        primary_assignee_id: Types.ObjectId | null;
        collaborator_ids: string[];
    },
    actorId: Types.ObjectId
): Promise<void> => {
    if (task.issue_type !== prev.issue_type) {
        await recordActivity({
            task_id: task._id,
            actor_id: actorId,
            activity_type: TASK_ACTIVITY_TYPES.ISSUE_TYPE_CHANGED,
            from_value: prev.issue_type,
            to_value: task.issue_type,
        });
    }
    if (task.story_points !== prev.story_points) {
        await recordActivity({
            task_id: task._id,
            actor_id: actorId,
            activity_type: TASK_ACTIVITY_TYPES.STORY_POINTS_CHANGED,
            from_value: prev.story_points,
            to_value: task.story_points,
        });
    }
    if (task.status !== prev.status) {
        await recordActivity({
            task_id: task._id,
            actor_id: actorId,
            activity_type: TASK_ACTIVITY_TYPES.STATUS_CHANGED,
            from_value: prev.status,
            to_value: task.status,
        });
    }
    if (task.priority !== prev.priority) {
        await recordActivity({
            task_id: task._id,
            actor_id: actorId,
            activity_type: TASK_ACTIVITY_TYPES.PRIORITY_CHANGED,
            from_value: prev.priority,
            to_value: task.priority,
        });
    }
    if (task.due_date !== prev.due_date) {
        await recordActivity({
            task_id: task._id,
            actor_id: actorId,
            activity_type: TASK_ACTIVITY_TYPES.DUE_DATE_CHANGED,
            from_value: prev.due_date,
            to_value: task.due_date,
        });
    }
    if (task.estimated_hours !== prev.estimated_hours) {
        await recordActivity({
            task_id: task._id,
            actor_id: actorId,
            activity_type: TASK_ACTIVITY_TYPES.ESTIMATE_CHANGED,
            from_value: prev.estimated_hours,
            to_value: task.estimated_hours,
        });
    }
    if (!objectIdEq(task.primary_assignee_id, prev.primary_assignee_id)) {
        await recordActivity({
            task_id: task._id,
            actor_id: actorId,
            activity_type: TASK_ACTIVITY_TYPES.ASSIGNEE_CHANGED,
            from_value: prev.primary_assignee_id,
            to_value: task.primary_assignee_id,
        });
    }
    if (!objectIdEq(task.sprint_id, prev.sprint_id)) {
        await recordActivity({
            task_id: task._id,
            actor_id: actorId,
            activity_type: TASK_ACTIVITY_TYPES.SPRINT_CHANGED,
            from_value: prev.sprint_id,
            to_value: task.sprint_id,
        });
    }
    if (!objectIdEq(task.story_id, prev.story_id)) {
        await recordActivity({
            task_id: task._id,
            actor_id: actorId,
            activity_type: TASK_ACTIVITY_TYPES.STORY_CHANGED,
            from_value: prev.story_id,
            to_value: task.story_id,
        });
    }
    // Collaborators — emit one row per added / removed user so the feed
    // can attribute each change individually instead of a single
    // "collaborators changed" entry.
    const nextCollab = new Set(task.collaborator_ids.map((id) => id.toString()));
    const prevCollab = new Set(prev.collaborator_ids);
    for (const idStr of nextCollab) {
        if (prevCollab.has(idStr)) continue;
        await recordActivity({
            task_id: task._id,
            actor_id: actorId,
            activity_type: TASK_ACTIVITY_TYPES.COLLABORATOR_ADDED,
            to_value: new Types.ObjectId(idStr),
            metadata: { user_id: idStr },
        });
    }
    for (const idStr of prevCollab) {
        if (nextCollab.has(idStr)) continue;
        await recordActivity({
            task_id: task._id,
            actor_id: actorId,
            activity_type: TASK_ACTIVITY_TYPES.COLLABORATOR_REMOVED,
            from_value: new Types.ObjectId(idStr),
            metadata: { user_id: idStr },
        });
    }
};

const objectIdEq = (a: Types.ObjectId | null, b: Types.ObjectId | null): boolean => {
    if (a == null && b == null) return true;
    if (a == null || b == null) return false;
    return a.equals(b);
};

// ─── DELETE /tasks/:id ───────────────────────────────────────────────────

export const deleteTask = async (taskId: Types.ObjectId, caller: ProjectCaller): Promise<{ deleted: true }> => {
    requireWriter(caller);
    const { task, project } = await loadTaskAndProject(taskId, caller);

    const before = toPublic(task);
    const oldPosition = task.position;
    const oldStatus = task.status;
    const oldProjectId = task.project_id;

    // Detach subtasks rather than cascade-delete (no cascading deletes in
    // Phase 1 — same policy as story → tasks). Sub-rows (comments,
    // attachments, activity, timesheets) land in later steps; once they
    // exist their respective services will need a "task deleted" hook.
    await Task.updateMany({ parent_task_id: task._id }, { $set: { parent_task_id: null } });

    // Strip this task from any other task's depends_on list.
    await Task.updateMany({ depends_on_task_ids: task._id }, { $pull: { depends_on_task_ids: task._id } });

    await task.deleteOne();

    // Close the position gap in the source column.
    await Task.updateMany(
        { project_id: oldProjectId, status: oldStatus, position: { $gt: oldPosition } },
        { $inc: { position: -1 } }
    );

    if (caller.audit) {
        await recordAudit(caller.audit, {
            action: AUDIT_ACTIONS.TASK_DELETE,
            target: { kind: AUDIT_TARGET_KINDS.TASK, id: task._id },
            before,
            metadata: { project_id: project._id.toString() },
        });
    }

    return { deleted: true };
};

// ─── POST /tasks/:id/reorder ─────────────────────────────────────────────

export const reorderTask = async (
    taskId: Types.ObjectId,
    body: ReorderTaskBody,
    caller: ProjectCaller
): Promise<Record<string, unknown>> => {
    // Reorder is allowed for managers/admins AND for the assignee — the
    // latter so a person dragging their own card on a Kanban board doesn't
    // need a manager round-trip. Other employees / clients are denied.
    const { task, project } = await loadTaskAndProject(taskId, caller);

    const isAssignee = !!task.primary_assignee_id && task.primary_assignee_id.equals(caller.id);
    if (!isManagerOrAdmin(caller) && !isAssignee) {
        throw AppError.forbidden(
            'Only admins, managers, or the task assignee can reorder this task',
            ERROR_CODES.TASK_WRITE_FORBIDDEN
        );
    }

    const before = { id: task._id.toString(), status: task.status, position: task.position };
    const prevStatus = task.status;

    if (body.status !== undefined && body.status !== task.status) {
        // Cross-column move: validate destination, then push to its end.
        assertValidStatus(body.status, project);
        // First close gap in source column so positions stay dense.
        const oldStatus = task.status;
        const oldPosition = task.position;
        task.status = body.status;
        task.position = await nextPositionInColumn(task.project_id, body.status);
        await task.save();
        await Task.updateMany(
            { project_id: task.project_id, status: oldStatus, position: { $gt: oldPosition } },
            { $inc: { position: -1 } }
        );
        // Now apply the within-new-column shift to the requested position.
        if (body.position !== task.position) {
            await shiftNeighboursInColumn(task, body.position);
            await task.save();
        }
    } else if (body.position !== task.position) {
        await shiftNeighboursInColumn(task, body.position);
        await task.save();
    }

    if (caller.audit) {
        await recordAudit(caller.audit, {
            action: AUDIT_ACTIONS.TASK_REORDER,
            target: { kind: AUDIT_TARGET_KINDS.TASK, id: task._id },
            before,
            after: { id: task._id.toString(), status: task.status, position: task.position },
            metadata: { project_id: project._id.toString() },
        });
    }

    // Activity feed: only emit for cross-column moves. Pure intra-column
    // reorders carry no semantic meaning the feed should narrate.
    if (task.status !== prevStatus) {
        await recordActivity({
            task_id: task._id,
            actor_id: caller.id,
            activity_type: TASK_ACTIVITY_TYPES.STATUS_CHANGED,
            from_value: prevStatus,
            to_value: task.status,
        });
    }

    return toPublic(task);
};

// ─── POST /tasks/:id/assign-story ────────────────────────────────────────
//
// Per API_Contract §8.2a: changing story membership is a STORY-write
// operation, so non-admin/manager callers receive STORY_WRITE_FORBIDDEN
// (not TASK_WRITE_FORBIDDEN).

export const assignTaskStory = async (
    taskId: Types.ObjectId,
    body: AssignStoryBody,
    caller: ProjectCaller
): Promise<Record<string, unknown>> => {
    if (!isManagerOrAdmin(caller)) {
        throw AppError.forbidden(
            'Only admins and managers can change a task’s story',
            ERROR_CODES.STORY_WRITE_FORBIDDEN
        );
    }
    const { task, project } = await loadTaskAndProject(taskId, caller);

    const before = { id: task._id.toString(), story_id: task.story_id ? task.story_id.toString() : null };
    const prevStoryId = task.story_id;

    if (body.story_id) {
        const storyId = new Types.ObjectId(body.story_id);
        await assertStoryBelongsToProject(storyId, project._id);
        task.story_id = storyId;
    } else {
        task.story_id = null;
    }
    task.updated_by = caller.id;
    await task.save();

    if (caller.audit) {
        await recordAudit(caller.audit, {
            action: AUDIT_ACTIONS.TASK_ASSIGN_STORY,
            target: { kind: AUDIT_TARGET_KINDS.TASK, id: task._id },
            before,
            after: { id: task._id.toString(), story_id: task.story_id ? task.story_id.toString() : null },
            metadata: { project_id: project._id.toString() },
        });
    }

    if (!objectIdEq(task.story_id, prevStoryId)) {
        await recordActivity({
            task_id: task._id,
            actor_id: caller.id,
            activity_type: TASK_ACTIVITY_TYPES.STORY_CHANGED,
            from_value: prevStoryId,
            to_value: task.story_id,
        });
    }

    return toPublic(task);
};

// ─── POST /tasks/:id/move-sprint ─────────────────────────────────────────

export const moveTaskToSprint = async (
    taskId: Types.ObjectId,
    body: MoveSprintBody,
    caller: ProjectCaller
): Promise<Record<string, unknown>> => {
    requireWriter(caller);
    const { task, project } = await loadTaskAndProject(taskId, caller);

    const before = { id: task._id.toString(), sprint_id: task.sprint_id ? task.sprint_id.toString() : null };
    const prevSprintId = task.sprint_id;

    if (body.sprint_id) {
        const sprintId = new Types.ObjectId(body.sprint_id);
        await assertSprintBelongsToProject(sprintId, project._id);
        task.sprint_id = sprintId;
    } else {
        task.sprint_id = null;
    }
    task.updated_by = caller.id;
    await task.save();

    if (caller.audit) {
        await recordAudit(caller.audit, {
            action: AUDIT_ACTIONS.TASK_MOVE_SPRINT,
            target: { kind: AUDIT_TARGET_KINDS.TASK, id: task._id },
            before,
            after: { id: task._id.toString(), sprint_id: task.sprint_id ? task.sprint_id.toString() : null },
            metadata: { project_id: project._id.toString() },
        });
    }

    if (!objectIdEq(task.sprint_id, prevSprintId)) {
        await recordActivity({
            task_id: task._id,
            actor_id: caller.id,
            activity_type: TASK_ACTIVITY_TYPES.SPRINT_CHANGED,
            from_value: prevSprintId,
            to_value: task.sprint_id,
        });
    }

    return toPublic(task);
};

// ─── POST /tasks/:id/dependencies ────────────────────────────────────────

export const addTaskDependency = async (
    taskId: Types.ObjectId,
    body: AddDependencyBody,
    caller: ProjectCaller
): Promise<Record<string, unknown>> => {
    requireWriter(caller);
    const { task, project } = await loadTaskAndProject(taskId, caller);

    const depId = new Types.ObjectId(body.depends_on_task_id);

    if (depId.equals(task._id)) {
        throw AppError.unprocessable('A task cannot depend on itself', ERROR_CODES.TASK_DEPENDENCY_SELF);
    }

    if (task.depends_on_task_ids.some((d) => d.equals(depId))) {
        throw AppError.conflict('Dependency already exists on this task', ERROR_CODES.TASK_DEPENDENCY_EXISTS);
    }

    if (task.depends_on_task_ids.length >= TASK_DEPENDENCIES_MAX) {
        throw AppError.unprocessable(
            `Cannot add more than ${TASK_DEPENDENCIES_MAX} dependencies to a single task`,
            ERROR_CODES.TASK_DEPENDENCY_EXISTS
        );
    }

    const dep = await Task.findById(depId).select('project_id').lean<{ project_id: Types.ObjectId } | null>();
    if (!dep) {
        throw AppError.notFound('Dependency task not found', ERROR_CODES.TASK_DEPENDENCY_NOT_FOUND);
    }
    if (!dep.project_id.equals(project._id)) {
        throw AppError.unprocessable(
            'Dependency task belongs to a different project',
            ERROR_CODES.TASK_DEPENDENCY_PROJECT_MISMATCH
        );
    }

    if (await wouldCreateCycle(task._id, depId)) {
        throw AppError.unprocessable(
            'Adding this dependency would create a circular reference',
            ERROR_CODES.TASK_DEPENDENCY_CIRCULAR
        );
    }

    task.depends_on_task_ids.push(depId);
    task.updated_by = caller.id;
    await task.save();

    if (caller.audit) {
        await recordAudit(caller.audit, {
            action: AUDIT_ACTIONS.TASK_DEPENDENCY_ADD,
            target: { kind: AUDIT_TARGET_KINDS.TASK, id: task._id },
            metadata: {
                project_id: project._id.toString(),
                depends_on_task_id: depId.toString(),
            },
        });
    }

    await recordActivity({
        task_id: task._id,
        actor_id: caller.id,
        activity_type: TASK_ACTIVITY_TYPES.DEPENDENCY_ADDED,
        to_value: depId,
        metadata: { depends_on_task_id: depId.toString() },
    });

    return toPublic(task);
};

// ─── DELETE /tasks/:id/dependencies/:dep_id ──────────────────────────────

export const removeTaskDependency = async (
    taskId: Types.ObjectId,
    depId: Types.ObjectId,
    caller: ProjectCaller
): Promise<Record<string, unknown>> => {
    requireWriter(caller);
    const { task, project } = await loadTaskAndProject(taskId, caller);

    const before = task.depends_on_task_ids.length;
    task.depends_on_task_ids = task.depends_on_task_ids.filter((d) => !d.equals(depId));
    if (task.depends_on_task_ids.length === before) {
        throw AppError.notFound('Dependency not found on this task', ERROR_CODES.TASK_DEPENDENCY_NOT_FOUND);
    }

    task.updated_by = caller.id;
    await task.save();

    if (caller.audit) {
        await recordAudit(caller.audit, {
            action: AUDIT_ACTIONS.TASK_DEPENDENCY_REMOVE,
            target: { kind: AUDIT_TARGET_KINDS.TASK, id: task._id },
            metadata: {
                project_id: project._id.toString(),
                depends_on_task_id: depId.toString(),
            },
        });
    }

    await recordActivity({
        task_id: task._id,
        actor_id: caller.id,
        activity_type: TASK_ACTIVITY_TYPES.DEPENDENCY_REMOVED,
        from_value: depId,
        metadata: { depends_on_task_id: depId.toString() },
    });

    return toPublic(task);
};
