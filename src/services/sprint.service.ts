import { Types } from 'mongoose';

import { Sprint, type SprintDocument } from '../models/sprint.model.js';
import { type ProjectDocument } from '../models/project.model.js';
import { AppError } from '../utils/app-error.js';
import { ERROR_CODES } from '../constants/error-codes.js';
import { ROLES, type RoleType } from '../constants/roles.js';
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
    // Writes require manager-or-above; the route already gates this, but we
    // double-check inside the service so a future call site can't accidentally
    // bypass it.
    if (caller.role !== ROLES.ADMIN && caller.role !== ROLES.MANAGER) {
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
// Tasks reference `sprint_id`; until Step 18 ships there can be none, so a
// hard delete is fine. When tasks land, this becomes "set sprint_id = null
// on all tasks in this sprint, then delete" (a deliberate move-to-backlog).

export const deleteSprint = async (sprintId: Types.ObjectId, caller: ProjectCaller): Promise<void> => {
    if (caller.role !== ROLES.ADMIN && caller.role !== ROLES.MANAGER) {
        throw AppError.forbidden();
    }

    const { sprint, project } = await loadSprintAndProject(sprintId, caller);
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
