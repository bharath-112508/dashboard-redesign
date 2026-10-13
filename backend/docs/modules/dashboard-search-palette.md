# Dashboard, Search & Command Palette — Backend

Three read-only aggregation surfaces grouped because they all pull from every other module in the platform — dashboards summarise per-role landing pages, `/search` powers global typeahead, `/command-palette` adds the Cmd-K verb catalog on top.

Cross-references: every prior module's collections are read by these — `users`, `attendance_records`, `attendance_correction_requests`, `leave_requests`, `leave_balances`, `leave_types`, `holidays`, `notifications`, `projects`, `tasks`, `timesheet_entries`, `billing_rates`, `sprints`. Schemas belong to [`Data_Model.md`](../../../Data_Model.md); the endpoint index belongs to [`API_Contract.md`](../../../API_Contract.md). No writes, no audits.

---

## Scope

| Sub-module | Surface | Notes |
|---|---|---|
| **Dashboard snapshot** | `GET /dashboard/{admin\|manager\|employee\|client}` | Point-in-time cards; per-card safe-fail |
| **Dashboard analytics** | `GET /dashboard/{admin\|manager\|employee\|client}/analytics` | Range-windowed section series + insight strings + deltas |
| **Dashboard overview** | `GET /dashboard/{admin\|manager\|employee\|client}/overview` | 3 summary tiles + attendance / representatives / projects roll-up |
| **Search** | `GET /search?q=&types=&limit=` | 4 buckets in parallel; regex+`$text` hybrid (Step 33) |
| **Command palette** | `GET /command-palette?q=` | Unified `{actions, items}` envelope; in-memory catalog + delegates items to search service |

---

## Roles & permissions

### Dashboards

All twelve routes sit behind one `router.use(authenticate)` and then the **same four permissions** — the `/analytics` and `/overview` variants add **no** gate of their own beyond the `?range=` / `?from=&to=` `validate` middleware.

| Route group | Permission | Held by (system roles) |
|---|---|---|
| `GET /dashboard/admin`, `/admin/analytics`, `/admin/overview` | `dashboard.admin` | **Admin only** — this bit is in no role bundle at all ([`system-role-definitions.ts`](../../src/constants/system-role-definitions.ts)); admin passes via the `system.admin` wildcard |
| `GET /dashboard/manager`, `/manager/analytics`, `/manager/overview` | `dashboard.manager` | Admin, Manager, Team Lead (`TEAM_LEAD_ADDITIONS`) |
| `GET /dashboard/employee`, `/employee/analytics`, `/employee/overview` | `dashboard.employee` | Admin, Manager, Team Lead, Employee (`EMPLOYEE_BASE`) |
| `GET /dashboard/client`, `/client/analytics`, `/client/overview` | `dashboard.client` | Client **and Representative** (`CLIENT_SIDE_BASE`) |

**Can a caller reach another role's dashboard? Yes — the permission is the only gate, and role bundles overlap by design.** A Manager holds `dashboard.manager` *and* `dashboard.employee` and can call all six of those endpoints; an Admin can call all twelve. What that does *not* give them is another **person's** data:

- `/employee/*` builders take only `callerId(req)` / `projectCallerFrom(req)` — they are pinned to the caller, so a Manager calling `/dashboard/employee/analytics` gets their own hours and attendance.
- `/manager/*` and `/client/*` builders branch on the caller's **role**, not on the URL. `buildManagerOverview` / `buildManagerAnalytics` give an org-wide payload to admin-like and `manager` callers and a project-scoped one to a Team Lead. `buildClient*` composes [`buildProjectVisibilityFilter`](../../src/services/project.service.ts) — so an **admin or manager calling `/dashboard/client/*` gets every project in the org**, because that helper returns `{}` for those roles. No downward leak, but the endpoint name is not a scope.
- 🔴 **`/dashboard/admin/overview` is the one endpoint with no scoping input at all.** `buildAdminOverview(from, to)` takes neither a caller nor the held-permission list, so — unlike the admin *snapshot* (per-card `callerCan`) and the admin *analytics* (per-section `callerCan`) — a custom role granted only `dashboard.admin` gets org headcount, client count, project totals and org-wide attendance with no sub-gating.

A caller with multiple role bundles hits only one set per navigation — the FE picks which one based on which permission they have.

### Search & palette

Both gated on **`authenticate` only** at the route layer. Per-bucket visibility scoping happens inside the services.

| Endpoint | Rate limit | Notes |
|---|---|---|
| `GET /search` | 60/min/user (`searchRateLimiter`) | Regex `$or` across collections — pathological in a tight loop |
| `GET /command-palette` | 60/min/user (`commandPaletteRateLimiter`) — **separate bucket** (H3) | Pre-H3 had no limiter and could bypass search budget by routing identical queries; separate bucket means Cmd-K + future search page don't compete |

---

## Dashboards — three endpoints per role, twelve in total

**The three are different payloads, not variants of one.** They share nothing but the permission and the IST calendar; a consumer picks by what the screen needs.

| Endpoint | Answers | Range-aware? | Service |
|---|---|---|---|
| `GET /dashboard/{role}` (snapshot) | *"What is true right now?"* — today's attendance, this month's holidays, the pending-approval queue, my leave balances, my unread count | **No.** Every window is hard-coded (today / current IST month / current IST year) | [`dashboard.service.ts`](../../src/services/dashboard.service.ts) |
| `GET /dashboard/{role}/analytics` | *"How did the window go?"* — per-day trend series, per-project hour splits, utilization, throughput; every section carries a plain-language `insight` string and a `delta` vs the previous equal period | **Yes** — `?range=` preset **or** `?from=&to=` custom | [`dashboard-analytics.service.ts`](../../src/services/dashboard-analytics.service.ts) |
| `GET /dashboard/{role}/overview` | *"Three headline numbers plus an attendance/projects roll-up for a window"* — the summary strip at the top of the page | **Yes** — `?from=&to=` only, defaults to month-to-date | [`dashboard-overview.service.ts`](../../src/services/dashboard-overview.service.ts) |

🔴 **Analytics does NOT live in `dashboard.service.ts`.** [`CLAUDE.md`](../../CLAUDE.md) says that file covers "snapshot + analytics" — it does not; `dashboard.service.ts` exports the four snapshot builders plus `resolveClientProjectIds`, and every `*Analytics` builder is in `dashboard-analytics.service.ts`. Two of the three services also each keep their **own private copy of `safeCard`** (`dashboard.service.ts` and `dashboard-overview.service.ts`, the latter with a comment saying so), and analytics has a third variant named `safeSection` with different semantics — see §Degradation.

---

## Snapshot — `GET /dashboard/{role}` ([`dashboard.service.ts`](../../src/services/dashboard.service.ts))

### Common patterns

**`safeCard(label, fn, fallback)`** — every card aggregator is wrapped. One slow/failing collection cannot black out the whole landing page. Failures log `warn` with `card: <label>`; the card defaults to a contractually-shaped empty value.

**IST anchoring** — `todayLocalDate()` and `currentYear()` use `DEFAULT_TIMEZONE` (Asia/Kolkata). H1 — `currentYear` uses IST so the year-end window between IST midnight and UTC midnight doesn't read last year's balances.

### `GET /dashboard/admin`

```ts
{
  generated_at,
  headcount?: {                                    // user.read
    active: number,
    deactivated: number,
    by_role: {admin, manager, team_lead, employee, client, representative},  // active only
  },
  attendance_today?: {date, present, on_leave, incomplete, flagged_for_correction, total_internal_active},  // attendance.read_team
  pending_leave_approvals?: {                      // leave_request.approve
    count, requires_additional_approval,
    recent: [{id, user_id, user_name, requested_leave_type_id, start_date, end_date, total_days, requires_additional_approval, created_at}],  // last 5
  },
  holidays_this_month?: number,                    // holiday.read
}
```

**Every card is individually permission-gated, and every key is optional.** `buildAdminDashboard(req.user.permissions)` only pushes a card's job when `callerCan(held, PERM)` passes ([`caller-permissions.ts`](../../src/utils/caller-permissions.ts) — `system.admin` wildcards, a pre-Step-47 token with no `permissions` claim holds **nothing**). A missing key means "not permitted", not "zero" — a zero-valued key means the aggregation ran and found nothing, and a card that *threw* also yields its zero fallback. The three states are indistinguishable to the FE except for key presence.

Permitted cards run in parallel via `Promise.all`, each wrapped in `safeCard`. The admin headcount aggregation excludes deactivated users from `by_role` counts (they're surfaced separately as `deactivated`) and carries all **six** roles including `representative`. Single-admin invariance is observable as `by_role.admin === 1` once bootstrap completes. `total_internal_active` excludes **both** client-side roles (`CLIENT_SIDE_ROLES`), not just `client`.

### `GET /dashboard/manager`

```ts
{
  generated_at,
  scope: 'team' | 'org',
  team_size: number,
  pending_leave_approvals?: PendingLeaveCard,   // leave_request.approve
}
```

**Admin-like AND `role === 'manager'` callers get `scope: 'org'`** — `isAdminLike(caller) || caller.role === ROLES.MANAGER`. `team_size` is then the org-wide count of active non-client-side users and the pending queue is unfiltered. Only a **Team Lead** falls into `scope: 'team'`.

🔴 **Team scope is project membership, not the reporting line.** There is no `resolveDirectReportIds` and `internal_profile.reporting_manager_id` is never read by any dashboard endpoint. The scope helper is [`resolveTeamLeadScope(callerId)`](../../src/services/dashboard-analytics.service.ts) — it lives in the **analytics** service and is imported back into the snapshot service:

```
resolveTeamLeadScope(callerId) →
  Project.find({member_ids: callerId}).select('_id member_ids')
  → { projectIds, memberIds }   // memberIds = every member of those projects, caller included
```

`team_size` counts `memberIds` **including the lead**; the approval queue is filtered to `memberIds` **minus the lead** (`reviewIds`) because a lead can't approve their own leave. Empty `reviewIds` → empty `PendingLeaveCard` without hitting `LeaveRequest`. A lead who is a member of no project therefore reports `team_size: 1` and an empty queue.

### `GET /dashboard/employee`

```ts
{
  generated_at, user_id,
  today: {attendance: {date, checked_in, check_in_time, checked_out, check_out_time, status, flagged_for_correction}},
  leave_balances: [{leave_type_id, code, name, available, allocated, used, pending}],
  recent_leaves: [{id, requested_leave_type_id, start_date, end_date, total_days, status, created_at}],   // last 5
  unread_notifications: number,
}
```

**Self-heal balances**: `initializeBalancesForUserYear({user_id, year: currentYear()})` runs before reading — no-op if rows exist, creates them if not. A brand-new joiner whose year hasn't been initialised still sees something useful (same self-heal as `/leave-balances/me`).

### `GET /dashboard/client`

```ts
{
  generated_at, user_id, scope: 'client',
  projects: {
    total: number,
    recent: [{id, name, code, status, task_count, open_task_count, last_activity_at}],  // top 5 by activity
  },
  recent_task_activity: [{id, title, status, project_id, project_name, updated_at}],   // last 10
  unread_notifications: number,
}
```

**Client visibility is composed, never hard-coded**: `resolveClientProjectIds(caller)` runs `Project.find(buildProjectVisibilityFilter(caller))` — so a `client` sees every project of their **company** (`company_id`), a `representative` only projects naming them in `representative_ids`, and a client-side caller with no `company_id` gets `DENY_ALL`. (An earlier hard-coded `{client_ids: caller.id}` here is exactly what the field rename would have silently turned into a dead dashboard; see the comment in the service.) Resolved **once** per request and passed to every card. Empty id list → every card returns its empty fallback (no 500s; no leaked data from other companies' projects).

**M10 — `computeClientProjectCards(visibleProjectIds, limit)` accepts the pre-resolved IDs**: pre-M10 re-ran `{client_ids: user_id}` inside the card, duplicating the visibility scan. The new shape uses `_id: {$in: projectIds}` — fast `_id`-key lookup.

**Per-project rollup via one `$facet`-equivalent aggregation** — `$group` by `(project_id, status)` then re-group by `project_id` to produce `{task_count, statuses[], last_activity_at}` per project. Open count is `sum(count where status NOT IN terminal_set)`. Terminal set = `DEFAULT_DONE_TASK_STATUS_KEY` + any project custom status with `is_terminal: true`.

Cards sorted by `last_activity_at` desc, with `name.localeCompare` as tiebreaker.

---

## Analytics — `GET /dashboard/{role}/analytics` ([`dashboard-analytics.service.ts`](../../src/services/dashboard-analytics.service.ts))

Time-windowed section data for the charts. Insight strings are pure functions in [`dashboard-insights.ts`](../../src/services/dashboard-insights.ts) (no LLM, no I/O) and the FE renders them **verbatim** — phrasing changes are BE-only. Range math lives in [`dashboard-range.ts`](../../src/utils/dashboard-range.ts).

### Envelope

```ts
{
  generated_at: string,              // ISO, response build time
  range: ResolvedRange,              // {key, label, insight_label, from, to, prev_from, prev_to, prev_label}
  sections: { [key]: SectionPayload | {error: true} },
}
```

A section key is **absent** when the caller lacks its permission, and present-with-`{error: true}` when its aggregation threw. Most section payloads carry `insight: string` and `delta: SectionDelta | null`.

### Query — `?range=` OR `?from=&to=` ([`dashboard.validator.ts`](../../src/validators/dashboard.validator.ts))

`range` is a strict enum of **five** keys (`DASHBOARD_RANGE_KEYS`), all resolved in IST:

| `range` | `from` | `to` | Previous period (`prev_from`…`prev_to`) | `prev_label` |
|---|---|---|---|---|
| `today` | today | today | yesterday | `yesterday` |
| `week` | **Monday** of this week | today | the previous Mon–Sun | `last week` |
| `month` | 1st of this month | today | the whole previous calendar month | `last month` |
| `30d` | today − 29 days | today | the 30 days before that | `the previous 30 days` |
| `quarter` | 1st day of this calendar quarter | today | the previous quarter | `last quarter` |

- **Default is `month`** when neither `range` nor `from`/`to` is given. 🔴 The default is applied by `resolveAnalyticsRange(q.range ?? 'month')` in [`dashboard-range.ts`](../../src/utils/dashboard-range.ts), called from the controller — **not** by the Zod schema. The header comment in [`dashboard.routes.ts`](../../src/routes/dashboard.routes.ts) claiming "`validate` … writes the coerced default (`'month'`) back onto `req.query`" is wrong: `range` is `.optional()` with no `.default()`, so `req.query.range` stays `undefined` and any other consumer reading it directly gets nothing.
- **`/analytics` also accepts a custom `from`/`to` window**, undocumented in [`CLAUDE.md`](../../CLAUDE.md) (which describes `?range=` only). Both dates are `YYYY-MM-DD` (regex, not `z.coerce.date()`), and **custom wins over `range` when both are sent** — `key: 'custom'`, `insight_label: 'in the selected range'`, `prev_label: 'the previous period'`, and the previous window is the equally-long span immediately before `from`.
- Validation rules, all three enforced by `dashboardAnalyticsQuerySchema` and all returning `VALIDATION_ERROR` / 400:
  1. `from` and `to` must be provided **together** (`(from == null) === (to == null)`), error surfaced on field `to`.
  2. `from <= to` (string compare on `YYYY-MM-DD`), error on field `from`.
  3. `dayjs(to).diff(dayjs(from), 'day') <= 366`, error on field `to`. **That diff excludes the start day**, so the widest accepted window is **367 inclusive days**, not 366.

### `resolveThroughputPeriod` — the one section that ignores the shared window

Every section except `throughput` reads `range.from`…`range.to` as-is (which for `week`/`month`/`quarter` ends at **today**, i.e. a partial period). The Tasks-Completed card instead re-derives the **full calendar period**: Sun–Sat for `week` (note: Sunday-start, unlike the Monday-start `week` range itself), 1st–last for `month`, first–last for `quarter`. `today`, `30d` and `custom` have no distinct calendar period and fall through unchanged. Not-yet-arrived days simply contribute zero, so this widening never inflates the count — but a consumer that sums `throughput.data` and compares it against `range.to` will see dates past it.

### Sections and where the numbers come from

Every row is `add(key, permission, fn)` in the per-scope assembler; the permission column is checked with `callerCan`, so `system.admin` satisfies all of them.

#### `/dashboard/admin/analytics` — org-wide, `userIds = null` (no `user_id` filter at all)

| Section | Permission | Collections aggregated | Notes |
|---|---|---|---|
| `kpi.headcount` | `user.read` | `users` grouped by `(role, status)` | `value` = active total, plus `deactivated` and `by_role` (active only) |
| `kpi.active_projects` | `project.read` | `projects` `countDocuments({status: 'active'})` | 🔴 **does not exclude archived projects** — `/overview`'s `projects.active` does (`is_archived: {$ne: true}`), so the two numbers legitimately disagree on the same screen |
| `kpi.hours_logged` | `timesheet.read` | `timesheet_entries` Σ `total_minutes` over `local_date` | `{value_minutes, delta}` |
| `kpi.billable_value` | `billing_rate.read` | `timesheet_entries` (`billable_total_minutes > 0`, `project_id != null`) × `billing_rates` | see §Billable value below |
| `attendance_trend` | `attendance.read_team` | `attendance_records` grouped by `(local_date, status)` | one point per day of the range, zero-filled; `present`/`on_leave` only |
| `leave_mix` | `leave_request.read_team` | `leave_requests` (**approved only**) Σ `total_days` by `requested_leave_type_id`, joined to `leave_types` | attributed by **`start_date`** falling in the window; `code`/`name` are `null` if the type row is gone |
| `leave_status` | `leave_request.read_team` | `leave_requests` (**cancelled excluded**) grouped by status + newest 5, joined to `users` for names | `requests` = approved+rejected+pending; `on_leave` = approved; `applied_date` is IST-formatted `created_at` |
| `upcoming_leaves` | `leave_request.read_team` | `leave_requests` approved with `start_date` in `[today, today+14d]`, joined to `users` + `leave_types` | 🔴 **ignores the range entirely** — always the next 14 days from *now*, capped at **8** rows |
| `hours_by_project` | `timesheet.read` | `timesheet_entries` Σ `total_minutes` by `project_id`, joined to `projects` | **top 8 by minutes**; a `null` `project_id` renders as `General (no project)`; `total_minutes` is the sum of the returned 8, not of the window |
| `utilization` | `timesheet.read` | `timesheet_entries` + `holidays` | `expected = working_days × 480 min × headcount`; working days = calendar days minus Sat/Sun minus `holidays` rows; `pct = 0` when expected is 0 |
| `tasks_by_status` | `task.read` | `tasks` grouped by `status` | 🔴 **not range-filtered** — it is an all-time snapshot of the scope, sitting inside a range-labelled payload. Only the default `done` key counts as terminal here (custom terminal statuses are honoured in `project_progress` only) |
| `throughput` | `task.read` | `tasks` `status: 'done'` bucketed by `completed_at` in IST | uses `completed_at`, not `updated_at` (a later edit would re-date the completion); full calendar period per above |
| `holidays` | `holiday.read` | `holidays` `date >= today` | next **5**, sorted ascending; range-independent |

`totalHeads` (the attendance-trend denominator and the utilization headcount) is `activeInternalCount()` — active users with `role $nin [client, representative]`. A bare `$ne: client` used to count representatives as staff and inflated it.

#### `/dashboard/manager/analytics`

Same section list as admin **minus `holidays`, `kpi.headcount` and `kpi.active_projects`**, plus `kpi.team_size` (ungated — no permission check, always present). Scope is decided once:

| Caller | `userIds` | `headcount` | Task scope |
|---|---|---|---|
| admin-like **or** `role === 'manager'` | `null` (org-wide) | `activeInternalCount()` | `{}` (all tasks) |
| Team Lead | `resolveTeamLeadScope().memberIds` | `memberIds.length` | `{project_id: {$in: projectIds}}` |
| Team Lead on no project | `[]` → matches nothing | `0` | `NO_TASKS_FILTER` = `{_id: ObjectId('000…000')}` — a sentinel that matches no task, deliberately not `{}` |

#### `/dashboard/employee/analytics` — always `userIds = [callerId]`

| Section | Permission | Source |
|---|---|---|
| `hours_trend` | `timesheet.write` | `timesheet_entries` Σ `total_minutes` per day, zero-filled across the range |
| `hours_by_project` | `timesheet.write` | as admin, scoped to self |
| `attendance_trend` | `attendance.check_in_out` | as admin, scoped to self; `totalHeads = 1`, and the single-user branch swaps the insight to `employeeAttendanceInsight` (days present of working days) |
| `leave_mix` | `leave_request.write` | as admin, scoped to self |
| `tasks_by_status` | `task.read` | `tasks` filtered `{primary_assignee_id: callerId}` — **assignee only**, unlike `/employee/overview`'s open-task tile which is `created_by OR primary_assignee_id` |
| `holidays` | `holiday.read` | next 5 |

Own-data sections are gated on the **behavioural** permission the role already bundles (`timesheet.write` for own hours, `leave_request.write` for own leave, `attendance.check_in_out` for own attendance) — there are no `*_read_own` bits to gate on (M3 deleted them). There is **no `kpi` key** on the employee payload.

#### `/dashboard/client/analytics` — serves both client-side roles

Project ids come from `Project.find(buildProjectVisibilityFilter(caller))` (company-scoped for `client`, roster-scoped for `representative`); a failure logs and degrades to `[]` rather than erroring the section.

| Section | Permission | Source |
|---|---|---|
| `project_progress` | `project.read` | `projects` (name/code/status/`custom_task_statuses`) + `tasks` grouped by `(project, status)` |
| `tasks_by_status` | `task.read` | `tasks` filtered to the visible projects; short-circuits to a zero payload when no project is visible |
| `throughput` | `task.read` | as admin, scoped to the visible projects; short-circuits likewise |

`project_progress` is the **only** analytics section that honours per-project custom terminal statuses (`done` + every `custom_task_statuses[].is_terminal`), because it has the project docs in hand. It has **no cap** — every visible project is returned, and the task aggregation covers all of their tasks.

### Billable value

`billableWindowValue` groups billable minutes by `(user, project, day)`, then applies the **project-level** `BillingRate` effective on that day — the latest `effective_from <= date` with `effective_to` null or `>= date`. **Task-level rates (`task_id != null`) are skipped**; they are a billing-report concern. A `(user, project, day)` with **no matching rate contributes 0 silently** — no warning, no flag, so a low KPI can mean "no rates configured" rather than "no billable work". See [`timesheets-billing.md`](./timesheets-billing.md) for the rate model.

### Deltas

`buildDelta(current, previous, prev_label, goodWhen)` returns **`null` when `previous <= 0`** — a section with no comparison base shows no delta rather than a `+100%`. `pct === 0` yields `direction: 'flat'`, `tone: 'neutral'`, label `same as <prev_label>`. `tone` is `neutral` whenever `goodWhen === 'neutral'`, so most cards are grey by design.

---

## Overview — `GET /dashboard/{role}/overview` ([`dashboard-overview.service.ts`](../../src/services/dashboard-overview.service.ts))

The summary strip: exactly three tiles plus an attendance / representatives / projects roll-up. Deliberately **not** the analytics payload — no series, no insights, no deltas.

### Query — `?from=&to=`, both `YYYY-MM-DD`

```ts
dashboardOverviewQuerySchema =
  z.object({ from: ymd.optional(), to: ymd.optional() })
   .transform((q) => ({
     from: q.from ?? today(IST).startOf('month'),   // 1st of the current IST month
     to:   q.to   ?? today(IST),                    // today, IST
   }))
   .refine((q) => q.from <= q.to,                                   // → 400 on field `from`
   .refine((q) => dayjs(q.to).diff(dayjs(q.from), 'day') <= 366,    // → 400 on field `to`
```

| Rule | Exact behaviour |
|---|---|
| Format | `/^\d{4}-\d{2}-\d{2}$/` — a plain regex on a string, so `2026-13-45` passes the schema and lands in the Mongo filter as a string comparison. There is no calendar validation. |
| Default window | **Month-to-date in IST**: `from` = first of the current month, `to` = today. Sending only `from` defaults `to` to today; sending only `to` defaults `from` to the 1st — the halves are independent here, unlike `/analytics` where both-or-neither is enforced. |
| Ordering | `from <= to`, string compare. Equal values are legal and switch the payload into single-day mode. |
| Maximum span | `dayjs(to).diff(dayjs(from), 'day') <= 366` → **367 inclusive days** is the widest accepted window (the diff excludes the start day). Same numbers as `/analytics`. |
| Order of operations | Both refinements run **after** the transform, so the defaults are always validated — and always pass. Only explicitly-sent dates can 400. |
| Other query params | The transform returns `{from, to}` and `validate` overwrites `req.query` with it, so **every other query parameter is dropped** — `?range=month` on an `/overview` route is silently ignored, not rejected. |

### Payload — `DashboardOverviewPayload`

```ts
{
  scope: 'admin' | 'manager' | 'employee' | 'client',   // fixed per endpoint, not derived from the caller
  range: {from, to, is_single_day},                     // is_single_day === (from === to)
  summary: [OverviewSummaryCard, OverviewSummaryCard, OverviewSummaryCard],  // exactly 3: {label, value, hint?}
  attendance: AttendanceOverview | null,                // null for the client scope only
  representatives: RepresentativesStatus | null,        // non-null for the client scope only
  projects: {active, completed, on_hold, total},
}
```

### The three tiles per scope

| Scope | Tile 1 | Tile 2 | Tile 3 |
|---|---|---|---|
| `admin` | **Total Employees** — active `admin+manager+team_lead+employee` | **Total Clients** — active `client` (representatives excluded) | **Total Projects** — `projects.total` |
| `manager`, org-wide branch (admin-like **or** `role === 'manager'`) | **Team members** — the same org-wide internal headcount as admin's tile 1, despite the label | **My Projects** — `projects.total` with filter `{}`, i.e. *all* projects | **Total Clients** |
| `manager`, Team Lead branch | **Team members** — `resolveTeamLeadScope().memberIds.length`, caller included | **My Projects** — projects where `member_ids ∋ caller` | **Total Clients** (org-wide, unscoped) |
| `employee` | **My present days** — `attendance.present_days` in the window | **My Projects** | **My open tasks** |
| `client` | **Company Projects** — `projects.total` | **Representatives** — `representatives.total` | **Active vs Completed** — `value: projects.active`, `hint: "<n> completed"` (the only tile that uses `hint`) |

🔴 **The headcount tiles are point-in-time, not as-of-date.** `currentHeadcount(roles)` is a bare `countDocuments({role: {$in}, status: 'active'})` with **no date filter** — it does not vary with `from`/`to` at all. That is deliberate (see the comment on the function): an earlier as-of-date version keyed on `created_at`, which is the DB seed date rather than employment history, and produced "1 employee, 10 of 11 present" for a past range. So a range that predates half the company still shows today's headcount as the attendance denominator's sibling.

### Where the numbers come from

| Field | Collections | Rules |
|---|---|---|
| `projects` | `projects` aggregated by `status`, `is_archived: {$ne: true}` always applied | Only `active`/`completed`/`on_hold` are counted, and **`total` is the sum of those three** — a project in any other status is silently absent from `total`. Visibility filter is the caller's responsibility: `{}` for admin/manager, `{member_ids: caller}` for employee/team lead, `{_id: {$in: resolveClientProjectIds(caller)}}` for the client scope |
| `attendance.present` / `on_leave` / `incomplete` | `attendance_records` grouped by `status` over `local_date ∈ [from, to]` | Single day → raw counts. **Multi-day → `present` is an average per working day**: `round(present_rows / distinct local_dates with status not in {weekend, holiday})`. `on_leave` and `incomplete` stay totals in both modes — mixing an average and two totals in one card |
| `attendance.present_days` | same aggregation | The raw `present` row count, un-averaged, in both modes. This is what the employee "My present days" tile reads |
| `attendance.correction_requests` | `attendance_correction_requests` `countDocuments` | Filtered on **`created_at`** (converted to IST start-of-day / end-of-day `Date` bounds), not on the corrected day's `local_date` — a request filed today about last month counts in *today's* window |
| `attendance.total_internal_active` | `users` active, `role $nin [client, representative]` | Narrowed by `_id: {$in: userIds}` when the scope is not org-wide, so the employee scope reports `1` |
| `representatives` | `users` `{role: 'representative', 'client_profile.company_id': companyId}` grouped by status | Anything not `active` counts as `inactive`, including future statuses. `client`-role people of the same company are **not** counted |
| Employee **My open tasks** | `tasks` `{$or: [{created_by}, {primary_assignee_id}], status: {$ne: 'done'}}` | 🔴 Compares against the default `done` key only — a task parked in a **custom terminal status** counts as open here, while the client snapshot's `open_task_count` excludes it. The two "open" definitions differ |

### Scope resolution

- `admin` — `buildAdminOverview(from, to)`, no caller argument at all (see the REDFLAG under §Roles & permissions).
- `manager` — org-wide for admin-like and `manager`; Team Leads scope attendance to `memberIds` and projects to `buildProjectVisibilityFilter`. Pending-leave approvals are **deliberately not a tile** — the analytics/snapshot approval card already shows that number.
- `employee` — attendance scoped to `[caller.id]`, projects to `buildProjectVisibilityFilter`.
- `client` — 🔴 **the range is echoed back but changes nothing.** Projects and representatives are both point-in-time and `attendance` is `null`, so `/dashboard/client/overview?from=…&to=…` returns an identical payload for every window. `company_id` comes from `req.caller_company_id` (set by `authenticate`); a caller without one falls back to `NO_COMPANY_ID` (`ObjectId('000000000000000000000000')`), which matches nothing and yields zeros rather than throwing.

### Degradation — three different safety nets

| Mechanism | Where | On failure |
|---|---|---|
| `safeCard(label, fn, fallback)` | `dashboard.service.ts` **and** a verbatim private copy in `dashboard-overview.service.ts` | Logs `warn` `{card: label}`, returns the contractually-shaped zero/empty fallback. The response is a **200 with wrong-looking zeros** |
| `safeSection(label, fn)` | `dashboard-analytics.service.ts` (exported) | Logs `warn` `{section: label}`, returns **`{error: true}`** in place of the section — the FE can tell a failure from a zero here, which it cannot on the other two surfaces |
| `callerCan` omission | all three services | The key is simply **absent**. Not an error |

Overview wraps *every* primitive plus the scope-resolution calls themselves (`overview.manager.team_scope`, `overview.client.resolve_projects`, `overview.employee.open_tasks`) — a failed scope resolution degrades to "empty scope", which reads as a legitimately empty team or client. Nothing on any of these three surfaces ever returns 5xx for an aggregation fault.

---

## Search ([`search.service.ts`](../../src/services/search.service.ts))

### Endpoint

```
GET /search?q=<2-100 chars>&types=users,projects,sprints,tasks&limit=10
```

Returns flat `{users[], projects[], sprints[], tasks[]}` (NOT a paginated envelope).

### Query rules

- `q` 2-100 chars, trimmed (strict). Below 2 chars rejected — single-letter queries match too many rows.
- `types` comma-separated subset of `['users', 'projects', 'sprints', 'tasks']`. Absent = all four. Empty list rejected (so the FE can't fire a zero-bucket request that returns empty but still hits the DB 4 times).
- `limit` per-bucket; default 10, max 50.

### Visibility scoping

| Caller | Users bucket | Projects bucket | Sprints + Tasks |
|---|---|---|---|
| Admin / Manager | All active | Open (no extra filter) | Open |
| Team Lead / Employee | **Always empty** — `searchUsers` returns `[]` for every role except admin/manager (`search.service.ts:144`), with no DB round-trip | `member_ids ∋ caller.id` via `buildProjectVisibilityFilter` | `project_id ∈ visibleProjectIds` |
| Client | **Always empty** (directory is internal-only) | `company_id = caller.company_id` via `buildProjectVisibilityFilter` (`representative` → `representative_ids ∋ caller.id`; no company → `DENY_ALL`) | `project_id ∈ visibleProjectIds` |

`resolveVisibleProjectIds(caller)` runs ONCE per request and is passed to the sprint + task bucket builders. Skipped entirely when neither bucket is requested (saves a round-trip on `?types=users` typeahead).

### Regex injection guard

```ts
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
```

A literal `q = ".*"` would otherwise match every row. Without escaping, `q = "?"` is a syntax error that throws inside the Mongo driver.

### Regex + `$text` hybrid (Step 33)

Per-bucket match clause built from `MatchSpec = {q, regex, useText: q.length >= TEXT_SEARCH_MIN_QUERY_LENGTH}`:

```
length < 3 → regex on legacy single-field set (typeahead path)
length ≥ 3 → $text: $search against the per-collection text index
```

| Collection | Regex fields | `$text` index (Step 33) |
|---|---|---|
| `projects` | `name, code` | `name + code + description` |
| `sprints` | `name` | `name + goal` |
| `tasks` | `title` | `title + description` |
| `users` | **`full_name` only — regex at every length** | NOT used (`$text` index spans `email + employee_id + job_title` too; using it would silently widen the PII surface §13 forbids) |

**Why regex below 3 chars** — Mongo's `$text` tokeniser splits on whitespace so `proj` won't match `project`. Regex without anchor is a collection scan, but bounded by `.limit()`.

**Why `$text` at 3+ chars** — Faster on large collections (text indexes use word tries); gains stemming + stopword handling from Mongo.

### Search-field choice (matches the response shape)

The response shape is minimal — `{id, full_name, role}` for users, no `email`. That's intentional: `GET /users` directory is gated to admin+manager only; surfacing email through `/search` would regress that contract for employees. Admins who want email-based lookup use `/users?q=`.

### Per-bucket caps

`SEARCH_DEFAULT_LIMIT = 10`, `SEARCH_MAX_LIMIT = 50`. Caps apply per-bucket (so `limit=50&types=users,projects` returns up to 100 rows total).

---

## Command palette ([`command-palette.service.ts`](../../src/services/command-palette.service.ts))

### Endpoint

```
GET /command-palette[?q=]
```

Returns `{actions, items}` together so the FE makes ONE HTTP call to render Cmd-K.

### Actions catalog ([`command-palette.ts:COMMAND_PALETTE_ACTIONS`](../../src/constants/command-palette.ts))

Static in-memory catalog. Each `CommandPaletteAction`:

```ts
{
  key: '<resource>.<verb>',    // stable id, FE keys icon + analytics off this
  label: string,                // display text
  description?: string,         // subline
  category: string,   // free-form by design — the eight values below are convention, not a type union
  url: string,                  // FE deep-link target
  keywords?: readonly string[], // additional substring tokens for ?q= filter
  permission?: Permission,      // required to surface; admins bypass via system.admin
}
```

Entries WITHOUT a `permission` field are visible to every authenticated user (navigation shortcuts, "my X" views).

**Adding a new action**: append a constant entry → service automatically picks it up. No DB writes.

### Filtering — `listActions(q, caller)`

```ts
const held = new Set(caller.permissions);
const isAdmin = isCallerAdmin(caller);
const qLower = q ? q.toLowerCase() : null;

for (action of COMMAND_PALETTE_ACTIONS):
  if !callerCanInvoke(action, held, isAdmin): skip          // permission gate
  if qLower && !actionMatchesQuery(action, qLower): skip    // substring match
  push(action)
```

`actionMatchesQuery` checks `label.toLowerCase().includes(qLower)` OR any `keyword.toLowerCase().includes(qLower)`. So typing "new" surfaces "Create new project" without remembering the exact label.

### `isCallerAdmin` — three-signal admin recognition

```ts
isCallerAdmin(caller) = 
  caller.permissions.includes('system.admin') ||
  caller.role === 'admin' ||                           // legacy denormalised
  caller.role_keys.includes('admin')                   // Step-47 resolved
```

Mirrors `auth.middleware.isCallerAdmin`. A legacy admin token from before the `permissions` claim landed (any in-flight tokens from the Step-47 deploy window) still gets the full catalog.

### Unified `getCommandPalette(query, caller)`

```ts
actionsResult = listActions(q, caller)                   ← in-memory, < 1 KiB work

searchableRole = isSearchableRole(caller.role) ? caller.role as RoleType : null
shouldFetchItems = q !== undefined && q.length >= SEARCH_MIN_QUERY_LENGTH && searchableRole !== null

items = shouldFetchItems
  ? await searchItems({q, types: undefined, limit: SEARCH_DEFAULT_LIMIT}, {id: caller.id, role: searchableRole})
  : EMPTY_ITEMS

return {actions: actionsResult.data, items}
```

**`q.length < 2` → items empty** (no DB round-trip). Actions filter on every keystroke; resource hits appear once the query is specific enough to be useful.

**`searchableRole === null` → items empty**. Search's visibility filter branches on the `RoleType` enum; if the caller's role isn't a known role we skip the items fetch (safe default — they get actions-only). Note `SEARCHABLE_ROLES = new Set(Object.values(ROLES))` — **all six** roles including `representative`, so in practice every authenticated caller gets an items fetch.

**Visibility delegation** — items fetch delegates to `search.service.search`, NOT a parallel implementation. Single source of truth for visibility scoping (member_ids vs company_id vs admin-open).

🔴 **They do drift for client-side callers.** `/search` passes `projectCallerFrom(req)`, which carries `company_id`; the palette calls `searchItems(..., { id, role })` with **no `company_id`** (`command-palette.service.ts:176-179`). `buildVisibilityFilter` then takes its `if (!caller.company_id) return DENY_ALL` branch, so a `client` typing in Cmd-K gets zero project/sprint/task items while the same query on `/search` returns their company's projects.

---

## End-to-end flows

### Admin lands on `/dashboard`

1. FE picks `/dashboard/admin` based on permissions. `GET /dashboard/admin`.
2. Service runs the cards the caller's JWT permissions allow (all 4 for an admin, via the `system.admin` wildcard) in parallel:
   - `computeHeadcount` → User aggregation by `(role, status)` → `{active, deactivated, by_role}`.
   - `computeAttendanceToday` → AttendanceRecord aggregation for today (IST) + flagged count + active internal count.
   - `computePendingLeaves({})` → LeaveRequest pending count + recent 5.
   - `computeHolidaysThisMonth` → Holiday countDocuments for current IST month.
3. Each wrapped in `safeCard` — if one throws, that card returns its empty fallback and the others still populate.
4. Response merged → `200 {generated_at, headcount, attendance_today, pending_leave_approvals, holidays_this_month}`.

### Team Lead lands on `/dashboard`

1. `GET /dashboard/manager` — caller holds `dashboard.manager` via the Team Lead bundle, is not admin-like, and `role !== 'manager'` → team scope.
2. `resolveTeamLeadScope(caller.id)` → the projects they're a member of, and the union of those projects' `member_ids` (7 people, the lead included).
3. `reviewIds` = those 7 minus the lead = 6.
4. `callerCan(held, leave_request.approve)` passes (Team Lead bundle) → `computePendingLeaves({user_id: {$in: 6}})`.
5. Response `{scope: 'team', team_size: 7, pending_leave_approvals: {...}}` — note `team_size` counts the lead, the queue does not.

### Manager opens the analytics page with no query string

1. `GET /dashboard/manager/analytics`. `validate({query: dashboardAnalyticsQuerySchema})` parses `{}` — all three fields optional, all three refinements vacuously true.
2. Controller: `resolveAnalyticsRange({})` → `q.from && q.to` is falsy → `resolveDashboardRange('month')` → `from` = 1st of this IST month, `to` = today, `prev_*` = the whole previous month.
3. `buildManagerAnalytics`: `role === 'manager'` → org-wide, `userIds = null`, `taskScope = {}`, `headcount = activeInternalCount()`.
4. `sectionCollector(held)` skips nothing the manager bundle grants; each `add(...)` runs inside `safeSection` concurrently.
5. `throughput` re-derives its own window via `resolveThroughputPeriod` → the **whole** calendar month, including days after today (all zero).
6. Response `200 {generated_at, range: {key: 'month', …}, sections: {kpi, attendance_trend, leave_mix, leave_status, upcoming_leaves, hours_by_project, utilization, tasks_by_status, throughput}}`.

### Client asks for a custom overview window

1. `GET /dashboard/client/overview?from=2026-01-01&to=2026-07-30`. Permission `dashboard.client` (held by both client-side roles).
2. Schema: both present, `from <= to`, `diff = 210 days ≤ 366` → passes; `req.query` is replaced with exactly `{from, to}`.
3. `buildClientOverview(projectCallerFrom(req), from, to)` → `resolveClientProjectIds` → `buildProjectVisibilityFilter` → `{company_id: caller.company_id}` for a `client`, `{representative_ids: caller.id}` for a `representative`.
4. `projectStatusFor({_id: {$in: ids}})` + `representativesStatusFor(company_id)` in parallel. **Neither reads `from`/`to`.**
5. Response `{scope: 'client', range: {from, to, is_single_day: false}, summary: [3 tiles], attendance: null, representatives: {...}, projects: {...}}` — every *number* is window-independent, but the bytes differ: `buildRange` echoes `{from, to, is_single_day}` back into the payload.

### Employee dashboard, fresh joiner with no balance row

1. `GET /dashboard/employee`. Service: `computeEmployeeLeaveBalances(user_id)`.
2. `initializeBalancesForUserYear({user_id, year: currentYear()})` — fresh joiner has no rows.
3. Settings + leave-type catalog read → creates per-type rows with default allocations (or pro-rata by months remaining if `pro_rata_for_joiners: true`).
4. `LeaveBalance.find({user_id, year})` now returns the freshly-seeded rows.
5. Joined with `LeaveType` for display labels. Response includes 7 balance cards.

### Client dashboard with 3 projects

1. `GET /dashboard/client`. `resolveClientProjectIds(user_id)` → 3 project IDs.
2. Parallel:
   - `computeClientProjectCards([3 ids], 5)` — one `$facet`-equivalent aggregation over Task: groups by (project, status) → re-groups by project. Per-project rollup: task_count + open_task_count + last_activity_at. Sorted by activity desc.
   - `computeClientRecentTaskActivity([3 ids], 10)` — last 10 tasks across all 3 projects, sorted by `updated_at desc`.
   - `unread_notifications` count.
3. Response: `{projects: {total: 3, recent: [3 cards]}, recent_task_activity: [10], unread_notifications}`.

### Employee searches "leave"

1. `GET /search?q=leave&types=tasks`.
2. Validator: q="leave" (4 chars, OK), types=['tasks'] (deduped + validated).
3. Service: `buildMatchSpec('leave')` → `{useText: true}` (4 ≥ 3).
4. `resolveVisibleProjectIds(employee)` → IDs of projects where caller is a member.
5. `searchTasks(matchSpec, 10, visibleProjectIds)`:
   - Filter `{project_id: {$in: visibleProjectIds}, $text: {$search: 'leave'}}`.
   - Text index returns tasks where title OR description contains 'leave'.
6. Other buckets skipped (not requested). Response `{users: [], projects: [], sprints: [], tasks: [n hits]}`.

### Client searches users (always empty)

1. `GET /search?q=alice` from a client. Default types = all four.
2. `searchUsers(...)` first checks `caller.role === CLIENT` → returns `[]` without a DB round-trip.
3. Projects: `buildProjectVisibilityFilter` applied — for a `client` that is `{company_id: caller.company_id}`, so hits cover every project of their company, not a roster subset. (`client_ids` no longer exists as a field anywhere in `src/`.)
4. Sprints + tasks: `visibleProjectIds` resolved (same client roster filter), then matched.
5. Response: users bucket empty; other 3 may have hits.

### Cmd-K opens empty (no query yet)

1. FE opens Cmd-K → `GET /command-palette`.
2. Service: `listActions(undefined, caller)` → filters catalog by `caller.permissions` (no substring match since `q` is absent).
3. `shouldFetchItems === false` (no `q`) → `items = EMPTY_ITEMS`.
4. Response: `{actions: [N filtered], items: {users: [], projects: [], sprints: [], tasks: []}}`.
5. FE renders the action list grouped by category.

### Cmd-K typeahead "ap" (1 char too short for items)

1. User types "a" → `?q=a`. Below `SEARCH_MIN_QUERY_LENGTH = 2`. **Actually rejected by the FE before sending; if it reaches BE, validator clamps min 1 char**, service then: `q.length >= 2` is false → items empty. Actions filtered by substring "a".
2. Types "p" → `?q=ap`. Now ≥ 2 chars. Service runs both: actions filter on "ap" + delegate to search service.
3. Items: all 4 buckets queried in parallel (regex path since `ap.length < 3`).
4. Response: `{actions: ['Apply for leave', 'Approve pending leaves', ...], items: {users: [...], projects: [...], ...}}`.

### Cmd-K admin sees full catalog despite no permissions claim

1. Admin's JWT predates the Step-47 `permissions` claim — has `role: 'admin'` and `role_keys: ['admin']` but `permissions: []`.
2. `isCallerAdmin(caller)`: `permissions.includes('system.admin') === false` → check `role === 'admin'` → **true**.
3. All actions surface regardless of `action.permission` setting.

---

## Audit & error codes

**No audit rows** — dashboards / search / palette are pure reads.

| Code | HTTP | When |
|---|---|---|
| `VALIDATION_ERROR` | 400 | `q` too short/long, unknown `types` value, empty `?types=` list; `range` outside the five-key enum; `from`/`to` not `YYYY-MM-DD`; `from > to`; span over 366 days' diff; on `/analytics` only, `from` without `to` (or vice versa) |
| `FORBIDDEN` | 403 | Missing the route's `dashboard.*` permission — `AppError.forbidden()` from `requirePermission`, message `Insufficient permissions` |
| *(no `error.code`)* | 429 | Per-user 60/min budget exceeded (separate buckets for search vs palette per H3) — **no rate limiter is mounted on any dashboard route**. 🔴 The limiters do not emit the standard envelope at all: `buildUserRateLimiter` responds with a bare `{"message": "Too many search requests. Please slow down."}` (`rate-limit.middleware.ts:113`), so there is no `error.code` to switch on. The catalog's 429 constant is `RATE_LIMITED`; `RATE_LIMIT_EXCEEDED` does not exist. |

No aggregation failure produces a 5xx on any of the twelve dashboard routes; see §Degradation.

---

## Gotchas

| # | Behavior | Why |
|---|---|---|
| 1 | Every dashboard card wrapped in `safeCard` — one slow/failing aggregation can't black out the page | Cards default to contractually-shaped empty values; failures log warn |
| 2 | H1 — `currentYear()` and `todayLocalDate()` IST-anchored | Year-end window between IST + UTC midnight doesn't read stale data |
| 3 | Admin dashboard `headcount.by_role` counts ACTIVE only, across all **six** roles incl. `representative`; deactivated surfaced separately | Total visible vs total ever |
| 4 | Manager scope is `'org'` for admin-like **and** `role === 'manager'`; only a **Team Lead** gets `'team'` | Same rule in all three manager endpoints (`isAdminLike(caller) \|\| caller.role === MANAGER`) |
| 5 | 🔴 Team scope is **project membership**, never `internal_profile.reporting_manager_id` — `resolveTeamLeadScope` (which lives in the *analytics* service) returns the members of the projects the lead belongs to | No dashboard endpoint reads the reporting line. `team_size` includes the lead; the approval queue excludes them |
| 5a | Every snapshot card is permission-gated with `callerCan` and its key is **omitted** when unheld | Absent key ≠ zero; a thrown card also yields zero, so absent/zero/failed are three different states with two representations |
| 6 | Employee dashboard self-heals leave balances (initializes year if missing) | Fresh joiner before first balance read |
| 7 | Client dashboard resolves `visibleProjectIds` ONCE per request, via `buildProjectVisibilityFilter` (company-scoped for `client`, roster-scoped for `representative`) — never a hard-coded `client_ids` filter | All cards scope through the list; composing means a field rename fails loudly instead of returning zero projects |
| 8 | M10 — `computeClientProjectCards(visibleProjectIds, limit)` accepts pre-resolved IDs | Pre-M10 re-ran client_ids filter; M10 uses `_id: {$in}` |
| 9 | Empty client `visibleProjectIds` → all cards return empty fallback, no DB queries | Performance + privacy |
| 10 | Per-project rollup uses ONE aggregation (no N+1) | `$group` by (project, status) → re-group by project |
| 11 | Terminal status set = `done` + per-project custom statuses with `is_terminal: true` | `open_task_count` calculation |
| 12 | Cards sorted by `last_activity_at` desc + `name.localeCompare` tiebreaker | Stable order across runs |
| 13 | `/search` route gate is `authenticate` only (no role) | Per-bucket visibility lives in service |
| 14 | Client always gets empty `users` bucket without DB round-trip | Directory is internal-only per §13 contract |
| 15 | Users bucket searches `full_name` ONLY (no email) | §13 PII contract — email exposed only via `/users` (admin+manager) |
| 16 | `escapeRegex` strips all regex metachars from `q` | Defense against `.*` matching everything OR `?` Mongo driver throw |
| 17 | Regex + `$text` hybrid: < 3 chars regex; ≥ 3 chars `$text` | Regex needed for typeahead prefix matching; `$text` faster + stems on longer queries |
| 18 | Users bucket NEVER uses `$text` even at ≥ 3 chars | `$text` index spans `email + employee_id + job_title` — would widen PII surface silently |
| 19 | `?types=` empty list rejected by validator | FE can't accidentally fire a 4-collection zero-bucket request |
| 20 | `resolveVisibleProjectIds` returns `null` for admin/manager (no project_id filter) | Saves a round-trip + index hit |
| 21 | `resolveVisibleProjectIds` SKIPPED when only `?types=users` | Saves a query for the most common typeahead |
| 22 | Empty `visibleProjectIds` for non-admin → sprint/task buckets return empty without DB call | Mongo `$in: []` would match nothing anyway, but explicit skip is clearer |
| 23 | Per-bucket cap applies per-bucket — `limit=50&types=users,projects` returns up to 100 rows | Total cap = `limit × types.length` |
| 24 | Search rate limit 60/min/user (`searchRateLimiter`) | Pathological regex `$or` in a tight loop |
| 25 | Command palette rate limit 60/min/user — SEPARATE BUCKET from search (H3) | Pre-H3 palette had no limiter; could bypass search budget |
| 26 | Command palette catalog is 100% in-memory (constant) | Action filter is < 1 KiB of work; no DB hit |
| 27 | Adding a new palette action = append to constants array; service picks it up | No DB writes; no FE config changes (FE uses `key` for icon mapping) |
| 28 | Actions without `permission` field are visible to every authenticated user | Navigation entries, "my X" views |
| 29 | Admin (via `system.admin` wildcard) bypasses every per-action permission gate | `isAdminLike` short-circuits |
| 30 | `isCallerAdmin` recognises admin via 3 signals: `system.admin` permission, legacy `role`, `role_keys[]` | Bridges Step-47 deploy window where JWTs lacked `permissions` claim |
| 31 | `actionMatchesQuery` matches against `label.lowercase` + every `keyword.lowercase` | Either matches → action surfaces |
| 32 | Cmd-K with no `q` → actions filtered by permissions only, items empty (no DB call) | First open shows actions immediately |
| 33 | Cmd-K with `q.length === 1` → actions filtered + items empty (no DB call) | Single-letter `q` too vague for resource search |
| 34 | Cmd-K with `q.length ≥ 2` → actions filtered + items via search service | Single round-trip for both |
| 35 | Cmd-K items always uses `types: undefined` (all 4 buckets) | The FE shows them all in the modal |
| 36 | Cmd-K delegates items to `search.service.search` — no parallel implementation | Visibility scoping in one place; never drifts |
| 37 | Cmd-K's `searchableRole === null` (caller role not in `RoleType` enum) → items empty | Safe default for legacy / custom-role tokens |
| 38 | Dashboards never audit | Pure reads; no state change |
| 39 | Search + palette never audit | Same |
| 40 | Snapshot + analytics return `generated_at`; **`/overview` does not** — it returns only `range` | No `Cache-Control: no-cache` headers anywhere; FE staleTime is the active TTL |
| 41 | 🔴 The three endpoints per role are **different payloads**, not variants — snapshot = now, analytics = windowed series, overview = 3 tiles + roll-up | Nothing is shared but the permission and the IST calendar |
| 42 | 🔴 Analytics lives in `dashboard-analytics.service.ts`, NOT `dashboard.service.ts` | `CLAUDE.md`'s "(snapshot + analytics)" attribution is wrong |
| 43 | `?range=` default `month` is applied by `resolveAnalyticsRange`, not by the Zod schema | The route-file comment claiming `validate` writes the default onto `req.query` is wrong — `req.query.range` stays `undefined` |
| 44 | `/analytics` also accepts `?from=&to=` (custom range) and **custom wins over `range`** | Undocumented in `CLAUDE.md`; both dates required together |
| 45 | Max span is `diff(to, from, 'day') <= 366` — i.e. **367 inclusive days** | The diff excludes the start day. Same rule on both `/analytics` and `/overview` |
| 46 | `/overview` defaults to **month-to-date IST**, and its halves default independently (`?from=` alone is legal) | `/analytics` instead requires `from`+`to` together |
| 47 | `/overview`'s schema `.transform` REPLACES `req.query` with `{from, to}` | Any other query param (`?range=`, `?scope=`) is silently dropped, not rejected |
| 48 | Date format is a bare regex — `2026-13-45` passes validation | No calendar check; it reaches Mongo as a string comparison and simply matches nothing |
| 49 | 🔴 `/admin/overview` takes **no caller and no permission list** — `dashboard.admin` alone yields org headcount, client count, project totals and org-wide attendance | The admin snapshot and admin analytics both sub-gate per card/section; this one does not |
| 50 | An admin or manager calling `/dashboard/client/*` sees **every project in the org** | `buildProjectVisibilityFilter` returns `{}` for those roles; the endpoint name is not a scope |
| 51 | 🔴 `tasks_by_status` is **not range-filtered** on any scope | An all-time count inside a range-labelled payload |
| 52 | 🔴 `upcoming_leaves` ignores the range — always the next 14 days from now, max 8 rows | Same for `holidays` (next 5 from today) |
| 53 | 🔴 `/client/overview` ignores the range completely | Projects + representatives are point-in-time, `attendance` is `null` — every window returns the same bytes |
| 54 | `throughput` uses its own **full calendar period** (`resolveThroughputPeriod`) and a **Sunday**-start week, while the shared `week` range is **Monday**-start and truncates at today | Dates in `throughput.data` can be later than `range.to` |
| 55 | `throughput` buckets on `completed_at`, not `updated_at` | A later edit would otherwise re-date an old completion |
| 56 | 🔴 `kpi.active_projects` (analytics) counts archived projects; `projects.active` (overview) excludes them | Two different "active projects" numbers on one screen, both correct per their own filter |
| 57 | 🔴 Two different "open task" definitions: `/employee/overview` uses `status != 'done'` (custom terminal statuses count as **open**); the client snapshot honours `custom_task_statuses[].is_terminal` | Only `project_progress` and the client snapshot are custom-status-aware |
| 58 | `/employee/analytics` `tasks_by_status` filters on `primary_assignee_id` only; `/employee/overview`'s open-task tile is `created_by` OR `primary_assignee_id` | The two employee task numbers are meant to differ |
| 59 | Overview `attendance.present` is a **per-working-day average** on multi-day ranges but a raw count on a single day; `on_leave`/`incomplete` are totals in both | Use `present_days` for "days present". Working days here = distinct `local_date`s with status not in `{weekend, holiday}` |
| 60 | `attendance.correction_requests` filters on the request's `created_at`, not the corrected day | A request filed today about last month lands in today's window |
| 61 | Overview headcount tiles are point-in-time and **do not vary with `from`/`to`** | Deliberate — an as-of-date version keyed on `created_at` (the seed date) produced "1 employee, 10 of 11 present" |
| 62 | `projects.total` is `active + completed + on_hold`, not the matched document count | A project in any other status vanishes from the total |
| 63 | Analytics failures return `{error: true}` for the section; snapshot/overview failures return **zeros** | Three safety nets, two representations — only analytics is distinguishable from a genuine zero |
| 64 | `buildDelta` returns `null` when the previous period is `<= 0` | No `+100%` off a zero base |
| 65 | Billable-value KPI silently contributes **0** for any `(user, project, day)` with no project-level billing rate; task-level rates are skipped entirely | A low KPI can mean "rates not configured", with no warning anywhere |
| 66 | A Team Lead on no project gets `taskScope = NO_TASKS_FILTER` (`{_id: ObjectId('000…000')}`), not `{}` | An empty scope must match nothing, not everything |
| 67 | `total_internal_active` / `activeInternalCount` exclude **both** `client` and `representative` | A bare `$ne: client` counted representatives as staff and inflated the team-size KPI and the attendance denominator |
| 68 | No dashboard route carries a rate limiter, and none of the twelve audits | Pure reads; only the global per-IP limiter applies |
| 69 | `hours_by_project` returns the **top 8** projects and `total_minutes` sums only those 8 | Not the window's true total. `null` `project_id` renders as `General (no project)` |
| 70 | `project_progress` has no cap — every visible project plus all of their tasks | The one unbounded analytics section |
