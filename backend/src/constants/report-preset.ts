/**
 * Report-preset constants (Phase 4 Step 42 — `/report-presets/*`).
 *
 * Personal saved-filter shortcuts on top of the Step-29 report
 * surface. Each preset stores a name + report identifier + the saved
 * filter shape; the FE pulls the preset, populates the regular report
 * query with its filters, and calls `GET /reports/:name`. There is
 * deliberately no server-side "apply preset" composition endpoint —
 * one round-trip more is worth keeping the API surface narrow.
 *
 * Owner-scoped: every read/write filters by `user_id = caller.id`.
 * Cross-user IDs surface as `REPORT_PRESET_NOT_FOUND` (anti-
 * enumeration; same posture as notifications and refresh-token
 * sessions).
 */

// Step 47: route gate is `requirePermission(report.read)` — same
// permission that gates the underlying `/reports/*` reads, so a user
// can never save a preset for a report they can't run.

// ─── Field caps ────────────────────────────────────────────────────────

export const REPORT_PRESET_NAME_MAX = 100;

// ─── Per-user cap ──────────────────────────────────────────────────────
//
// Defence-in-depth against runaway preset creation. 50 is comfortably
// above realistic use (a power user with one preset per project + a
// few personal favourites might hit ~20). Hitting the cap returns
// `REPORT_PRESET_LIMIT_EXCEEDED` so the FE can prompt the user to
// delete an old preset.

export const REPORT_PRESET_PER_USER_CAP = 50;

// ─── List endpoint pagination ──────────────────────────────────────────

export const REPORT_PRESET_LIST_DEFAULT_LIMIT = 20;
export const REPORT_PRESET_LIST_MAX_LIMIT = 100;
