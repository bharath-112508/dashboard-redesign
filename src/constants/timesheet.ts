/**
 * Timesheet + billing-rate constants (Data_Model.md §6 / API_Contract.md §9 /
 * BUILD_PROGRESS.md Step 23).
 *
 * Timesheet entries capture both billable and non-billable time on the same
 * row (Data_Model §6.1). `entry_type` distinguishes a task-linked entry
 * (must reference a project + task the caller can see) from a "general"
 * entry (a category like meeting / training / admin / other; project is
 * optional, task is null).
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
