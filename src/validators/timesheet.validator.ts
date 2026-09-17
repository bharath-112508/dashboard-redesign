import { z } from 'zod';

import {
    TIMESHEET_DESCRIPTION_MAX,
    TIMESHEET_ENTRY_TYPES,
    TIMESHEET_GENERAL_CATEGORY_MAX,
    isGeneralCategoryValid,
    TIMESHEET_HOURS_MAX,
    TIMESHEET_LIST_DEFAULT_LIMIT,
    TIMESHEET_LIST_MAX_LIMIT,
    TIMESHEET_MINUTES_MAX,
    TIMESHEET_IMPORT_MAX_ROWS,
    TIMESHEET_SUMMARY_GROUP_BY,
} from '../constants/timesheet.js';

/**
 * Zod schemas for `/timesheets/*` (API_Contract.md §9.1–9.4 /
 * BUILD_PROGRESS.md Step 23).
 *
 * The shape splits along `entry_type`:
 *   - `task_linked` → `project_id` + `task_id` are required, `general_category` must be null.
 *   - `general`     → `project_id` and `general_category` are each optional
 *                     but at least ONE is required (a category attributes
 *                     time that belongs to no project), `task_id` must be null.
 *
 * We use a discriminated union so Zod gives a useful per-branch error
 * instead of a fan of "expected/forbidden" messages on every field.
 *
 * Cross-field rules that require *runtime* state (project visibility,
 * `local_date <= today`, billable+non-billable > 0) live in the service
 * — duplicating them here would couple the validator to the date module
 * and the project ACL.
 */

const objectIdSchema = z.string().regex(/^[a-f0-9]{24}$/i, 'Must be a valid ObjectId');

/**
 * Notes are mandatory on every entry: a logged hour that says nothing about
 * what was done is unreviewable, and the whole point of the project rollups
 * is that someone can read them later.
 *
 * Enforced HERE and not on the model. `description` on `timesheet_entries`
 * stays `default: ''` with no `required`, because Mongoose rejects an empty
 * string for a required String — every entry logged before this rule would
 * then fail validation on `entry.save()` when someone edited an unrelated
 * field, e.g. correcting the hours. History stays saveable; new input must
 * carry notes.
 *
 * On PATCH the KEY is optional (you may edit just the hours) but the VALUE
 * can never be blanked, which is what `.min(1)` buys on the partial schema.
 */
const descriptionSchema = z
    .string()
    .trim()
    .min(1, 'Add a note describing what you worked on.')
    .max(TIMESHEET_DESCRIPTION_MAX);
const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be a YYYY-MM-DD date');

// Shared duration shape — same on create and patch. Every entry splits its
// time across three parallel buckets: billable, non-billable, and idle
// (non-productive downtime). Idle fields default to 0 so existing clients
// that don't send them keep working.
const durationSchema = z.object({
    billable_hours: z.number().int().min(0).max(TIMESHEET_HOURS_MAX),
    billable_minutes: z.number().int().min(0).max(TIMESHEET_MINUTES_MAX),
    non_billable_hours: z.number().int().min(0).max(TIMESHEET_HOURS_MAX),
    non_billable_minutes: z.number().int().min(0).max(TIMESHEET_MINUTES_MAX),
    idle_hours: z.number().int().min(0).max(TIMESHEET_HOURS_MAX).default(0),
    idle_minutes: z.number().int().min(0).max(TIMESHEET_MINUTES_MAX).default(0),
});

// ─── POST /timesheets ────────────────────────────────────────────────────

const taskLinkedCreateSchema = z
    .object({
        local_date: isoDateSchema,
        entry_type: z.literal(TIMESHEET_ENTRY_TYPES.TASK_LINKED),
        project_id: objectIdSchema,
        sprint_id: objectIdSchema.optional().nullable(),
        task_id: objectIdSchema,
        general_category: z.null().optional(),
        description: descriptionSchema,
    })
    .extend(durationSchema.shape);

// An hour is attributed to a PROJECT or to a CATEGORY, at least one of the two.
// Requiring a project on every row (the rule this replaces) meant meetings,
// internal discussion, support and training either got charged to a client
// project nobody was working on, or went unlogged. Making the category a
// closed list is the other half: free text could not be grouped or charted,
// so it drifted into a second description box.
const generalCreateSchema = z
    .object({
        local_date: isoDateSchema,
        entry_type: z.literal(TIMESHEET_ENTRY_TYPES.GENERAL),
        /**
         * OPTIONAL on a general entry. Meetings, internal discussion, support
         * and training are real work that belongs to no project, and forcing
         * a project on them meant people either attributed the hours to a
         * client project they were not working on, or did not log them.
         *
         * The category below is what keeps the hour attributable when this is
         * absent — see the refine.
         */
        project_id: objectIdSchema.nullable().optional(),
        sprint_id: z.null().optional(),
        task_id: z.null().optional(),
        /**
         * Free text WITH a project (the area worked on — "Payroll module"),
         * one of `TIMESHEET_GENERAL_CATEGORIES` WITHOUT one. The refine below
         * is what enforces the difference; the string bounds here are the
         * column's, and apply either way.
         */
        general_category: z.string().trim().min(1).max(TIMESHEET_GENERAL_CATEGORY_MAX).nullable().optional(),
        description: descriptionSchema,
    })
    .extend(durationSchema.shape)
    .refine((d) => isGeneralCategoryValid(d.general_category, Boolean(d.project_id)), {
        // The invariant that replaces "project is mandatory": an hour is
        // attributable to a PROJECT or to a CATEGORY. Dropping both would put
        // the row outside every rollup, findable only by listing timesheets —
        // and a free-text category could not carry that load alone.
        message: 'Pick a project, or choose what this time was for.',
        path: ['general_category'],
    });

export const createTimesheetBodySchema = z.discriminatedUnion('entry_type', [
    taskLinkedCreateSchema,
    generalCreateSchema,
]);
export type CreateTimesheetBody = z.infer<typeof createTimesheetBodySchema>;

// ─── PATCH /timesheets/:id ───────────────────────────────────────────────
//
// PATCH does NOT allow swapping `entry_type` — that's effectively a
// different row. Edits cover hours/minutes, description, and (for
// task_linked) sprint/task drift.

export const patchTimesheetBodySchema = z
    .object({
        billable_hours: z.number().int().min(0).max(TIMESHEET_HOURS_MAX),
        billable_minutes: z.number().int().min(0).max(TIMESHEET_MINUTES_MAX),
        non_billable_hours: z.number().int().min(0).max(TIMESHEET_HOURS_MAX),
        non_billable_minutes: z.number().int().min(0).max(TIMESHEET_MINUTES_MAX),
        idle_hours: z.number().int().min(0).max(TIMESHEET_HOURS_MAX),
        idle_minutes: z.number().int().min(0).max(TIMESHEET_MINUTES_MAX),
        description: descriptionSchema,
        // Both nullable: on a general entry either one may be cleared, as long
        // as the OTHER still attributes the time. That pairwise rule needs the
        // stored row to evaluate — and so does whether this may be free text —
        // so `updateEntry` enforces both post-merge rather than the schema
        // guessing at what isn't in the patch.
        general_category: z.string().trim().min(1).max(TIMESHEET_GENERAL_CATEGORY_MAX).nullable(),
        project_id: objectIdSchema.nullable(),
        sprint_id: objectIdSchema.nullable(),
        task_id: objectIdSchema,
    })
    .partial()
    .refine((d) => Object.keys(d).length > 0, { message: 'At least one field must be supplied' });
export type PatchTimesheetBody = z.infer<typeof patchTimesheetBodySchema>;

// ─── GET /timesheets/me & /timesheets ────────────────────────────────────
//
// Manager list adds `user_id`; self list omits it. We accept both shapes
// in one schema and let the service filter — managers see everything,
// non-managers get their own row regardless of any `user_id` they pass.

export const listTimesheetsQuerySchema = z
    .object({
        user_id: objectIdSchema.optional(),
        project_id: objectIdSchema.optional(),
        task_id: objectIdSchema.optional(),
        from_date: isoDateSchema.optional(),
        to_date: isoDateSchema.optional(),
        page: z.coerce.number().int().min(1).default(1),
        limit: z.coerce.number().int().min(1).max(TIMESHEET_LIST_MAX_LIMIT).default(TIMESHEET_LIST_DEFAULT_LIMIT),
    })
    .strict();
export type ListTimesheetsQuery = z.infer<typeof listTimesheetsQuerySchema>;

// ─── GET /timesheets/summary ─────────────────────────────────────────────

export const summaryQuerySchema = z.object({
    user_id: objectIdSchema.optional(),
    project_id: objectIdSchema.optional(),
    task_id: objectIdSchema.optional(),
    from_date: isoDateSchema.optional(),
    to_date: isoDateSchema.optional(),
    group_by: z.enum(TIMESHEET_SUMMARY_GROUP_BY).default('project'),
});
export type SummaryQuery = z.infer<typeof summaryQuerySchema>;

// ─── Path params ─────────────────────────────────────────────────────────

export const timesheetIdPathSchema = z.object({ id: objectIdSchema });
export type TimesheetIdPath = z.infer<typeof timesheetIdPathSchema>;

export const dayDatePathSchema = z.object({ date: isoDateSchema });
export type DayDatePath = z.infer<typeof dayDatePathSchema>;

// ─── POST /timesheets/import[/preview] ───────────────────────────────────

/**
 * One row as it came out of the user's spreadsheet.
 *
 * Deliberately NOT `createTimesheetBodySchema`. That schema speaks the
 * database's language — resolved ObjectIds, hours split from minutes — and a
 * spreadsheet speaks the user's: a project CODE or name, a ticket key, and
 * decimal hours. Resolving one into the other is the service's job, and
 * keeping the wire format close to the file is what lets an error name the
 * cell the user actually has to fix.
 */
const importRowSchema = z.object({
    /**
     * 1-based line in the source file, carried through so every error can
     * point at a row the user can find. Assigned by the parser, not typed by
     * anyone — without it, "row 12 is invalid" means the twelfth VALID row,
     * which is not where the mistake is.
     */
    row_number: z.number().int().min(1),
    date: isoDateSchema,
    /** Project code (`TEM2`) or a name; the service resolves and rejects an
     *  ambiguous name rather than guessing. */
    project: z.string().trim().min(1, 'Name a project.'),
    /** `TEM2-142`. Present ⇒ the row becomes a task-linked entry. */
    ticket: z.string().trim().min(1).optional().nullable(),
    /** `general_category`. Ignored on ticket rows. */
    context: z.string().trim().max(TIMESHEET_GENERAL_CATEGORY_MAX).optional().nullable(),
    /** DECIMAL hours as typed in the sheet (`3.5`), not hours + minutes. */
    billable: z.number().min(0).max(TIMESHEET_HOURS_MAX).default(0),
    non_billable: z.number().min(0).max(TIMESHEET_HOURS_MAX).default(0),
    notes: descriptionSchema,
});

export const timesheetImportBodySchema = z.object({
    // `.min(1)` so an empty file is a clear 400 rather than a successful
    // import of nothing. Over the cap is refused, never truncated — silently
    // importing the first 500 rows of a 700-row sheet loses billable hours.
    rows: z.array(importRowSchema).min(1, 'The file has no rows.').max(TIMESHEET_IMPORT_MAX_ROWS),
});

export type TimesheetImportRow = z.infer<typeof importRowSchema>;
export type TimesheetImportBody = z.infer<typeof timesheetImportBodySchema>;
