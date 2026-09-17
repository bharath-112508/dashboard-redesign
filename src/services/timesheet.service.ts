import { Types } from 'mongoose';

import {
    TimesheetEntry,
    computeTimesheetTotals,
    type TimesheetEntryDocument,
} from '../models/timesheet-entry.model.js';
import { Task } from '../models/task.model.js';
import { Project } from '../models/project.model.js';
import { User } from '../models/user.model.js';
import { LeaveRequest } from '../models/leave-request.model.js';
import { AppError } from '../utils/app-error.js';
import { ERROR_CODES } from '../constants/error-codes.js';
import { PERMISSIONS } from '../constants/permissions.js';
import { ROLES } from '../constants/roles.js';
import { scopedUserIdFilter } from './reporting-scope.service.js';
import { AUDIT_ACTIONS, AUDIT_TARGET_KINDS } from '../constants/audit.js';
import {
    TIMESHEET_DEFAULT_DAILY_WARN_THRESHOLD_HOURS,
    TIMESHEET_DEFAULT_SELF_EDIT_WINDOW_DAYS,
    TIMESHEET_ENTRY_TYPES,
    isGeneralCategoryValid,
    type TimesheetSummaryGroupBy,
} from '../constants/timesheet.js';
import { LEAVE_REQUEST_STATUSES } from '../constants/leave.js';
import { recordAudit } from './audit.service.js';
import { loadProjectForCaller } from './project.service.js';
import type { ProjectCaller } from './project.service.js';
import { getOrInitSettings } from './settings.service.js';
import dayjs, { DATE_FORMAT, DEFAULT_TIMEZONE } from '../utils/date.js';
import type { PaginationMeta } from '../utils/api-response.js';
import type {
    CreateTimesheetBody,
    ListTimesheetsQuery,
    PatchTimesheetBody,
    SummaryQuery,
} from '../validators/timesheet.validator.js';

/**
 * Timesheet service — Data_Model.md §6.1 / API_Contract.md §9 /
 * BUILD_PROGRESS.md Step 23.
 *
 * Authorisation model:
 *  - Create / list-self / day-view: any authenticated internal role
 *    (admin / manager / employee). Clients don't log time.
 *  - List-all + summary: manager + admin only.
 *  - Patch + delete: row author within `self_edit_window_days`, OR
 *    admin/manager at any time. An out-of-window manager edit fires
 *    `timesheet.edit_out_of_window` audit on top of the regular
 *    `timesheet.update` so the Step-31 audit UI can surface "manager
 *    overrode the window".
 *
 * Soft policies (warnings, not blocks):
 *  - Daily total > `daily_warn_threshold_hours` →
 *    `warning.exceeds_daily_threshold = true` on the response.
 *  - Logging on a day the user has an approved leave →
 *    `warning.overlaps_approved_leave = true`.
 *  Both warnings still persist the entry — we want the row in the
 *  audit trail with the warning attached, not a clean failure.
 */

// ─── Caller shape ────────────────────────────────────────────────────────

type Caller = ProjectCaller;

// ─── Types ───────────────────────────────────────────────────────────────

interface PolicyContext {
    selfEditWindowDays: number;
    dailyWarnThresholdHours: number;
}

export interface TimesheetWriteResult {
    data: Record<string, unknown>;
    warnings: {
        exceeds_daily_threshold: boolean;
        overlaps_approved_leave: boolean;
    };
}

// ─── Helpers ─────────────────────────────────────────────────────────────

/**
 * `timesheet.edit_out_of_window` was catalogued, bundled into the Manager
 * role, and audited on every override — but never actually *checked*. The
 * service tested `isManagerOrAdmin(caller.role)`, so the permission decided
 * nothing and the compliance audit row recorded an override that required
 * no entitlement. Granting or revoking the bit changed no behaviour.
 *
 * Mirrors `callerHasPermission`: the `system.admin` wildcard satisfies it.
 */
const canEditOutOfWindow = (caller: Caller): boolean => {
    const held = caller.permissions ?? [];
    return (
        held.includes(PERMISSIONS.SYSTEM_ADMIN) ||
        held.includes(PERMISSIONS.TIMESHEET_EDIT_OUT_OF_WINDOW) ||
        caller.role === ROLES.ADMIN
    );
};

const isManagerOrAdmin = (role: string): boolean => role === ROLES.ADMIN || role === ROLES.MANAGER;

// Read access to the TEAM timesheet surfaces (list + summary) is open to every
// team-tier role that holds `timesheet.read` — admin, manager, AND team lead.
// The `GET /timesheets` + `/summary` routes already enforce `timesheet.read`
// (M4); this mirrors that so team leads aren't 403'd by the service *after*
// passing the route. Privileged WRITE surfaces (patch/delete others, get a
// single non-owned entry) stay manager/admin-only via `isManagerOrAdmin`.
const canReadTeamTimesheets = (role: string): boolean =>
    role === ROLES.ADMIN || role === ROLES.MANAGER || role === ROLES.TEAM_LEAD;

const toPublic = (doc: TimesheetEntryDocument): Record<string, unknown> => doc.toJSON() as Record<string, unknown>;

const todayLocal = (): string => dayjs().tz(DEFAULT_TIMEZONE).format(DATE_FORMAT);

const loadPolicy = async (): Promise<PolicyContext> => {
    const settings = await getOrInitSettings();
    return {
        selfEditWindowDays: Number.isFinite(settings.timesheet.self_edit_window_days)
            ? settings.timesheet.self_edit_window_days
            : TIMESHEET_DEFAULT_SELF_EDIT_WINDOW_DAYS,
        dailyWarnThresholdHours: Number.isFinite(settings.timesheet.daily_warn_threshold_hours)
            ? settings.timesheet.daily_warn_threshold_hours
            : TIMESHEET_DEFAULT_DAILY_WARN_THRESHOLD_HOURS,
    };
};

/**
 * The entry's `local_date` must be <= today (no future logging). Both
 * sides are compared as `YYYY-MM-DD` strings — lexical comparison is
 * date-correct for the ISO format.
 */
const assertNotFuture = (localDate: string): void => {
    if (localDate > todayLocal()) {
        throw AppError.unprocessable("You can't log time for a future date.", ERROR_CODES.TIMESHEET_FUTURE_DATE, {
            local_date: localDate,
            today: todayLocal(),
        });
    }
};

const totalMinutesOf = (input: {
    billable_hours: number;
    billable_minutes: number;
    non_billable_hours: number;
    non_billable_minutes: number;
    idle_hours?: number;
    idle_minutes?: number;
}): number =>
    input.billable_hours * 60 +
    input.billable_minutes +
    input.non_billable_hours * 60 +
    input.non_billable_minutes +
    (input.idle_hours ?? 0) * 60 +
    (input.idle_minutes ?? 0);

const assertNonZero = (input: {
    billable_hours: number;
    billable_minutes: number;
    non_billable_hours: number;
    non_billable_minutes: number;
    idle_hours?: number;
    idle_minutes?: number;
}): void => {
    if (totalMinutesOf(input) <= 0) {
        throw AppError.unprocessable(
            'At least one of billable / non-billable time must be greater than zero',
            ERROR_CODES.TIMESHEET_ZERO_DURATION
        );
    }
};

/**
 * Per-entry hard cap of 24 hours. The model caps `*_hours` at 24 and
 * `*_minutes` at 59 independently, so without this guard a single row
 * could encode 24h59m billable + 24h59m non-billable ≈ 50h on a
 * single date. A whole day only has 24 hours; anything larger is silly
 * data we'd rather refuse than store. The daily-warn-threshold is a
 * separate, softer cap; this one is hard.
 */
const TIMESHEET_PER_ENTRY_MAX_MINUTES = 24 * 60;

const assertEntryUnderDailyCap = (input: {
    billable_hours: number;
    billable_minutes: number;
    non_billable_hours: number;
    non_billable_minutes: number;
    idle_hours?: number;
    idle_minutes?: number;
}): void => {
    const total = totalMinutesOf(input);
    if (total > TIMESHEET_PER_ENTRY_MAX_MINUTES) {
        throw AppError.unprocessable(
            `A single timesheet entry cannot exceed ${TIMESHEET_PER_ENTRY_MAX_MINUTES} minutes (24 hours)`,
            ERROR_CODES.TIMESHEET_DURATION_TOO_LARGE,
            { received_minutes: total, max_minutes: TIMESHEET_PER_ENTRY_MAX_MINUTES }
        );
    }
};

/**
 * Verify the caller can read the parent task + project. Reuses
 * `loadProjectForCaller` so timesheet visibility tracks task visibility
 * exactly. Returns the task's `project_id` so callers can persist a
 * consistent denormalised reference.
 */
const loadTaskForCaller = async (
    taskId: Types.ObjectId,
    caller: Caller
): Promise<{ _id: Types.ObjectId; project_id: Types.ObjectId; sprint_id: Types.ObjectId | null }> => {
    const task = await Task.findById(taskId)
        .select('_id project_id sprint_id')
        .lean<{ _id: Types.ObjectId; project_id: Types.ObjectId; sprint_id: Types.ObjectId | null } | null>();
    if (!task) throw AppError.notFound('Task not found', ERROR_CODES.TASK_NOT_FOUND);
    await loadProjectForCaller(task.project_id, caller);
    return task;
};

/**
 * Sum total_minutes already logged on `local_date` by `user_id`. Both
 * create and patch call this AFTER persisting the new/updated row, so
 * the new value is included in the aggregate naturally — no row-
 * exclusion is required.
 */
const sumDailyTotalMinutes = async (userId: Types.ObjectId, localDate: string): Promise<number> => {
    const rows = await TimesheetEntry.aggregate<{ total: number }>([
        { $match: { user_id: userId, local_date: localDate } },
        { $group: { _id: null, total: { $sum: '$total_minutes' } } },
    ]);
    return rows[0]?.total ?? 0;
};

export interface TaskLoggedTime {
    /** Total minutes logged against the task across ALL users' timesheets. */
    logged_minutes: number;
    /** Of which, minutes marked billable. */
    billable_minutes: number;
    /** Number of timesheet rows referencing the task. */
    entry_count: number;
    /** Distinct people who logged time on the task. */
    contributor_count: number;
}

/**
 * Roll up every timesheet entry that references `taskId` (across all users) into
 * the task's actual time spent — powers the task-detail Estimate popover. Uses
 * the `{ task_id: 1 }` drilldown index. Read-only; no auth here (callers gate).
 */
export const sumLoggedTimeForTask = async (taskId: Types.ObjectId): Promise<TaskLoggedTime> => {
    const rows = await TimesheetEntry.aggregate<{
        logged: number;
        billable: number;
        entries: number;
        contributors: Types.ObjectId[];
    }>([
        { $match: { task_id: taskId } },
        {
            $group: {
                _id: null,
                logged: { $sum: '$total_minutes' },
                billable: { $sum: '$billable_total_minutes' },
                entries: { $sum: 1 },
                contributors: { $addToSet: '$user_id' },
            },
        },
    ]);
    const r = rows[0];
    return {
        logged_minutes: r?.logged ?? 0,
        billable_minutes: r?.billable ?? 0,
        entry_count: r?.entries ?? 0,
        contributor_count: r?.contributors?.length ?? 0,
    };
};

/**
 * v1 semantics: "any approved leave covering this date" → warning.
 * `is_half_day` / `half_day_slot` are NOT consulted — a `first_half`
 * leave on `2026-04-22` will still flag a timesheet entry on the same
 * date even if the user logged second-half work. The warning is soft
 * (doesn't block the entry), so the false-positive cost is low and
 * the under-warning risk (missing a leave overlap entirely) is the
 * one we'd actually regret. A future setting can refine this to
 * "warn only if the slot conflicts with the entry's time-of-day"
 * once we capture that on entries.
 */
const overlapsApprovedLeave = async (userId: Types.ObjectId, localDate: string): Promise<boolean> => {
    const overlap = await LeaveRequest.exists({
        user_id: userId,
        status: LEAVE_REQUEST_STATUSES.APPROVED,
        start_date: { $lte: localDate },
        end_date: { $gte: localDate },
    });
    return Boolean(overlap);
};

const exceedsDailyThreshold = (totalMinutes: number, thresholdHours: number): boolean => {
    return totalMinutes > thresholdHours * 60;
};

const isWithinSelfEditWindow = (localDate: string, windowDays: number): boolean => {
    const today = todayLocal();
    const earliestEditableDate = dayjs(today)
        .subtract(windowDays - 1, 'day')
        .format(DATE_FORMAT);
    return localDate >= earliestEditableDate;
};

const loadEntryOr404 = async (id: Types.ObjectId): Promise<TimesheetEntryDocument> => {
    const entry = await TimesheetEntry.findById(id);
    if (!entry) throw AppError.notFound('Timesheet entry not found', ERROR_CODES.TIMESHEET_NOT_FOUND);
    return entry;
};

// ─── POST /timesheets ────────────────────────────────────────────────────

export const createEntry = async (input: CreateTimesheetBody, caller: Caller): Promise<TimesheetWriteResult> => {
    assertNotFuture(input.local_date);
    assertNonZero(input);
    assertEntryUnderDailyCap(input);

    // Task-linked always resolves one; a general entry may have none, in which
    // case `general_category` carries the attribution instead (validator-enforced).
    let projectId: Types.ObjectId | null = null;
    let sprintId: Types.ObjectId | null = null;
    let taskId: Types.ObjectId | null = null;
    let generalCategory: string | null = null;

    if (input.entry_type === TIMESHEET_ENTRY_TYPES.TASK_LINKED) {
        const taskOid = new Types.ObjectId(input.task_id);
        const task = await loadTaskForCaller(taskOid, caller);
        // Cross-check the body's project_id matches the task's parent.
        if (input.project_id && new Types.ObjectId(input.project_id).toString() !== task.project_id.toString()) {
            throw AppError.unprocessable(
                'project_id does not match the parent project of task_id',
                ERROR_CODES.TIMESHEET_TASK_REQUIRED
            );
        }
        projectId = task.project_id;
        taskId = task._id;
        // Prefer the body's sprint_id if given (and visible via the task's
        // project — the validator guards the format), otherwise fall back
        // to the task's current sprint to keep summaries clean.
        sprintId = input.sprint_id ? new Types.ObjectId(input.sprint_id) : task.sprint_id;
    } else {
        // General entry. A project is OPTIONAL here — meetings, internal
        // discussion, support and training belong to no project, and the
        // validator requires a category instead when one is absent. When a
        // project IS given, verify the caller can see it so the row doesn't
        // quietly land against a project they have no access to.
        if (input.project_id) {
            const pOid = new Types.ObjectId(input.project_id);
            await loadProjectForCaller(pOid, caller);
            projectId = pOid;
        }
        // Omitted is stored as `null`, not `undefined` — the column is
        // `String | null` and an undefined would leave the key off the doc,
        // so `{ general_category: null }` grouping in the summary would miss it.
        generalCategory = input.general_category ?? null;
    }

    const policy = await loadPolicy();

    const totals = computeTimesheetTotals(input);
    const created = await TimesheetEntry.create({
        user_id: caller.id,
        local_date: input.local_date,
        entry_type: input.entry_type,
        project_id: projectId,
        sprint_id: sprintId,
        task_id: taskId,
        general_category: generalCategory,
        billable_hours: input.billable_hours,
        billable_minutes: input.billable_minutes,
        non_billable_hours: input.non_billable_hours,
        non_billable_minutes: input.non_billable_minutes,
        idle_hours: input.idle_hours,
        idle_minutes: input.idle_minutes,
        ...totals,
        description: input.description ?? '',
        last_edited_by: caller.id,
        last_edited_at: new Date(),
    });

    const dailyTotal = await sumDailyTotalMinutes(caller.id, input.local_date);
    const warnings = {
        exceeds_daily_threshold: exceedsDailyThreshold(dailyTotal, policy.dailyWarnThresholdHours),
        overlaps_approved_leave: await overlapsApprovedLeave(caller.id, input.local_date),
    };

    if (caller.audit) {
        await recordAudit(caller.audit, {
            action: AUDIT_ACTIONS.TIMESHEET_CREATE,
            target: { kind: AUDIT_TARGET_KINDS.TIMESHEET_ENTRY, id: created._id },
            after: toPublic(created),
            metadata: {
                user_id: caller.id.toString(),
                local_date: created.local_date,
                total_minutes: created.total_minutes,
                exceeds_daily_threshold: warnings.exceeds_daily_threshold,
                overlaps_approved_leave: warnings.overlaps_approved_leave,
            },
        });
    }

    return { data: toPublic(created), warnings };
};

// ─── PATCH /timesheets/:id ───────────────────────────────────────────────

export const patchEntry = async (
    id: Types.ObjectId,
    patch: PatchTimesheetBody,
    caller: Caller
): Promise<TimesheetWriteResult> => {
    const entry = await loadEntryOr404(id);

    const isOwner = entry.user_id.equals(caller.id);
    const isPrivileged = isManagerOrAdmin(caller.role);

    if (!isOwner && !isPrivileged) {
        throw AppError.forbidden();
    }

    const policy = await loadPolicy();
    // The date the edit window is judged on: the one the entry ALREADY has,
    // captured before any move below. A mistyped date is frequently outside
    // the window BECAUSE it is wrong — somebody who meant yesterday and typed
    // last month would otherwise be locked out of the fix. Kept for the audit
    // row too, which has to name the date that allowed an override.
    const windowDate = entry.local_date;
    const inWindow = isWithinSelfEditWindow(windowDate, policy.selfEditWindowDays);
    if (isOwner && !isPrivileged && !inWindow) {
        throw AppError.forbidden(
            `Edits are restricted to the ${policy.selfEditWindowDays}-day window after the entry date`,
            ERROR_CODES.TIMESHEET_EDIT_WINDOW_EXPIRED
        );
    }
    // A privileged caller reaching past the window needs the permission that
    // names the act; the audit row below is the compliance record of it.
    if (!inWindow && isPrivileged && !canEditOutOfWindow(caller)) {
        throw AppError.forbidden(
            `Edits outside the ${policy.selfEditWindowDays}-day window need the out-of-window permission`,
            ERROR_CODES.TIMESHEET_EDIT_WINDOW_EXPIRED
        );
    }

    const before = toPublic(entry);

    // Applied AFTER the window verdict above, which is the whole point.
    if (patch.local_date !== undefined) {
        assertNotFuture(patch.local_date);
        entry.local_date = patch.local_date;
    }

    if (patch.billable_hours !== undefined) entry.billable_hours = patch.billable_hours;
    if (patch.billable_minutes !== undefined) entry.billable_minutes = patch.billable_minutes;
    if (patch.non_billable_hours !== undefined) entry.non_billable_hours = patch.non_billable_hours;
    if (patch.non_billable_minutes !== undefined) entry.non_billable_minutes = patch.non_billable_minutes;
    if (patch.idle_hours !== undefined) entry.idle_hours = patch.idle_hours;
    if (patch.idle_minutes !== undefined) entry.idle_minutes = patch.idle_minutes;
    if (patch.description !== undefined) entry.description = patch.description;

    if (entry.entry_type === TIMESHEET_ENTRY_TYPES.GENERAL && patch.general_category !== undefined) {
        entry.general_category = patch.general_category;
    }

    // A general entry may be moved between projects, or have its project
    // cleared entirely — an entry reclassified as a meeting shouldn't have to
    // be deleted and re-created.
    if (entry.entry_type === TIMESHEET_ENTRY_TYPES.GENERAL && patch.project_id !== undefined) {
        if (patch.project_id) {
            const pOid = new Types.ObjectId(patch.project_id);
            await loadProjectForCaller(pOid, caller);
            entry.project_id = pOid;
        } else {
            entry.project_id = null;
        }
    }

    // The create-time invariant, re-checked against the MERGED row: a patch
    // that clears one attributor can't be judged on its own, because whether
    // it's legal depends on the field it didn't mention. Detaching the project
    // also narrows the category from free text to the managed list, which is
    // the other thing only the merged row can tell us.
    if (
        entry.entry_type === TIMESHEET_ENTRY_TYPES.GENERAL &&
        !isGeneralCategoryValid(entry.general_category, Boolean(entry.project_id))
    ) {
        throw AppError.unprocessable(
            'Pick a project, or choose what this time was for — otherwise the hours are unattributable.',
            ERROR_CODES.VALIDATION_ERROR
        );
    }

    if (entry.entry_type === TIMESHEET_ENTRY_TYPES.TASK_LINKED) {
        if (patch.task_id !== undefined) {
            const newTaskOid = new Types.ObjectId(patch.task_id);
            const task = await loadTaskForCaller(newTaskOid, caller);
            entry.task_id = task._id;
            entry.project_id = task.project_id;
            // Sprint reset to task's current sprint unless caller passes one.
            entry.sprint_id = task.sprint_id;
        }
        if (patch.sprint_id !== undefined) {
            entry.sprint_id = patch.sprint_id ? new Types.ObjectId(patch.sprint_id) : null;
        }
    }

    // Same zero-duration + 24h cap guards as create — covers the edge
    // case where a patch zeroes both fields to "undo" the row instead
    // of deleting it, and prevents an admin override from inflating a
    // single row past 24h.
    const post = {
        billable_hours: entry.billable_hours,
        billable_minutes: entry.billable_minutes,
        non_billable_hours: entry.non_billable_hours,
        non_billable_minutes: entry.non_billable_minutes,
        idle_hours: entry.idle_hours,
        idle_minutes: entry.idle_minutes,
    };
    assertNonZero(post);
    assertEntryUnderDailyCap(post);

    const totals = computeTimesheetTotals(post);
    entry.billable_total_minutes = totals.billable_total_minutes;
    entry.non_billable_total_minutes = totals.non_billable_total_minutes;
    entry.idle_total_minutes = totals.idle_total_minutes;
    entry.total_minutes = totals.total_minutes;

    entry.last_edited_by = caller.id;
    entry.last_edited_at = new Date();
    await entry.save();

    // Against `entry.local_date`, which is the DESTINATION day after a move.
    // The warnings describe the day the hours now land on; reporting the day
    // they left would describe a total that no longer includes them.
    const dailyTotal = await sumDailyTotalMinutes(entry.user_id, entry.local_date);
    const warnings = {
        exceeds_daily_threshold: exceedsDailyThreshold(dailyTotal, policy.dailyWarnThresholdHours),
        overlaps_approved_leave: await overlapsApprovedLeave(entry.user_id, entry.local_date),
    };

    if (caller.audit) {
        await recordAudit(caller.audit, {
            action: AUDIT_ACTIONS.TIMESHEET_UPDATE,
            target: { kind: AUDIT_TARGET_KINDS.TIMESHEET_ENTRY, id: entry._id },
            before,
            after: toPublic(entry),
            metadata: {
                user_id: entry.user_id.toString(),
                local_date: entry.local_date,
                total_minutes: entry.total_minutes,
                privileged_edit: isPrivileged && !isOwner,
                out_of_window: !inWindow,
            },
        });
        if (isPrivileged && !inWindow) {
            // Second audit row is intentional — `timesheet.edit_out_of_window`
            // is the canonical compliance signal for a manager override.
            // Step 31's UI greps for this verb.
            await recordAudit(caller.audit, {
                action: AUDIT_ACTIONS.TIMESHEET_EDIT_OUT_OF_WINDOW,
                target: { kind: AUDIT_TARGET_KINDS.TIMESHEET_ENTRY, id: entry._id },
                metadata: {
                    user_id: entry.user_id.toString(),
                    // The date the window was judged on, NOT the entry's
                    // current one — after a move those differ, and the
                    // compliance record has to name the date that allowed
                    // the override.
                    local_date: windowDate,
                    ...(entry.local_date !== windowDate ? { moved_to: entry.local_date } : {}),
                    edit_window_days: policy.selfEditWindowDays,
                },
            });
        }
    }

    return { data: toPublic(entry), warnings };
};

// ─── DELETE /timesheets/:id ──────────────────────────────────────────────

export const deleteEntry = async (id: Types.ObjectId, caller: Caller): Promise<{ deleted: true }> => {
    const entry = await loadEntryOr404(id);

    const isOwner = entry.user_id.equals(caller.id);
    const isPrivileged = isManagerOrAdmin(caller.role);

    if (!isOwner && !isPrivileged) {
        throw AppError.forbidden();
    }

    const policy = await loadPolicy();
    const inWindow = isWithinSelfEditWindow(entry.local_date, policy.selfEditWindowDays);
    if (isOwner && !isPrivileged && !inWindow) {
        throw AppError.forbidden(
            `Deletes are restricted to the ${policy.selfEditWindowDays}-day window after the entry date`,
            ERROR_CODES.TIMESHEET_EDIT_WINDOW_EXPIRED
        );
    }
    // A privileged caller reaching past the window needs the permission that
    // names the act; the audit row below is the compliance record of it.
    if (!inWindow && isPrivileged && !canEditOutOfWindow(caller)) {
        throw AppError.forbidden(
            `Deletes outside the ${policy.selfEditWindowDays}-day window need the out-of-window permission`,
            ERROR_CODES.TIMESHEET_EDIT_WINDOW_EXPIRED
        );
    }

    const before = toPublic(entry);
    await entry.deleteOne();

    if (caller.audit) {
        await recordAudit(caller.audit, {
            action: AUDIT_ACTIONS.TIMESHEET_DELETE,
            // A timesheet entry has no name — label it with its date + hours.
            target: {
                kind: AUDIT_TARGET_KINDS.TIMESHEET_ENTRY,
                id: entry._id,
                label: `${entry.local_date} · ${(entry.total_minutes / 60).toFixed(1)}h`,
            },
            before,
            metadata: {
                user_id: entry.user_id.toString(),
                local_date: entry.local_date,
                total_minutes: entry.total_minutes,
                privileged_edit: isPrivileged && !isOwner,
                out_of_window: !inWindow,
            },
        });
    }

    return { deleted: true };
};

// ─── GET /timesheets/:id ─────────────────────────────────────────────────

export const getEntry = async (id: Types.ObjectId, caller: Caller): Promise<Record<string, unknown>> => {
    const entry = await loadEntryOr404(id);
    if (!entry.user_id.equals(caller.id) && !isManagerOrAdmin(caller.role)) {
        throw AppError.forbidden();
    }
    return toPublic(entry);
};

// ─── GET /timesheets/me  &  GET /timesheets ──────────────────────────────

const buildListFilter = (query: ListTimesheetsQuery, scopeUserId: unknown): Record<string, unknown> => {
    const filter: Record<string, unknown> = {};
    if (scopeUserId) filter.user_id = scopeUserId;
    if (query.project_id) filter.project_id = new Types.ObjectId(query.project_id);
    if (query.task_id) filter.task_id = new Types.ObjectId(query.task_id);
    if (query.from_date && query.to_date) {
        filter.local_date = { $gte: query.from_date, $lte: query.to_date };
    } else if (query.from_date) {
        filter.local_date = { $gte: query.from_date };
    } else if (query.to_date) {
        filter.local_date = { $lte: query.to_date };
    }
    return filter;
};

/**
 * Self listing — caller always sees only their own rows. Any `user_id`
 * in the query is ignored (we don't even reject it; it's a harmless
 * no-op so an admin who accidentally hits the self-route still gets
 * their own timesheet rather than a 400).
 */
export const listMyEntries = async (
    query: ListTimesheetsQuery,
    caller: Caller
): Promise<{ data: Record<string, unknown>[]; meta: PaginationMeta }> => {
    const filter = buildListFilter(query, caller.id);
    const skip = (query.page - 1) * query.limit;
    const [rows, total] = await Promise.all([
        TimesheetEntry.find(filter).sort({ local_date: -1, created_at: -1 }).skip(skip).limit(query.limit),
        TimesheetEntry.countDocuments(filter),
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

/**
 * Per-page display hydration — mirrors the audit/attendance/leaves
 * pattern. Lets the admin team-timesheets UI render names and project
 * labels without N+1 lookups against `/users/:id` and `/projects/:id`.
 */
interface TimesheetUserDisplay {
    id: string;
    full_name: string | null;
}
interface TimesheetProjectDisplay {
    id: string;
    name: string;
    code: string;
}

const loadTimesheetUserDisplays = async (ids: Types.ObjectId[]): Promise<Map<string, TimesheetUserDisplay>> => {
    if (ids.length === 0) return new Map();
    const users = await User.find({ _id: { $in: ids } })
        .select('_id full_name')
        .lean<{ _id: Types.ObjectId; full_name: string }[]>();
    return new Map(users.map((u) => [u._id.toString(), { id: u._id.toString(), full_name: u.full_name }]));
};

const loadTimesheetProjectDisplays = async (ids: Types.ObjectId[]): Promise<Map<string, TimesheetProjectDisplay>> => {
    if (ids.length === 0) return new Map();
    const projects = await Project.find({ _id: { $in: ids } })
        .select('_id name code')
        .lean<{ _id: Types.ObjectId; name: string; code: string }[]>();
    return new Map(projects.map((p) => [p._id.toString(), { id: p._id.toString(), name: p.name, code: p.code }]));
};

/**
 * The client-facing row. An explicit whitelist, not a `delete` list: a field
 * added to the model later is absent here by default, whereas a blacklist
 * would start leaking it the day it is introduced.
 *
 * `total_minutes` deliberately repeats the billable figure — the client is
 * shown the billable slice as the whole of what they see, and echoing the real
 * total (billable + non-billable + idle) would expose the difference.
 */
const toClientPublic = (
    r: TimesheetEntryDocument,
    taskMap: Map<string, TimesheetTaskDisplay>,
    userMap: Map<string, TimesheetUserDisplay>
): Record<string, unknown> => ({
    id: r._id.toString(),
    local_date: r.local_date,
    entry_type: r.entry_type,
    general_category: r.general_category ?? null,
    description: r.description ?? null,
    billable_total_minutes: r.billable_total_minutes,
    total_minutes: r.billable_total_minutes,
    task: r.task_id ? (taskMap.get(r.task_id.toString()) ?? { id: r.task_id.toString(), title: null }) : null,
    user: userMap.get(r.user_id.toString()) ?? { id: r.user_id.toString(), full_name: null },
});

/**
 * Client-side callers get a deliberately narrow slice of the two team-timesheet
 * readers (`listAllEntries` and `summary`): the BILLABLE effort on ONE project
 * they can already open, and nothing else.
 *
 * Three constraints, each load-bearing:
 *
 *  1. `project_id` is mandatory. Without it the aggregation spans every
 *     project in the system.
 *  2. The project goes through `loadProjectForCaller` — the same scoping every
 *     other project read uses. This endpoint has no row scoping of its own and
 *     trusts the `project_id` it is handed, so relaxing the role check without
 *     this would let a client read another customer's hours by editing an id.
 *  3. Non-billable and idle figures are dropped from the response — that time
 *     is our cost, not the customer's. Dropped server-side rather than hidden
 *     in the UI: a field that never leaves the API cannot leak through a
 *     future component.
 *
 * Per-person output (`group_by: 'user'`, a `user_id` filter, and the author on
 * each row) IS exposed, deliberately — the customer is shown who did the work
 * they are billed for, the way an agency invoice names its consultants. It was
 * withheld in the first cut of this view; widening it was a product decision,
 * so don't "restore" the block on the assumption it was an oversight. The
 * project scoping above is what keeps it to their own people.
 */
const CLIENT_SIDE_ROLES: readonly string[] = [ROLES.CLIENT, ROLES.REPRESENTATIVE];

const assertClientProjectScope = async (
    query: { project_id?: string; user_id?: string; group_by?: TimesheetSummaryGroupBy },
    caller: Caller
): Promise<void> => {
    if (!query.project_id) {
        throw AppError.forbidden('A project must be specified.');
    }
    // Throws if this caller cannot open the project at all.
    await loadProjectForCaller(new Types.ObjectId(query.project_id), caller);
};

/** Manager/admin listing — `user_id` filter optional. */
export const listAllEntries = async (
    query: ListTimesheetsQuery,
    caller: Caller
): Promise<{ data: Record<string, unknown>[]; meta: PaginationMeta }> => {
    const isClientSide = CLIENT_SIDE_ROLES.includes(caller.role);
    if (isClientSide) {
        await assertClientProjectScope(query, caller);
    } else if (!canReadTeamTimesheets(caller.role) && !query.project_id) {
        // Mirrors `summary` — see the note there.
        throw AppError.forbidden();
    }
    // Reporting-chain scoping — Admin sees all; Manager/Team-Lead only their
    // direct reports. `undefined` → no user_id restriction (admin, no filter).
    // Client-side callers are scoped by project instead (asserted above); the
    // reporting chain is an internal-staff concept and would resolve to nothing
    // for them, so their `user_id` filter is passed through as given.
    let scopeUserId: unknown | undefined;
    if (isClientSide) {
        scopeUserId = query.user_id ? new Types.ObjectId(query.user_id) : undefined;
    } else if (query.project_id) {
        // The project is the boundary, exactly as `summary` already treats it
        // — and this is the call that authorises the caller to open it at all.
        // Without this branch the entries list applied the reporting chain
        // while the totals above it did not, so the project's Timesheet tab
        // showed a Team Lead a full billable figure over a list containing
        // only their own direct reports' rows.
        await loadProjectForCaller(new Types.ObjectId(query.project_id), caller);
        scopeUserId = query.user_id ? new Types.ObjectId(query.user_id) : undefined;
    } else {
        scopeUserId = await scopedUserIdFilter(caller, query.user_id);
    }
    const filter = buildListFilter(query, scopeUserId);
    // Same billable-only narrowing as `summary`: a row with no billable time is
    // internal effort the customer neither pays for nor needs to see.
    if (isClientSide) filter.billable_total_minutes = { $gt: 0 };
    const skip = (query.page - 1) * query.limit;
    const [rows, total] = await Promise.all([
        TimesheetEntry.find(filter).sort({ local_date: -1, user_id: 1, created_at: -1 }).skip(skip).limit(query.limit),
        TimesheetEntry.countDocuments(filter),
    ]);

    if (isClientSide) {
        const [taskMap, userMap] = await Promise.all([
            loadTimesheetTaskDisplays(
                Array.from(new Set(rows.filter((r) => r.task_id).map((r) => r.task_id!.toString()))).map(
                    (id) => new Types.ObjectId(id)
                )
            ),
            loadTimesheetUserDisplays(
                Array.from(new Set(rows.map((r) => r.user_id.toString()))).map((id) => new Types.ObjectId(id))
            ),
        ]);
        return {
            data: rows.map((r) => toClientPublic(r, taskMap, userMap)),
            meta: {
                page: query.page,
                limit: query.limit,
                total,
                total_pages: Math.max(1, Math.ceil(total / query.limit)),
            },
        };
    }

    const userIds = Array.from(new Set(rows.map((r) => r.user_id.toString()))).map((id) => new Types.ObjectId(id));
    const projectIds = Array.from(new Set(rows.filter((r) => r.project_id).map((r) => r.project_id!.toString()))).map(
        (id) => new Types.ObjectId(id)
    );
    // Task-linked entries carry only `task_id`; resolve titles so the team
    // view can show WHICH task an employee logged against (not just the
    // project). Reuses the same display helper the summary tab uses.
    const taskIds = Array.from(new Set(rows.filter((r) => r.task_id).map((r) => r.task_id!.toString()))).map(
        (id) => new Types.ObjectId(id)
    );
    const [userMap, projectMap, taskMap] = await Promise.all([
        loadTimesheetUserDisplays(userIds),
        loadTimesheetProjectDisplays(projectIds),
        loadTimesheetTaskDisplays(taskIds),
    ]);

    return {
        data: rows.map((r) => {
            const obj = toPublic(r);
            obj.user = userMap.get(r.user_id.toString()) ?? {
                id: r.user_id.toString(),
                full_name: null,
            };
            if (r.project_id) {
                const pid = r.project_id.toString();
                obj.project = projectMap.get(pid) ?? { id: pid, name: null, code: null };
            }
            if (r.task_id) {
                const tid = r.task_id.toString();
                obj.task = taskMap.get(tid) ?? { id: tid, title: null };
            }
            return obj;
        }),
        meta: {
            page: query.page,
            limit: query.limit,
            total,
            total_pages: Math.max(1, Math.ceil(total / query.limit)),
        },
    };
};

// ─── GET /timesheets/me/day/:date ────────────────────────────────────────

export const listMyDay = async (
    date: string,
    caller: Caller
): Promise<{ data: Record<string, unknown>[]; meta: { local_date: string; total_minutes: number } }> => {
    const rows = await TimesheetEntry.find({ user_id: caller.id, local_date: date }).sort({ created_at: 1 });
    const totalMinutes = rows.reduce((acc, r) => acc + r.total_minutes, 0);
    return {
        data: rows.map(toPublic),
        meta: { local_date: date, total_minutes: totalMinutes },
    };
};

// ─── GET /timesheets/summary ─────────────────────────────────────────────

const groupKeyForBy = (groupBy: TimesheetSummaryGroupBy): Record<string, unknown> => {
    switch (groupBy) {
        case 'user':
            return { user_id: '$user_id' };
        case 'project':
            // When grouping by project, split rows without a project_id
            // (i.e. entry_type='general') by their `general_category` so
            // each general bucket — Meetings, Code review, etc. — gets
            // its own row instead of being lumped into a single null.
            return {
                project_id: '$project_id',
                general_category: {
                    $cond: [{ $eq: ['$project_id', null] }, '$general_category', null],
                },
            };
        case 'task':
            return { task_id: '$task_id' };
        case 'date':
            return { local_date: '$local_date' };
    }
};

interface TimesheetTaskDisplay {
    id: string;
    title: string | null;
}

const loadTimesheetTaskDisplays = async (ids: Types.ObjectId[]): Promise<Map<string, TimesheetTaskDisplay>> => {
    if (ids.length === 0) return new Map();
    const tasks = await Task.find({ _id: { $in: ids } })
        .select('_id title')
        .lean<{ _id: Types.ObjectId; title: string }[]>();
    return new Map(tasks.map((t) => [t._id.toString(), { id: t._id.toString(), title: t.title }]));
};

export const summary = async (query: SummaryQuery, caller: Caller): Promise<Array<Record<string, unknown>>> => {
    const isClientSide = CLIENT_SIDE_ROLES.includes(caller.role);
    if (isClientSide) {
        await assertClientProjectScope(query, caller);
    } else if (!canReadTeamTimesheets(caller.role) && !query.project_id) {
        // An Employee holds no `timesheet.read`, so the org-wide question
        // ("everyone's hours") stays closed to them. One project they can
        // already open is a different question, and now that anyone can create
        // a project, the person who owns one has to be able to see what it
        // cost. `loadProjectForCaller` below is what actually authorises it —
        // this branch only insists they name a project first.
        throw AppError.forbidden();
    }

    // Row scoping for INTERNAL callers. This endpoint had none — it was the
    // only team-timesheet read without it — so a Team Lead whose `listAllEntries`
    // returned nothing still got every employee's totals here. Same data, two
    // endpoints, two different answers about who may see it.
    //
    // Which scope applies depends on the question being asked:
    //
    //  - WITH `project_id` (the project Timesheet tab): the project itself is
    //    the boundary. `loadProjectForCaller` decides whether the caller may
    //    open it at all, and everyone who may sees the project's whole effort —
    //    a project total that silently omitted non-reports would be a wrong
    //    number, not a filtered one.
    //  - WITHOUT it (the org-wide Team timesheets page): the reporting chain,
    //    exactly as `listAllEntries` does, so the two tabs of that page finally
    //    agree.
    let scopedUserId: unknown | undefined;
    if (!isClientSide) {
        if (query.project_id) {
            await loadProjectForCaller(new Types.ObjectId(query.project_id), caller);
        } else {
            scopedUserId = await scopedUserIdFilter(caller, query.user_id);
        }
    }

    const match: Record<string, unknown> = {};
    if (scopedUserId !== undefined) match.user_id = scopedUserId;
    else if (query.user_id) match.user_id = new Types.ObjectId(query.user_id);
    if (query.project_id) match.project_id = new Types.ObjectId(query.project_id);
    if (query.task_id) match.task_id = new Types.ObjectId(query.task_id);
    if (query.from_date && query.to_date) {
        match.local_date = { $gte: query.from_date, $lte: query.to_date };
    } else if (query.from_date) {
        match.local_date = { $gte: query.from_date };
    } else if (query.to_date) {
        match.local_date = { $lte: query.to_date };
    }
    // Rows with no billable time would still surface as 0.00 h groups with a
    // live `entry_count` — i.e. a count of internal, non-billable activity.
    if (isClientSide) match.billable_total_minutes = { $gt: 0 };

    const rows = await TimesheetEntry.aggregate<{
        _id: Record<string, unknown>;
        billable_total_minutes: number;
        non_billable_total_minutes: number;
        idle_total_minutes: number;
        total_minutes: number;
        entry_count: number;
    }>([
        { $match: match },
        {
            $group: {
                _id: groupKeyForBy(query.group_by),
                billable_total_minutes: { $sum: '$billable_total_minutes' },
                non_billable_total_minutes: { $sum: '$non_billable_total_minutes' },
                idle_total_minutes: { $sum: '$idle_total_minutes' },
                total_minutes: { $sum: '$total_minutes' },
                entry_count: { $sum: 1 },
            },
        },
        { $sort: { total_minutes: -1 } },
    ]);

    // Hydrate display info matching `group_by`. Each row's `group_key`
    // carries one of `user_id` / `project_id` / `task_id` / `local_date`;
    // we batch-load the matching collection once per page so the FE can
    // render names without N+1 lookups.
    const collectIds = (key: 'user_id' | 'project_id' | 'task_id'): Types.ObjectId[] =>
        Array.from(
            new Set(
                rows
                    .map((r) => r._id[key])
                    .filter((v): v is Types.ObjectId | string => v != null)
                    .map((v) => (v instanceof Types.ObjectId ? v.toString() : String(v)))
            )
        ).map((s) => new Types.ObjectId(s));

    let userMap: Map<string, TimesheetUserDisplay> = new Map();
    let projectMap: Map<string, TimesheetProjectDisplay> = new Map();
    let taskMap: Map<string, TimesheetTaskDisplay> = new Map();
    if (query.group_by === 'user') {
        userMap = await loadTimesheetUserDisplays(collectIds('user_id'));
    } else if (query.group_by === 'project') {
        projectMap = await loadTimesheetProjectDisplays(collectIds('project_id'));
    } else if (query.group_by === 'task') {
        taskMap = await loadTimesheetTaskDisplays(collectIds('task_id'));
    }

    return rows.map((r) => {
        // Client-side callers get billable only. `total_minutes` is re-stated
        // as the billable figure so a consumer that reads it can't accidentally
        // surface non-billable effort it was never sent.
        const out: Record<string, unknown> = isClientSide
            ? {
                  group_key: r._id,
                  billable_total_minutes: r.billable_total_minutes,
                  total_minutes: r.billable_total_minutes,
                  entry_count: r.entry_count,
              }
            : {
                  group_key: r._id,
                  billable_total_minutes: r.billable_total_minutes,
                  non_billable_total_minutes: r.non_billable_total_minutes,
                  idle_total_minutes: r.idle_total_minutes,
                  total_minutes: r.total_minutes,
                  entry_count: r.entry_count,
              };
        if (query.group_by === 'user') {
            const id = r._id.user_id;
            const idStr = id instanceof Types.ObjectId ? id.toString() : id ? String(id) : null;
            out.user = idStr ? (userMap.get(idStr) ?? { id: idStr, full_name: null }) : null;
        } else if (query.group_by === 'project') {
            const id = r._id.project_id;
            const idStr = id instanceof Types.ObjectId ? id.toString() : id ? String(id) : null;
            out.project = idStr ? (projectMap.get(idStr) ?? { id: idStr, name: null, code: null }) : null;
        } else if (query.group_by === 'task') {
            const id = r._id.task_id;
            const idStr = id instanceof Types.ObjectId ? id.toString() : id ? String(id) : null;
            out.task = idStr ? (taskMap.get(idStr) ?? { id: idStr, title: null }) : null;
        }
        return out;
    });
};

// ─── Internal: used by the timesheet-reminder cron job ───────────────────
//
// Returns the set of `user_id`s who have at least one entry on the given
// local_date. The job loads the full headcount, subtracts on-leave users
// + this set, and notifies the remainder.

export const userIdsWithEntriesOn = async (localDate: string): Promise<Set<string>> => {
    const rows = await TimesheetEntry.distinct('user_id', { local_date: localDate });
    return new Set(rows.map((id: Types.ObjectId) => id.toString()));
};
