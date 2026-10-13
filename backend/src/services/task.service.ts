import { Types } from 'mongoose';

import { Task, type TaskDocument } from '../models/task.model.js';
import { coverUrlsForTasks } from './task-attachment.service.js';
import { Story } from '../models/story.model.js';
import { Sprint } from '../models/sprint.model.js';
import { User } from '../models/user.model.js';
import { Project, type ProjectDocument } from '../models/project.model.js';
import { AppError } from '../utils/app-error.js';
import { isAdminLike, isProjectWorkAuthor } from '../utils/role-check.js';
import { ERROR_CODES } from '../constants/error-codes.js';
import { ROLES } from '../constants/roles.js';
import { USER_STATUSES } from '../constants/user-statuses.js';
import {
    DEFAULT_TASK_STATUSES,
    DEFAULT_TASK_STATUS_VALUES,
    TASK_CLIENT_PATCH_FIELDS,
    TASK_REPORT_PRIORITY_VALUES,
    TASK_CREATOR_PATCH_FIELDS,
    TASK_DEPENDENCIES_MAX,
    TASK_EMPLOYEE_PATCH_FIELDS,
    TASK_ISSUE_TYPES,
    TASK_MAX_ASSIGNEES,
    TASK_MAX_SUBTASK_DEPTH,
    TASK_MEMBER_PATCH_FIELDS,
    TASK_PRIORITIES,
    TASK_REPORT_IMPACT_LABEL,
    TASK_REPORT_KINDS,
    TASK_WORK_FIELDS,
} from '../constants/task.js';
import { AUDIT_ACTIONS, AUDIT_TARGET_KINDS } from '../constants/audit.js';
import { DEFAULT_DONE_TASK_STATUS_KEY } from '../constants/story.js';
import { SPRINT_STATUSES } from '../constants/project.js';
import { TASK_ACTIVITY_TYPES } from '../constants/task-activity.js';
import { notifyClientTaskReported, notifyTaskAssigned } from './notification-dispatcher.service.js';
import { recordAudit } from './audit.service.js';
import { recordActivity } from './task-activity.service.js';
import { buildProjectVisibilityFilter, loadProjectForCaller } from './project.service.js';
import type { ProjectCaller } from './project.service.js';
import { sumLoggedTimeForTask } from './timesheet.service.js';
import type { PaginationMeta } from '../utils/api-response.js';
import type {
    AddDependencyBody,
    AssignStoryBody,
    CreateTaskBody,
    ListTasksQuery,
    MoveSprintBody,
    PatchTaskBody,
    RankTaskBody,
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

/** Order-preserving ObjectId de-dupe (first occurrence wins). */
const dedupeObjectIds = (ids: Types.ObjectId[]): Types.ObjectId[] => {
    const seen = new Set<string>();
    const out: Types.ObjectId[] = [];
    for (const id of ids) {
        const key = String(id);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(id);
    }
    return out;
};

/** Is the caller one of the task's assignees? Checks the multi-assignee array
 *  and the (kept-in-sync) primary field so pre-migration rows still resolve. */
const isCallerAssignee = (task: TaskDocument, caller: ProjectCaller): boolean => {
    if (task.assignee_ids.some((id) => id.equals(caller.id))) return true;
    return !!task.primary_assignee_id && task.primary_assignee_id.equals(caller.id);
};

/**
 * A non-creator employee's assignee change (Jira "Assign to me"): they may
 * take the ticket for themselves — even from someone else — but may not hand
 * it to another person, nor unassign it. Reassigning others and clearing the
 * assignee stay with the creator and managers.
 */
const assertSelfAddOnly = (patch: PatchTaskBody, task: TaskDocument, caller: ProjectCaller): void => {
    if (patch.assignee_ids === undefined) return;
    const requested = patch.assignee_ids.map(String);
    const current = new Set(task.assignee_ids.map((id) => String(id)));
    if (task.primary_assignee_id) current.add(String(task.primary_assignee_id));
    const unchanged = requested.length === current.size && requested.every((id) => current.has(id));
    if (unchanged) return;
    if (requested.length === 0) {
        throw AppError.forbidden(
            'Only the task creator or a manager can unassign this ticket.',
            ERROR_CODES.TASK_WRITE_FORBIDDEN
        );
    }
    if (requested.some((id) => id !== String(caller.id))) {
        throw AppError.forbidden('You can assign this ticket only to yourself.', ERROR_CODES.TASK_WRITE_FORBIDDEN);
    }
};

/** Exported for unit tests — a pure guard, worth covering on its own. */
export const assertEmployeePatchScope = (patch: PatchTaskBody, task: TaskDocument, caller: ProjectCaller): void => {
    if (isManagerOrAdmin(caller)) return;
    if (!INTERNAL_ROLES.includes(caller.role)) {
        // Client-side callers reach this route via TASK_REPORT (the route gate
        // is OR). They may amend ONLY a report they filed themselves, and only
        // the fields in TASK_CLIENT_PATCH_FIELDS. Every other task in a project
        // they can see stays read-only to them.
        if (task.source !== 'client' || !task.created_by.equals(caller.id)) {
            throw AppError.forbidden(
                'You can only edit an issue you reported yourself',
                ERROR_CODES.TASK_WRITE_FORBIDDEN
            );
        }
        // Frozen once the team picks it up. While the report still sits at the
        // entry status nobody has acted on it, so a reporter correcting their
        // own wording costs nothing. The moment it moves, someone is working to
        // that description — letting the client rewrite the title or re-rank the
        // priority underneath them changes the job after it started.
        if (task.status !== DEFAULT_TASK_STATUSES.TO_DO) {
            throw AppError.forbidden(
                'This issue is already being worked on — add a comment instead of editing it',
                ERROR_CODES.TASK_WRITE_FORBIDDEN
            );
        }
        const outside = Object.keys(patch).filter((k) => !TASK_CLIENT_PATCH_FIELDS.includes(k));
        if (outside.length > 0) {
            throw AppError.forbidden(
                `You may only update: ${TASK_CLIENT_PATCH_FIELDS.join(', ')}`,
                ERROR_CODES.TASK_WRITE_FORBIDDEN
            );
        }
        // Urgent and critical are the team's call: a reporter stays within what they could report with.
        if (patch.priority !== undefined && !TASK_REPORT_PRIORITY_VALUES.includes(patch.priority as never)) {
            throw AppError.forbidden(
                `A reported issue's priority may be: ${TASK_REPORT_PRIORITY_VALUES.join(', ')}`,
                ERROR_CODES.TASK_WRITE_FORBIDDEN
            );
        }
        return;
    }
    // Fields outside the employee whitelist are never allowed for any employee.
    // The creator gets a wider set — see `TASK_CREATOR_PATCH_FIELDS`.
    const isCreator = task.created_by.equals(caller.id);
    // Employees only reach a task through a project they are a member of, so the planning fields apply to all of them.
    const allowed = [...new Set([...TASK_EMPLOYEE_PATCH_FIELDS, ...TASK_CREATOR_PATCH_FIELDS, ...TASK_MEMBER_PATCH_FIELDS])];
    const offending = Object.keys(patch).filter((k) => !allowed.includes(k));
    if (offending.length > 0) {
        throw AppError.forbidden(
            `You may only update: ${allowed.join(', ')}`,
            ERROR_CODES.TASK_WRITE_FORBIDDEN
        );
    }

    // The CREATOR fully owns the task they made — they can (re)assign anyone.
    if (isCreator) return;

    // Non-creator employee:
    //  - work-field edits (status/description/estimate) require being an assignee;
    //  - an assignee change may only put the caller on it (taking it over).
    const isAssignee = isCallerAssignee(task, caller);
    const editsWorkFields = Object.keys(patch).some((k) => TASK_WORK_FIELDS.includes(k));
    if (editsWorkFields && !isAssignee) {
        throw AppError.forbidden(
            'Employees can only update tasks they created or are assigned to',
            ERROR_CODES.TASK_WRITE_FORBIDDEN
        );
    }
    assertSelfAddOnly(patch, task, caller);
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

/**
 * Completion-timestamp transition for `completed_at`. Returns the value to
 * write, or `undefined` when the done-state didn't change (leave it untouched).
 * Stamped on not-done → done, cleared on done → not-done. `completed_at` is thus
 * a true completion time, unlike `updated_at` which any edit re-dates.
 */
const completedAtOnTransition = (oldStatus: string | null, newStatus: string): Date | null | undefined => {
    const wasDone = oldStatus === DEFAULT_DONE_TASK_STATUS_KEY;
    const isDone = newStatus === DEFAULT_DONE_TASK_STATUS_KEY;
    if (wasDone === isDone) return undefined;
    return isDone ? new Date() : null;
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

/** The sprint must be this project's, and not completed — a closed sprint is
 *  history (Jira refuses moving work into one). */
const assertSprintBelongsToProject = async (sprintId: Types.ObjectId, projectId: Types.ObjectId): Promise<void> => {
    const sprint = await Sprint.findById(sprintId)
        .select('project_id status')
        .lean<{ project_id: Types.ObjectId; status?: string } | null>();
    if (!sprint || !sprint.project_id.equals(projectId)) {
        throw AppError.unprocessable(
            'Sprint does not belong to the task project',
            ERROR_CODES.TASK_SPRINT_PROJECT_MISMATCH
        );
    }
    if (sprint.status === SPRINT_STATUSES.COMPLETED) {
        throw AppError.unprocessable(
            'That sprint is completed — move it to an active or planned sprint, or the backlog.',
            ERROR_CODES.SPRINT_INVALID_TRANSITION
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

// ─── Backlog-rank helpers (Phase 2 Backlog screen) ───────────────────────
//
// `backlog_rank` is a dense integer scoped to `project_id` only — it orders
// the Backlog + every sprint list in one continuous sequence, independent of
// the per-(project,status) `position` used by the Kanban board. These helpers
// mirror `nextPositionInColumn` / `shiftNeighboursInColumn` but drop the
// `status` dimension.

/**
 * Append rank for a new task — one past the current max rank in the project.
 * Pre-backfill rows may lack `backlog_rank`; a missing value sorts as null
 * (lowest) so the desc sort still surfaces the true max, and we fall back to
 * 0 when no ranked row exists yet.
 */
const nextBacklogRank = async (projectId: Types.ObjectId): Promise<number> => {
    const last = await Task.findOne({ project_id: projectId })
        .sort({ backlog_rank: -1 })
        .select('backlog_rank')
        .lean<{ backlog_rank?: number } | null>();
    return last && typeof last.backlog_rank === 'number' ? last.backlog_rank + 1 : 0;
};

/**
 * Shift neighbours in the same project to make room for `task` at
 * `newRankRaw`. Mutates `task.backlog_rank`; caller saves. Mirrors
 * `shiftNeighboursInColumn`, but scoped to `project_id` only (not status).
 */
const shiftBacklogNeighbours = async (task: TaskDocument, newRankRaw: number): Promise<void> => {
    const last = await Task.findOne({ project_id: task.project_id })
        .sort({ backlog_rank: -1 })
        .select('backlog_rank')
        .lean<{ backlog_rank?: number } | null>();
    const maxRank = last && typeof last.backlog_rank === 'number' ? last.backlog_rank : 0;
    const newRank = Math.max(0, Math.min(newRankRaw, maxRank));
    const oldRank = task.backlog_rank;
    if (newRank === oldRank) return;

    if (newRank > oldRank) {
        await Task.updateMany(
            {
                project_id: task.project_id,
                _id: { $ne: task._id },
                backlog_rank: { $gt: oldRank, $lte: newRank },
            },
            { $inc: { backlog_rank: -1 } }
        );
    } else {
        await Task.updateMany(
            {
                project_id: task.project_id,
                _id: { $ne: task._id },
                backlog_rank: { $gte: newRank, $lt: oldRank },
            },
            { $inc: { backlog_rank: 1 } }
        );
    }
    task.backlog_rank = newRank;
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

/** A ticket can't start after it is due (redesign start date). Returns the start date for chaining. */
const assertStartNotAfterDue = (start: string | null, due: string | null): string | null => {
    if (start && due && start > due) {
        throw AppError.unprocessable("The start date can't be after the due date.", ERROR_CODES.VALIDATION_ERROR, {
            errors: [{ field: 'start_date', message: "The start date can't be after the due date." }],
        });
    }
    return start;
};

export const createTask = async (input: CreateTaskBody, caller: ProjectCaller): Promise<Record<string, unknown>> => {
    // Any internal team member (admin/manager/team_lead/employee) may create a
    // task; `loadProjectForCaller` below restricts them to projects they can
    // see (for an employee that means projects they're a member of). Client-side
    // roles are read-only — the route's `task.write` gate already blocks them,
    // but we guard here too so the service is safe on its own.
    if (!INTERNAL_ROLES.includes(caller.role)) {
        throw AppError.forbidden('Only internal team members can create tasks', ERROR_CODES.TASK_WRITE_FORBIDDEN);
    }
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

    // One assignee. Accept `assignee_ids` (new clients) and/or a lone
    // `primary_assignee_id` (older clients); they must name the same person.
    const rawAssignees: Types.ObjectId[] = [];
    if (input.primary_assignee_id) rawAssignees.push(new Types.ObjectId(input.primary_assignee_id));
    for (const id of input.assignee_ids ?? []) rawAssignees.push(new Types.ObjectId(id));
    const assigneeIds = dedupeObjectIds(rawAssignees);
    if (assigneeIds.length > TASK_MAX_ASSIGNEES) {
        throw AppError.badRequest('A ticket has one assignee — add others as contributors.');
    }
    if (assigneeIds.length > 0) await assertActiveInternalUsers(assigneeIds, ERROR_CODES.TASK_INVALID_ASSIGNEE);
    const primaryAssignee = assigneeIds[0] ?? null;

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

    // Backlog ordering — append to the end of the project's continuous rank
    // sequence (spans the backlog + every sprint). Independent of `position`.
    const backlogRank = await nextBacklogRank(projectId);

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
        labels: input.labels ?? [],
        due_date: input.due_date ?? null,
        start_date: assertStartNotAfterDue(input.start_date ?? null, input.due_date ?? null),
        estimated_hours: input.estimated_hours ?? 0,
        assignee_ids: assigneeIds,
        primary_assignee_id: primaryAssignee,
        collaborator_ids: collabIds,
        depends_on_task_ids: depIds,
        position,
        backlog_rank: backlogRank,
        created_by: caller.id,
        updated_by: caller.id,
        // A task created directly in the done column is "completed" now.
        completed_at: status === DEFAULT_DONE_TASK_STATUS_KEY ? new Date() : null,
    });

    if (caller.audit) {
        await recordAudit(caller.audit, {
            action: AUDIT_ACTIONS.TASK_CREATE,
            target: { kind: AUDIT_TARGET_KINDS.TASK, id: created._id },
            after: toPublic(created),
            metadata: { project_id: projectId.toString() },
        });
    }

    // Fire-and-forget: assignment notifications must never fail the write.
    void notifyTaskAssigned({
        task_id: created._id,
        task_title: created.title,
        actor_id: caller.id,
        assignee_ids: assigneeIds,
    });

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

// ─── GET /projects/:id/task-labels (label suggestions) ───────────────────
//
// Distinct labels across every task in the project, sorted alpha — powers the
// autocomplete in the task create/edit label input and the board's label
// filter. Visibility is enforced via `loadProjectForCaller` (404 → 403 for a
// project the caller can't see), same as every other project-scoped read.

export const listProjectTaskLabels = async (projectId: Types.ObjectId, caller: ProjectCaller): Promise<string[]> => {
    await loadProjectForCaller(projectId, caller);
    const labels = await Task.distinct('labels', { project_id: projectId });
    return (labels as unknown[])
        .filter((l): l is string => typeof l === 'string' && l.length > 0)
        .sort((a, b) => a.localeCompare(b));
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
    // "My tasks" — match any task where the caller is ONE OF the assignees
    // (multi-assignee). `assignee_ids` carries the primary too (kept in sync).
    //
    // `null` selects the UNASSIGNED queue. Tested on `primary_assignee_id`
    // rather than `assignee_ids: { $size: 0 }`: the two are equivalent (the
    // service keeps primary = assignee_ids[0]), but `$size` cannot use an
    // index, and there is a `{primary_assignee_id, status}` index right here.
    if (query.assignee_id !== undefined) {
        if (query.assignee_id === 'null') filter.primary_assignee_id = null;
        else filter.assignee_ids = new Types.ObjectId(query.assignee_id);
    }
    if (query.status) filter.status = query.status;
    if (query.priority) filter.priority = query.priority;
    if (query.source) filter.source = query.source;
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

    let covers: Map<string, string> | null = null;
    if (query.include_cover) {
        covers = await coverUrlsForTasks(rows.map((r) => r._id));
    }

    return {
        data: rows.map((r) =>
            covers ? { ...toPublic(r), cover_url: covers.get(r._id.toString()) ?? null } : toPublic(r)
        ),
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
    // Actual time spent, rolled up from every timesheet entry on this task
    // (all users) — powers the Estimate popover on the detail page.
    // The reporter's display name rides along so callers without `user.read`
    // (clients) can still show who raised it — name only, nothing else.
    const [time_tracking, reporterDoc] = await Promise.all([
        sumLoggedTimeForTask(task._id),
        User.findById(task.created_by).select('full_name').lean<{ full_name: string } | null>(),
    ]);
    return {
        ...toPublic(task),
        time_tracking,
        reporter: { id: task.created_by.toString(), full_name: reporterDoc?.full_name ?? null },
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
        title: task.title,
        status: task.status,
        priority: task.priority,
        issue_type: task.issue_type,
        story_points: task.story_points,
        labels: [...task.labels],
        due_date: task.due_date,
        estimated_hours: task.estimated_hours,
        is_flagged: task.is_flagged,
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
    if (patch.labels !== undefined) task.labels = patch.labels;
    if (patch.due_date !== undefined) task.due_date = patch.due_date;
    if (patch.start_date !== undefined) task.start_date = patch.start_date;
    // Checked on the merged ticket: a patch may carry only one of the two dates.
    if (patch.start_date !== undefined || patch.due_date !== undefined) assertStartNotAfterDue(task.start_date ?? null, task.due_date ?? null);
    if (patch.estimated_hours !== undefined) task.estimated_hours = patch.estimated_hours;
    if (patch.is_flagged !== undefined) task.is_flagged = patch.is_flagged;

    if (patch.sprint_id !== undefined) {
        const sid = patch.sprint_id ? new Types.ObjectId(patch.sprint_id) : null;
        if (sid && !objectIdEq(sid, task.sprint_id)) await assertSprintBelongsToProject(sid, project._id);
        task.sprint_id = sid;
    }

    if (patch.story_id !== undefined) {
        const sid = patch.story_id ? new Types.ObjectId(patch.story_id) : null;
        if (sid) await assertStoryBelongsToProject(sid, project._id);
        task.story_id = sid;
    }

    // Assignment. `assignee_ids` is authoritative (new clients); a lone
    // `primary_assignee_id` is honoured for back-compat. Either way we keep
    // `primary_assignee_id = assignee_ids[0]` so single-assignee reads still work.
    // Diff against the roster BEFORE the patch so only genuinely-new
    // assignees are notified — re-saving a task with an unchanged roster
    // must not re-ping everyone on it.
    const assigneesBefore = new Set(task.assignee_ids.map((id) => String(id)));
    let addedAssignees: Types.ObjectId[] = [];
    if (patch.assignee_ids !== undefined) {
        const ids = dedupeObjectIds(patch.assignee_ids.map((id) => new Types.ObjectId(id)));
        if (ids.length > 0) await assertActiveInternalUsers(ids, ERROR_CODES.TASK_INVALID_ASSIGNEE);
        addedAssignees = ids.filter((id) => !assigneesBefore.has(String(id)));
        task.assignee_ids = ids;
        task.primary_assignee_id = ids[0] ?? null;
    } else if (patch.primary_assignee_id !== undefined) {
        const aid = patch.primary_assignee_id ? new Types.ObjectId(patch.primary_assignee_id) : null;
        if (aid) await assertActiveInternalUsers([aid], ERROR_CODES.TASK_INVALID_ASSIGNEE);
        addedAssignees = aid && !assigneesBefore.has(String(aid)) ? [aid] : [];
        task.primary_assignee_id = aid;
        task.assignee_ids = aid ? [aid] : [];
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
        const completedAt = completedAtOnTransition(prev.status, patch.status);
        task.status = patch.status;
        task.position = await nextPositionInColumn(task.project_id, patch.status);
        if (completedAt !== undefined) task.completed_at = completedAt;
        statusChanged = true;
    }

    // Position change within current column — only meaningful if status
    // didn't already move us to the end.
    if (!statusChanged && patch.position !== undefined && patch.position !== task.position) {
        await shiftNeighboursInColumn(task, patch.position);
    }

    task.updated_by = caller.id;
    await task.save();
    if (!objectIdEq(task.story_id, prev.story_id)) await cascadeEpicToSubtasks(task, caller.id);
    if (!objectIdEq(task.sprint_id, prev.sprint_id)) await cascadeSprintToSubtasks(task, caller.id);

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

    // Fire-and-forget, after the write has committed — only the assignees
    // this patch actually added.
    if (addedAssignees.length > 0) {
        void notifyTaskAssigned({
            task_id: task._id,
            task_title: task.title,
            actor_id: caller.id,
            assignee_ids: addedAssignees,
        });
    }

    return toPublic(task);
};

/**
 * Diff `task` against the pre-mutation snapshot and write one activity
 * row per changed field. Best-effort — recordActivity swallows errors.
 */
const emitPatchActivities = async (
    task: TaskDocument,
    prev: {
        title: string;
        status: string;
        priority: string;
        issue_type: string;
        story_points: number | null;
        labels: string[];
        due_date: string | null;
        estimated_hours: number;
        is_flagged: boolean;
        sprint_id: Types.ObjectId | null;
        story_id: Types.ObjectId | null;
        primary_assignee_id: Types.ObjectId | null;
        collaborator_ids: string[];
    },
    actorId: Types.ObjectId
): Promise<void> => {
    if (task.title !== prev.title) {
        await recordActivity({
            task_id: task._id,
            actor_id: actorId,
            activity_type: TASK_ACTIVITY_TYPES.TITLE_CHANGED,
            from_value: prev.title,
            to_value: task.title,
        });
    }
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
    // Labels — compare as case-insensitive SETS so a reorder or a case-only
    // rewrite of the same tags is treated as a no-op (no activity row). The
    // validator already deduped case-insensitively, but the incoming spelling
    // may differ from what's stored.
    if (!labelSetsEqual(task.labels, prev.labels)) {
        await recordActivity({
            task_id: task._id,
            actor_id: actorId,
            activity_type: TASK_ACTIVITY_TYPES.LABELS_CHANGED,
            from_value: prev.labels,
            to_value: [...task.labels],
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
    if (task.is_flagged !== prev.is_flagged) {
        await recordActivity({
            task_id: task._id,
            actor_id: actorId,
            activity_type: task.is_flagged ? TASK_ACTIVITY_TYPES.FLAG_ADDED : TASK_ACTIVITY_TYPES.FLAG_REMOVED,
            from_value: prev.is_flagged,
            to_value: task.is_flagged,
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

/**
 * Compare two label lists as case-insensitive sets — order-independent, so a
 * pure reorder isn't a "change", and case-insensitive, matching the validator's
 * dedupe semantics.
 */
const labelSetsEqual = (a: string[], b: string[]): boolean => {
    if (a.length !== b.length) return false;
    const setA = new Set(a.map((s) => s.toLowerCase()));
    for (const label of b) if (!setA.has(label.toLowerCase())) return false;
    return true;
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

    const isAssignee = isCallerAssignee(task, caller);
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
        const completedAt = completedAtOnTransition(oldStatus, body.status);
        task.status = body.status;
        task.position = await nextPositionInColumn(task.project_id, body.status);
        if (completedAt !== undefined) task.completed_at = completedAt;
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

// ─── POST /tasks/:id/rank ────────────────────────────────────────────────
//
// Phase 2 Backlog — reorder a task within the per-project `backlog_rank`
// ordering (the Backlog/sprint lists). The body names the neighbour to land
// after/before; both omitted ⇒ move to the top. Same writer rule as reorder
// — admin/manager/team_lead OR the task's assignee — so a person can rank
// their own work without a manager round-trip.

export const rankTask = async (
    taskId: Types.ObjectId,
    body: RankTaskBody,
    caller: ProjectCaller
): Promise<Record<string, unknown>> => {
    const { task, project } = await loadTaskAndProject(taskId, caller);

    const isAssignee = isCallerAssignee(task, caller);
    if (!isManagerOrAdmin(caller) && !isAssignee) {
        throw AppError.forbidden(
            'Only admins, managers, or the task assignee can rank this task',
            ERROR_CODES.TASK_WRITE_FORBIDDEN
        );
    }

    const prevRank = task.backlog_rank;

    // Resolve the target rank from the neighbour. Because ranks are dense and
    // the moved task occupies one of them, the target index depends on the
    // direction of travel (classic off-by-one when moving down past a gap the
    // task itself will vacate).
    let targetRank: number;
    if (body.before_task_id || body.after_task_id) {
        const neighbourId = new Types.ObjectId((body.before_task_id ?? body.after_task_id) as string);
        const neighbour = await Task.findOne({ _id: neighbourId, project_id: task.project_id })
            .select('backlog_rank')
            .lean<{ backlog_rank?: number } | null>();
        if (!neighbour || typeof neighbour.backlog_rank !== 'number') {
            throw AppError.unprocessable(
                'The neighbour task was not found in this project.',
                ERROR_CODES.TASK_NOT_FOUND
            );
        }
        const movingDown = task.backlog_rank < neighbour.backlog_rank;
        if (body.before_task_id) {
            targetRank = movingDown ? neighbour.backlog_rank - 1 : neighbour.backlog_rank;
        } else {
            targetRank = movingDown ? neighbour.backlog_rank : neighbour.backlog_rank + 1;
        }
    } else {
        // Neither neighbour supplied → move to the top of the project order.
        targetRank = 0;
    }

    await shiftBacklogNeighbours(task, targetRank);
    task.updated_by = caller.id;
    await task.save();

    if (caller.audit) {
        await recordAudit(caller.audit, {
            action: AUDIT_ACTIONS.TASK_RANK,
            target: { kind: AUDIT_TARGET_KINDS.TASK, id: task._id },
            before: { id: task._id.toString(), backlog_rank: prevRank },
            after: { id: task._id.toString(), backlog_rank: task.backlog_rank },
            metadata: { project_id: project._id.toString() },
        });
    }

    if (task.backlog_rank !== prevRank) {
        await recordActivity({
            task_id: task._id,
            actor_id: caller.id,
            activity_type: TASK_ACTIVITY_TYPES.RANK_CHANGED,
            from_value: prevRank,
            to_value: task.backlog_rank,
        });
    }

    return toPublic(task);
};

// ─── POST /tasks/:id/assign-story ────────────────────────────────────────
//
// Per API_Contract §8.2a: changing story membership is a STORY-write
// operation, so non-admin/manager callers receive STORY_WRITE_FORBIDDEN
// (not TASK_WRITE_FORBIDDEN).

/**
 * Subtasks share their parent's epic (as in Jira): when a parent's epic
 * changes, its subtasks follow. Without this a subtask kept the epic it was
 * created with, so the board showed parent and child under different epics.
 * A subtask's own epic change doesn't cascade (subtasks have no children).
 */
const cascadeEpicToSubtasks = async (task: TaskDocument, callerId: Types.ObjectId): Promise<void> => {
    if (task.parent_task_id) return;
    await Task.updateMany({ parent_task_id: task._id }, { $set: { story_id: task.story_id, updated_by: callerId } });
};

/** Same for sprints: a parent moved into a sprint (or the backlog) takes its subtasks with it. */
const cascadeSprintToSubtasks = async (task: TaskDocument, callerId: Types.ObjectId): Promise<void> => {
    if (task.parent_task_id) return;
    await Task.updateMany({ parent_task_id: task._id }, { $set: { sprint_id: task.sprint_id, updated_by: callerId } });
};

export const assignTaskStory = async (
    taskId: Types.ObjectId,
    body: AssignStoryBody,
    caller: ProjectCaller
): Promise<Record<string, unknown>> => {
    if (!isManagerOrAdmin(caller) && !isProjectWorkAuthor(caller)) {
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
    if (!objectIdEq(task.story_id, prevStoryId)) await cascadeEpicToSubtasks(task, caller.id);

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
    // Redesign: planning a project's sprints is open to its members (see TASK_MEMBER_PATCH_FIELDS).
    if (!isProjectWorkAuthor(caller)) requireWriter(caller);
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
    if (!objectIdEq(task.sprint_id, prevSprintId)) await cascadeSprintToSubtasks(task, caller.id);

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

// ─── Client-side issue reporting ──────────────────────────────────────────

/**
 * Roles allowed to file a report. Deliberately the client side only: the
 * `source: 'client'` marker this writes must be TRUE, and an internal user
 * filing through here would make it a lie. Internal staff already have the
 * full `createTask`.
 */
const REPORTER_ROLES: readonly string[] = [ROLES.CLIENT, ROLES.REPRESENTATIVE];

/**
 * Raise an issue on a project the caller can already see.
 *
 * This is NOT `createTask` with a different gate. A client controls exactly
 * three things — title, description and a suggested priority — and the server
 * decides everything else:
 *
 *   sprint_id  = null   → lands in the BACKLOG, never straight onto the board.
 *                         A client report must not silently insert itself into
 *                         the team's committed sprint scope; triage decides.
 *   story_id   = null   → not attached to an epic by an outsider.
 *   assignees  = []     → a client does not pick who works on it.
 *   status     = to_do  → the project's entry status.
 *   issue_type = bug    → this surface is the bug-report form.
 *   source     = client → survives every later status/priority change, so
 *                         "what did the client raise" stays answerable.
 *
 * `due_date` = null → meaningless on an unread report; triage dates it.
 */
export const createTaskReport = async (
    input: { project_id: string; title: string; description?: string; priority?: string; kind?: string },
    caller: ProjectCaller
): Promise<Record<string, unknown>> => {
    if (!REPORTER_ROLES.includes(caller.role)) {
        throw AppError.forbidden('Only client-side users can file a report', ERROR_CODES.TASK_WRITE_FORBIDDEN);
    }
    const isFeature = input.kind === TASK_REPORT_KINDS.FEATURE;
    const stated = input.priority ?? TASK_PRIORITIES.MEDIUM;
    // A FEATURE request carries no client-chosen priority. The customer is
    // asked how much it would help — which is worth knowing — but that answer
    // is theirs about impact, not a scheduling decision, and letting it land on
    // `task.priority` would put an outsider's ranking into the queue the team
    // plans from. It goes in the description instead (see
    // TASK_REPORT_IMPACT_NOTE), and the team sets the real priority at triage.
    //
    // Issue reports still honour the suggestion: for a defect, Low / Medium /
    // High is the same scale the team uses, and the route comment has always
    // called it a suggestion the team may override.
    const priority = isFeature ? TASK_PRIORITIES.MEDIUM : stated;
    // The client's answer becomes a LABEL, not a priority and not a line in
    // their own description: labels are what a developer sees on the board card
    // and the task row, which is where the triage decision actually gets made.
    const impactLabel = isFeature ? TASK_REPORT_IMPACT_LABEL[stated] : undefined;

    const projectId = new Types.ObjectId(input.project_id);
    // The whole access decision. A `client` reaches every project of their
    // company; a `representative` only the ones they're rostered on. Neither
    // can name a project id they cannot already open.
    const project = await loadProjectForCaller(projectId, caller);

    const status = DEFAULT_TASK_STATUSES.TO_DO;
    assertValidStatus(status, project);

    const position = await nextPositionInColumn(projectId, status);
    const backlogRank = await nextBacklogRank(projectId);

    // Same atomic reservation as `createTask` — concurrent reports get
    // distinct issue keys without a transaction.
    const counter = await Project.findOneAndUpdate(
        { _id: projectId },
        { $inc: { task_seq: 1 } },
        { new: true, projection: { task_seq: 1 } }
    ).lean<{ task_seq: number } | null>();
    if (!counter) {
        throw AppError.notFound('Project not found', ERROR_CODES.PROJECT_NOT_FOUND);
    }

    const created = await Task.create({
        project_id: projectId,
        task_number: counter.task_seq,
        sprint_id: null,
        story_id: null,
        parent_task_id: null,
        title: input.title,
        description: input.description ?? '',
        status,
        priority,
        issue_type: isFeature ? TASK_ISSUE_TYPES.IMPROVEMENT : TASK_ISSUE_TYPES.BUG,
        story_points: null,
        labels: impactLabel ? [impactLabel] : [],
        // Nobody has triaged it yet, so it has no due date.
        due_date: null,
        estimated_hours: 0,
        assignee_ids: [],
        primary_assignee_id: null,
        collaborator_ids: [],
        depends_on_task_ids: [],
        position,
        backlog_rank: backlogRank,
        source: 'client',
        created_by: caller.id,
        updated_by: caller.id,
        completed_at: null,
    });

    if (caller.audit) {
        await recordAudit(caller.audit, {
            action: AUDIT_ACTIONS.TASK_CREATE,
            target: { kind: AUDIT_TARGET_KINDS.TASK, id: created._id },
            after: toPublic(created),
            metadata: { project_id: projectId.toString(), source: 'client', kind: input.kind ?? 'issue' },
        });
    }

    void recordActivity({
        task_id: created._id,
        actor_id: caller.id,
        activity_type: TASK_ACTIVITY_TYPES.CREATED,
    });

    // Fire-and-forget, like every other dispatch: a notification failure must
    // never fail the report itself. This matters more here than elsewhere
    // though — the report has no assignee by design, so this fan-out is the
    // ONLY signal the team gets. If it silently fails the issue sits unseen.
    void notifyClientTaskReported({
        task_id: created._id,
        task_title: created.title,
        project_id: projectId,
        project_name: (project as { name?: string }).name ?? 'a project',
        actor_id: caller.id,
        is_feature: isFeature,
    }).catch(() => undefined); // the dispatcher self-catches; this makes the
    // guarantee hold even if that ever stops being true.

    return toPublic(created);
};
