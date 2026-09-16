# Leave Management — Backend

The **Leave Management** module owns the entire leave engine: leave-type catalog, per-user-per-year balances, leave-request lifecycle (apply → approve / reject / cancel), the pure segment generator that splits requests across types + years + months, comp-off ledger with the LeaveBalance mirror, SL monthly forfeiture, and the year-rollover + reconciliation cron jobs.

For role bundles + the `requirePermission` mechanism see [`roles-rbac.md`](./roles-rbac.md). For audit emission semantics see [`auth.md`](./auth.md). For dispatch (Slack DM, in-app, email) see the Notifications module.

---

## Scope

| Surface | In scope | Notes |
|---|---|---|
| Leave-type catalog + 7 seeded codes (CL/SL/MATERNITY/PATERNITY/WFH/COMP_OFF/UNPAID) | ✓ | `leave_types` model + boot-time seeder |
| Leave-balance per `(user, type, year)` | ✓ | `leave_balances` with denormalised `available` |
| Pure segment engine (year split, SL→CL spillover, working-day enumeration) | ✓ | `services/leave-segment.engine.ts` — zero DB imports |
| Leave-request lifecycle (apply / preview / list / get / approve / reject / cancel / calendar) | ✓ | `leave_requests` with embedded `leave_segments[]` |
| Atomic balance reservation (apply) + atomic state transitions (approve / reject / cancel) | ✓ | CAS via `findOneAndUpdate({available: {$gte}})` + transactional state flips |
| Comp-off ledger (append-only) + denorm balance on `users.comp_off_balance` | ✓ | `comp_off_ledger` + `User.comp_off_balance` cache |
| Comp-off → LeaveBalance(COMP_OFF) mirror for the apply engine | ✓ | BUG-036 — apply reads from LeaveBalance, comp-off lives in ledger |
| SL monthly forfeiture (apply-time + cron) | ✓ | `sl_monthly_forfeitures` collection with `(user, year, month)` unique idempotency |
| Year-rollover cron (Jan 1 00:05 IST) | ✓ | `jobs/leave-year-rollover.job.ts` |
| Comp-off balance reconciliation cron (02:30 IST daily) | ✓ | M42 — `jobs/comp-off-reconciliation.job.ts` |
| Holiday calendar interaction | Read-only consumer | Holiday module owns CRUD; engine reads `holidays.date` for working-day enumeration |
| Slack DM / push / email dispatch | Consumed | Notifications module owns it; this service calls `notifyLeaveSubmitted` + `notifyLeaveDecided` |

---

## Roles & permissions

| Permission | Held by (default bundles) | Gates |
|---|---|---|
| `leave_type.read` | Employee+, Client | `GET /leave-types` |
| `leave_type.write` | Admin | `POST /leave-types`, `PATCH /leave-types/:id`, `POST /leave-types/:id/deactivate` |
| `leave_request.write` | Admin, Manager, Team Lead, Employee | `POST /leaves`, `POST /leaves/preview-split`. **Clients don't have it** — clients can't apply for leave. |
| `leave_request.approve` | Admin, Manager, Team Lead | `POST /leaves/:id/approve`, `POST /leaves/:id/reject` |
| `leave_request.read_team` | Admin, Manager, Team Lead | `GET /leaves/calendar` (C5 — was authenticate-only pre-fix, leaked the org's leave plan to any caller) |
| `leave_balance.read_team` | Admin, Manager | `GET /leave-balances` (admin team view) |
| `leave_balance.adjust` | Admin | `PATCH /leave-balances/:id`, `POST /leave-balances/initialize-year` |
| `comp_off.read` | Admin, Manager (`/comp-off`); everyone has `/comp-off/me` via `authenticate` | `GET /comp-off` (team view) |
| `comp_off.write` | Admin, Manager | `POST /comp-off/adjust` |

`GET /leaves`, `GET /leaves/:id`, `GET /leave-balances/me`, `POST /leaves/:id/cancel`, `GET /comp-off/me` are **`authenticate`-only**; the service-layer `isReviewer(role)` and `caller.id.equals(req.user_id)` checks scope what each role sees.

The service-layer `isReviewer` accepts Admin / Manager / Team Lead (Step-47 — Team Lead is a first-line approver per the role bundle). Reporting-chain narrowing (only own reports' requests) is a future enhancement; today all three roles can approve any pending leave they can see.

---

## Data model

### `leave_types` ([`leave-type.model.ts`](../../src/models/leave-type.model.ts))

Master config for the engine. Seeded on every boot from `LEAVE_TYPE_SEEDS` ([`constants/leave.ts`](../../src/constants/leave.ts) — `$setOnInsert` so admin overrides survive restarts).

```ts
{
  _id, code (UNIQUE, uppercase),       // CL / SL / MATERNITY / PATERNITY / WFH / COMP_OFF / UNPAID + customs
  name,
  default_allocation_days,
  carry_forward, carry_forward_cap,
  monthly_cap,                          // SL=1 in v1; null otherwise
  monthly_forfeiture,                   // true = unused buckets forfeit at month-end (currently false for everything)
  is_unlimited,                         // WFH — skips balance check entirely
  is_earned,                            // COMP_OFF — no annual allocation; balance from comp_off_ledger
  is_event_based,                       // MATERNITY/PATERNITY — admin grants per event, no annual cycle
  pro_rata_on_join: 'none' | 'by_months_remaining' | 'sl_monthly_buckets',
  supports_half_day,                    // CL + SL only (true); others false
  advance_notice_days,                  // CL=14, everything else 0
  resets_yearly,                        // CL/SL=true; MATERNITY/PATERNITY/WFH/COMP_OFF/UNPAID=false
  is_active,                            // false = hidden from apply form; historical rows preserved
}
```

**Hard-delete is forbidden.** Deactivation flips `is_active: false`. Historical `leave_segments[].leave_type_id` would otherwise dangle.

#### Seeded codes

| Code | Annual | Carry-forward | Monthly cap | Forfeiture | Half-day | Notice | Pro-rata |
|---|---|---|---|---|---|---|---|
| **CL** (Casual) | 15 | No | — | — | Yes | 14 days | `by_months_remaining` |
| **SL** (Sick) | 12 | No | 1/month | No (changed — used to forfeit unused monthly buckets; business reverted) | Yes | 0 | `sl_monthly_buckets` |
| **MATERNITY** | 180 | No | — | — | No | 0 | `none` (event-based) |
| **PATERNITY** | 30 | No | — | — | No | 0 | `none` (event-based) |
| **WFH** | 0 | No | — | — | No | 0 | `none` (`is_unlimited: true`) |
| **COMP_OFF** | 0 | Yes | — | — | No | 0 | `none` (`is_earned: true`, ledger-backed) |
| **UNPAID** | (large) | No | — | — | No | 0 | `none` |

### `leave_balances` ([`leave-balance.model.ts`](../../src/models/leave-balance.model.ts))

One row per `(user_id, leave_type_id, year)` — unique compound index. Composite key keeps year-spanning requests honest: a Dec 29 → Jan 3 request creates two segments (one per year) that independently `pending++` against the matching year's row.

```ts
{
  user_id, leave_type_id, year,
  allocated,                  // computed by pro_rata_on_join at init time
  carried_forward,
  used, pending, adjusted,
  monthly_forfeited,
  available,                  // DENORMALIZED — recomputed on every mutation
}
```

**`available` denormalization:**
```ts
available = allocated + carried_forward + adjusted − used − pending − monthly_forfeited
```

Helper `recomputeAvailable(b)` in the model file. Stored (not computed at read) so the apply-flow's atomic CAS guard works:

```ts
LeaveBalance.findOneAndUpdate(
  { user_id, leave_type_id, year, available: { $gte: needed } },
  { $inc: { pending: needed, available: -needed } }
)
```

The `$gte` predicate makes the reservation race-safe — two concurrent applies for the same (user, type, year) can't both pass the check.

**Indexes:**
- `{user_id: 1, leave_type_id: 1, year: 1}` **unique**
- `{year: 1}` — supports cross-user year-rollup queries

For COMP_OFF, this row is **informational only** (`is_earned: true` on the type) — the source of truth is `comp_off_ledger`. The matching `(user, COMP_OFF, year)` row is still maintained as a mirror so the `/leave-balances/me` response shape stays uniform AND the apply-leave engine can read availability from a single source.

### `leave_requests` ([`leave-request.model.ts`](../../src/models/leave-request.model.ts))

The header doc represents the **user-visible** request. The actual debits live in **embedded `leave_segments[]`** because a single SL request can split into `1 SL + N CL` and a year-spanning request creates one segment per year. Storing inline keeps apply → approve → cancel transactions single-document.

```ts
{
  _id, user_id, requested_leave_type_id,
  start_date, end_date,           // YYYY-MM-DD strings
  is_half_day, half_day_slot,     // 'first_half' | 'second_half' | null
  total_days,                     // sum of segments
  leave_segments: [{leave_type_id, year, days}],
  reason, attachment_url,
  status,                         // 'pending' | 'approved' | 'rejected' | 'cancelled'
  requires_additional_approval,   // set when applied would drive a balance < 0 (CL only)
  additional_approval_reason,     // required ≥ 5 chars on approve if requires_additional_approval
  approver_id, approver_remarks, acted_at,
  cancelled_at, cancelled_by, cancellation_reason,
  slack_message: {channel, ts} | null,  // for chat.update lifecycle messages
}
```

#### State machine

```
                  ┌── reject ──▶ rejected
pending ──cancel──┤
                  └── self-cancel ──▶ cancelled (refund pending)
   │
   └── approve ──▶ approved
                     └── cancel (before start) ──▶ cancelled (refund used)
```

Approve / reject / cancel-after-approval use atomic `findOneAndUpdate({_id, status: <expected>})` so the loser of any race sees a 409 instead of double-mutating balances.

#### Indexes

- `{user_id: 1, start_date: -1}` — "my leaves" view
- `{approver_id: 1, status: 1}` — "my queue" for managers
- `{status: 1, requires_additional_approval: 1}` — overrides queue
- `{start_date: 1, end_date: 1}` — calendar range queries
- `{'leave_segments.leave_type_id': 1, 'leave_segments.year': 1}` — for SL replay attribution (C4)
- `{status: 1, start_date: -1}` — **M40** — admin queue: `find({status, start_date: $lte}).sort({start_date: -1})`

### `comp_off_ledger` ([`comp-off-ledger.model.ts`](../../src/models/comp-off-ledger.model.ts))

Append-only. Each row is either `earned` (+) or `consumed` (−). Sign implied by `type`; `days` is always positive.

```ts
{
  user_id,
  type: 'earned' | 'consumed',
  days,                              // always positive
  source_type: 'attendance_overtime' | 'leave_request' | 'admin_adjustment',
  source_ref_id,                     // attendance row OR leave row OR null
  remarks,
  created_by,
}
```

Current balance for a user = `Σ(earned) − Σ(consumed)`, **cached on `users.comp_off_balance`** and maintained by the CAS `$inc` on every adjust. Nightly reconciliation cron (M42) detects + repairs drift.

**Comp-off never expires** — no year-end forfeiture, no carry-forward toggle. The `users.comp_off_balance` cache is the single number surfaced in the user-facing API.

Index: `{user_id: 1, created_at: -1}` for the per-user ledger feed.

### `sl_monthly_forfeitures` ([`sl-monthly-forfeiture.model.ts`](../../src/models/sl-monthly-forfeiture.model.ts))

Two jobs at once: **idempotency record for the month-end SL forfeiture cron** (currently disabled because `monthly_forfeiture: false` on SL after the business reverted the "use it or lose it" policy), and **audit log for the apply-time SL monthly-cap check**.

Apply-time semantics ([`leave-segment.engine.ts`](../../src/services/leave-segment.engine.ts)): when computing whether a user can claim 1 SL day in month M of year Y, count `approved+pending SL days in (Y, M) on leave_segments` PLUS `forfeited_days from this collection where (user, Y, M)`. If total `>= SL.monthly_cap`, the request **routes that day to CL instead**.

Unique compound `(user_id, year, month)` is what makes the monthly cron idempotent — a duplicate `insertOne` raises E11000 and the cron treats that as "already done".

---

## Segment engine

[`services/leave-segment.engine.ts`](../../src/services/leave-segment.engine.ts) — **pure function, zero Mongoose imports**. Unit-tested by [`leave-segment.engine.test.ts`](../../src/services/leave-segment.engine.test.ts) without spinning up a database.

### Inputs

| Field | Source |
|---|---|
| `requested_code` | The leave type the user *applied under* — drives split policy (e.g. SL → 1 SL/month + remainder to CL) |
| `start_date` / `end_date` / `is_half_day` / `half_day_slot` | Request body |
| `working_days` | `system_settings.work_schedule.working_days` (default `[1,2,3,4,5]` = Mon–Fri) |
| `holidays` | `Set<YYYY-MM-DD>` from the Holidays module |
| `sl_month_used` | Per-month map of "SL slots already gone" — caller seeds from approved+pending SL segments + `sl_monthly_forfeitures` |
| `available` | `(code, year) → leave_balances.available` snapshot — engine flags `requires_additional_approval` when a chosen segment would drive it `< 0` |
| `slots_per_month` | SL monthly cap from `leave_types.SL.monthly_cap` (1 in v1) |

### Output

```ts
{
  total_days,                            // sum of segments, snapped to 0.5 grid
  leave_segments: [{leave_type_code, year, days}],
  requires_additional_approval,         // any segment drives available < 0?
  warnings: [{code, message}],          // LEAVE_SPANS_YEARS, LEAVE_NO_WORKING_DAYS, LEAVE_INVALID_HALF_DAY
  working_days: ['YYYY-MM-DD', ...],    // post weekend/holiday filter
}
```

### Algorithm

1. **Half-day fast path**: if `is_half_day`, require `start_date == end_date`. Single working day, single segment.
2. **Working-day enumeration**: walk `start → end`, skip days not in `working_days`, skip days in `holidays`. Result is the canonical day list.
3. **Group by year**. Multi-year → emit `LEAVE_SPANS_YEARS` warning.
4. **Per-year split** — different logic by `requested_code`:
   - **Anything except SL** → one segment `{requested_code, year, totalDays}`.
   - **SL** → walk months in order. For each month, allow up to `slots_per_month - already_used` SL days; **remainder spills to CL**. The engine increments its in-memory `sl_used` map as it allocates, so a multi-year SL request doesn't double-claim the slot.
5. **Finalize**: sum total, snap to 0.5, mark `requires_additional_approval` if any planned segment drives `available[code|year] - planned[code|year] < 0`.

The engine deliberately stops at **codes**, not ids. Apply-flow translates `code → leave_type_id` against the active types map right before persisting.

---

## SL month-attribution replay (C4)

[`buildSlMonthUsedMap`](../../src/services/leave-request.service.ts).

**Pre-C4 bug**: the helper read each historical request's `start_date.month` ONCE and attributed every stored SL day for that request to that single month. A request spanning Jan 30 → Feb 2 with 1 SL day in Feb got filed as January SL usage; the next February request then re-claimed its February slot, **double-spending the cap**.

**Post-C4 fix**: re-derive month attribution by **replaying the engine's own chronological first-fit + `slots_per_month` cap algorithm** against each historical request's actual working-day enumeration. Requests are processed in `created_at` order so the cap state at each request's apply time is reconstructed — not what the calendar looks like today.

Pseudo:
```
For each historical SL request in created_at order:
  Aggregate this request's SL days by year
  Enumerate the request's actual working days
  Bucket by (year, month)
  For each year with stored SL:
    slRemaining = stored SL days
    For each month in order:
      take = min(slots_per_month - already_used, monthDayCount, slRemaining)
      if take > 0:
        out[(year, month)] += take
        slRemaining -= take

Plus: SlMonthlyForfeiture rows additive
```

Holidays are loaded for the **full year span** of every touched year (not just the requesting leave's date range) so historical requests outside the apply context's range are still correctly day-counted.

---

## Endpoints

### Leave types ([`routes/leave-type.routes.ts`](../../src/routes/leave-type.routes.ts))

| Method | Path | Permission | Notes |
|---|---|---|---|
| `GET` | `/leave-types` | `leave_type.read` | `?is_active&show_deleted` — BUG-002 default hides inactive |
| `POST` | `/leave-types` | `leave_type.write` | E11000 on duplicate code → 409 `DUPLICATE_RESOURCE` |
| `PATCH` | `/leave-types/:id` | `leave_type.write` | `code` NOT patchable (stable natural key) |
| `POST` | `/leave-types/:id/deactivate` | `leave_type.write` | Idempotent; flips `is_active: false` |

### Leave balances ([`routes/leave-balance.routes.ts`](../../src/routes/leave-balance.routes.ts))

| Method | Path | Permission | Notes |
|---|---|---|---|
| `GET` | `/leave-balances/me` | `authenticate` | Self-heals: initializes balances for the requested year if missing. `available` is published through `presentedAvailable`, so an uncapped type (WFH) reports **0**, not the raw `0 − used − pending` negative; `used` is the meaningful figure there. Same for the dashboard card and the leaves report. |
| `GET` | `/leave-balances` | `leave_balance.read_team` | `?user_id&year` |
| `POST` | `/leave-balances/initialize-year` | `leave_balance.adjust` | Manual bulk-init across every active user who is neither client-side nor a freelancer. 🔴 **Not filtered on `date_of_joining`** — it used to require one, which silently skipped every employee without a joining date on file, leaving them with zero balance rows and therefore absent from the admin leave-balance list (which renders from balance rows). `initializeBalancesForUserYear` already defaults a missing joining date to the start of the target year; that one fallback owns the case for every caller. |
| `PATCH` | `/leave-balances/:id` | `leave_balance.adjust` | `{total_days?, used_days?, reason}` **or** `{delta, reason}` — one shape or the other, never both. **Totals** are how an operator reconciles against an external leave portal: state the counters as that system reports them and the remaining balance is derived. `total_days` is the full allowance (quota + carry-forward + manual adjustment) and lands on `adjusted`, so the computed quota and any carry-forward stay on the row; `used_days` is written straight to `used`, because days taken in a system being migrated from have no leave requests here to derive them from. Either field may be sent alone. Totals that already match are accepted, so syncing a roster doesn't error on the rows that agree. **`delta`** is the original relative move, non-zero, and still reads better for a known grant or clawback. Everything rounds to 2dp. |

### Leave requests ([`routes/leave-request.routes.ts`](../../src/routes/leave-request.routes.ts))

| Method | Path | Permission | Body / query |
|---|---|---|---|
| `POST` | `/leaves/preview-split` | `leave_request.write` | Same body as POST `/leaves`. Returns dry-run segments. |
| `GET` | `/leaves/calendar` | `leave_request.read_team` (C5) | `?from_date&to_date` (≤ 366d). Returns approved leaves with `display_end_date` (last working day for bar rendering) |
| `GET` | `/leaves` | `authenticate` | Employees see own; reviewers see all. `?status&user_id&from_date&to_date&requires_additional_approval&page&limit` |
| `POST` | `/leaves` | `leave_request.write` | `ApplyLeaveBody` |
| `GET` | `/leaves/:id` | `authenticate` (caller is owner OR reviewer) | — |
| `POST` | `/leaves/:id/approve` | `leave_request.approve` | `{approver_remarks?, additional_approval_reason?}` |
| `POST` | `/leaves/:id/reject` | `leave_request.approve` | `{approver_remarks}` — required 1–500 chars |
| `POST` | `/leaves/:id/cancel` | `authenticate` (owner OR reviewer; not own approve) | `{cancellation_reason?}` — BUG-035 made optional |

### Comp-off ([`routes/comp-off.routes.ts`](../../src/routes/comp-off.routes.ts))

| Method | Path | Permission | Notes |
|---|---|---|---|
| `GET` | `/comp-off/me` | `authenticate` | Returns `{data, meta, balance}` envelope (not the standard `paginated()`) |
| `GET` | `/comp-off` | `comp_off.read` | Team ledger with hydrated user display |
| `POST` | `/comp-off/adjust` | `comp_off.write` | `{user_id, type, days, remarks}` — CAS-guarded |

---

## Apply flow (detailed)

[`applyLeave`](../../src/services/leave-request.service.ts):

1. **Load apply context** — `system_settings.work_schedule.working_days`, holidays for the date range, active leave types (by code + by id).
2. **Validate type** — exists + `is_active`. Else `RESOURCE_NOT_FOUND` / `VALIDATION_ERROR`.
3. **Date-policy gates**:
   - `start_date < today` (IST) → 422 `LEAVE_BACKDATED_NOT_ALLOWED`. Backdated leave is forbidden.
   - `advance_notice_days > 0` and `start_date < today + notice` → 422 `LEAVE_NOTICE_VIOLATION` with `{earliest_start_date, advance_notice_days}`.
   - `is_half_day && !supports_half_day` → 422 `LEAVE_INVALID_HALF_DAY`.
4. **Engine**:
   - Build `slMonthUsed` via `buildSlMonthUsedMap` (C4 replay).
   - Build `availableMap` via `loadAvailableMap` — self-heals the balance row for every touched year.
   - Both run in parallel via `Promise.all`.
   - `generateSegments(...)` → `engine` result.
5. **Engine warnings → errors**:
   - `LEAVE_INVALID_HALF_DAY` warning → 422.
   - `total_days === 0 || segments.length === 0` → 422 `LEAVE_NO_WORKING_DAYS` (all weekends/holidays — common single-day-holiday case).
6. **Overlap check** — `assertNoOverlap`:
   - `findOne({user_id, status: ['pending', 'approved'], start_date: {$lte: new.end}, end_date: {$gte: new.start}})`.
   - If hit → 409 `LEAVE_OVERLAP` with `{conflicting_id}`.
7. **Resolve segments** — `code → leave_type_id` via the active types map. Missing → internal error (the type was deleted between context load and resolve).
8. **`reserveBalances`** — for each segment, sequentially:
   - `findOrInitBalance(user_id, type_id, year)`.
   - Atomic CAS: `findOneAndUpdate({user_id, type_id, year, available: {$gte: seg.days}}, {$inc: {pending: +days, available: -days}})`. The `available: $gte` predicate is **omitted** for `is_unlimited` (WFH) and `code === CL` (CL can dip negative when the approver provides `additional_approval_reason`).
   - If `null` returned → **insufficient balance** → 409 `INSUFFICIENT_LEAVE_BALANCE` with `{code, year, requested}`. Any prior reservations in this request are rolled back via `releaseReservations`.
9. **Persist** — `LeaveRequest.create({...status: 'pending'})`. If the insert throws, `releaseReservations` rolls back the reservations.
10. **H2 — post-insert overlap re-check** — `assertNoOverlap` with `excludeId: created._id`. If a competing row appeared between step 6 and step 9 (two concurrent applies on different DB snapshots), **delete this insert + release reservations + throw `LEAVE_OVERLAP`**. Wrapping the apply in `withTransaction` does NOT close this race because the two writes target different documents and don't trip any unique-index conflict; transactions only detect document-level write conflicts, not logical overlap.
11. **H4 — audit** `LEAVE_APPLY` with `after: {status, dates, total_days, requires_additional_approval}` and `metadata: {user_id, leave_type_id, segments_count}`. Pre-H4 only approve/reject/cancel were audited; the CREATION was invisible to the trail.
12. **Notify** — `notifyLeaveSubmitted({request_id, requester_id, leave_type_label, dates, ...})`. Best-effort — dispatcher logs `NOTIFICATION_DISPATCH_FAILED` on failure and never throws.

---

## Approve flow

[`approveLeave`](../../src/services/leave-request.service.ts):

1. **Load** + `ensureCanReviewRequest`:
   - Caller must be reviewer (`isReviewer(role)`).
   - Caller must NOT be the requester (self-approval refused).
2. **Additional-approval guard** — if `existing.requires_additional_approval` and the body's `additional_approval_reason` is missing or < 5 chars → 422 `ADDITIONAL_APPROVAL_REASON_REQUIRED`.
3. **H2 — atomic state transition + balance moves** (`withTransaction`):
   - `findOneAndUpdate({_id, status: 'pending'}, {$set: {status: 'approved', approver_id, approver_remarks, additional_approval_reason?, acted_at}})` — atomic guard returns `null` if status changed mid-flight → 409 `CORRECTION_REQUEST_NOT_PENDING`.
   - For each segment: `LeaveBalance.updateOne({user_id, leave_type_id, year}, {$inc: {pending: -days, used: +days}}, {session})`.
   - **Either everything commits or nothing does**. Pre-H2 the status flip and balance updates were separate writes; a partition between them left the request approved but balance still in `pending`, silently inflating available balance by the leave amount.
4. Audit `LEAVE_APPROVE`.
5. Notify `notifyLeaveDecided('approved', ...)`.

---

## Reject flow

Mirror of approve but the balance refund is `pending → 0` (no `used` change since the leave never approved):

1. `ensureCanReviewRequest`.
2. **C2 — atomic state transition + refund** (`withTransaction`):
   - `findOneAndUpdate({_id, status: 'pending'}, {$set: {status: 'rejected', approver_id, approver_remarks, acted_at}})`.
   - `releaseReservations` (`$inc: {pending: -days, available: +days}` on each segment).
3. Audit `LEAVE_REJECT`. Notify.

---

## Cancel flow

[`cancelLeave`](../../src/services/leave-request.service.ts):

1. **Permission** — self can cancel own; reviewers can cancel anyone's. Else 403.
2. **State preconditions**:
   - Already cancelled → idempotent success.
   - Status `rejected` → 409 `CORRECTION_REQUEST_NOT_PENDING`.
   - Status `approved` AND `start_date <= today (IST)` → 422 `LEAVE_ALREADY_CONSUMED`. Too late.
3. **C2 — atomic state transition + refund**:
   - `findOneAndUpdate({_id, status: <expectedStatus>}, {$set: {status: 'cancelled', cancelled_at, cancelled_by, cancellation_reason}})`. `null` → 409 `CONCURRENT_UPDATE_CONFLICT`.
   - **Approved cancellation**: `$inc: {used: -days, available: +days}` (refund what was already debited).
   - **Pending cancellation**: `releaseReservations` (`$inc: {pending: -days, available: +days}`).
4. Audit `LEAVE_CANCEL` with `metadata: {self_cancel, previous_status}`. Notify.

---

## Calendar endpoint

[`calendarLeaves`](../../src/services/leave-request.service.ts) — returns approved leaves in the date range. Hydrates leave-type info + user display names so the FE doesn't N+1.

Stamps `display_end_date` — the **last working day** in `[start_date, end_date]` (skips non-working weekdays and holidays). The bar in the FE calendar uses this as the visual end date so a Thu→Sat request shows a 2-day bar (Thu–Fri) that matches the `total_days` count instead of visually spanning the weekend cells where nothing was consumed.

Cap: 1000 rows. Validator caps the date range at 366 days.

---

## Comp-off flow

[`adjustCompOff`](../../src/services/comp-off.service.ts):

1. **Permission** — `isReviewer(role)` (admin / manager). Service-layer defence-in-depth above the route's `comp_off.write` gate.
2. **Target user load** — `find({_id, select: 'role comp_off_balance'})`. M42 — fetch balance alongside role in one read for the audit `before` snapshot.
3. **BUG-037 — clients refused** — comp-off is staff-only. 422 `FORBIDDEN_ROLE_TARGET`.
4. **H5 + C3 — atomic transactional write**:
   - `withTransaction`:
     - **CAS atomic balance gate** — `findOneAndUpdate({_id, comp_off_balance: {$gte: days}} for consumed, {$inc: {comp_off_balance: signedDelta}}, {new: true, session})`. The `$gte` predicate is the **race-safe gate** on consume; loser sees `null` → 409 `INSUFFICIENT_LEAVE_BALANCE` with `{available, requested}`.
     - For grants (`type=earned`), CAS predicate is just `{_id}` — `null` means the user vanished mid-adjust → 404 `USER_NOT_FOUND`.
     - **Ledger insert** — `CompOffLedger.create({user_id, type, days, source_type: ADMIN_ADJUSTMENT, source_ref_id: null, remarks, created_by}, {session})`.
     - **BUG-036 — LeaveBalance(COMP_OFF, current_year) mirror** — `syncLeaveBalanceForCompOff`. The apply-leave engine reads availability from `LeaveBalance`, NOT the ledger. Without the mirror, a comp-off grant doesn't become spendable. The mirror writes `LeaveBalance.adjusted = balance` + `recomputeAvailable`. H3 — year is IST-aware via `dayjs().tz(DEFAULT_TIMEZONE).year()`; a UTC-derived `new Date().getFullYear()` would put a late-night IST grant in the wrong year's row.
5. **Audit** `COMP_OFF_ADJUST` with `before: {balance: pre-CAS}`, `after: {balance: post-CAS}`, `metadata: {user_id, type, delta, remarks}`. I1 — pre-I1 had no audit; only the ledger row's `created_by` carried actor context.
6. Returns `{ledger, balance: balanceAfter}`.

### Comp-off earn (from attendance)

The attendance EOD finalizer job inserts `earned` rows with `source_type: 'attendance_overtime'` and the `source_ref_id` pointing at the originating attendance record. Same CAS pattern. See [`attendance.md`](./attendance.md).

### Comp-off consume (from leave)

When a comp-off leave is approved (`LEAVE_REQUEST` source), the leave service inserts a `consumed` ledger row. Refund on cancel inserts an `earned` row.

---

## Cron jobs

### `leave_year_rollover` — Jan 1 00:05 IST

[`jobs/leave-year-rollover.job.ts`](../../src/jobs/leave-year-rollover.job.ts). For every active internal (non-client) user, ensure a `(user, leave_type, year=N+1)` row exists for every active leave type.

Mechanics fall out of the leave-balance shape:

| Type | Rollover behaviour |
|---|---|
| **CL / SL** | `carry_forward: false` — new row gets a fresh `allocated` from `computeAllocation()` (pro-rata for mid-year joiners). `used / pending / monthly_forfeited` zero. |
| **WFH / MATERNITY / PATERNITY / UNPAID** | Unlimited or event-based; `allocated = 0`. Untouched. |
| **COMP_OFF** | `is_earned: true` — `computeAllocation` returns 0 for the new row. Source of truth is the (timeless) ledger; the cached `users.comp_off_balance` retains its current value. |
| **Year-spanning reservations** | When a Dec → Jan request is approved in December, `findOrInitBalance` already creates the year=N+1 row and bumps `pending`. The rollover uses `$setOnInsert` so that pre-existing row (with the carried `pending`) is preserved verbatim. |

Idempotency: run-key is the target year. Same-year re-run = no-op. `initializeYearForAllUsers` is itself idempotent via the unique compound key. Retry up to 3 times on transient errors — the next scheduled run is a YEAR away.

### `comp_off_reconciliation` — Daily 02:30 IST (M42)

[`jobs/comp-off-reconciliation.job.ts`](../../src/jobs/comp-off-reconciliation.job.ts). Pre-M42, `adjustCompOff` re-aggregated the entire ledger on every grant/consume (twice — before AND after the CAS) for partial-failure recovery. That was O(ledger-size) per adjust.

Post-M42, the hot path trusts the CAS `$inc` (C3 already does this atomically). This cron is the safety net: once a day, walk users with ledger activity, recompute the sum, and **auto-repair drift**. Sources of drift defended against:

1. A direct `db.compoffLedger.insert(...)` outside the service (smoke seed, backfill script, manual ops repair) that didn't pair with `User.$inc`.
2. A future service bug that drops the `$inc` on one path.
3. A restored backup where User and CompOffLedger were taken at different points.

Repair policy: **auto-fix**. Emits `COMP_OFF_DRIFT_REPAIRED` at warn per affected user; the row gets its balance reset on the spot. "Alert but don't auto-fix" would strand users with bad balances until a human investigates — worse UX.

Run-key: `YYYY-MM-DD` (IST). Same-day re-runs collide on the `job_runs` unique index.

### SL monthly forfeiture cron (disabled-by-flag)

Lives in the codebase but **inert** because `leave_types.SL.monthly_forfeiture: false` after the business reverted the "use it or lose it" policy. The cron's `findOne` is gated on `monthly_forfeiture: true` so flipping the flag turns it back on automatically. The infrastructure stays in place for any future leave type that opts in.

---

## Audit actions produced

| Action | When |
|---|---|
| `LEAVE_TYPE_CREATE` / `_UPDATE` / `_DEACTIVATE` | Type CRUD |
| `LEAVE_BALANCE_ADJUST` | `PATCH /leave-balances/:id` — `before`/`after: {adjusted, used, available}`; metadata: `{reason, delta, user_id, leave_type_id, year}`, plus `total_days`/`used_days` when the operator stated totals. 🔴 On that path `delta` is the **derived** move in what's left, so it can be 0 while both counters changed (raising allowed and taken by the same amount) — the stated figures are what the operator actually typed. A 0 delta also suppresses the employee's notification: nothing they can spend moved. |
| `LEAVE_APPLY` | `POST /leaves` (H4) — `after: {status, dates, total_days, requires_additional_approval}`, `metadata: {user_id, leave_type_id, is_half_day, segments_count}` |
| `LEAVE_APPROVE` | `POST /leaves/:id/approve` — `metadata: {requester_id, requires_additional_approval, total_days}` |
| `LEAVE_REJECT` | `POST /leaves/:id/reject` — `metadata: {requester_id}` |
| `LEAVE_CANCEL` | `POST /leaves/:id/cancel` — `metadata: {requester_id, self_cancel, previous_status}` |
| `COMP_OFF_ADJUST` | `POST /comp-off/adjust` (I1) — `before/after: {balance}`, `metadata: {user_id, type, delta, remarks}` |

---

## Error codes produced

| Code | HTTP | When |
|---|---|---|
| `RESOURCE_NOT_FOUND` | 404 | Leave type / balance / request id miss |
| `VALIDATION_ERROR` | 400 | Body / query Zod failures (date shape, range > max, half-day mismatch, etc.) |
| `LEAVE_BACKDATED_NOT_ALLOWED` | 422 | `start_date < today` (IST) |
| `LEAVE_NOTICE_VIOLATION` | 422 | `start_date < today + advance_notice_days` — details include `earliest_start_date` |
| `LEAVE_INVALID_HALF_DAY` | 422 | `is_half_day=true` but `start != end` OR type doesn't support half-day |
| `LEAVE_NO_WORKING_DAYS` | 422 | Engine resolved to 0 working days (all weekends/holidays) |
| `LEAVE_OVERLAP` | 409 | Concurrent or pre-existing pending/approved leave covers the dates — details include `conflicting_id` |
| `INSUFFICIENT_LEAVE_BALANCE` | 409 | CAS reservation failed on apply (non-CL non-unlimited types); also comp-off consume CAS failure |
| `ADDITIONAL_APPROVAL_REASON_REQUIRED` | 422 | Approve on `requires_additional_approval=true` without ≥ 5-char reason |
| `CORRECTION_REQUEST_NOT_PENDING` | 409 | Atomic state-transition guard lost the race (approve/reject) |
| `CONCURRENT_UPDATE_CONFLICT` | 409 | Cancel's atomic guard lost the race |
| `LEAVE_ALREADY_CONSUMED` | 422 | Cancel on an approved leave whose start_date <= today |
| `DUPLICATE_RESOURCE` | 409 | `POST /leave-types` with duplicate code |
| `FORBIDDEN_ROLE_TARGET` | 422 | Comp-off adjust target is a client (BUG-037) |
| `USER_NOT_FOUND` | 404 | Comp-off adjust target missing |
| `FORBIDDEN` | 403 | Self-approve refused; non-reviewer trying to act |

---

## End-to-end flows

### Employee applies for 5-day CL (within balance)

1. POST `/leaves` with `{leave_type_id: CL_id, start_date: '2026-07-13', end_date: '2026-07-17', reason: 'Family trip'}`.
2. `requirePermission(leave_request.write)` passes (Employee bundle has it).
3. Apply context loads — working_days `[1,2,3,4,5]`, no holidays in range, active types.
4. Date gates: today is `2026-07-01`. `advance_notice_days = 14` for CL; earliest start is `2026-07-15`. **Fail with 422 `LEAVE_NOTICE_VIOLATION`** `{earliest_start_date: '2026-07-15', advance_notice_days: 14}`.

Same body with `start_date: '2026-07-20'`:
1. Notice OK (≥ 14 days).
2. Engine: 5 working days, all CL, year=2026.
3. `availableMap['CL|2026']` = 10. Engine doesn't flag `requires_additional_approval`.
4. Overlap check — none.
5. `reserveBalances`: CL is exempt from the `available: $gte` predicate (allowed to dip negative). `$inc: {pending: +5, available: -5}` on the CL balance row.
6. `LeaveRequest.create(...status: 'pending')`.
7. Post-insert overlap re-check passes (no concurrent insert).
8. Audit `LEAVE_APPLY`; notify reviewers.

### Employee applies for 3-day SL with month already used

1. POST `/leaves` with `{leave_type_id: SL_id, start_date: '2026-07-13', end_date: '2026-07-15', reason: 'Flu'}`.
2. Notice OK (SL has 0).
3. `buildSlMonthUsedMap` replays historical SL — finds Jul 2026 already has 1 SL day (used earlier in the month). `slMonthUsed['2026-7'] = 1`.
4. Engine: 3 working days, requested code SL. Month bucket `2026-7`: `remaining = max(0, 1 - 1) = 0`. **No SL days allocated.** All 3 days spill to CL.
5. Result: `segments = [{CL, 2026, 3}]`. `requires_additional_approval` flagged if `available[CL|2026] < 3`.
6. Reservation: 3 days of CL `pending`.
7. Audit `LEAVE_APPLY`.

### Manager approves a leave that requires additional approval

1. The leave was created with `requires_additional_approval: true` (the engine flagged `available - planned < 0` for CL).
2. Manager POST `/leaves/{id}/approve` with `{approver_remarks: 'Approved', additional_approval_reason: 'Personal emergency'}`.
3. `requirePermission(leave_request.approve)` passes.
4. Service: `ensureCanReviewRequest` — manager, not the requester. OK.
5. Guard: `additional_approval_reason.trim().length >= 5`. OK.
6. `withTransaction`:
   - Atomic state flip `pending → approved` with `findOneAndUpdate({status: 'pending'})`.
   - For each segment: `$inc: {pending: -days, used: +days}` on the balance row.
7. Audit `LEAVE_APPROVE`; notify `decision: 'approved'`.

### Concurrent overlap race (H2)

1. User A's client opens two tabs, both filling out the same leave dates and clicking Submit simultaneously.
2. Both reach `assertNoOverlap` — both see no overlap (separate DB snapshots).
3. Both reserve balances (might conflict on `available` CAS but assume both succeed because there's enough room).
4. Both `LeaveRequest.create({...})`. **Both succeed** (no unique index on dates).
5. Both reach the post-insert `assertNoOverlap` with `excludeId: createdId`.
6. Tab 1 sees Tab 2's row → throws `LEAVE_OVERLAP`. Tab 1's row is deleted and balances released.
7. Tab 2 (later by microseconds) sees Tab 1's row already deleted (or vice-versa — whichever wins the re-check loses the race).
8. **Either outcome is correct**: one row remains, the other was undone. Pre-H2 silent double-insert outcome was not.

### Year-spanning leave (Dec 29 → Jan 3)

1. Engine enumerates working days across two years: e.g. 2 days in 2026, 2 days in 2027. Emits `LEAVE_SPANS_YEARS` warning.
2. Per-year split: 2 segments — `[{CL, 2026, 2}, {CL, 2027, 2}]` (if CL is requested).
3. `reserveBalances` calls `findOrInitBalance` for each `(user, CL, year)`. The 2027 row is freshly created via `initializeBalancesForUserYear` if it didn't exist (the year-rollover cron hasn't run yet).
4. Each segment's balance is reserved separately.
5. On approve, each segment's `pending → used` happens inside the same transaction.

### Comp-off grant with apply-engine sync

1. Manager POSTs `/comp-off/adjust` with `{user_id, type: 'earned', days: 1, remarks: 'Worked on Saturday'}`.
2. CAS: `findOneAndUpdate({_id: userId}, {$inc: {comp_off_balance: +1}}, {new: true})`. Returns updated user. `balanceAfter = 1` (assume was 0).
3. Insert ledger row.
4. `syncLeaveBalanceForCompOff(userId, 1)`:
   - Find COMP_OFF type. Find `LeaveBalance(user, COMP_OFF, currentYear=2026)`.
   - If exists, set `adjusted = 1`, recompute `available = 0 + 0 + 1 - 0 - 0 - 0 = 1`. Save.
   - If missing, create with `adjusted: 1, available: 1`.
5. Audit `COMP_OFF_ADJUST`. Now the user can apply `COMP_OFF` leave for 1 day — the engine reads `available[COMP_OFF|2026] = 1` from `LeaveBalance`, not from the ledger.

### Concurrent comp-off consume

1. Admin A POSTs `/comp-off/adjust` `{user_id, type: 'consumed', days: 2}` for a user with balance 3.
2. Admin B simultaneously POSTs `{user_id, type: 'consumed', days: 2}`.
3. Both reach the CAS. Mongo serializes — one wins: `$gte: 2` matches (balance 3); `$inc: -2` lands; new balance 1. Other CAS now sees balance 1, `$gte: 2` predicate fails → returns `null`.
4. Winner: ledger row created, mirror synced, audit row. Returns 200.
5. Loser: 409 `INSUFFICIENT_LEAVE_BALANCE` `{available: 3 (the pre-CAS snapshot we took before the race), requested: 2}`.

---

## Gotchas

| # | Behaviour | Why |
|---|---|---|
| 1 | `leave_types` are **hard-delete forbidden**; deactivation flips `is_active` | Historical `leave_segments[].leave_type_id` would dangle |
| 2 | Leave-type seeding uses `$setOnInsert` only | Admin overrides survive restarts; only missing canonical codes get inserted |
| 3 | `leave_balances.available` is **denormalized** + `$gte`-guarded on apply | Race-safe reservation in a single CAS without a transaction |
| 4 | **CL can dip negative** with `additional_approval_reason` | Approve flow requires the reason ≥ 5 chars when `requires_additional_approval: true` |
| 5 | WFH (`is_unlimited`) skips the balance check entirely | No `available` predicate on the CAS |
| 6 | SL spills to CL when monthly cap is reached | Engine's per-month first-fit allocation; the user applied under SL but a day with no SL slot left becomes CL |
| 7 | C4 — SL month attribution **replays the engine algorithm** chronologically against historical requests | Pre-C4 attributed all SL days for a multi-month request to `start_date.month`, double-spending the cap on the second month |
| 8 | C4 also pulls holidays for the **full year span** of touched years, not just the apply's date range | Historical requests outside the apply context's range still need correct working-day exclusion |
| 9 | Apply-time SL "already used" map includes both **approved/pending segments AND `sl_monthly_forfeitures` rows** | Forfeitures are additive — a forfeited month and a used month both block the slot |
| 10 | `is_half_day` requires `start_date == end_date` AND `half_day_slot` set | Validator + engine both enforce |
| 11 | `half_day_slot` is informational only — `days = 0.5` regardless of slot | Slot drives the FE calendar render, not the debit math |
| 12 | `total_days` always snaps to 0.5 grid (`Math.round(total * 2) / 2`) | Floating-point safety on multi-segment sums |
| 13 | Year-spanning request emits `LEAVE_SPANS_YEARS` warning + one segment per year | Each year's row is reserved independently; rollover cron preserves carried `pending` |
| 14 | Year-rollover cron uses `$setOnInsert` on the unique compound key | Pre-existing year=N+1 rows (with carried pending from a December-applied January leave) are preserved verbatim |
| 15 | Apply-flow's `loadAvailableMap` self-heals balance rows for every touched year | A user predates the leave module's introduction; first read initializes |
| 16 | H1 — `initializeBalancesForUserYear` runs inside `withTransaction` from user-create | User create + balance init are atomic; pre-H1 balance failure left a quiet half-created user |
| 17 | H1 — IST-anchored `currentYear()` in leave-balance reads | Jan 1 IST midnight to UTC midnight (5h30m) would otherwise read the wrong year |
| 18 | H2 — overlap re-check **post-insert** with `excludeId` | Pre-H2 silent double-insert; wrapping in `withTransaction` doesn't close logical-overlap races |
| 19 | H2 — approve / reject / cancel run **inside `withTransaction`** | State flip + balance moves are atomic; pre-H2 partition left status changed but balance lagging |
| 20 | `releaseReservations` accepts an optional `session` and omits it from `updateOne` when absent | Pre-H2 tests strict-match call args via `toHaveBeenNthCalledWith` — passing `{session: undefined}` breaks them |
| 21 | Calendar endpoint stamps `display_end_date` (last working day) | FE bar render matches `total_days` — Thu→Sat shows Thu–Fri |
| 22 | Calendar caps at 1000 rows + 366 days | Defensive — calendar isn't a reporting surface |
| 23 | C5 — calendar gated on `leave_request.read_team`, not `authenticate` | Pre-C5 rank-and-file employees could enumerate every employee's leave plan |
| 24 | BUG-035 — cancellation reason is optional | Users canceling own pending requests shouldn't have to justify it |
| 25 | M42 — comp-off balance no longer re-aggregated on every adjust | CAS `$inc` is the source of truth; nightly cron reconciles drift |
| 26 | M42 — nightly cron auto-repairs detected drift (logs `COMP_OFF_DRIFT_REPAIRED` per user) | Conservative alert-only would strand users with bad balances |
| 27 | BUG-036 — comp-off adjust **syncs `LeaveBalance(user, COMP_OFF, currentYear).adjusted`** | Apply-leave engine reads availability from LeaveBalance, not the ledger; without the mirror, a grant doesn't become spendable |
| 28 | BUG-036 H3 fix — `syncLeaveBalanceForCompOff` uses IST-aware year | UTC-derived year would put late-night IST grants in the wrong year's row |
| 29 | BUG-037 — comp-off adjust refused on clients | Comp-off is staff-only; the picker filters but a direct API caller is rejected |
| 30 | C3 — CAS predicate `comp_off_balance: {$gte: days}` on consume | Race-safe; loser sees `null` → 409 with `{available, requested}` |
| 31 | C3 follow-through — distinct copy for "user vanished" vs "insufficient balance" | "Insufficient balance" on a grant path is misleading |
| 32 | I1 — `COMP_OFF_ADJUST` audit row was added post-pre-I1 | Pre-I1 the only durable record was the ledger row's `created_by` |
| 33 | Atomic state guards on approve/reject/cancel use **`status: <expected>` predicate** | Concurrent double-action sees `null` from the CAS → 409 instead of double-mutating balances |
| 34 | Self-approve is refused at the service layer | Reviewer can't approve own leave; admin must use another reviewer |
| 35 | Cancel on an already-started approved leave returns 422 `LEAVE_ALREADY_CONSUMED` | Too late — the days are spent |
| 36 | `notifyLeaveSubmitted` / `notifyLeaveDecided` are **best-effort** — failures log `NOTIFICATION_DISPATCH_FAILED` and never throw | The leave write is the durable record; notifications are best-effort |
| 37 | `slack_message: {channel, ts}` persisted on the request | Lifecycle uses `chat.update` (one Slack message walks pending → approved/rejected), not a fresh post per state change |
| 38 | `LEAVE_TYPE.advance_notice_days` is per-type, configurable via PATCH | CL=14 by default; SL=0 (sick is by definition unscheduled); admin can override |
| 39 | `leave_request.read_team` includes Team Lead (Step-47) | First-line approver model — Team Lead approves their reports' leaves |
| 40 | Calendar endpoint hydrates user display names + leave-type info | FE renders names + codes without N+1 |
| 41 | M40 — `listLeaves` index `{status, start_date: -1}` covers admin queue | Pre-M40 the in-memory sort was wasted work on every queue refresh |
| 42 | Year rollover retries up to 3 times on transient errors | Next scheduled run is a YEAR away; a Mongo blip would skip the rollover |
| 43 | SL monthly forfeiture cron is **inert** because `SL.monthly_forfeiture: false` | Business reverted "use it or lose it"; infrastructure stays in place for future opt-in |
