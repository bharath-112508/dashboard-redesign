/**
 * Timesheet + billing-rate constants (Data_Model.md §6 / API_Contract.md §9 /
 * BUILD_PROGRESS.md Step 23).
 *
 * Timesheet entries capture both billable and non-billable time on the same
 * row (Data_Model §6.1). `entry_type` distinguishes a task-linked entry
 * (must reference a project + task the caller can see) from a "general"
 * entry (project is required too — task is null, and `general_category` is an
 * optional label such as meeting / training / admin on top of the project).
 *
 * Policy knobs live on `system_settings.timesheet`:
 *   - `self_edit_window_days`        — how long an employee can edit their
 *                                      own row before manager-only mode.
 *   - `daily_warn_threshold_hours`   — the soft cap that triggers a
 *                                      `warning.exceeds_daily_threshold`
 *                                      response flag (the entry is still
 *                                      persisted; never blocks).
 *
 * Billing rates have an effective date range and a four-key lookup
 * tuple `(user_id, project_id, task_id, effective_from)` per Data_Model
 * §6.2. Creating a new rate that overlaps an existing range for the
 * same `(user, project, task)` tuple auto-closes the predecessor's
 * `effective_to` to the day before the new row's `effective_from`.
 */

// ─── Field caps & shape ──────────────────────────────────────────────────

export const TIMESHEET_DESCRIPTION_MAX = 2_000;
export const TIMESHEET_GENERAL_CATEGORY_MAX = 64;

/** Hard upper bound on a single entry's hours field — anti-typo guard. */
export const TIMESHEET_HOURS_MAX = 24;
/** Minutes field on the row (per Data_Model: 0–59). */
export const TIMESHEET_MINUTES_MAX = 59;

/**
 * Allowed `entry_type` values. Stored as snake_case strings on the row.
 */
export const TIMESHEET_ENTRY_TYPES = {
    TASK_LINKED: 'task_linked',
    GENERAL: 'general',
} as const;
export type TimesheetEntryType = (typeof TIMESHEET_ENTRY_TYPES)[keyof typeof TIMESHEET_ENTRY_TYPES];
export const TIMESHEET_ENTRY_TYPE_VALUES: readonly TimesheetEntryType[] = Object.values(TIMESHEET_ENTRY_TYPES);

/**
 * Group-by keys for the summary endpoint. Anything outside this set is
 * a 400 from the validator.
 */
export const TIMESHEET_SUMMARY_GROUP_BY = ['user', 'project', 'task', 'date'] as const;
export type TimesheetSummaryGroupBy = (typeof TIMESHEET_SUMMARY_GROUP_BY)[number];

// ─── Pagination ──────────────────────────────────────────────────────────

export const TIMESHEET_LIST_DEFAULT_LIMIT = 20;
export const TIMESHEET_LIST_MAX_LIMIT = 200;

export const BILLING_RATE_LIST_DEFAULT_LIMIT = 20;
export const BILLING_RATE_LIST_MAX_LIMIT = 100;

// Step 47: route gates use `requirePermission(timesheet.read/write,
// billing_rate.read/write, timesheet.edit_out_of_window)`. The
// service layer's `isManagerOrAdmin` helper still gates per-row
// "manager moderates anyone" semantics (see `timesheet.service.ts`).

// ─── Defaults the service falls back to when settings are missing ────────
//
// Mirrors `constants/settings.ts:DEFAULT_SETTINGS.timesheet`. Duplicated
// here so a service that needs the cap before the settings doc is loaded
// (e.g. validator default) doesn't have to import the heavy settings
// module.

export const TIMESHEET_DEFAULT_SELF_EDIT_WINDOW_DAYS = 7;
export const TIMESHEET_DEFAULT_DAILY_WARN_THRESHOLD_HOURS = 8;

/**
 * Hard ceiling on a single timesheet export.
 *
 * Deliberately far above the 200-row list cap: an export is a deliberate,
 * one-off action, not a page render. If a window genuinely exceeds this the
 * file still downloads and says on its face that it was truncated, rather
 * than silently handing over a short one.
 */
export const TIMESHEET_EXPORT_MAX_ROWS = 5000;

// ─── General-entry categories ────────────────────────────────────────────

/**
 * What a general entry with NO PROJECT was for.
 *
 * A fixed list, and only on the project-less path. There, `general_category`
 * is the sole thing attributing the hour, so it has to be groupable: free text
 * cannot be charted or filtered — it drifted into a second description box
 * ("Testing the login flow", "test") — and internal time would be as invisible
 * as it was back when it had no project at all.
 *
 * With a project chosen the field carries no reporting load (the project does)
 * and stays FREE TEXT, naming the area worked on — "Payroll module", "Login
 * flow". `isGeneralCategoryValid` is where that either-or is decided.
 *
 * A list rather than an admin-managed collection because eight values cover
 * the cases and a CRUD surface for them is not yet worth its own model,
 * routes and UI. Promote it if people start asking for their own.
 */
export const TIMESHEET_GENERAL_CATEGORIES = [
    'Meeting',
    'Internal discussion',
    'Support',
    'Training',
    'Documentation',
    'Admin',
    'Recruitment',
    'Other',
] as const;

export type TimesheetGeneralCategory = (typeof TIMESHEET_GENERAL_CATEGORIES)[number];

/**
 * Is this category legal for an entry with this project?
 *
 * The one place the either-or lives, because it is asked twice — once by the
 * create validator and once by `updateEntry` against the MERGED row, where a
 * patch that clears the project has to be judged on the category it didn't
 * mention.
 */
export const isGeneralCategoryValid = (category: string | null | undefined, hasProject: boolean): boolean => {
    if (hasProject) return true; // free text, or nothing — the project attributes it
    return Boolean(category) && (TIMESHEET_GENERAL_CATEGORIES as readonly string[]).includes(category!);
};

/**
 * Shown where a project-less entry needs a NAME in the project position.
 *
 * Only where a dash cannot work. The web tables print "—" — read in a dense
 * grid, with the category in the next column, the absence is obvious and a
 * word is noise. A chart legend and a Slack table row have no such context:
 * a "—" bucket in the dashboard is unreadable and a Slack row starting "*—*"
 * looks broken, so those two get the word.
 *
 * One constant because they previously disagreed with each other — Slack said
 * "No project", the dashboard said "General (no project)".
 */
export const TIMESHEET_NO_PROJECT_LABEL = 'Internal';

// ─── Bulk import ─────────────────────────────────────────────────────────

/**
 * Rows accepted in one import.
 *
 * A month for one person is 20–60 rows, so this covers a quarter while
 * staying a synchronous request with no job queue. Higher than the holidays
 * bulk cap (`BULK_INSERT_MAX = 200`) because timesheet rows are denser — one
 * per project per day rather than one per date.
 *
 * Over the cap is REFUSED, never truncated: silently importing the first 500
 * rows of a 700-row sheet loses billable hours nobody would notice.
 */
export const TIMESHEET_IMPORT_MAX_ROWS = 500;
