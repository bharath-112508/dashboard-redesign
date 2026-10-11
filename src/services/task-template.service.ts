import { Types } from 'mongoose';

import { TaskTemplate, type TaskTemplateDocument } from '../models/task-template.model.js';
import { Story } from '../models/story.model.js';
import { Sprint } from '../models/sprint.model.js';
import { User } from '../models/user.model.js';
import { AppError } from '../utils/app-error.js';
import { ERROR_CODES } from '../constants/error-codes.js';
import { ROLES, type RoleType } from '../constants/roles.js';
import { isProjectAuthor } from '../utils/role-check.js';
import { USER_STATUSES } from '../constants/user-statuses.js';
import { TASK_TEMPLATE_RECURRENCE_MAX_PER_RUN } from '../constants/task-template.js';
import { AUDIT_ACTIONS, AUDIT_TARGET_KINDS } from '../constants/audit.js';
import { recordAudit, recordSystemAudit, type AuditContext } from './audit.service.js';
import { createTask } from './task.service.js';
import { loadProjectForCaller } from './project.service.js';
import dayjs, { DATE_FORMAT, DEFAULT_TIMEZONE } from '../utils/date.js';
import logger from '../utils/logger.js';
import type { PaginationMeta } from '../utils/api-response.js';
import type {
    CreateTaskTemplateBody,
    InstantiateTaskTemplateBody,
    ListTaskTemplatesQuery,
    PatchTaskTemplateBody,
} from '../validators/task-template.validator.js';

/**
 * Task-template service (Phase 4 Step 40).
 *
 * Responsibilities:
 *  - **CRUD** for `task_templates`. Project-scoped writes (admin +
 *    manager); reads are scoped by the same project visibility filter
 *    that powers the project task list.
 *  - **Manual instantiation** via `instantiateTemplate(id, overrides)`
 *    — wraps the existing `task.service.createTask` so a template
 *    inherits all of the task surface's invariants (status validation,
 *    parent-task checks, dependency caps, etc.) for free.
 *  - **Recurring sweep** via `runRecurringTaskSweep(now)` — daily
 *    cron entry point. Walks templates with `recurrence.enabled: true`
 *    whose schedule fires today AND haven't been generated yet today,
 *    instantiates each as a system audit, and stamps
 *    `recurrence.last_generated_at` for idempotency.
 *
 * Reference resilience: at instantiation we silently drop assignee /
 * collaborator references that no longer satisfy project membership,
 * along with story / sprint references that are missing or for a
 * different project. Each drop emits a `warn` so an operator can see
 * "template X had a stale reference and we dropped it" without a
 * recurring task hard-failing for a single staleness.
 */

// ─── Types ─────────────────────────────────────────────────────────────

export interface TemplateCaller {
    id: Types.ObjectId;
    role: RoleType;
    audit?: AuditContext;
}

// H2 — Team Lead holds `task_template.write` per the Step-47 system-role
// bundle. Pre-H2 the gate compared role-string against admin/manager only
// and 403'd Team Leads who'd already passed the route's
// `requirePermission(TASK_TEMPLATE_WRITE)` gate.
const requireWriter = (caller: TemplateCaller): void => {
    if (!isProjectAuthor(caller)) {
        throw AppError.forbidden(
            'Only admins, managers, and team leads can manage task templates',
            ERROR_CODES.FORBIDDEN
        );
    }
};

const toPublic = (doc: TaskTemplateDocument): Record<string, unknown> => doc.toJSON() as Record<string, unknown>;

// ─── CRUD ──────────────────────────────────────────────────────────────

export const createTemplate = async (
    projectId: Types.ObjectId,
    body: CreateTaskTemplateBody,
    caller: TemplateCaller
): Promise<Record<string, unknown>> => {
    requireWriter(caller);
    // Visibility check — manager scope already returns true here, but
    // load the project so we 404 cleanly on a missing/archived id.
    await loadProjectForCaller(projectId, { id: caller.id, role: caller.role });

    const doc = await TaskTemplate.create({
        project_id: projectId,
        ...body,
        // Coerce string ids to ObjectId for storage; null stays null.
        default_assignee_id: body.default_assignee_id ? new Types.ObjectId(body.default_assignee_id) : null,
        default_collaborator_ids: body.default_collaborator_ids.map((id) => new Types.ObjectId(id)),
        default_story_id: body.default_story_id ? new Types.ObjectId(body.default_story_id) : null,
        default_sprint_id: body.default_sprint_id ? new Types.ObjectId(body.default_sprint_id) : null,
        created_by: caller.id,
    });

    if (caller.audit) {
        await recordAudit(caller.audit, {
            action: AUDIT_ACTIONS.TASK_TEMPLATE_CREATE,
            target: { kind: AUDIT_TARGET_KINDS.TASK_TEMPLATE, id: doc._id },
            after: toPublic(doc),
            metadata: { project_id: projectId.toString(), recurring: Boolean(doc.recurrence?.enabled) },
        });
    }

    return toPublic(doc);
};

export const updateTemplate = async (
    id: Types.ObjectId,
    body: PatchTaskTemplateBody,
    caller: TemplateCaller
): Promise<Record<string, unknown>> => {
    requireWriter(caller);
    const doc = await TaskTemplate.findById(id);
    if (!doc) throw AppError.notFound('Task template not found', ERROR_CODES.TASK_TEMPLATE_NOT_FOUND);
    await loadProjectForCaller(doc.project_id, { id: caller.id, role: caller.role });

    const before = toPublic(doc);
    if (body.name !== undefined) doc.name = body.name;
    if (body.title !== undefined) doc.title = body.title;
    if (body.description !== undefined) doc.description = body.description;
    if (body.priority !== undefined) doc.priority = body.priority as TaskTemplateDocument['priority'];
    if (body.default_assignee_id !== undefined) {
        doc.default_assignee_id = body.default_assignee_id ? new Types.ObjectId(body.default_assignee_id) : null;
    }
    if (body.default_collaborator_ids !== undefined) {
        doc.default_collaborator_ids = body.default_collaborator_ids.map((s) => new Types.ObjectId(s));
    }
    if (body.default_story_id !== undefined) {
        doc.default_story_id = body.default_story_id ? new Types.ObjectId(body.default_story_id) : null;
    }
    if (body.default_sprint_id !== undefined) {
        doc.default_sprint_id = body.default_sprint_id ? new Types.ObjectId(body.default_sprint_id) : null;
    }
    if (body.default_due_offset_days !== undefined) doc.default_due_offset_days = body.default_due_offset_days;
    if (body.default_estimated_hours !== undefined) doc.default_estimated_hours = body.default_estimated_hours;
    if (body.recurrence !== undefined) {
        // Reset `last_generated_at` when the schedule shape changes —
        // operators tweaking the cadence shouldn't have yesterday's
        // skip-state silently survive into the new rule.
        doc.recurrence = body.recurrence
            ? {
                  enabled: body.recurrence.enabled,
                  frequency: body.recurrence.frequency,
                  weekdays: body.recurrence.weekdays,
                  day_of_month: body.recurrence.day_of_month,
                  start_date: body.recurrence.start_date,
                  end_date: body.recurrence.end_date,
                  last_generated_at: null,
              }
            : null;
    }
    if (body.is_archived !== undefined) doc.is_archived = body.is_archived;
    doc.updated_by = caller.id;

    await doc.save();

    if (caller.audit) {
        await recordAudit(caller.audit, {
            action: AUDIT_ACTIONS.TASK_TEMPLATE_UPDATE,
            target: { kind: AUDIT_TARGET_KINDS.TASK_TEMPLATE, id: doc._id },
            before,
            after: toPublic(doc),
            metadata: { project_id: doc.project_id.toString() },
        });
    }

    return toPublic(doc);
};

export const deleteTemplate = async (id: Types.ObjectId, caller: TemplateCaller): Promise<{ deleted: true }> => {
    requireWriter(caller);
    const doc = await TaskTemplate.findById(id);
    if (!doc) throw AppError.notFound('Task template not found', ERROR_CODES.TASK_TEMPLATE_NOT_FOUND);
    await loadProjectForCaller(doc.project_id, { id: caller.id, role: caller.role });

    const before = toPublic(doc);
    await doc.deleteOne();

    if (caller.audit) {
        await recordAudit(caller.audit, {
            action: AUDIT_ACTIONS.TASK_TEMPLATE_DELETE,
            target: { kind: AUDIT_TARGET_KINDS.TASK_TEMPLATE, id: doc._id },
            before,
            metadata: { project_id: doc.project_id.toString() },
        });
    }

    return { deleted: true };
};

export const listTemplates = async (
    projectId: Types.ObjectId,
    query: ListTaskTemplatesQuery,
    caller: TemplateCaller
): Promise<{ data: Record<string, unknown>[]; meta: PaginationMeta }> => {
    await loadProjectForCaller(projectId, { id: caller.id, role: caller.role });

    const filter: Record<string, unknown> = { project_id: projectId };
    if (query.is_archived !== undefined) filter.is_archived = query.is_archived;
    if (query.recurring_only) filter['recurrence.enabled'] = true;

    const skip = (query.page - 1) * query.limit;
    const [rows, total] = await Promise.all([
        TaskTemplate.find(filter).sort({ name: 1, _id: 1 }).skip(skip).limit(query.limit),
        TaskTemplate.countDocuments(filter),
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

export const getTemplate = async (id: Types.ObjectId, caller: TemplateCaller): Promise<Record<string, unknown>> => {
    const doc = await TaskTemplate.findById(id);
    if (!doc) throw AppError.notFound('Task template not found', ERROR_CODES.TASK_TEMPLATE_NOT_FOUND);
    await loadProjectForCaller(doc.project_id, { id: caller.id, role: caller.role });
    return toPublic(doc);
};

// ─── Reference resilience ──────────────────────────────────────────────

const filterValidUserIds = async (ids: Types.ObjectId[]): Promise<Types.ObjectId[]> => {
    if (ids.length === 0) return [];
    const found = await User.find({ _id: { $in: ids }, status: USER_STATUSES.ACTIVE })
        .select('_id')
        .lean<{ _id: Types.ObjectId }[]>();
    const ok = new Set(found.map((u) => u._id.toString()));
    return ids.filter((id) => ok.has(id.toString()));
};

const validateStoryRef = async (storyId: Types.ObjectId, projectId: Types.ObjectId): Promise<boolean> => {
    const exists = await Story.findOne({ _id: storyId, project_id: projectId })
        .select('_id')
        .lean<{ _id: Types.ObjectId } | null>();
    return Boolean(exists);
};

/** A completed sprint counts as stale too — tasks can't be added to one, so the
 *  instance drops to the backlog instead of failing the (recurring) run. */
const validateSprintRef = async (sprintId: Types.ObjectId, projectId: Types.ObjectId): Promise<boolean> => {
    const exists = await Sprint.findOne({ _id: sprintId, project_id: projectId, status: { $ne: 'completed' } })
        .select('_id')
        .lean<{ _id: Types.ObjectId } | null>();
    return Boolean(exists);
};

// ─── Manual instantiation ──────────────────────────────────────────────

export const instantiateTemplate = async (
    id: Types.ObjectId,
    overrides: InstantiateTaskTemplateBody,
    caller: TemplateCaller
): Promise<Record<string, unknown>> => {
    requireWriter(caller);
    const doc = await TaskTemplate.findById(id);
    if (!doc) throw AppError.notFound('Task template not found', ERROR_CODES.TASK_TEMPLATE_NOT_FOUND);
    if (doc.is_archived) {
        throw AppError.unprocessable('Cannot instantiate an archived template', ERROR_CODES.TASK_TEMPLATE_NOT_FOUND);
    }
    await loadProjectForCaller(doc.project_id, { id: caller.id, role: caller.role });

    const task = await materialiseTaskFromTemplate(doc, overrides, {
        ...caller,
        // Override path passes the caller's audit context — task.service
        // emits its own task.create row.
    });

    if (caller.audit) {
        await recordAudit(caller.audit, {
            action: AUDIT_ACTIONS.TASK_TEMPLATE_INSTANTIATE,
            target: { kind: AUDIT_TARGET_KINDS.TASK_TEMPLATE, id: doc._id },
            metadata: {
                project_id: doc.project_id.toString(),
                created_task_id: (task as { id: string }).id,
                source: 'manual',
            },
        });
    }

    return task;
};

// Pure "build a task body from this template + overrides + reference
// validation". Shared between manual + cron paths.
const materialiseTaskFromTemplate = async (
    doc: TaskTemplateDocument,
    overrides: InstantiateTaskTemplateBody,
    caller: TemplateCaller
): Promise<Record<string, unknown>> => {
    // 1. Assignee — drop if no longer active.
    let primaryAssigneeId: string | null = overrides.primary_assignee_id ?? doc.default_assignee_id?.toString() ?? null;
    if (primaryAssigneeId) {
        const ok = await filterValidUserIds([new Types.ObjectId(primaryAssigneeId)]);
        if (ok.length === 0) {
            logger.warn(
                { template_id: doc._id.toString(), dropped_assignee: primaryAssigneeId },
                'Task-template instantiate: dropped stale primary assignee reference'
            );
            primaryAssigneeId = null;
        }
    }

    // 2. Collaborators — keep only the still-active subset.
    const collabSourceIds: string[] =
        overrides.collaborator_ids ?? doc.default_collaborator_ids.map((id) => id.toString());
    const collabAfterCheck = await filterValidUserIds(collabSourceIds.map((s) => new Types.ObjectId(s)));
    const droppedCollabs = collabSourceIds.length - collabAfterCheck.length;
    if (droppedCollabs > 0) {
        logger.warn(
            { template_id: doc._id.toString(), dropped_count: droppedCollabs },
            'Task-template instantiate: dropped one or more stale collaborator references'
        );
    }

    // 3. Story — drop if missing or in another project.
    let storyId: string | null = overrides.story_id ?? doc.default_story_id?.toString() ?? null;
    if (storyId) {
        const ok = await validateStoryRef(new Types.ObjectId(storyId), doc.project_id);
        if (!ok) {
            logger.warn(
                { template_id: doc._id.toString(), dropped_story_id: storyId },
                'Task-template instantiate: dropped stale story reference'
            );
            storyId = null;
        }
    }

    // 4. Sprint — same.
    let sprintId: string | null = overrides.sprint_id ?? doc.default_sprint_id?.toString() ?? null;
    if (sprintId) {
        const ok = await validateSprintRef(new Types.ObjectId(sprintId), doc.project_id);
        if (!ok) {
            logger.warn(
                { template_id: doc._id.toString(), dropped_sprint_id: sprintId },
                'Task-template instantiate: dropped stale sprint reference'
            );
            sprintId = null;
        }
    }

    // 5. Due date — explicit override > offset from today > none.
    let dueDate: string | null = null;
    if (overrides.due_date) {
        dueDate = overrides.due_date;
    } else if (doc.default_due_offset_days !== null) {
        dueDate = dayjs().tz(DEFAULT_TIMEZONE).add(doc.default_due_offset_days, 'day').format(DATE_FORMAT);
    }

    // 6. Hand off to the existing createTask, which re-validates
    // every reference at the project scope and emits its own audit
    // row. Use the same caller context so the resulting task's
    // `created_by` is honest.
    return createTask(
        {
            project_id: doc.project_id.toString(),
            sprint_id: sprintId,
            story_id: storyId,
            parent_task_id: null,
            title: overrides.title ?? doc.title,
            description: doc.description,
            priority: doc.priority,
            due_date: dueDate,
            estimated_hours: doc.default_estimated_hours,
            primary_assignee_id: primaryAssigneeId,
            collaborator_ids: collabAfterCheck.map((id) => id.toString()),
            depends_on_task_ids: [],
            // status defaults to "to_do" inside createTask when omitted.
        },
        { id: caller.id, role: caller.role, audit: caller.audit }
    );
};

// ─── Recurring sweep (cron entry point) ────────────────────────────────

interface SweepSummary extends Record<string, unknown> {
    templates_scanned: number;
    tasks_created: number;
    skipped_already_today: number;
    failures: number;
}

/**
 * Scan recurring templates and instantiate any whose schedule fires
 * today (IST). Idempotent: a same-day re-run is a no-op for templates
 * whose `recurrence.last_generated_at` already equals today.
 *
 * Frequency semantics:
 *  - daily   — fires every day inside the start/end window.
 *  - weekly  — fires when today's weekday is in `recurrence.weekdays`.
 *  - monthly — fires when today's day-of-month equals `day_of_month`.
 *
 * Cap: at most `TASK_TEMPLATE_RECURRENCE_MAX_PER_RUN` templates per
 * tick. A single failure does NOT abort the rest — log warn,
 * increment `failures`, continue.
 */
export const runRecurringTaskSweep = async (now: Date = new Date()): Promise<SweepSummary> => {
    const summary: SweepSummary = {
        templates_scanned: 0,
        tasks_created: 0,
        skipped_already_today: 0,
        failures: 0,
    };

    const today = dayjs(now).tz(DEFAULT_TIMEZONE);
    const todayIso = today.format(DATE_FORMAT);
    const todayWeekday = today.day();
    const todayDayOfMonth = today.date();

    const candidates = await TaskTemplate.find({
        'recurrence.enabled': true,
        is_archived: false,
    })
        .limit(TASK_TEMPLATE_RECURRENCE_MAX_PER_RUN)
        .exec();

    for (const tpl of candidates) {
        summary.templates_scanned += 1;
        if (!tpl.recurrence) continue;
        const r = tpl.recurrence;

        // Window check.
        if (todayIso < r.start_date) continue;
        if (r.end_date && todayIso > r.end_date) continue;

        // Already generated today?
        if (r.last_generated_at === todayIso) {
            summary.skipped_already_today += 1;
            continue;
        }

        // Schedule fires today?
        let fires = false;
        if (r.frequency === 'daily') fires = true;
        else if (r.frequency === 'weekly') fires = r.weekdays.includes(todayWeekday);
        else if (r.frequency === 'monthly') fires = r.day_of_month === todayDayOfMonth;
        if (!fires) continue;

        try {
            // System caller — `created_by` records the original
            // template author so the resulting task's audit trail
            // is at least pointing at a real user. The audit row
            // for the instantiation itself is `system` role.
            const systemCaller: TemplateCaller = {
                id: tpl.created_by,
                role: ROLES.ADMIN, // bypass the role gate for cron-driven creates
            };
            const task = await materialiseTaskFromTemplate(tpl, {}, systemCaller);

            // Stamp last-generated atomically — defends against a
            // concurrent cron tick (test seam / accidental double
            // schedule) firing the same template twice.
            const stamp = await TaskTemplate.findOneAndUpdate(
                { _id: tpl._id, 'recurrence.last_generated_at': r.last_generated_at },
                { $set: { 'recurrence.last_generated_at': todayIso } },
                { new: true }
            );
            if (!stamp) {
                // Lost the race — another tick already stamped. The
                // task we just created is a duplicate; log so the
                // operator can clean it up if desired.
                logger.warn(
                    { template_id: tpl._id.toString(), task_id: (task as { id: string }).id },
                    'Recurring task race: stamp lost, duplicate task created'
                );
                summary.failures += 1;
                continue;
            }

            await recordSystemAudit({
                action: AUDIT_ACTIONS.TASK_TEMPLATE_RECURRENCE_RUN,
                target: { kind: AUDIT_TARGET_KINDS.TASK_TEMPLATE, id: tpl._id },
                metadata: {
                    project_id: tpl.project_id.toString(),
                    created_task_id: (task as { id: string }).id,
                    fire_date: todayIso,
                    frequency: r.frequency,
                },
            });

            summary.tasks_created += 1;
        } catch (err) {
            logger.warn(
                { err, template_id: tpl._id.toString() },
                'Recurring task instantiate failed; will retry tomorrow'
            );
            summary.failures += 1;
        }
    }

    return summary;
};
