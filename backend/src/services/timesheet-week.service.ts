import { Types } from 'mongoose';
import { TimesheetWeek, type TimesheetWeekDocument } from '../models/timesheet-week.model.js';
import { AppError } from '../utils/app-error.js';
import { ERROR_CODES } from '../constants/error-codes.js';
import { ROLES } from '../constants/roles.js';
import { AUDIT_ACTIONS, AUDIT_TARGET_KINDS } from '../constants/audit.js';
import { recordAudit } from './audit.service.js';
import { scopedUserIdFilter } from './reporting-scope.service.js';
import type { ProjectCaller } from './project.service.js';

/** The Monday of a YYYY-MM-DD date, as YYYY-MM-DD. */
export const weekOf = (date: string): string => {
    const d = new Date(`${date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    return d.toISOString().slice(0, 10);
};

const assertMonday = (week: string) => {
    if (weekOf(week) !== week) throw AppError.unprocessable('A week starts on a Monday', ERROR_CODES.VALIDATION_ERROR);
};

const toPublic = (doc: TimesheetWeekDocument) => ({
    id: doc._id.toString(),
    user_id: doc.user_id.toString(),
    week_start: doc.week_start,
    submitted_at: doc.submitted_at,
});

/** Team reviewers (the same roles that read the team timesheet). */
const isReviewer = (role: string) => role === ROLES.ADMIN || role === ROLES.MANAGER || role === ROLES.TEAM_LEAD;
const isManagerOrAdmin = (role: string) => role === ROLES.ADMIN || role === ROLES.MANAGER;

/** Refuses a change to time in a week that is submitted (409). */
export const assertWeekOpen = async (userId: Types.ObjectId, date: string): Promise<void> => {
    if (await TimesheetWeek.exists({ user_id: userId, week_start: weekOf(date) })) {
        throw AppError.conflict('This week is submitted. Reopen it to change its time.', ERROR_CODES.TIMESHEET_WEEK_SUBMITTED);
    }
};

// ─── GET /timesheets/weeks ───────────────────────────────────────────────

export const listWeeks = async (
    query: { from_date?: string; to_date?: string; user_id?: string },
    caller: ProjectCaller
): Promise<ReturnType<typeof toPublic>[]> => {
    const filter: Record<string, unknown> = {};
    if (isReviewer(caller.role)) {
        const scoped = await scopedUserIdFilter(caller, query.user_id);
        if (scoped !== undefined) filter.user_id = scoped;
    } else {
        filter.user_id = caller.id;
    }
    if (query.from_date || query.to_date) {
        filter.week_start = {
            ...(query.from_date ? { $gte: query.from_date } : {}),
            ...(query.to_date ? { $lte: query.to_date } : {}),
        };
    }
    // ponytail: capped at 2000 rows; a year of weekly rows for a 40-person team fits.
    const rows = await TimesheetWeek.find(filter).sort({ week_start: -1 }).limit(2000);
    return rows.map(toPublic);
};

// ─── PUT /timesheets/weeks/:week ─────────────────────────────────────────

export const submitWeek = async (week: string, caller: ProjectCaller) => {
    assertMonday(week);
    // Submitting twice keeps the first submission.
    const doc = await TimesheetWeek.findOneAndUpdate(
        { user_id: caller.id, week_start: week },
        { $setOnInsert: { user_id: caller.id, week_start: week, submitted_at: new Date() } },
        { upsert: true, new: true }
    );
    if (caller.audit) {
        await recordAudit(caller.audit, {
            action: AUDIT_ACTIONS.TIMESHEET_WEEK_SUBMIT,
            target: { kind: AUDIT_TARGET_KINDS.TIMESHEET_WEEK, id: doc._id },
            after: toPublic(doc),
        });
    }
    return toPublic(doc);
};

// ─── DELETE /timesheets/weeks/:week ──────────────────────────────────────

export const reopenWeek = async (week: string, userId: string | undefined, caller: ProjectCaller): Promise<{ reopened: true }> => {
    assertMonday(week);
    const target = userId ? new Types.ObjectId(userId) : caller.id;
    if (!target.equals(caller.id) && !isManagerOrAdmin(caller.role)) {
        throw AppError.forbidden('Only a manager can reopen someone else\'s week');
    }
    await TimesheetWeek.deleteOne({ user_id: target, week_start: week });
    if (caller.audit) {
        await recordAudit(caller.audit, {
            action: AUDIT_ACTIONS.TIMESHEET_WEEK_REOPEN,
            target: { kind: AUDIT_TARGET_KINDS.TIMESHEET_WEEK, id: target },
            metadata: { user_id: target.toString(), week_start: week },
        });
    }
    return { reopened: true };
};
