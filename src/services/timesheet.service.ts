import { Types } from 'mongoose';

import {
    TimesheetEntry,
    computeTimesheetTotals,
    type TimesheetEntryDocument,
} from '../models/timesheet-entry.model.js';
import { Task } from '../models/task.model.js';
import { LeaveRequest } from '../models/leave-request.model.js';
import { AppError } from '../utils/app-error.js';
import { ERROR_CODES } from '../constants/error-codes.js';
import { ROLES } from '../constants/roles.js';
import { AUDIT_ACTIONS, AUDIT_TARGET_KINDS } from '../constants/audit.js';
import {
    TIMESHEET_DEFAULT_DAILY_WARN_THRESHOLD_HOURS,
    TIMESHEET_DEFAULT_SELF_EDIT_WINDOW_DAYS,
    TIMESHEET_ENTRY_TYPES,
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

const isManagerOrAdmin = (role: string): boolean => role === ROLES.ADMIN || role === ROLES.MANAGER;

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
        throw AppError.unprocessable('local_date cannot be in the future', ERROR_CODES.TIMESHEET_FUTURE_DATE, {
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
}): number =>
    input.billable_hours * 60 + input.billable_minutes + input.non_billable_hours * 60 + input.non_billable_minutes;

const assertNonZero = (input: {
    billable_hours: number;
    billable_minutes: number;
    non_billable_hours: number;
    non_billable_minutes: number;
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
        // General entry. project_id is optional; when supplied, verify the
        // caller can see it so the row doesn't quietly land against a
        // project they have no access to.
        if (input.project_id) {
            const pOid = new Types.ObjectId(input.project_id);
            await loadProjectForCaller(pOid, caller);
            projectId = pOid;
        }
        generalCategory = input.general_category;
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
    const inWindow = isWithinSelfEditWindow(entry.local_date, policy.selfEditWindowDays);
    if (isOwner && !isPrivileged && !inWindow) {
        throw AppError.forbidden(
            `Edits are restricted to the ${policy.selfEditWindowDays}-day window after the entry date`,
            ERROR_CODES.TIMESHEET_EDIT_WINDOW_EXPIRED
        );
    }

    const before = toPublic(entry);

    if (patch.billable_hours !== undefined) entry.billable_hours = patch.billable_hours;
    if (patch.billable_minutes !== undefined) entry.billable_minutes = patch.billable_minutes;
    if (patch.non_billable_hours !== undefined) entry.non_billable_hours = patch.non_billable_hours;
    if (patch.non_billable_minutes !== undefined) entry.non_billable_minutes = patch.non_billable_minutes;
    if (patch.description !== undefined) entry.description = patch.description;

    if (entry.entry_type === TIMESHEET_ENTRY_TYPES.GENERAL && patch.general_category !== undefined) {
        entry.general_category = patch.general_category;
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
    };
    assertNonZero(post);
    assertEntryUnderDailyCap(post);

    const totals = computeTimesheetTotals(post);
    entry.billable_total_minutes = totals.billable_total_minutes;
    entry.non_billable_total_minutes = totals.non_billable_total_minutes;
    entry.total_minutes = totals.total_minutes;

    entry.last_edited_by = caller.id;
    entry.last_edited_at = new Date();
    await entry.save();

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
                    local_date: entry.local_date,
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

    const before = toPublic(entry);
    await entry.deleteOne();

    if (caller.audit) {
        await recordAudit(caller.audit, {
            action: AUDIT_ACTIONS.TIMESHEET_DELETE,
            target: { kind: AUDIT_TARGET_KINDS.TIMESHEET_ENTRY, id: entry._id },
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

const buildListFilter = (query: ListTimesheetsQuery, scopeUserId: Types.ObjectId | null): Record<string, unknown> => {
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

/** Manager/admin listing — `user_id` filter optional. */
export const listAllEntries = async (
    query: ListTimesheetsQuery,
    caller: Caller
): Promise<{ data: Record<string, unknown>[]; meta: PaginationMeta }> => {
    if (!isManagerOrAdmin(caller.role)) throw AppError.forbidden();
    const scopeUserId = query.user_id ? new Types.ObjectId(query.user_id) : null;
    const filter = buildListFilter(query, scopeUserId);
    const skip = (query.page - 1) * query.limit;
    const [rows, total] = await Promise.all([
        TimesheetEntry.find(filter).sort({ local_date: -1, user_id: 1, created_at: -1 }).skip(skip).limit(query.limit),
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
            return { project_id: '$project_id' };
        case 'task':
            return { task_id: '$task_id' };
        case 'date':
            return { local_date: '$local_date' };
    }
};

export const summary = async (query: SummaryQuery, caller: Caller): Promise<Array<Record<string, unknown>>> => {
    if (!isManagerOrAdmin(caller.role)) throw AppError.forbidden();
    const match: Record<string, unknown> = {};
    if (query.user_id) match.user_id = new Types.ObjectId(query.user_id);
    if (query.project_id) match.project_id = new Types.ObjectId(query.project_id);
    if (query.task_id) match.task_id = new Types.ObjectId(query.task_id);
    if (query.from_date && query.to_date) {
        match.local_date = { $gte: query.from_date, $lte: query.to_date };
    } else if (query.from_date) {
        match.local_date = { $gte: query.from_date };
    } else if (query.to_date) {
        match.local_date = { $lte: query.to_date };
    }

    const rows = await TimesheetEntry.aggregate<{
        _id: Record<string, unknown>;
        billable_total_minutes: number;
        non_billable_total_minutes: number;
        total_minutes: number;
        entry_count: number;
    }>([
        { $match: match },
        {
            $group: {
                _id: groupKeyForBy(query.group_by),
                billable_total_minutes: { $sum: '$billable_total_minutes' },
                non_billable_total_minutes: { $sum: '$non_billable_total_minutes' },
                total_minutes: { $sum: '$total_minutes' },
                entry_count: { $sum: 1 },
            },
        },
        { $sort: { total_minutes: -1 } },
    ]);

    return rows.map((r) => ({
        group_key: r._id,
        billable_total_minutes: r.billable_total_minutes,
        non_billable_total_minutes: r.non_billable_total_minutes,
        total_minutes: r.total_minutes,
        entry_count: r.entry_count,
    }));
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
