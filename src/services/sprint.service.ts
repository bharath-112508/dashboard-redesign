import { Types } from 'mongoose';

import { Sprint, type SprintDocument } from '../models/sprint.model.js';
import { Project, type ProjectDocument } from '../models/project.model.js';
import { Task } from '../models/task.model.js';
import { AppError } from '../utils/app-error.js';
import { ERROR_CODES } from '../constants/error-codes.js';
import { ROLES, type RoleType } from '../constants/roles.js';
import { isAdminLike, isProjectAuthor } from '../utils/role-check.js';
import { SPRINT_PICKER_MAX, SPRINT_STATUSES, type SprintStatus } from '../constants/project.js';
import { DEFAULT_TASK_STATUSES } from '../constants/task.js';
import { AUDIT_ACTIONS, AUDIT_TARGET_KINDS } from '../constants/audit.js';
import { withTransaction } from '../utils/with-transaction.js';
import { recordAudit } from './audit.service.js';
import { buildProjectVisibilityFilter, loadProjectForCaller } from './project.service.js';
import type { ProjectCaller } from './project.service.js';
import type { PaginationMeta } from '../utils/api-response.js';
import type {
    CompleteSprintBody,
    CreateSprintBody,
    ListSprintsQuery,
    PatchSprintBody,
} from '../validators/sprint.validator.js';

/**
 * Sprint service — Data_Model.md §5.2 / API_Contract.md §7.3.
 *
 *  - Reads are scoped via `loadProjectForCaller` from the project service so
 *    we don't duplicate the visibility rule.
 *  - The schema enforces `start_date <= end_date` for create/patch via the
 *    validator's `.refine`. The service additionally enforces "sprint window
 *    must lie within the parent project's window" — but only when the
 *    project has an `end_date` set. Open-ended projects (`end_date = null`)
 *    allow sprints to extend arbitrarily.
 */

const toPublic = (doc: SprintDocument): Record<string, unknown> => doc.toJSON() as Record<string, unknown>;

const assertWithinProjectWindow = (project: ProjectDocument, start: string, end: string): void => {
    if (start < project.start_date) {
        throw AppError.unprocessable(
            'Sprint start_date is before the project start_date',
            ERROR_CODES.SPRINT_DATE_INVALID,
            { project_start_date: project.start_date, sprint_start_date: start }
        );
    }
    if (project.end_date !== null && end > project.end_date) {
        throw AppError.unprocessable("The sprint can't end after the project ends.", ERROR_CODES.SPRINT_DATE_INVALID, {
            project_end_date: project.end_date,
            sprint_end_date: end,
        });
    }
};

// ─── POST /projects/:project_id/sprints ──────────────────────────────────

export const createSprint = async (
    projectId: Types.ObjectId,
    input: CreateSprintBody,
    caller: ProjectCaller
): Promise<Record<string, unknown>> => {
    const project = await loadProjectForCaller(projectId, caller);
    assertWithinProjectWindow(project, input.start_date, input.end_date);

    const created = await Sprint.create({
        project_id: project._id,
        name: input.name,
        goal: input.goal,
        start_date: input.start_date,
        end_date: input.end_date,
        status: input.status,
        created_by: caller.id,
    });

    if (caller.audit) {
        await recordAudit(caller.audit, {
            action: AUDIT_ACTIONS.SPRINT_CREATE,
            target: { kind: AUDIT_TARGET_KINDS.SPRINT, id: created._id },
            after: toPublic(created),
            metadata: { project_id: project._id.toString() },
        });
    }

    return toPublic(created);
};

// ─── GET /projects/:project_id/sprints ───────────────────────────────────

export const listSprints = async (
    projectId: Types.ObjectId,
    query: ListSprintsQuery,
    caller: ProjectCaller
): Promise<{ data: Record<string, unknown>[]; meta: PaginationMeta }> => {
    const project = await loadProjectForCaller(projectId, caller);

    const filter: Record<string, unknown> = { project_id: project._id };
    if (query.status) filter.status = query.status;
    // F1 — archived sprints are excluded from the default list view.
    // When the caller wants the archive UI bucket, they pass
    // `?is_archived=true` explicitly. When they want a mixed view
    // (e.g. analytics) they pass `?is_archived=false` for symmetry —
    // omitting the param keeps the default-active contract.
    if (query.is_archived === undefined) {
        filter.is_archived = false;
    } else {
        filter.is_archived = query.is_archived;
    }

    const skip = (query.page - 1) * query.limit;
    const [rows, total] = await Promise.all([
        Sprint.find(filter).sort({ start_date: -1 }).skip(skip).limit(query.limit),
        Sprint.countDocuments(filter),
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

// ─── GET /sprints/:id ────────────────────────────────────────────────────

const loadSprintAndProject = async (
    sprintId: Types.ObjectId,
    caller: { id: Types.ObjectId; role: RoleType }
): Promise<{ sprint: SprintDocument; project: ProjectDocument }> => {
    const sprint = await Sprint.findById(sprintId);
    if (!sprint) throw AppError.notFound('Sprint not found', ERROR_CODES.SPRINT_NOT_FOUND);
    const project = await loadProjectForCaller(sprint.project_id, caller);
    return { sprint, project };
};

/**
 * Cross-project sprint listing — the option list for the `/tasks` sprint
 * filter, which spans every project the caller can see.
 *
 * `listSprints` above is project-scoped and takes a `projectId`; there was no
 * way to ask "every sprint I can see" without one request per project, which
 * is an N+1 the task page would pay on every load.
 *
 * Read scope mirrors `listTasks` EXACTLY — admin/manager see all, everyone
 * else is narrowed to the projects `buildProjectVisibilityFilter` returns. If
 * these two ever disagree, the filter would offer a sprint whose tasks the
 * caller cannot list, and the picker would silently return nothing.
 *
 * Archived sprints are excluded: this feeds a filter for current work, and a
 * closed-out sprint is noise in that list.
 */
export const listAllSprints = async (caller: ProjectCaller): Promise<Record<string, unknown>[]> => {
    const filter: Record<string, unknown> = { is_archived: false };

    const seesAllProjects = isAdminLike(caller) || caller.role === ROLES.MANAGER;
    if (!seesAllProjects) {
        const visible = buildProjectVisibilityFilter(caller);
        const ids = await Project.find(visible).select('_id').limit(1_000).lean<{ _id: Types.ObjectId }[]>();
        filter.project_id = { $in: ids.map((p) => p._id) };
    }

    // Capped rather than paginated: this is a dropdown, not a browsable list.
    // Newest first so the sprints in flight sit at the top.
    const rows = await Sprint.find(filter).sort({ start_date: -1 }).limit(SPRINT_PICKER_MAX);
    return rows.map(toPublic);
};

export const getSprint = async (sprintId: Types.ObjectId, caller: ProjectCaller): Promise<Record<string, unknown>> => {
    const { sprint } = await loadSprintAndProject(sprintId, caller);
    return toPublic(sprint);
};

// ─── PATCH /sprints/:id ──────────────────────────────────────────────────

export const updateSprint = async (
    sprintId: Types.ObjectId,
    patch: PatchSprintBody,
    caller: ProjectCaller
): Promise<Record<string, unknown>> => {
    // Defence-in-depth — route already enforces `requirePermission(SPRINT_WRITE)`.
    // H2 — Team Lead holds `sprint.write` per the Step-47 role bundle, so the
    // service-layer check must accept Admin / Manager / Team Lead. Pre-H2 the
    // gate compared role-string against admin/manager only, contradicting the
    // bundle and 403'ing Team Leads who'd already passed the route gate.
    if (!isProjectAuthor(caller)) {
        throw AppError.forbidden();
    }

    const { sprint, project } = await loadSprintAndProject(sprintId, caller);

    const before = toPublic(sprint);
    const prevStatus = sprint.status;

    if (patch.name !== undefined) sprint.name = patch.name;
    if (patch.goal !== undefined) sprint.goal = patch.goal;
    if (patch.start_date !== undefined) sprint.start_date = patch.start_date;
    if (patch.end_date !== undefined) sprint.end_date = patch.end_date;
    if (patch.status !== undefined) {
        sprint.status = patch.status as SprintStatus;
        // Keep `completed_at` in lock-step with the status: stamp it when the
        // sprint first enters `completed`, clear it if it's moved back out.
        if (sprint.status === SPRINT_STATUSES.COMPLETED && prevStatus !== SPRINT_STATUSES.COMPLETED) {
            sprint.completed_at = new Date();
        } else if (sprint.status !== SPRINT_STATUSES.COMPLETED && prevStatus === SPRINT_STATUSES.COMPLETED) {
            sprint.completed_at = null;
        }
    }

    if (sprint.end_date < sprint.start_date) {
        throw AppError.unprocessable("The end date can't be before the start date.", ERROR_CODES.SPRINT_DATE_INVALID);
    }
    assertWithinProjectWindow(project, sprint.start_date, sprint.end_date);

    await sprint.save();

    if (caller.audit) {
        await recordAudit(caller.audit, {
            action: AUDIT_ACTIONS.SPRINT_UPDATE,
            target: { kind: AUDIT_TARGET_KINDS.SPRINT, id: sprint._id },
            before,
            after: toPublic(sprint),
            metadata: { project_id: project._id.toString() },
        });
    }

    return toPublic(sprint);
};

// ─── DELETE /sprints/:id ─────────────────────────────────────────────────
//
// Refuse the delete if any tasks reference this sprint (BACKEND_AUDIT.md
// R3). The "move to backlog" alternative — null out `sprint_id` on every
// task — is a deliberate user action via PATCH /tasks/:id and shouldn't
// be a side effect of a sprint delete: a manager who deletes a sprint
// rarely wants the work disappeared from any sprint at all.
//
// T11 escape hatch: an ARCHIVED sprint (`is_archived: true`) is allowed
// to delete even with lingering tasks. The archive flag is the operator's
// explicit acknowledgement of "this sprint is decommissioned; delete the
// row even though tasks may still reference it" — exactly the workflow
// R3 was missing.

export const deleteSprint = async (sprintId: Types.ObjectId, caller: ProjectCaller): Promise<void> => {
    // H2 — Team Lead holds `sprint.write`; see updateSprint comment.
    if (!isProjectAuthor(caller)) {
        throw AppError.forbidden();
    }

    const { sprint, project } = await loadSprintAndProject(sprintId, caller);

    if (!sprint.is_archived) {
        const taskCount = await Task.countDocuments({ sprint_id: sprintId });
        if (taskCount > 0) {
            throw AppError.conflict(
                'Sprint has tasks; archive it first (POST /sprints/:id/archive) or PATCH each task to a different sprint before deleting.',
                ERROR_CODES.RESOURCE_HAS_DEPENDENTS,
                { tasks: taskCount }
            );
        }
    }

    const before = toPublic(sprint);

    await sprint.deleteOne();

    if (caller.audit) {
        await recordAudit(caller.audit, {
            action: AUDIT_ACTIONS.SPRINT_DELETE,
            target: { kind: AUDIT_TARGET_KINDS.SPRINT, id: sprint._id },
            before,
            metadata: { project_id: project._id.toString() },
        });
    }
};

// ─── POST /sprints/:id/archive (T11) ─────────────────────────────────────
//
// Flip `is_archived: true` on the sprint. Idempotent — calling on an
// already-archived sprint is a no-op success. After archive, the
// `R3` dependant-refusal in `deleteSprint` is bypassed: an archived
// sprint can be deleted even with lingering tasks.

export const archiveSprint = async (
    sprintId: Types.ObjectId,
    caller: ProjectCaller
): Promise<Record<string, unknown>> => {
    // H2 — Team Lead holds `sprint.write`; see updateSprint comment.
    if (!isProjectAuthor(caller)) {
        throw AppError.forbidden();
    }

    const { sprint, project } = await loadSprintAndProject(sprintId, caller);

    if (sprint.is_archived) {
        return toPublic(sprint);
    }

    const before = { is_archived: sprint.is_archived };
    sprint.is_archived = true;
    await sprint.save();

    if (caller.audit) {
        await recordAudit(caller.audit, {
            action: AUDIT_ACTIONS.SPRINT_ARCHIVE,
            target: { kind: AUDIT_TARGET_KINDS.SPRINT, id: sprint._id },
            before,
            after: { is_archived: sprint.is_archived },
            metadata: { project_id: project._id.toString() },
        });
    }

    return toPublic(sprint);
};

export const unarchiveSprint = async (
    sprintId: Types.ObjectId,
    caller: ProjectCaller
): Promise<Record<string, unknown>> => {
    // H2 — Team Lead holds `sprint.write`; see updateSprint comment.
    if (!isProjectAuthor(caller)) {
        throw AppError.forbidden();
    }

    const { sprint, project } = await loadSprintAndProject(sprintId, caller);

    if (!sprint.is_archived) {
        return toPublic(sprint);
    }

    const before = { is_archived: sprint.is_archived };
    sprint.is_archived = false;
    await sprint.save();

    if (caller.audit) {
        await recordAudit(caller.audit, {
            action: AUDIT_ACTIONS.SPRINT_UNARCHIVE,
            target: { kind: AUDIT_TARGET_KINDS.SPRINT, id: sprint._id },
            before,
            after: { is_archived: sprint.is_archived },
            metadata: { project_id: project._id.toString() },
        });
    }

    return toPublic(sprint);
};

// ─── POST /sprints/:id/start (Phase 2 Backlog) ───────────────────────────
//
// Move a sprint planned → active. Enforces the **single-active** rule: a
// project may have at most one active sprint at a time. Only a `planned`
// sprint can be started — completing a cancelled/completed sprint is a
// separate concern the schema deliberately leaves open, but the Backlog
// lifecycle buttons drive the strict planned → active → completed path.

export const startSprint = async (
    sprintId: Types.ObjectId,
    caller: ProjectCaller
): Promise<Record<string, unknown>> => {
    // H2 — Team Lead holds `sprint.write`; defence-in-depth behind the route.
    if (!isProjectAuthor(caller)) {
        throw AppError.forbidden();
    }

    const { sprint, project } = await loadSprintAndProject(sprintId, caller);

    if (sprint.status !== SPRINT_STATUSES.PLANNED) {
        throw AppError.unprocessable('Only a planned sprint can be started.', ERROR_CODES.SPRINT_INVALID_TRANSITION, {
            status: sprint.status,
        });
    }

    // Single-active rule — another active sprint in the same project blocks
    // the start (the FE disables the button, the service is the enforcer).
    const activeExists = await Sprint.findOne({
        project_id: sprint.project_id,
        status: SPRINT_STATUSES.ACTIVE,
        _id: { $ne: sprint._id },
    })
        .select('_id')
        .lean<{ _id: Types.ObjectId } | null>();
    if (activeExists) {
        throw AppError.conflict(
            'Another sprint in this project is already active. Complete it before starting a new one.',
            ERROR_CODES.SPRINT_ALREADY_ACTIVE,
            { active_sprint_id: activeExists._id.toString() }
        );
    }

    const before = { status: sprint.status };
    sprint.status = SPRINT_STATUSES.ACTIVE;
    await sprint.save();

    if (caller.audit) {
        await recordAudit(caller.audit, {
            action: AUDIT_ACTIONS.SPRINT_START,
            target: { kind: AUDIT_TARGET_KINDS.SPRINT, id: sprint._id },
            before,
            after: { status: sprint.status },
            metadata: { project_id: project._id.toString() },
        });
    }

    return toPublic(sprint);
};

// ─── POST /sprints/:id/complete (Phase 2 Backlog) ────────────────────────
//
// Move a sprint active → completed and relocate its **unfinished** tasks —
// anything whose status is NOT in the project's terminal set (default `done`
// plus any custom status flagged `is_terminal`). Finished tasks stay on the
// completed sprint (the historical record); unfinished ones move to the
// backlog (`sprint_id = null`) or to a target planned/active sprint. The
// status flip + task moves ride one transaction so a mid-move failure can't
// leave the sprint completed with tasks half-relocated.

export const completeSprint = async (
    sprintId: Types.ObjectId,
    body: CompleteSprintBody,
    caller: ProjectCaller
): Promise<{ sprint: Record<string, unknown>; moved_task_count: number }> => {
    // H2 — Team Lead holds `sprint.write`; defence-in-depth behind the route.
    if (!isProjectAuthor(caller)) {
        throw AppError.forbidden();
    }

    const { sprint, project } = await loadSprintAndProject(sprintId, caller);

    if (sprint.status !== SPRINT_STATUSES.ACTIVE) {
        throw AppError.unprocessable('Only an active sprint can be completed.', ERROR_CODES.SPRINT_INVALID_TRANSITION, {
            status: sprint.status,
        });
    }

    // Resolve the move target — backlog (null) or a validated planned/active
    // sprint in the SAME project.
    let targetSprintId: Types.ObjectId | null;
    if (body.move_unfinished_to === 'backlog') {
        targetSprintId = null;
    } else {
        const targetId = new Types.ObjectId(body.move_unfinished_to);
        if (targetId.equals(sprint._id)) {
            throw AppError.unprocessable(
                'Cannot move unfinished tasks to the sprint being completed.',
                ERROR_CODES.TASK_SPRINT_PROJECT_MISMATCH
            );
        }
        const target = await Sprint.findById(targetId)
            .select('project_id status')
            .lean<{ project_id: Types.ObjectId; status: SprintStatus } | null>();
        const validStatus = target?.status === SPRINT_STATUSES.PLANNED || target?.status === SPRINT_STATUSES.ACTIVE;
        if (!target || !target.project_id.equals(project._id) || !validStatus) {
            throw AppError.unprocessable(
                'The target sprint must be a planned or active sprint in the same project.',
                ERROR_CODES.TASK_SPRINT_PROJECT_MISMATCH
            );
        }
        targetSprintId = targetId;
    }

    // Terminal statuses: default `done` ∪ project custom statuses flagged
    // `is_terminal`. Unfinished = status NOT in this set.
    const terminalKeys = new Set<string>([DEFAULT_TASK_STATUSES.DONE]);
    for (const s of project.custom_task_statuses ?? []) {
        if (s.is_terminal) terminalKeys.add(s.key);
    }

    const before = { status: sprint.status };

    const movedCount = await withTransaction(async (session) => {
        const unfinishedFilter = {
            sprint_id: sprint._id,
            status: { $nin: [...terminalKeys] },
        };
        const count = await Task.countDocuments(unfinishedFilter, { session });
        if (count > 0) {
            await Task.updateMany(unfinishedFilter, { $set: { sprint_id: targetSprintId } }, { session });
        }
        sprint.status = SPRINT_STATUSES.COMPLETED;
        // Stamp the actual completion moment so the UI can show the exact
        // date and tell whether it landed on time vs after `end_date`.
        sprint.completed_at = new Date();
        await sprint.save({ session });
        return count;
    });

    if (caller.audit) {
        await recordAudit(caller.audit, {
            action: AUDIT_ACTIONS.SPRINT_COMPLETE,
            target: { kind: AUDIT_TARGET_KINDS.SPRINT, id: sprint._id },
            before,
            after: { status: sprint.status },
            metadata: {
                project_id: project._id.toString(),
                moved_task_count: movedCount,
                move_unfinished_to: targetSprintId ? targetSprintId.toString() : 'backlog',
            },
        });
    }

    return { sprint: toPublic(sprint), moved_task_count: movedCount };
};
