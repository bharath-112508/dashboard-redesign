import { Types } from 'mongoose';

import { User } from '../models/user.model.js';
import { AttendanceRecord } from '../models/attendance-record.model.js';
import { Holiday } from '../models/holiday.model.js';
import { LeaveRequest } from '../models/leave-request.model.js';
import { ROLES } from '../constants/roles.js';
import { USER_STATUSES } from '../constants/user-statuses.js';
import { LEAVE_REQUEST_STATUSES } from '../constants/leave.js';
import dayjs, { DEFAULT_TIMEZONE } from '../utils/date.js';
import { JOB_NAMES, JOB_USER_BATCH_SIZE, attendanceFinalizerRunKey } from '../constants/jobs.js';
import { runJob, type JobContext, type RunJobOptions, type RunJobResult } from './runner.js';

/**
 * 14.1 Attendance finalizer (Plan §8 row 1).
 *
 * Daily 23:00 IST. For "yesterday" (IST), for every active internal user:
 *
 *  - **No record** → insert a placeholder. The status depends on the day:
 *      * Holiday  → `holiday`
 *      * Weekend  → `weekend` (defined as: that weekday is NOT in
 *                  `system_settings.work_schedule.working_days`)
 *      * On approved leave for that date → `on_leave`
 *      * Else     → `absent`
 *  - **Has check-in but no check-out** → set `status = incomplete` +
 *    `flagged_for_correction = true` so the employee sees the missing-
 *    checkout chip on `/attendance/me`.
 *
 * Idempotency:
 *  - Run-key is the IST date being closed. The job_runs unique key absorbs
 *    duplicate fires for the same date.
 *  - Inserts use `{ user_id, local_date }` as the `$setOnInsert` upsert key,
 *    which is also the unique index on `attendance_records`. A user who
 *    checks in *during* the finalizer pass will already have a row and we
 *    won't overwrite it (their `present` row stays `present`).
 *
 * Runtime: streams `User.find().cursor()` in batches of `JOB_USER_BATCH_SIZE`
 * to keep memory flat as headcount climbs. Per-user errors are caught and
 * counted into the summary so a single bad row doesn't abort the whole run.
 */

interface FinalizerSettings {
    workingDays: readonly number[];
}

const loadFinalizerSettings = async (): Promise<FinalizerSettings> => {
    const { getOrInitSettings } = await import('../services/settings.service.js');
    const s = await getOrInitSettings();
    return { workingDays: s.work_schedule?.working_days ?? [1, 2, 3, 4, 5] };
};

const isWorkingWeekday = (date: string, workingDays: readonly number[]): boolean => {
    const dow = dayjs.tz(date, DEFAULT_TIMEZONE).day(); // 0..6
    return workingDays.includes(dow);
};

interface UserOnLeave {
    user_id: Types.ObjectId;
}

const usersOnApprovedLeaveOn = async (date: string): Promise<Set<string>> => {
    const rows = await LeaveRequest.find({
        status: LEAVE_REQUEST_STATUSES.APPROVED,
        start_date: { $lte: date },
        end_date: { $gte: date },
    }).select({ user_id: 1, _id: 0 });
    const set = new Set<string>();
    for (const r of rows as unknown as UserOnLeave[]) set.add(r.user_id.toString());
    return set;
};

interface FinalizerSummary extends Record<string, unknown> {
    target_date: string;
    users_processed: number;
    placeholders_inserted: number;
    incomplete_marked: number;
    holiday_inserts: number;
    weekend_inserts: number;
    on_leave_inserts: number;
    absent_inserts: number;
    skipped_existing: number;
    user_errors: number;
}

/**
 * Pure finalizer logic — exported for unit tests. The cron entry point
 * (`runAttendanceFinalizer`) wraps this with the runner / lock / audit.
 */
export const finalizeAttendanceForDate = async (
    targetDate: string,
    log: JobContext['log']
): Promise<FinalizerSummary> => {
    const summary: FinalizerSummary = {
        target_date: targetDate,
        users_processed: 0,
        placeholders_inserted: 0,
        incomplete_marked: 0,
        holiday_inserts: 0,
        weekend_inserts: 0,
        on_leave_inserts: 0,
        absent_inserts: 0,
        skipped_existing: 0,
        user_errors: 0,
    };

    const [{ workingDays }, isHoliday, onLeaveSet] = await Promise.all([
        loadFinalizerSettings(),
        Holiday.exists({ date: targetDate }).then((h) => !!h),
        usersOnApprovedLeaveOn(targetDate),
    ]);

    const isWeekend = !isWorkingWeekday(targetDate, workingDays);

    // Default placeholder status for missing rows depends on day type. We
    // still need per-user override for `on_leave`.
    const baseStatus: 'holiday' | 'weekend' | 'absent' = isHoliday ? 'holiday' : isWeekend ? 'weekend' : 'absent';

    // Step A — flip any "checked-in but never checked-out" rows.
    const incompleteFlip = await AttendanceRecord.updateMany(
        {
            local_date: targetDate,
            check_in: { $ne: null },
            check_out: null,
            status: { $ne: 'incomplete' },
        },
        {
            $set: {
                status: 'incomplete',
                flagged_for_correction: true,
            },
        }
    );
    summary.incomplete_marked = incompleteFlip.modifiedCount ?? 0;

    // Step A.1 — close any open break inside checked-in records for targetDate.
    //
    // A break is open when `segments[].breaks[].end` is null. We synthesize
    // the end time as 23:59:59 IST on targetDate (same approach as the finalizer
    // using end-of-day rather than recomputing per-user, keeping this bulk/no-JS).
    // We use the positional filtered operator ($[b]) with arrayFilters to target
    // only null-end breaks across all segments without fetching individual docs.
    const synthesizedBreakEnd = dayjs.tz(`${targetDate} 23:59:59`, DEFAULT_TIMEZONE).toDate();
    await AttendanceRecord.updateMany(
        {
            local_date: targetDate,
            check_in: { $ne: null },
            'segments.breaks': { $elemMatch: { end: null } },
        },
        {
            $set: { 'segments.$[s].breaks.$[b].end': { time: synthesizedBreakEnd, source: 'app' } },
        },
        {
            arrayFilters: [{ 's.check_out': null, 's.breaks': { $elemMatch: { end: null } } }, { 'b.end': null }],
        }
    );

    // Step B — insert placeholders for users with no row.
    //
    // We stream the user list to keep memory bounded. For each user we do an
    // upsert with `$setOnInsert` so a row inserted concurrently (e.g. the
    // user actually checked in mid-finalizer) is not overwritten.
    const cursor = User.find({
        status: USER_STATUSES.ACTIVE,
        role: { $ne: ROLES.CLIENT },
    })
        .select({ _id: 1, role: 1 })
        .batchSize(JOB_USER_BATCH_SIZE)
        .cursor();

    for await (const u of cursor) {
        summary.users_processed += 1;

        const userOnLeave = onLeaveSet.has(u._id.toString());
        const placeholderStatus: 'on_leave' | typeof baseStatus = userOnLeave ? 'on_leave' : baseStatus;

        try {
            const result = await AttendanceRecord.updateOne(
                { user_id: u._id, local_date: targetDate },
                {
                    $setOnInsert: {
                        user_id: u._id,
                        local_date: targetDate,
                        check_in: null,
                        check_out: null,
                        total_worked_minutes: null,
                        overtime_minutes: 0,
                        status: placeholderStatus,
                        flagged_for_correction: false,
                        wfh: false,
                        notes: '',
                    },
                },
                { upsert: true }
            );

            const inserted = (result.upsertedCount ?? 0) > 0;
            if (inserted) {
                summary.placeholders_inserted += 1;
                if (placeholderStatus === 'holiday') summary.holiday_inserts += 1;
                else if (placeholderStatus === 'weekend') summary.weekend_inserts += 1;
                else if (placeholderStatus === 'on_leave') summary.on_leave_inserts += 1;
                else summary.absent_inserts += 1;
            } else {
                summary.skipped_existing += 1;
            }
        } catch (err) {
            summary.user_errors += 1;
            try {
                log.warn(
                    { err, user_id: u._id.toString(), target_date: targetDate },
                    'Attendance finalizer per-user step failed'
                );
            } catch {
                // swallow
            }
        }
    }

    return summary;
};

/**
 * Cron entry point — wraps the pure finalizer in the shared runner so it
 * gets the idempotency lock + audit row + structured logging.
 */
export const runAttendanceFinalizer = (now: Date = new Date(), opts: RunJobOptions = {}): Promise<RunJobResult> => {
    const runKey = attendanceFinalizerRunKey(now);
    return runJob(
        JOB_NAMES.ATTENDANCE_FINALIZER,
        runKey,
        async (ctx) => finalizeAttendanceForDate(runKey, ctx.log),
        opts
    );
};
