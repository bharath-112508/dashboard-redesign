# Dashboard, Search & Command Palette — Backend

Three read-only aggregation surfaces grouped because they all pull from every other module in the platform — dashboards summarise per-role landing pages, `/search` powers global typeahead, `/command-palette` adds the Cmd-K verb catalog on top.

Cross-references: every prior module's collections are read by these — `users`, `attendance_records`, `leave_requests`, `leave_balances`, `holidays`, `notifications`, `projects`, `sprints`, `tasks`. No writes, no audits.

---

## Scope

| Sub-module | Surface | Notes |
|---|---|---|
| **Dashboards** | `GET /dashboard/{admin\|manager\|employee\|client}` | One endpoint per role; per-card safe-fail |
| **Search** | `GET /search?q=&types=&limit=` | 4 buckets in parallel; regex+`$text` hybrid (Step 33) |
| **Command palette** | `GET /command-palette?q=` | Unified `{actions, items}` envelope; in-memory catalog + delegates items to search service |

---

## Roles & permissions

### Dashboards

| Endpoint | Permission | Held by |
|---|---|---|
| `GET /dashboard/admin` | `dashboard.admin` | Admin |
| `GET /dashboard/manager` | `dashboard.manager` | Admin, Manager, Team Lead |
| `GET /dashboard/employee` | `dashboard.employee` | Admin, Manager, Team Lead, Employee |
| `GET /dashboard/client` | `dashboard.client` | Client |

A caller with multiple role bundles hits only one endpoint per navigation — the FE picks which one based on which permission they have.

### Search & palette

Both gated on **`authenticate` only** at the route layer. Per-bucket visibility scoping happens inside the services.

| Endpoint | Rate limit | Notes |
|---|---|---|
| `GET /search` | 60/min/user (`searchRateLimiter`) | Regex `$or` across collections — pathological in a tight loop |
| `GET /command-palette` | 60/min/user (`commandPaletteRateLimiter`) — **separate bucket** (H3) | Pre-H3 had no limiter and could bypass search budget by routing identical queries; separate bucket means Cmd-K + future search page don't compete |

---

## Dashboards ([`dashboard.service.ts`](../../src/services/dashboard.service.ts), 670 lines)

### Common patterns

**`safeCard(label, fn, fallback)`** — every card aggregator is wrapped. One slow/failing collection cannot black out the whole landing page. Failures log `warn` with `card: <label>`; the card defaults to a contractually-shaped empty value.

**IST anchoring** — `todayLocalDate()` and `currentYear()` use `DEFAULT_TIMEZONE` (Asia/Kolkata). H1 — `currentYear` uses IST so the year-end window between IST midnight and UTC midnight doesn't read last year's balances.

### `GET /dashboard/admin`

```ts
{
  generated_at,
  headcount: {
    active: number,
    deactivated: number,
    by_role: {admin, manager, team_lead, employee, client},  // active only
  },
  attendance_today: {date, present, on_leave, incomplete, flagged_for_correction, total_internal_active},
  pending_leave_approvals: {
    count, requires_additional_approval,
    recent: [{id, user_id, requested_leave_type_id, start_date, end_date, total_days, requires_additional_approval, created_at}],  // last 5
  },
  holidays_this_month: number,
}
```

**4 cards in parallel via `Promise.all`** — each wrapped in `safeCard`. The admin headcount aggregation excludes deactivated users from `by_role` counts (they're surfaced separately as `deactivated`). Single-admin invariance is observable as `by_role.admin === 1` once bootstrap completes.

### `GET /dashboard/manager`

```ts
{
  generated_at,
  scope: 'team' | 'org',
  team_size: number,
  pending_leave_approvals: PendingLeaveCard,
}
```

**Admin-like callers get `scope: 'org'`** (`isAdminLike(caller)` per [auth module](./auth.md)): no team filter, sees the full pending queue.

**Manager / Team Lead callers get `scope: 'team'`**: pending leaves scoped to direct reports via `internal_profile.reporting_manager_id === caller.id`.

```
resolveDirectReportIds(manager_id) →
  User.find({status: ACTIVE, role: { $ne: CLIENT }, 'internal_profile.reporting_manager_id': manager_id})
```

Zero reports → empty PendingLeaveCard returned without hitting LeaveRequest.

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

**Client visibility**: only projects where `client_ids ∋ caller.id` are visible — every card scopes through `resolveClientProjectIds(user_id)` resolved **once** per request. Empty client → every card returns its empty fallback (no 500s; no leaked data from other clients' projects).

**M10 — `computeClientProjectCards(visibleProjectIds, limit)` accepts the pre-resolved IDs**: pre-M10 re-ran `{client_ids: user_id}` inside the card, duplicating the visibility scan. The new shape uses `_id: {$in: projectIds}` — fast `_id`-key lookup.

**Per-project rollup via one `$facet`-equivalent aggregation** — `$group` by `(project_id, status)` then re-group by `project_id` to produce `{task_count, statuses[], last_activity_at}` per project. Open count is `sum(count where status NOT IN terminal_set)`. Terminal set = `DEFAULT_DONE_TASK_STATUS_KEY` + any project custom status with `is_terminal: true`.

Cards sorted by `last_activity_at` desc, with `name.localeCompare` as tiebreaker.

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
| Team Lead / Employee | All active | `member_ids ∋ caller.id` via `buildProjectVisibilityFilter` | `project_id ∈ visibleProjectIds` |
| Client | **Always empty** (directory is internal-only) | `client_ids ∋ caller.id` | `project_id ∈ visibleProjectIds` |

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
  category: 'navigation'|'projects'|'tasks'|'time'|'leaves'|'attendance'|'reports'|'admin',
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

**`searchableRole === null` → items empty**. Search's visibility filter branches on the `RoleType` enum; if the caller's role isn't one of `{admin, manager, team_lead, employee, client}` we skip the items fetch (safe default — they get actions-only).

**Visibility delegation** — items fetch delegates to `search.service.search`, NOT a parallel implementation. Single source of truth for visibility scoping (member_ids vs client_ids vs admin-open) so Cmd-K and the dedicated `/search` endpoint never drift.

---

## End-to-end flows

### Admin lands on `/dashboard`

1. FE picks `/dashboard/admin` based on permissions. `GET /dashboard/admin`.
2. Service runs 4 cards in parallel:
   - `computeHeadcount` → User aggregation by `(role, status)` → `{active, deactivated, by_role}`.
   - `computeAttendanceToday` → AttendanceRecord aggregation for today (IST) + flagged count + active internal count.
   - `computePendingLeaves({})` → LeaveRequest pending count + recent 5.
   - `computeHolidaysThisMonth` → Holiday countDocuments for current IST month.
3. Each wrapped in `safeCard` — if one throws, that card returns its empty fallback and the others still populate.
4. Response merged → `200 {generated_at, headcount, attendance_today, pending_leave_approvals, holidays_this_month}`.

### Manager lands on `/dashboard`

1. `GET /dashboard/manager` — caller has `dashboard.manager` but not `system.admin`.
2. `isAdminLike(caller) === false` → team scope.
3. `resolveDirectReportIds(manager_id)` → 7 reports.
4. `computePendingLeaves({user_id: {$in: 7 reports}})` → scoped pending queue.
5. Response `{scope: 'team', team_size: 7, pending_leave_approvals: {...}}`.

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
3. Projects: `client_ids ∋ caller.id` filter applied. Returns hits limited to projects where the client is on the roster.
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
| `VALIDATION_ERROR` | 400 | `q` too short/long, unknown `types` value, empty `?types=` list |
| `RATE_LIMIT_EXCEEDED` | 429 | Per-user 60/min budget exceeded (separate buckets for search vs palette per H3) |

---

## Gotchas

| # | Behavior | Why |
|---|---|---|
| 1 | Every dashboard card wrapped in `safeCard` — one slow/failing aggregation can't black out the page | Cards default to contractually-shaped empty values; failures log warn |
| 2 | H1 — `currentYear()` and `todayLocalDate()` IST-anchored | Year-end window between IST + UTC midnight doesn't read stale data |
| 3 | Admin dashboard `headcount.by_role` counts ACTIVE only; deactivated surfaced separately | Total visible vs total ever |
| 4 | Manager dashboard scope: admin-like = `'org'`, others = `'team'` (direct reports only) | `isAdminLike(caller)` mirrors auth module |
| 5 | Manager `pending_leave_approvals` scoped via `reporting_manager_id` | Direct reports only |
| 6 | Employee dashboard self-heals leave balances (initializes year if missing) | Fresh joiner before first balance read |
| 7 | Client dashboard resolves `visibleProjectIds` ONCE per request | All cards scope through the list |
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
| 40 | All 3 endpoints return `generated_at` (dashboards) or implicit timestamp (response time) — useful for FE freshness | No `Cache-Control: no-cache` headers; FE staleTime is the active TTL |
