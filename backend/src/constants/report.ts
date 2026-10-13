/**
 * Report constants (Step 29 — `/reports/*` endpoints; API_Contract §10).
 *
 * Reports are pure aggregations over the operational collections. The
 * service layer reads, never writes — no audit actions or target kinds
 * land here. Step 30 layers async exports on top of this surface;
 * shapes returned by these endpoints are also what the export workers
 * consume, so the field names should be stable.
 *
 * RBAC (Step 47): every report endpoint is gated on `report.read`
 * (held by manager + admin only). Report data crosses user
 * boundaries (billing rolls up by project, utilization spans the
 * team) so an employee or client cannot read them. Exports require
 * the additional `report_export.write` permission.
 */

// ─── Date-range cap ─────────────────────────────────────────────────────
//
// A 90-day cap on the requested range bounds the worst-case aggregation
// cost. For longer windows (annual reports, audit reviews) the FE can
// chunk into quarters and reduce client-side. Tunable up — Step 33's
// perf pass will set this against measured P95 latency.

export const REPORT_RANGE_MAX_DAYS = 92;

// ─── Output caps ────────────────────────────────────────────────────────
//
// Row caps act as defence-in-depth so a misconfigured admin-of-1000-users
// query can't walk an unbounded result set into the response. Step 30
// exports stream the same data row-by-row and don't use these caps.

export const REPORT_ROW_CAP = 1_000;

// ─── Billing report — group-by enum (per API_Contract §10.2) ────────────

export const BILLING_REPORT_GROUP_BY = ['employee', 'task'] as const;

// ─── Default expected hours (utilization) ───────────────────────────────
//
// "Expected hours" is `working_days_in_range × daily_threshold`. We pull
// `daily_threshold` from `system_settings.timesheet.daily_warn_threshold_hours`
// at runtime; this fallback fires only when settings haven't been
// initialised (which the platform also guards via `getOrInitSettings`).
//
// Working days: Mon–Fri minus configured holidays (Step 9). Per-user
// custom contracts (e.g. 32-hour weeks) are deferred — `Plan §3.4`
// flags them as a v1.5 concern and the FE doesn't yet expose the
// field. The report's `expected_minutes` is therefore an organisation-
// uniform figure, not a per-user contract.

export const REPORT_DEFAULT_DAILY_HOURS = 8;
