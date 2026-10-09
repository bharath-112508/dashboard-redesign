/**
 * Timeline / Gantt constants (Phase 4 Step 41 —
 * `GET /projects/:project_id/timeline`).
 *
 * The timeline endpoint reshapes existing task + sprint data for a
 * frontend Gantt view. It does NOT introduce a new persistent field;
 * tasks today don't carry an explicit `start_date`, so the service
 * derives one per task at read time via a fallback chain
 * (`sprint.start_date` → `created_at`). Adding an explicit `start_date`
 * column to the task model is a Phase-5 enhancement (heavy blast
 * radius on the existing task validators / service / tests).
 *
 * The endpoint mirrors the report surface's discipline:
 *  - Required `from_date` + `to_date`, capped at `TIMELINE_RANGE_MAX_DAYS`.
 *  - No pagination — the Gantt renders everything in the window at
 *    once. Bounded by the date-range cap.
 *  - Read-only; no mutations, audit rows, or notifications.
 */

// Step 47: route gate is `requirePermission(project.read)` — same as
// the project list. Per-project scoping happens in the service via
// `loadProjectForCaller`.

// ─── Date range cap ────────────────────────────────────────────────────
//
// 1 year = ~52 sprints worth of tasks for a busy project.  Bounds the
// payload size + scan cost without limiting realistic Gantt views
// (quarterly / annual planning windows fit comfortably).

export const TIMELINE_RANGE_MAX_DAYS = 365;

// ─── Result cap ────────────────────────────────────────────────────────
//
// Defence-in-depth: even with the date range capped, a project with an
// unusually dense backlog (e.g. an import that created 5 000 tasks in
// one sprint) shouldn't blow the response. The service caps at 2 000
// tasks per response — well above any realistic Gantt UI's render
// budget. Hitting the cap surfaces a `truncated: true` flag so the FE
// can prompt the user to narrow the date range.

export const TIMELINE_TASK_CAP = 2_000;

/** Tasks with no due date listed under the chart (they have no bar). */
export const TIMELINE_UNDATED_CAP = 100;
