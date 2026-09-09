import { Types } from 'mongoose';

import type { RoleType } from '../constants/roles.js';
import { PERMISSIONS } from '../constants/permissions.js';
import { Project } from '../models/project.model.js';
import { Task } from '../models/task.model.js';
import { DEFAULT_TASK_STATUSES } from '../constants/task.js';
import { SLACK_SELECT_OPTION_CAP } from '../constants/slack.js';
import { callerCan } from '../utils/caller-permissions.js';
import logger from '../utils/logger.js';
import type { LogTimeProjectOption, LogTimeTicketOption } from '../utils/slack-block-kit/timesheet.js';
import { buildProjectVisibilityFilter, loadProjectForCaller } from './project.service.js';
import { resolvePermissionsForUser } from './role.service.js';

/**
 * Projects offerable in the Slack "Log time" modal.
 *
 * Scoped with `buildProjectVisibilityFilter` — the same helper every other
 * project read uses — so an Employee sees exactly the projects the web picker
 * shows them and there is no second copy of the visibility rule to drift.
 *
 * Capped at Slack's `static_select` ceiling: 101 options is an API error, not
 * a truncated menu, so the limit is enforced in the query rather than left to
 * the builder to trip over.
 */
export const loadLogTimeProjects = async (caller: {
    id: Types.ObjectId;
    role: RoleType;
}): Promise<LogTimeProjectOption[]> => {
    const rows = await Project.find({
        ...buildProjectVisibilityFilter(caller),
        is_archived: false,
    })
        .sort({ name: 1 })
        .limit(SLACK_SELECT_OPTION_CAP)
        .lean();

    return rows.map((p) => ({
        id: String((p as { _id: Types.ObjectId })._id),
        label: (p as { name: string }).name,
    }));
};

/**
 * Whether `userId` currently holds `timesheet.write` (the `system.admin`
 * wildcard included — `callerCan` handles that). This is the SAME question
 * `slack-home.service.ts` asks to decide whether to render the "Log time"
 * button (`callerCan(perms, PERMISSIONS.TIMESHEET_WRITE)`), asked again here
 * for enforcement.
 *
 * Enforcement previously used a role-based check
 * (`!CLIENT_SIDE_ROLES.includes(role)`, formerly `canLogTime` in
 * `utils/role-check.ts`), which fails OPEN for a real, supported RBAC
 * configuration: `assignRolesToUser` (role.service.ts) leaves the legacy
 * `User.role` field at its previous value (commonly `'employee'`) when a
 * user is assigned ONLY custom roles — it never writes `'client'` or
 * `'representative'` for such a user, because that field isn't part of the
 * custom-role assignment path at all. So an admin who builds a restricted
 * custom role that deliberately excludes `timesheet.write` and assigns it
 * produces a caller who correctly sees no Log Time button (rendering
 * already checks the permission) but PASSED the old role-based enforcement
 * gate — the two gates disagreed. Asking the same permission question in
 * both places means they can't.
 *
 * `createEntry` (`timesheet.service.ts`) has no permission check of its
 * own, and the Slack interactive path bypasses Express `requirePermission`
 * entirely — so this is the actual authorization boundary for both the
 * modal-open branch and (the write path) `handleLogTimeSubmission`, not a
 * UI nicety.
 */
export const callerCanLogTime = async (userId: Types.ObjectId): Promise<boolean> => {
    const { permissions } = await resolvePermissionsForUser(userId);
    return callerCan(permissions, PERMISSIONS.TIMESHEET_WRITE);
};

/**
 * Tickets offerable in the "Log time" modal for ONE project.
 *
 * Scope is deliberately narrow — the caller's own tasks, excluding `done`.
 * A `static_select` is a scrolling menu, not a search box, so a project-wide
 * list would be unusable long before it hit Slack's 100-option ceiling; and
 * when you are logging YOUR time, the ticket is almost always one of yours.
 * Matches on `assignee_ids` rather than `primary_assignee_id` because a task
 * shared between several people belongs to all of them (see task.model.ts) —
 * keying on the denormalized field would hide co-assigned work.
 *
 * DISPLAY ONLY — never an authorization boundary. It returns `[]` instead of
 * throwing for a project the caller cannot see, so a stale or forged
 * `block_actions` degrades to an empty menu rather than breaking the open
 * modal. The write is still guarded: `createEntry` runs `loadTaskForCaller`
 * and cross-checks the task's parent project against `project_id`, so a
 * submission naming a hidden project or someone else's ticket is refused
 * there regardless of what this returned.
 */
export const loadLogTimeTickets = async (
    projectId: string,
    caller: { id: Types.ObjectId; role: RoleType }
): Promise<LogTimeTicketOption[]> => {
    let oid: Types.ObjectId;
    try {
        oid = new Types.ObjectId(projectId);
    } catch {
        return [];
    }

    // Loaded for two reasons: it applies the caller's visibility scope, and
    // the project's `code` is half of every ticket label (`VLJ-142`).
    let code: string;
    try {
        const project = await loadProjectForCaller(oid, caller);
        code = (project as unknown as { code?: string }).code ?? '';
    } catch (err) {
        logger.warn(
            { err, project_id: projectId, reason: 'log_time_tickets_project_unreadable' },
            'Slack log-time: ticket list requested for a project the caller cannot read'
        );
        return [];
    }

    const rows = await Task.find({
        project_id: oid,
        assignee_ids: caller.id,
        status: { $ne: DEFAULT_TASK_STATUSES.DONE },
    })
        .sort({ task_number: 1 })
        .limit(SLACK_SELECT_OPTION_CAP)
        .lean();

    return rows.map((t) => {
        const row = t as unknown as { _id: Types.ObjectId; task_number?: number; title?: string };
        return {
            id: String(row._id),
            label: `${code}-${row.task_number ?? '?'} ${row.title ?? ''}`.trim(),
        };
    });
};
