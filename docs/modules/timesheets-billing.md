# Timesheets & Billing Rates — Backend

Paired here because billing rates exist to multiply against timesheet hours at report time. The **Timesheets** sub-module owns daily time-logging (billable + non-billable split on the same row, task-linked or general), warnings (daily-threshold, leave-overlap — both soft), and the manager-only summary aggregate. The **Billing Rates** sub-module owns the per-`(user × project × task)` hourly-rate table with effective date ranges, auto-close-on-overlap semantics, and a "delete-only-if-unused" guard so historical bills never silently rebase.

Cross-references:
- [`leave-management.md`](./leave-management.md) — `overlapsApprovedLeave` checks `LeaveRequest{user, status:approved, start≤date≤end}` for the soft warning.
- [`project-management.md`](./project-management.md) — `loadProjectForCaller` is reused for task-linked entry visibility (timesheets inherit project ACL).
- [`reports-exports.md`](./reports-exports.md) (next module) — billing report joins `timesheet_entries × billing_rates` via the (user, project, task, date∈range) lookup.

---

## Scope

| Sub-module | Surface | Notes |
|---|---|---|
| **Timesheets** | `GET/POST/PATCH/DELETE /timesheets` + `/me` + `/me/day/:date` + `/summary` | Multi-row per day; billable + non-billable on same row |
| **Billing Rates** | `GET/POST/PATCH/DELETE /billing-rates` + `POST /:id/end` | Effective date ranges; auto-close on overlap |
| `timesheet_reminder` cron | Daily 20:00 IST | Notify users with no entry today, excluding on-leave |
| Report join | Cross-module | Owned by reports module |

---

## Roles & permissions

### Timesheets

Route-level baseline: `authenticate` only. Per-route gates narrow further.

| Endpoint | Permission | Held by |
|---|---|---|
| `GET /timesheets/me` | `authenticate` only (M4 — was `TIMESHEET_WRITE`) | Admin, Manager, Team Lead, Employee |
| `GET /timesheets/me/day/:date` | `authenticate` only (M4) | same |
| `GET /timesheets` | `timesheet.read` | Admin, Manager, Team Lead |
| `GET /timesheets/summary` | `timesheet.read` | Admin, Manager, Team Lead |
| `POST /timesheets` | `timesheet.write` | Admin, Manager, Team Lead, Employee |
| `GET /timesheets/:id` | **anyOf** `timesheet.read` OR `timesheet.write` (M4) | Read-only audit/HR holders + writers |
| `PATCH /timesheets/:id` | `timesheet.write` | Admin/Manager/TL/Employee — service-layer row-level check (owner OR privileged) |
| `DELETE /timesheets/:id` | `timesheet.write` | same |
| `timesheet.edit_out_of_window` | Privileged edit signal (not a route gate) | Audit-only — Manager+ when editing past the self-edit window |

**M4** — `GET /me` + `/me/day` used to require `TIMESHEET_WRITE`, which excluded read-only audit/HR roles holding `TIMESHEET_READ`. The service pins these to the caller's `user_id`, so `authenticate`-only is correct. `GET /:id` uses anyOf semantics — either role passes the gate, and the service applies the row-level "owner OR privileged" check.

**Clients have no timesheet permissions at all.** They don't log time and the entire surface is invisible to them.

**Service-layer row authorization** (`isManagerOrAdmin` helper):
- Owner can read/edit/delete their own row **within `self_edit_window_days`** (default 7).
- `Manager` and `Admin` (NOT `Team Lead` for write — see helper definition) can read/edit/delete **any** row at any time. Out-of-window edits fire a second audit row `timesheet.edit_out_of_window`.
- `Team Lead` is **not** considered privileged for row-level writes (the helper checks `role === ADMIN || role === MANAGER`); they can read team via the route-level `TIMESHEET_READ` but only edit their own rows.

### Billing Rates

| Endpoint | Permission | Held by |
|---|---|---|
| `GET /billing-rates` | `billing_rate.read` | Admin, Manager |
| `POST /billing-rates`, `PATCH`, `POST /:id/end`, `DELETE` | `billing_rate.write` | Admin only (per seed) |

No per-row authorization beyond the route gate.

---

## Data model

### `timesheet_entries` ([`timesheet-entry.model.ts`](../../src/models/timesheet-entry.model.ts))

```ts
{
  _id, user_id,
  local_date: 'YYYY-MM-DD',         // IST
  entry_type: 'task_linked' | 'general',

  // task_linked: project_id + task_id required (sprint_id optional, falls back to task's current sprint)
  // general: sprint_id/task_id null; project_id and general_category are each
  //          optional BUT at least one is required — and with no project the
  //          category must come off TIMESHEET_GENERAL_CATEGORIES
  project_id: ObjectId | null,
  sprint_id:  ObjectId | null,
  task_id:    ObjectId | null,
  general_category: string | null,   // ≤ 64; free text only when project_id is set

  // Same-row billable + non-billable split (NOT a separate is_billable flag — see plan §6.1)
  billable_hours: 0..24,
  billable_minutes: 0..59,
  billable_total_minutes,            // = billable_hours*60 + billable_minutes (denormalized)
  non_billable_hours: 0..24,
  non_billable_minutes: 0..59,
  non_billable_total_minutes,
  total_minutes,                      // = billable_total + non_billable_total

  description: string,                // ≤ 2000
  last_edited_by, last_edited_at,
  created_at, updated_at,
}
```

**Derived totals** are computed by [`computeTimesheetTotals`](../../src/models/timesheet-entry.model.ts) and persisted before save. Exported from the model so the service calls it before `create` / `save` — no stale total slips through.

**Indexes**:
- `{user_id: 1, local_date: -1}` — own-entries listing
- `{project_id: 1, local_date: -1}` — billing-report rollup
- `{task_id: 1}` — task drilldown
- `{local_date: 1}` — day-level summary across all users

**Why same-row split (not `is_billable` flag)**: a previous design had two rows per (task, day) — one billable, one non-billable. The Plan §6.1 "Decisions" entry rejected it because the join with billing rates needed to know "of these N hours on task T, how many are billable" — the flag approach forced a per-row `SUM(CASE WHEN is_billable THEN minutes)` aggregate that wasn't index-friendly. Same-row carries both totals; the report sums `billable_total_minutes` and multiplies by the rate.

### `billing_rates` ([`billing-rate.model.ts`](../../src/models/billing-rate.model.ts))

```ts
{
  _id,
  user_id, project_id, task_id: ObjectId | null,   // null = project-level fallback
  hourly_rate: number ≥ 0,
  effective_from: 'YYYY-MM-DD',                     // INCLUSIVE
  effective_to: 'YYYY-MM-DD' | null,                // INCLUSIVE; null = current/open-ended
  created_by, created_at, updated_at,
}
```

**Indexes**:
- `{user_id, project_id, task_id, effective_from: -1}` — the report's lookup path.
- `{user_id, project_id, task_id, effective_from}` **unique** (`billing_rates_tuple_unique`) — defense-in-depth against the parallel-create race. Two admins posting rates for the same tuple at the same `effective_from` both pass the in-process overlap check (each runs `find` before either saves) and would create two simultaneously-applicable rows. The unique index turns the second insert into a clean E11000 → 409 `DUPLICATE_RESOURCE`.
- `{project_id: 1}` — list-by-project filter.

**Effective range** — both bounds INCLUSIVE. A rate from `2026-01-01` → `2026-03-31` covers the whole of March 31. `effective_to = null` means "still current".

---

## Timesheet endpoints

| Method | Path | Permission | Body / Query |
|---|---|---|---|
| `GET` | `/timesheets/me` | auth | `?user_id?&project_id?&task_id?&from_date?&to_date?&page&limit` (default 20, max 200) — strict |
| `GET` | `/timesheets/me/day/:date` | auth | path: `:date` ISO | meta carries `{local_date, total_minutes}` |
| `GET` | `/timesheets/summary` | `timesheet.read` | `?user_id?&project_id?&task_id?&from_date?&to_date?&group_by=user\|project\|task\|date` (default `project`) |
| `GET` | `/timesheets` | `timesheet.read` | same as `/me` query — `user_id` honored |
| `POST` | `/timesheets` | `timesheet.write` | discriminated by `entry_type` — see below |
| `GET` | `/timesheets/:id` | `read` OR `write` (anyOf) | path: `:id` |
| `PATCH` | `/timesheets/:id` | `timesheet.write` | partial body (≥ 1 field) — no `entry_type` swap |
| `DELETE` | `/timesheets/:id` | `timesheet.write` | path: `:id` |

### Body shapes (discriminated by `entry_type`)

**`task_linked`** — strict project + task:
```ts
{
  local_date, entry_type: 'task_linked',
  project_id, sprint_id?: nullable, task_id,
  general_category: null,        // forbidden on this branch
  billable_hours, billable_minutes, non_billable_hours, non_billable_minutes,
  description?: ≤ 2000,
}
```

**`general`** — meetings / training / admin / other:
```ts
{
  local_date, entry_type: 'general',
  project_id?: nullable,         // optional; if set, caller must be able to see it
  sprint_id: null, task_id: null,
  general_category: string (1..64),  // REQUIRED + from the list when project_id is absent;
                                     // optional free text when it is present
  billable_hours, billable_minutes, non_billable_hours, non_billable_minutes,
  description?: ≤ 2000,
}
```

Cross-field rules **enforced in the service** (not the validator — they require runtime state):
- `local_date ≤ today` → else 422 `TIMESHEET_FUTURE_DATE`.
- `billable_total + non_billable_total > 0` → else 422 `TIMESHEET_ZERO_DURATION`.
- `total_minutes ≤ 24*60 = 1440` per row → else 422 `TIMESHEET_DURATION_TOO_LARGE`. The model caps `*_hours: 24` and `*_minutes: 59` independently, so without this guard a single row could encode ~50h.
- For `task_linked`, the body's `project_id` MUST match the task's parent → else 422 `TIMESHEET_TASK_REQUIRED`. Defense against client-side typos.
- Task visibility checked via `loadTaskForCaller` → reuses `loadProjectForCaller` so timesheet visibility tracks task visibility exactly.

### Summary endpoint (`GET /timesheets/summary`)

Aggregates `total_minutes`, `billable_total_minutes`, `non_billable_total_minutes`, and `entry_count` over the matched rows, grouped by `group_by`:

| `group_by` | `_id` shape | Notes |
|---|---|---|
| `user` | `{user_id}` | Hydrated as `{group_key, user: {id, full_name}, ...totals}` |
| `project` | `{project_id, general_category}` | When `project_id` is null (general entry), splits by `general_category` so Meetings, Code review, etc. each get their own row instead of being lumped into a single null bucket |
| `task` | `{task_id}` | Hydrated with `{task: {id, title}}` |
| `date` | `{local_date}` | No hydration |

Sorted by `total_minutes` descending. Service-layer `isManagerOrAdmin` gate **on top of** the route-level `TIMESHEET_READ` (the gate is double-bolted because the aggregate spans users).

---

## Timesheet flows

### Create entry (task-linked, in-window)

```
POST /timesheets {entry_type:'task_linked', task_id, project_id, billable_hours:4, billable_minutes:0, ...}
  ↓
assertNotFuture(local_date)                       ← TIMESHEET_FUTURE_DATE
assertNonZero(input)                              ← TIMESHEET_ZERO_DURATION
assertEntryUnderDailyCap(input)                   ← TIMESHEET_DURATION_TOO_LARGE
  ↓
loadTaskForCaller(task_id, caller)                ← reuses loadProjectForCaller → 404 if unseen
verify input.project_id === task.project_id       ← TIMESHEET_TASK_REQUIRED
sprintId = body.sprint_id ?? task.sprint_id       ← fallback to task's current sprint
  ↓
computeTimesheetTotals → {billable_total, non_billable_total, total_minutes}
TimesheetEntry.create({user_id: caller.id, ...input, ...totals, last_edited_by, last_edited_at})
  ↓
sumDailyTotalMinutes(caller.id, local_date)        ← AFTER persist; new row included naturally
warnings.exceeds_daily_threshold = daily_total_minutes > policy.daily_warn_threshold * 60
warnings.overlaps_approved_leave = LeaveRequest.exists({user, status:approved, start≤date≤end})
  ↓
audit TIMESHEET_CREATE with metadata {total_minutes, exceeds_daily_threshold, overlaps_approved_leave}
return {data: row, warnings}
```

Response envelope: `{data: row, warnings: {exceeds_daily_threshold, overlaps_approved_leave}}`. Warnings **never block** — entry persists. FE shows the warning chip below the row.

### Create entry (general, project optional)

`project_id` is optional — meetings, internal discussion, support and training belong to no project, and requiring one meant they were either charged to a client project nobody was working on or went unlogged. When supplied, `loadProjectForCaller` runs so the row doesn't quietly land against a project the caller can't see; when absent, no ACL call is made at all.

🔴 **An hour is attributed by a PROJECT or by a CATEGORY — at least one, never neither** — and the shape of `general_category` follows from which. Without a project it IS the attribution, so it is required and must be one of `TIMESHEET_GENERAL_CATEGORIES`: free text there cannot be grouped or charted and drifts into a second description box, which would leave internal time as invisible as it was when it had no project. With a project the project carries that load, so the field is optional free text naming the area worked on (`"Payroll module"`). `isGeneralCategoryValid(category, hasProject)` (`constants/timesheet.ts`) is the one place that decides, because the question is asked twice — by the create validator, and again by `updateEntry` against the **merged** row, where clearing the project also narrows the category back to the list and only the merged row can tell. `task_id`, `sprint_id` always null.

### Patch (in-window own, or privileged any-time)

```
loadEntryOr404(id)
  ↓
isOwner = entry.user_id.equals(caller.id)
isPrivileged = caller.role === ADMIN || caller.role === MANAGER
  ↓
if !isOwner && !isPrivileged → 403
  ↓
inWindow = local_date >= (today - selfEditWindowDays + 1)
if isOwner && !isPrivileged && !inWindow → 403 TIMESHEET_EDIT_WINDOW_EXPIRED
  ↓
apply patches (hours/minutes/description; if task_linked + task_id given, reload task + sprint fallback)
assertNonZero(post) + assertEntryUnderDailyCap(post)
recompute totals → save
sumDailyTotalMinutes + overlapsApprovedLeave → warnings
  ↓
audit TIMESHEET_UPDATE with metadata {privileged_edit, out_of_window}
if isPrivileged && !inWindow:
  ALSO audit TIMESHEET_EDIT_OUT_OF_WINDOW       ← canonical compliance signal; Step-31 UI greps this verb
return {data: row, warnings}
```

The **second audit row** on out-of-window manager edits is intentional. `TIMESHEET_EDIT_OUT_OF_WINDOW` is what the audit UI matches against to surface "manager overrode the self-edit window" — keeping it as a separate verb means the regular update audit stays clean while the override is greppable.

**PATCH does NOT swap `entry_type`** — that's effectively a different row. The validator schema omits the field.

### Delete (same authorization model as patch)

Same owner-OR-privileged + window check. Audit `TIMESHEET_DELETE` with before-snapshot + `{privileged_edit, out_of_window}` metadata.

### Self-listing (`/me`)

`buildListFilter` always pins `user_id = caller.id`. The query schema accepts `user_id` but the service **ignores** it — a harmless no-op so an admin who accidentally hits the self-route still gets their own timesheet rather than a 400.

### Manager list-all (`/timesheets`)

`isManagerOrAdmin` gate. User/project displays hydrated per-page (batched `User.find` + `Project.find` like audit/attendance/leaves). FE renders names without N+1 lookups.

---

## Billing Rate endpoints

| Method | Path | Permission | Body / Query |
|---|---|---|---|
| `GET` | `/billing-rates` | `billing_rate.read` | `?user_id?&project_id?&task_id?&active_on?&page&limit` (default 20, max 100) — strict |
| `POST` | `/billing-rates` | `billing_rate.write` | `{user_id, project_id, task_id?, hourly_rate, effective_from, effective_to?}` |
| `PATCH` | `/billing-rates/:id` | `billing_rate.write` | partial `{hourly_rate?, effective_to?}` — tuple fields are immutable |
| `POST` | `/billing-rates/:id/end` | `billing_rate.write` | — — idempotent close-now |
| `DELETE` | `/billing-rates/:id` | `billing_rate.write` | — — only if unused |

**`active_on=YYYY-MM-DD`** is the most useful query: "what rate applies to this user/project on this date?" → filter is `effective_from ≤ date AND (effective_to IS NULL OR effective_to ≥ date)`.

**PATCH is intentionally narrow**: only `hourly_rate` and `effective_to` are editable. The `(user, project, task, effective_from)` tuple defines the row's identity — moving any of those means delete + create, not patch.

---

## Billing rate write invariants

### 1. `effective_to >= effective_from`

Both bounds inclusive. `effective_to < effective_from` → 422 `BILLING_RATE_INVALID_RANGE`. Validated by `assertRange`.

### 2. Auto-close overlap on create — **forward extension only**

```
overlaps = findOverlappingRates({user, project, task, effective_from, effective_to})
                                ↑ symmetric overlap predicate:
                                  existing.from ≤ new.to AND (existing.to == null OR existing.to ≥ new.from)
if overlaps.length === 0 → just insert
if overlaps.length > 0:
  isSimpleForwardExtend = overlaps.length === 1
                          && overlaps[0].effective_to === null         ← predecessor is open-ended
                          && overlaps[0].effective_from < new.effective_from  ← strictly earlier
                          && new.effective_to === null                  ← new one is also open-ended
  if !isSimpleForwardExtend → 422 BILLING_RATE_INVALID_RANGE with {overlapping_rate_ids: [...]}
  ↓
  predecessor.effective_to = new.effective_from - 1 day
  predecessor.save()
  previousRateId = predecessor._id
  ↓
BillingRate.create(new)
  except E11000 on tuple unique index:
    → 409 DUPLICATE_RESOURCE with {user_id, project_id, task_id, effective_from}
  ↓
audit BILLING_RATE_CREATE with metadata {previous_rate_id?}    ← lets Step-31 audit UI render rate-history timeline
```

**Why "forward extend only" not general overlap resolution**:

The clean case is "current rate is open-ended; new rate starts today; bump the old one to yesterday and keep going". Anything else — back-filling a closed range that would slice through an open one, two simultaneously-overlapping rows, same-day overlap — gets refused with `BILLING_RATE_INVALID_RANGE`. The audit's lookup at report time relies on at most ONE rate being effective on any given day; the service holds the line here rather than trying to be clever.

**Recovery path for the refused cases**: admin uses `POST /:id/end` first to close the predecessor explicitly (audited as `billing_rate.end`), then creates the new row.

**Race**: two admins posting the same tuple + `effective_from` at the same time both pass the in-process overlap check (each runs `find` before either has `save`d) and would create two simultaneously-applicable rows. The unique index `billing_rates_tuple_unique` turns the second insert into a clean E11000 → 409.

### 3. Delete only if unused (`BILLING_RATE_IN_USE`)

```ts
usageFilter = {user_id, project_id, local_date: {$gte: effective_from}}
if task_id: usageFilter.task_id = task_id
if effective_to: usageFilter.local_date.$lte = effective_to

if TimesheetEntry.exists(usageFilter): throw 409 BILLING_RATE_IN_USE
```

The "usage" definition is **conservative**: any timesheet entry on the same `(user, project, task)` tuple within the effective range counts, **including non-billable rows**. The report engine still pulls them through the same join, so deleting the rate would silently rebase historical bills onto the next-most-recent rate.

### 4. `POST /:id/end` is idempotent

```
if rate.effective_to !== null: return rate unchanged       ← idempotent
today = today IST
rate.effective_to = today < rate.effective_from ? rate.effective_from : today
                                                  ↑ forward-dated row being ended before it began → empty range
save
audit BILLING_RATE_END
```

Why idempotent: re-clicking "End" on an already-ended rate shouldn't move the boundary forward and accidentally re-bill the intervening days. Returning unchanged is safe; if admin genuinely wants to move the boundary, `PATCH effective_to` is the explicit lever.

---

## Audit actions

| Action | When | Carries |
|---|---|---|
| `timesheet.create` | `POST /timesheets` | `after`, `metadata {total_minutes, exceeds_daily_threshold, overlaps_approved_leave}` |
| `timesheet.update` | `PATCH /:id` | `before`/`after`, `metadata {privileged_edit, out_of_window}` |
| `timesheet.edit_out_of_window` | Manager+ patching/deleting outside the self-edit window | `metadata {user_id, local_date, edit_window_days}` — **separate row** in addition to the regular `update`/`delete` |
| `timesheet.delete` | `DELETE /:id` | `before`, `metadata {privileged_edit, out_of_window}` |
| `billing_rate.create` | `POST /billing-rates` | `after`, `metadata {user_id, project_id, task_id, previous_rate_id?}` |
| `billing_rate.update` | `PATCH /:id` | `before`/`after` |
| `billing_rate.end` | `POST /:id/end` | `before`/`after` (no-op if already ended → no audit) |
| `billing_rate.delete` | `DELETE /:id` | `before` |

`timesheet.edit_out_of_window` is the canonical compliance signal — Step-31 audit UI greps for this verb to surface "manager overrode the window" without having to join two audit rows.

---

## Error codes

| Code | HTTP | When |
|---|---|---|
| `TIMESHEET_FUTURE_DATE` | 422 | `local_date > today IST` |
| `TIMESHEET_ZERO_DURATION` | 422 | All four `*_hours/_minutes` sum to 0 |
| `TIMESHEET_DURATION_TOO_LARGE` | 422 | `total_minutes > 1440` (24h) |
| `TIMESHEET_TASK_REQUIRED` | 422 | task_linked entry where body's `project_id` doesn't match the task's parent |
| `TIMESHEET_GENERAL_CATEGORY_REQUIRED` | 422 | (reserved — discriminated union enforces at validator) |
| `TIMESHEET_EDIT_WINDOW_EXPIRED` | 403 | Non-privileged owner trying to edit/delete a row outside `self_edit_window_days` |
| `TIMESHEET_NOT_FOUND` | 404 | `id` missing |
| `TASK_NOT_FOUND` | 404 | Cross-module — task referenced doesn't exist or caller can't see its project |
| `BILLING_RATE_INVALID_RANGE` | 422 | `effective_to < effective_from`, OR overlap is not a simple-forward-extend |
| `BILLING_RATE_IN_USE` | 409 | Delete blocked — at least one timesheet entry references this rate's tuple in its range |
| `BILLING_RATE_NOT_FOUND` | 404 | `id` missing |
| `DUPLICATE_RESOURCE` | 409 | Parallel insert race on `(user, project, task, effective_from)` unique index |

---

## `timesheet_reminder` cron ([`timesheet-reminder.job.ts`](../../src/jobs/timesheet-reminder.job.ts))

**Schedule**: daily 20:00 IST. `runKey = today IST date`. The `job_runs` unique index absorbs duplicate fires.

For each active **internal** user (admin / manager / employee — clients don't log time):

```
1. Skip if approved-leave covers today (LeaveRequest{start≤today≤end, status:approved})
2. Skip if user has at least one entry on today (TimesheetEntry.distinct('user_id', {local_date: today}))
3. Else fire notifyTimesheetReminder({recipient, local_date, expected_hours})
```

Notifications fan out via the notification-dispatcher (in-app + Slack DM + email + push, per the recipient's opt-ins).

**Why "logged at least one entry" not "logged the full expected hours"**: a strict comparison would nag mid-shift users. The soft prompt is the gentler default. A future setting can opt teams into the strict variant.

**Summary**: `{target_date, headcount, on_leave, already_logged, notified}` — single audit row per run via the job runner.

---

## End-to-end flows

### Employee logs 4h on a task

1. `POST /timesheets {entry_type: 'task_linked', task_id: T, project_id: P, billable_hours: 4, billable_minutes: 0, non_billable_hours: 0, non_billable_minutes: 0, local_date: '2026-06-08', description: 'Wired up the leave-approval flow.'}`.
2. Validator: discriminated `task_linked` branch matches. Duration shape OK.
3. Service:
   - `assertNotFuture('2026-06-08')` — today.
   - `assertNonZero` — total 240 min.
   - `assertEntryUnderDailyCap` — 240 ≤ 1440.
   - `loadTaskForCaller(T, caller)` → reuses `loadProjectForCaller(P, caller)` → caller is a member → OK.
   - `computeTimesheetTotals` → `{billable_total_minutes: 240, non_billable_total_minutes: 0, total_minutes: 240}`.
   - Create row.
   - `sumDailyTotalMinutes(caller, '2026-06-08')` = 240 (first entry today). `exceeds_daily_threshold = false`.
   - `overlapsApprovedLeave` = false.
   - Audit `TIMESHEET_CREATE`.
4. Response: `{data: row, warnings: {exceeds_daily_threshold: false, overlaps_approved_leave: false}}`.

### Employee logs another 5h same day (threshold warning)

1. Same POST with 5h. Service inserts. After-insert daily total = 240 + 300 = 540 min = 9h > 8h threshold.
2. `warnings.exceeds_daily_threshold = true`.
3. Audit metadata carries `exceeds_daily_threshold: true`.
4. FE shows soft "Over 8h logged today" chip. Row persists.

### Employee logs on a day they're on approved leave

1. Employee has an approved CL for `2026-06-08`. They log a 2h "general — meeting" entry on the same date.
2. `overlapsApprovedLeave('2026-06-08')` → true.
3. `warnings.overlaps_approved_leave = true`. Row persists. FE shows soft "Overlaps approved leave" chip.

### Manager edits an employee row 10 days later (out-of-window)

1. Self-edit window is 7 days. Employee's row from 10 days ago.
2. Manager `PATCH /timesheets/:id {billable_hours: 6}`.
3. `isOwner=false, isPrivileged=true, inWindow=false`.
4. Privileged gate passes; window check skipped because privileged.
5. Apply patches → recompute totals → save.
6. **TWO audit rows**:
   - `TIMESHEET_UPDATE` with `metadata.privileged_edit: true, out_of_window: true`.
   - `TIMESHEET_EDIT_OUT_OF_WINDOW` separate row carrying `{user_id, local_date, edit_window_days: 7}`.

### Employee tries to delete a 10-day-old row (refused)

1. Employee `DELETE /timesheets/:id`. `isOwner=true, isPrivileged=false, inWindow=false`.
2. → 403 `TIMESHEET_EDIT_WINDOW_EXPIRED`.
3. Admin can still delete it (privileged gate).

### Admin creates a new billing rate (forward extension)

1. Existing: `User U × Project P × Task null, rate=80, from=2025-01-01, to=null` (open-ended).
2. `POST /billing-rates {user_id: U, project_id: P, task_id: null, hourly_rate: 95, effective_from: 2026-01-01, effective_to: null}`.
3. Service `findOverlappingRates` returns the existing rate.
4. `isSimpleForwardExtend = true` (only one overlap, predecessor open-ended, strictly earlier, new also open-ended).
5. Close predecessor: `effective_to = 2025-12-31`. Save.
6. Create new rate. `previousRateId = predecessor._id`.
7. Audit `BILLING_RATE_CREATE` with `metadata.previous_rate_id`.

### Admin tries to back-fill a closed range over an open one (refused)

1. Existing: `from=2025-01-01, to=null`.
2. `POST /billing-rates {effective_from: 2025-06-01, effective_to: 2025-09-30, hourly_rate: 90}`.
3. `findOverlappingRates` returns the existing rate.
4. `isSimpleForwardExtend = false` (the new one has a finite `effective_to`).
5. → 422 `BILLING_RATE_INVALID_RANGE` with `{overlapping_rate_ids: [existing._id]}`.
6. Admin uses `POST /:id/end` first to close the predecessor explicitly, then creates the new row.

### Admin ends an already-ended rate (no-op)

1. Rate has `effective_to = 2025-12-31` already.
2. `POST /:id/end`. `effective_to !== null` → return unchanged. **No audit row** (we don't audit no-ops).

### Admin tries to delete a billing rate that's been used (refused)

1. Rate covers Jan 2026. Some timesheet entries exist for the tuple in Jan 2026.
2. `DELETE /:id`. `TimesheetEntry.exists({user, project, task?, local_date: {$gte: from, $lte: to}})` → true.
3. → 409 `BILLING_RATE_IN_USE`. Admin must use `POST /:id/end` instead (which keeps history intact).

### 20:00 cron reminds an employee

1. Cron runs 20:00 IST. Headcount = 50. On approved leave = 3. Already logged = 36.
2. 11 users notified via in-app + Slack DM + email + push (per their opt-ins).
3. Single job_runs audit row with summary `{target_date, headcount: 50, on_leave: 3, already_logged: 36, notified: 11}`.

---

## Gotchas

| # | Behavior | Why |
|---|---|---|
| 1 | M4 — `/me` + `/me/day` route gates are `authenticate` only (NOT `TIMESHEET_WRITE`) | Read-only audit/HR holders need access; service pins to caller's user_id |
| 2 | M4 — `GET /:id` gated as **anyOf** `TIMESHEET_READ` OR `TIMESHEET_WRITE` | Read-only roles can see entries; row-level "owner OR privileged" check applies |
| 3 | `isManagerOrAdmin` excludes Team Lead from privileged write semantics | Team Lead can read team via route gate but only edit their own rows |
| 4 | Same-row billable + non-billable (NOT a separate is_billable flag) | Plan §6.1 decision — index-friendly aggregate at report time |
| 5 | Derived totals (`billable_total_minutes`, `non_billable_total_minutes`, `total_minutes`) computed by `computeTimesheetTotals` before save | No stale total slips through |
| 6 | Per-entry hard cap 24h (`TIMESHEET_PER_ENTRY_MAX_MINUTES = 1440`) on top of model caps `*_hours: 24, *_minutes: 59` | Without the cap, one row could encode ~50h |
| 7 | `local_date > today IST` rejected as `TIMESHEET_FUTURE_DATE` | No future logging |
| 8 | `task_linked` entry's body `project_id` MUST match `task.project_id` | Defense against client-side typos; surfaces as `TIMESHEET_TASK_REQUIRED` |
| 9 | `sumDailyTotalMinutes` runs AFTER persist — new row included naturally in the aggregate | No row-exclusion needed |
| 10 | `overlapsApprovedLeave` ignores `is_half_day` / `half_day_slot` (v1) | Under-warning would be the regrettable case; future setting can refine |
| 11 | Warnings never block — entry persists; FE surfaces chip | `warning.exceeds_daily_threshold` + `warning.overlaps_approved_leave` are soft signals |
| 12 | Manager out-of-window edit fires `TIMESHEET_EDIT_OUT_OF_WINDOW` as a **second** audit row | Step-31 audit UI greps this verb specifically |
| 13 | Audit metadata on update/delete carries `{privileged_edit, out_of_window}` flags | Lets the audit UI annotate rows without re-deriving |
| 14 | `PATCH` does NOT swap `entry_type` | Effectively a different row; delete + create instead |
| 15 | Self-edit window default = 7 days (`TIMESHEET_DEFAULT_SELF_EDIT_WINDOW_DAYS`) | Configurable in `system_settings.timesheet.self_edit_window_days` |
| 16 | Self-listing `/me` ignores any `user_id` in query (no 400) | Harmless no-op so admin hitting self-route still gets their own data |
| 17 | List queries are `.strict()` — unknown params return 400 | Anti-typo guard (e.g. `?status=` instead of `?from_date=`) |
| 18 | List rows hydrate `user.{id, full_name}` + `project.{id, name, code}` per page | Batched `User.find` + `Project.find` — no N+1 |
| 19 | Summary `group_by=project` splits null-project rows by `general_category` | Each general bucket gets its own row instead of being lumped into one null |
| 20 | Summary endpoint has BOTH route-level `TIMESHEET_READ` AND service-level `isManagerOrAdmin` gate | Double-bolted because aggregate spans users |
| 21 | Billing-rate `(user, project, task, effective_from)` unique index turns parallel-create race into clean 409 | Defense in depth — in-process overlap check would otherwise miss it |
| 22 | Auto-close on create only handles "simple forward extend" | Anything else refused with `BILLING_RATE_INVALID_RANGE` — admin uses `POST /:id/end` first |
| 23 | Billing-rate delete blocked when ANY (incl. non-billable) timesheet entry references the tuple in the range | Conservative — report engine pulls non-billable through the same join |
| 24 | `POST /:id/end` is idempotent — no-op if already ended (NO audit row) | Re-clicking End shouldn't move the boundary forward |
| 25 | `effective_to = null` means "current/open-ended" (NOT future-dated) | Lookups use `$or: [{to:null}, {to:{$gte:date}}]` |
| 26 | Effective bounds are both INCLUSIVE | `2026-01-01` → `2026-03-31` covers all of March 31 |
| 27 | PATCH on billing rates allows ONLY `hourly_rate` and `effective_to` | Tuple fields define identity; moving them = delete + create |
| 28 | `task_id = null` rate is the project-level fallback at report time | Task-specific rate wins over null-task rate |
| 29 | `active_on=YYYY-MM-DD` query filter — `{from ≤ date AND (to IS NULL OR to ≥ date)}` | The FE's rate-picker uses this exclusively |
| 30 | Soft policies are persisted with the row + warning attached, NOT a clean rejection | Audit trail needs the row + warning visible |
