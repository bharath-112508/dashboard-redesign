/**
 * Holiday calendar constants — Step 9 (`API_Contract.md §4.3`,
 * `Data_Model.md §2.3`).
 *
 * Authorization model (Step 47):
 *  - Reads gated on `holiday.read` (held by every system role).
 *  - Writes (`POST`, `POST /bulk`, `PATCH`, `DELETE`) gated on
 *    `holiday.write` (held only by Admin via the `system.admin`
 *    wildcard). HR/admin owns the calendar.
 *
 * Modelling notes:
 *  - `holidays.date` is a single ISO `YYYY-MM-DD` string in IST (no timezone
 *    drift), uniquely indexed. We cap the list query window at 5 years to keep
 *    payloads bounded.
 *  - Bulk insert is capped at `BULK_INSERT_MAX` items per request — the
 *    typical calendar import is ≤ 25 holidays/year.
 *  - Hard delete (Data_Model.md doesn't carry a `deleted_at` field on this
 *    collection). Future leave/attendance jobs that read holidays do so by
 *    `date`, not by foreign key, so a hard-delete won't dangle a reference.
 */

export const NAME_MAX = 100;
export const BULK_INSERT_MAX = 200;

// Years either side of "now" the list window may span. 5 years lets the FE
// preload a multi-year planner without the server returning thousands of rows.
export const LIST_MAX_RANGE_YEARS = 5;

// Strict ISO local-date format (Asia/Kolkata) — same convention as
// attendance.local_date.
export const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
