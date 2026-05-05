import { Types } from 'mongoose';

import { Sprint, type SprintDocument } from '../models/sprint.model.js';
import { type ProjectDocument } from '../models/project.model.js';
import { Task } from '../models/task.model.js';
import { AppError } from '../utils/app-error.js';
import { ERROR_CODES } from '../constants/error-codes.js';
import { type RoleType } from '../constants/roles.js';
import { isProjectAuthor } from '../utils/role-check.js';
import { type SprintStatus } from '../constants/project.js';
import { AUDIT_ACTIONS, AUDIT_TARGET_KINDS } from '../constants/audit.js';
import { recordAudit } from './audit.service.js';
import { loadProjectForCaller } from './project.service.js';
import type { ProjectCaller } from './project.service.js';
import type { PaginationMeta } from '../utils/api-response.js';
import type { CreateSprintBody, ListSprintsQuery, PatchSprintBody } from '../validators/sprint.validator.js';

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
        throw AppError.unprocessable('Sprint end_date is after the project end_date', ERROR_CODES.SPRINT_DATE_INVALID, {
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

    if (patch.name !== undefined) sprint.name = patch.name;
    if (patch.goal !== undefined) sprint.goal = patch.goal;
    if (patch.start_date !== undefined) sprint.start_date = patch.start_date;
    if (patch.end_date !== undefined) sprint.end_date = patch.end_date;
    if (patch.status !== undefined) sprint.status = patch.status as SprintStatus;

    if (sprint.end_date < sprint.start_date) {
        throw AppError.unprocessable('end_date must be on or after start_date', ERROR_CODES.SPRINT_DATE_INVALID);
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
