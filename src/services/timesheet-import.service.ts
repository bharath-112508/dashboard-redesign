import { Types } from 'mongoose';

import { Project } from '../models/project.model.js';
import { Task } from '../models/task.model.js';
import { TimesheetEntry } from '../models/timesheet-entry.model.js';
import {
    TIMESHEET_ENTRY_TYPES,
    TIMESHEET_GENERAL_CATEGORIES,
    TIMESHEET_HOURS_MAX,
    TIMESHEET_NO_PROJECT_LABEL,
} from '../constants/timesheet.js';
import type { TimesheetImportRow } from '../validators/timesheet.validator.js';
import dayjs, { DEFAULT_TIMEZONE, DATE_FORMAT } from '../utils/date.js';
import { buildProjectVisibilityFilter } from './project.service.js';
import { recordAudit, type AuditContext } from './audit.service.js';
import { withTransaction } from '../utils/with-transaction.js';
import { AppError } from '../utils/app-error.js';
import { ERROR_CODES } from '../constants/error-codes.js';
import { AUDIT_ACTIONS, AUDIT_TARGET_KINDS } from '../constants/audit.js';
import { exceedsDailyThreshold, loadPolicy, overlapsApprovedLeave, sumDailyTotalMinutes } from './timesheet.service.js';
import type { ProjectCaller } from './project.service.js';

/**
 * Bulk timesheet import — resolution and validation.
 *
 * Turns rows as they came out of a spreadsheet (a project CODE or name, a
 * ticket key, decimal hours) into the shape `createEntry` wants (ObjectIds,
 * hours split from minutes), applying the same rules a single-entry create
 * applies.
 *
 * `validateImportRows` is the ONE place those rules live. Preview and commit
 * both call it, and the commit re-runs it from scratch rather than trusting
 * what the preview returned — a project can be archived, or an entry added
 * from Slack or the web, in between. A preview whose verdict the commit does
 * not reproduce is a preview that lies.
 *
 * Import only ever CREATES. It never edits or deletes, and it never replaces
 * what is already logged on a date — see `previewImport`'s collisions.
 */

/** `TEM2-142` → the project code and the per-project task number. */
const TICKET_KEY = /^([A-Za-z0-9_]+)-(\d+)$/;

/**
 * Match a category cell against the managed list, returning the CANONICAL
 * spelling, or null when it isn't one of them.
 *
 * Case- and space-insensitive, unlike the single-entry path: there the value
 * comes from a `<Select>` and can only be exact, here somebody typed it into
 * a spreadsheet. Blocking a file over "meeting" versus "Meeting" would be
 * pedantry. The canonical value is what gets stored, so the hour still groups
 * with every other one of its kind.
 */
const canonicalGeneralCategory = (raw: string | null): string | null => {
    if (!raw) return null;
    const needle = raw.trim().toLowerCase();
    return TIMESHEET_GENERAL_CATEGORIES.find((c) => c.toLowerCase() === needle) ?? null;
};

export interface ResolvedImportRow {
    local_date: string;
    entry_type: string;
    /** Null on a general row that names no project — see the category rule
     *  in `validateImportRows`. */
    project_id: Types.ObjectId | null;
    task_id: Types.ObjectId | null;
    general_category: string | null;
    billable_hours: number;
    billable_minutes: number;
    non_billable_hours: number;
    non_billable_minutes: number;
    description: string;
}

export interface ImportRowVerdict {
    /** 1-based line in the SOURCE FILE, so an error points at a row the user
     *  can actually find. Never the index in this array. */
    row_number: number;
    ok: boolean;
    /** Why it was blocked. Written to be actionable on its own. */
    reason?: string;
    /** Human-readable project, echoed so the user can eyeball the match a
     *  code or name resolved to before committing. */
    project_label?: string;
    resolved?: ResolvedImportRow;
}

export interface ImportCollision {
    date: string;
    existing_entries: number;
    existing_minutes: number;
}

export interface ImportWarning {
    date: string;
    reason: string;
}

/** Decimal hours (`3.5`) → whole hours + minutes, to the nearest minute. */
const toHoursMinutes = (decimal: number): { hours: number; minutes: number } => {
    const total = Math.round(decimal * 60);
    return { hours: Math.floor(total / 60), minutes: total % 60 };
};

const minutesOf = (r: ResolvedImportRow): number =>
    r.billable_hours * 60 + r.billable_minutes + r.non_billable_hours * 60 + r.non_billable_minutes;

const todayLocal = (): string => dayjs().tz(DEFAULT_TIMEZONE).format(DATE_FORMAT);

interface ProjectRow {
    _id: Types.ObjectId;
    code?: string;
    name?: string;
}

/**
 * Index the caller's VISIBLE projects by code and by name.
 *
 * Scoped with `buildProjectVisibilityFilter` — the same helper every other
 * project read uses. This is the authorization boundary for resolution: a
 * project the caller cannot open must not become resolvable just because
 * they typed its code into a spreadsheet.
 *
 * Names map to a LIST, not a single project, because they are not unique —
 * live data already carries two projects called `Template-1`. Collapsing
 * that to one would silently log hours against whichever came back first.
 */
const indexProjects = async (caller: ProjectCaller) => {
    const rows = (await Project.find({ ...buildProjectVisibilityFilter(caller), is_archived: false })
        .select('code name')
        .lean()) as unknown as ProjectRow[];

    const byCode = new Map<string, ProjectRow>();
    const byName = new Map<string, ProjectRow[]>();
    for (const p of rows) {
        if (p.code) byCode.set(p.code.toUpperCase(), p);
        const key = (p.name ?? '').trim().toLowerCase();
        if (key) byName.set(key, [...(byName.get(key) ?? []), p]);
    }
    // `ids` covers EVERY visible project, not just the ones with a code.
    // The ticket lookup scopes by it, and scoping by `byCode` instead would
    // silently fail to find tickets on a code-less project referenced by
    // name — every project has a code today, so it would have stayed hidden.
    return { byCode, byName, ids: rows.map((p) => p._id) };
};

type ProjectIndex = Awaited<ReturnType<typeof indexProjects>>;

/** Resolve one row's project cell. Returns the project or a blocking reason. */
const resolveProject = (raw: string, index: ProjectIndex): { project: ProjectRow } | { reason: string } => {
    const trimmed = raw.trim();

    const byCode = index.byCode.get(trimmed.toUpperCase());
    if (byCode) return { project: byCode };

    const named = index.byName.get(trimmed.toLowerCase()) ?? [];
    if (named.length === 1) return { project: named[0]! };
    if (named.length > 1) {
        // Name the candidates. "Ambiguous" on its own leaves the user with no
        // way to fix the row.
        const codes = named
            .map((p) => p.code)
            .filter(Boolean)
            .join(', ');
        return { reason: `"${trimmed}" matches ${named.length} projects — use the code instead (${codes}).` };
    }
    return { reason: `"${trimmed}" is not a project you can log time against.` };
};

export interface ValidateResult {
    rows: ImportRowVerdict[];
}

/**
 * Validate and resolve every row. Never throws for a bad row — a bad row is
 * data, not an exception, and the caller needs ALL the failures at once.
 * Reporting one error per upload turns fixing a sheet into a guessing game.
 */
export const validateImportRows = async (
    rows: TimesheetImportRow[],
    caller: ProjectCaller
): Promise<ValidateResult> => {
    const index = await indexProjects(caller);

    // Tickets are looked up in ONE query for the whole file rather than one
    // per row: a month of task-linked rows would otherwise be 60 round trips.
    const wantedTickets = rows
        .map((r) => (r.ticket ? TICKET_KEY.exec(r.ticket.trim()) : null))
        .filter((m): m is RegExpExecArray => m !== null);
    const taskNumbers = [...new Set(wantedTickets.map((m) => Number(m[2])))];
    const tasks = taskNumbers.length
        ? ((await Task.find({ project_id: { $in: index.ids }, task_number: { $in: taskNumbers } })
              .select('task_number project_id')
              .lean()) as unknown as { _id: Types.ObjectId; task_number: number; project_id: Types.ObjectId }[])
        : [];
    const taskKey = (projectId: Types.ObjectId, num: number) => `${String(projectId)}:${num}`;
    const taskByKey = new Map(tasks.map((t) => [taskKey(t.project_id, t.task_number), t]));

    const today = todayLocal();

    const verdicts: ImportRowVerdict[] = rows.map((r) => {
        const blocked = (reason: string): ImportRowVerdict => ({ row_number: r.row_number, ok: false, reason });

        if (r.date > today) return blocked(`${r.date} is in the future.`);

        // OPTIONAL. An hour is attributed to a project OR to a category, at
        // least one of the two — so a row for a meeting, training or support
        // legitimately names no project. This importer was written when a
        // project was mandatory on every row, which made internal time
        // impossible to import at all. Empty means "general"; filled in but
        // unmatched is still an error, since optional is not the same as
        // ignored when wrong.
        const projectCell = (r.project ?? '').trim();
        let project: ProjectRow | null = null;
        if (projectCell) {
            const resolved = resolveProject(r.project, index);
            if ('reason' in resolved) return blocked(resolved.reason);
            project = resolved.project;
        }
        const label = project ? (project.name ?? project.code ?? '') : TIMESHEET_NO_PROJECT_LABEL;

        let task: Types.ObjectId | null = null;
        if (r.ticket && !project) {
            // A ticket belongs to a project. Naming one without the other is
            // a gap in the sheet, not an intent to log general time.
            return blocked(`Ticket "${r.ticket}" needs its project — fill in the project column.`);
        }
        if (r.ticket && project) {
            const m = TICKET_KEY.exec(r.ticket.trim());
            if (!m) return blocked(`"${r.ticket}" is not a ticket key — expected something like NMF-142.`);
            const hit = taskByKey.get(taskKey(project._id, Number(m[2])));
            if (!hit) {
                // Either it does not exist, or it belongs to another project.
                // Both mean the same thing to the user: this ticket is not on
                // the project this row names.
                return blocked(`Ticket "${r.ticket}" is not on ${label}.`);
            }
            task = hit._id;
        }

        const billable = toHoursMinutes(r.billable);
        const nonBillable = toHoursMinutes(r.non_billable);
        const total = billable.hours * 60 + billable.minutes + nonBillable.hours * 60 + nonBillable.minutes;

        if (total === 0) return blocked('No time on either side — set billable or non-billable hours.');
        if (total > TIMESHEET_HOURS_MAX * 60) {
            return blocked(`A single entry cannot exceed ${TIMESHEET_HOURS_MAX} hours.`);
        }

        // The validator's discriminated union refuses a category on a
        // task-linked entry, so a ticket row drops it rather than failing at
        // write time with an error about a field the user never saw.
        const rawCategory = task ? null : r.context?.trim() || null;
        let category = rawCategory;
        if (!task && !project) {
            // With no project the category is the ONLY thing attributing the
            // hour, so it has to be groupable — free text can't be charted or
            // filtered, and internal time would be as invisible as it was
            // when it had no project either. Mirrors `isGeneralCategoryValid`
            // on the single-entry path.
            category = canonicalGeneralCategory(rawCategory);
            if (!category) {
                return blocked(
                    rawCategory
                        ? `"${rawCategory}" is not a category. With no project, use one of: ${TIMESHEET_GENERAL_CATEGORIES.join(', ')}.`
                        : `Give a project, or a category — one of: ${TIMESHEET_GENERAL_CATEGORIES.join(', ')}.`
                );
            }
        }

        return {
            row_number: r.row_number,
            ok: true,
            project_label: label,
            resolved: {
                local_date: r.date,
                entry_type: task ? TIMESHEET_ENTRY_TYPES.TASK_LINKED : TIMESHEET_ENTRY_TYPES.GENERAL,
                project_id: project ? project._id : null,
                task_id: task,
                general_category: category,
                billable_hours: billable.hours,
                billable_minutes: billable.minutes,
                non_billable_hours: nonBillable.hours,
                non_billable_minutes: nonBillable.minutes,
                description: r.notes.trim(),
            },
        };
    });

    return { rows: verdicts };
};

export interface PreviewResult {
    rows: ImportRowVerdict[];
    collisions: ImportCollision[];
    warnings: ImportWarning[];
    summary: {
        total_rows: number;
        ok_rows: number;
        blocked_rows: number;
        billable_minutes: number;
        non_billable_minutes: number;
    };
}

/**
 * Dry run. Resolves and validates, then reports two things a per-row check
 * cannot see:
 *
 *  - **Collisions** — dates that already have time logged. Import ADDS, it
 *    never replaces, so a re-upload doubles a day unless the user sees this
 *    first. Several entries per day are legitimate, which is exactly why we
 *    cannot dedupe automatically.
 *  - **Warnings** — a day's total across the whole FILE plus what is already
 *    logged. No single row breaks any rule when a sheet puts three 4h rows on
 *    one date, and nothing on the single-entry path would ever catch it.
 *    Surfaced as a warning, not a block, matching how this codebase already
 *    treats daily hours.
 */
export const previewImport = async (rows: TimesheetImportRow[], caller: ProjectCaller): Promise<PreviewResult> => {
    const { rows: verdicts } = await validateImportRows(rows, caller);
    const ok = verdicts.filter((v) => v.ok && v.resolved);

    const dates = [...new Set(ok.map((v) => v.resolved!.local_date))];

    const existing = dates.length
        ? ((await TimesheetEntry.find({ user_id: caller.id, local_date: { $in: dates } })
              .select('local_date total_minutes')
              .lean()) as unknown as { local_date: string; total_minutes?: number }[])
        : [];

    const collisions: ImportCollision[] = dates
        .map((date) => {
            const on = existing.filter((e) => e.local_date === date);
            return {
                date,
                existing_entries: on.length,
                existing_minutes: on.reduce((acc, e) => acc + (e.total_minutes ?? 0), 0),
            };
        })
        .filter((c) => c.existing_entries > 0);

    const policy = await loadPolicy();
    const warnings: ImportWarning[] = [];
    for (const date of dates) {
        const fromFile = ok
            .filter((v) => v.resolved!.local_date === date)
            .reduce((acc, v) => acc + minutesOf(v.resolved!), 0);
        const alreadyLogged = collisions.find((c) => c.date === date)?.existing_minutes ?? 0;

        if (exceedsDailyThreshold(fromFile + alreadyLogged, policy.dailyWarnThresholdHours)) {
            warnings.push({
                date,
                reason: `${((fromFile + alreadyLogged) / 60).toFixed(2)}h on this day is over the ${policy.dailyWarnThresholdHours}h threshold.`,
            });
        }
        if (await overlapsApprovedLeave(caller.id, date)) {
            warnings.push({ date, reason: 'You have approved leave on this day.' });
        }
    }

    return {
        rows: verdicts,
        collisions,
        warnings,
        summary: {
            total_rows: verdicts.length,
            ok_rows: ok.length,
            blocked_rows: verdicts.length - ok.length,
            billable_minutes: ok.reduce(
                (acc, v) => acc + v.resolved!.billable_hours * 60 + v.resolved!.billable_minutes,
                0
            ),
            non_billable_minutes: ok.reduce(
                (acc, v) => acc + v.resolved!.non_billable_hours * 60 + v.resolved!.non_billable_minutes,
                0
            ),
        },
    };
};

/** Re-exported so the controller can report a day's running total without
 *  reaching into `timesheet.service` itself. */
export { sumDailyTotalMinutes };

export interface CommitResult {
    imported: number;
    dates: { from: string; to: string };
}

/**
 * Write the file. ALL-OR-NOTHING: one transaction, and any blocked row aborts
 * the whole import before anything is written.
 *
 * Re-validates from scratch rather than trusting what the preview returned. A
 * project can be archived, or an entry added from Slack or the web, between
 * the two calls — and a client could simply post rows the preview never saw.
 * Trusting a "already validated" flag from the caller would be both a
 * correctness hole and an authorization one.
 *
 * DEVIATION from the design doc, deliberately: the doc proposed threading a
 * session through `createEntry` so import reused the real create path. That
 * does not survive contact with the preview — a dry run must not write, so
 * `validateImportRows` already had to carry the rules. Routing the commit
 * through `createEntry` as well would mean validating twice against two
 * copies of the rules, which is the drift it was meant to prevent. The rules
 * live in `validateImportRows` alone; `timesheet-import.rules.test.ts` pins
 * them against `createEntry`'s.
 */
export const commitImport = async (
    rows: TimesheetImportRow[],
    caller: ProjectCaller,
    audit?: AuditContext
): Promise<CommitResult> => {
    const { rows: verdicts } = await validateImportRows(rows, caller);

    const blocked = verdicts.filter((v) => !v.ok);
    if (blocked.length > 0) {
        // The user previewed and confirmed, so reaching here means something
        // changed underneath them. Hand back the same per-row shape the
        // preview uses so the UI can render it without a second code path.
        throw AppError.unprocessable(
            'Some rows are no longer valid — preview the file again.',
            ERROR_CODES.TIMESHEET_IMPORT_STALE,
            { rows: blocked }
        );
    }

    const resolved = verdicts.map((v) => v.resolved!);
    const dates = resolved.map((r) => r.local_date).sort();

    await withTransaction(async (session) => {
        await TimesheetEntry.insertMany(
            resolved.map((r) => ({
                user_id: caller.id,
                local_date: r.local_date,
                entry_type: r.entry_type,
                project_id: r.project_id,
                sprint_id: null,
                task_id: r.task_id,
                general_category: r.general_category,
                billable_hours: r.billable_hours,
                billable_minutes: r.billable_minutes,
                non_billable_hours: r.non_billable_hours,
                non_billable_minutes: r.non_billable_minutes,
                idle_hours: 0,
                idle_minutes: 0,
                billable_total_minutes: r.billable_hours * 60 + r.billable_minutes,
                non_billable_total_minutes: r.non_billable_hours * 60 + r.non_billable_minutes,
                idle_total_minutes: 0,
                total_minutes: minutesOf(r),
                description: r.description,
                last_edited_by: caller.id,
            })),
            // `ordered: true` — stop at the first failure so the transaction
            // aborts cleanly rather than writing a prefix.
            { session, ordered: true }
        );

        if (audit) {
            // ONE row for the import, not one per entry.
            await recordAudit(audit, {
                action: AUDIT_ACTIONS.TIMESHEET_IMPORT,
                target: { kind: AUDIT_TARGET_KINDS.TIMESHEET_ENTRY, id: caller.id },
                metadata: {
                    imported: resolved.length,
                    from_date: dates[0],
                    to_date: dates[dates.length - 1],
                },
            });
        }
    });

    return {
        imported: resolved.length,
        dates: { from: dates[0] ?? '', to: dates[dates.length - 1] ?? '' },
    };
};
