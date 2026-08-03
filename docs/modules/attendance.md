# Attendance — Backend

The **Attendance** module owns daily check-in / check-out (multi-segment per day per BUG-040), **breaks within a segment** (`break/start` + `break/end`, subtracted from worked time), the **today-only immediate self-edit pair** (`POST /me/breaks`, `POST /me/times`), the correction-request lifecycle (employee proposes a fix → manager approves/rejects, owner can cancel pending), admin direct correction (`PATCH /attendance/:id`), QR-code office check-in (resolves an `office_location` token), optional geofence + WiFi/IP gating, and the EOD finalizer cron (flips checked-in-but-not-out rows to `incomplete`, force-closes breaks left open inside them, and inserts placeholders for absent / holiday / weekend / on-leave days).

Cross-module dependencies:
- **Leave Management** owns `comp_off_ledger`. Attendance still computes and stores `overtime_minutes` on the record, but **nothing reads it** — comp-off accrual moved to billable timesheet minutes (`comp-off-accrual.service.ts`), and the `attendance_overtime` ledger `source_type` is legacy with no writer left. See [`leave-management.md`](./leave-management.md).
- **Slack** offers check-in/out without leaving Slack — App Home **Check In / Check Out** buttons and the `/checkin` / `/checkout` slash commands both flow through the same `checkIn` / `checkOut` services as the web app, with `method: 'manual'`. `getTodayAttendanceSummary` (this service) powers the Slack Home dashboard's today's-attendance section. See the Slack subsystem in [`settings-notifications.md`](./settings-notifications.md).
- **Holidays** + **Settings** (`work_schedule.working_days`, `work_schedule.daily_expected_hours`, `attendance.geofence`, `attendance.wifi_restriction`) drive finalizer + check-in gating. See [`holidays-locations.md`](./holidays-locations.md) (next module) and the Settings catalog in the Settings module.
- **Office Locations** owns `office_locations` + QR tokens (the resolver here calls `OfficeLocation.findOne({qr_code_token, is_active})`).

---

## Scope

| Surface | In scope | Notes |
|---|---|---|
| `POST /attendance/check-in` | ✓ | Multi-segment per BUG-040 |
| `POST /attendance/check-out` | ✓ | Closes the latest open segment |
| `POST /attendance/break/start` | ✓ | Opens a break on the latest **open** segment |
| `POST /attendance/break/end` | ✓ | Closes the newest open break, wherever it is |
| `POST /attendance/me/breaks` | ✓ | **Replaces** today's whole break list (cap 20) |
| `POST /attendance/me/times` | ✓ | Edits the **latest** segment's punches on **today**, immediately |
| `POST /attendance/qr-verify` | ✓ | Look up location before check-in |
| `GET /attendance/me/today` | ✓ | Single row for today (IST-anchored) |
| `GET /attendance/me` | ✓ | Paginated own history |
| `GET /attendance` | ✓ | Team list with user-display hydration |
| `PATCH /attendance/:id` | ✓ | Admin direct correction with C1 audit |
| `POST /attendance/correction-requests` | ✓ | Employee submits correction |
| `GET /attendance/correction-requests` | ✓ | Auto-filtered for employees |
| `POST /attendance/correction-requests/:id/approve` | ✓ | Multi-segment proposal path + legacy single-pair |
| `POST /attendance/correction-requests/:id/reject` | ✓ | |
| `POST /attendance/correction-requests/:id/cancel` | ✓ | M49 — owner-only withdraw |
| `attendance_finalizer` cron | ✓ | Daily 23:00 IST |
| `comp_off_ledger` writes from overtime | Cross-module | Owned by Leave Management |

---

## Roles & permissions

Route-level baseline in [`attendance.routes.ts`](../../src/routes/attendance.routes.ts): the **entire router** requires `ATTENDANCE_CHECK_IN_OUT` (via `router.use(requirePermission(...))`). Clients don't hold this and would only ever see 403s.

| Endpoint | Permission | Held by |
|---|---|---|
| `POST /attendance/check-in` / `check-out` / `qr-verify` | `attendance.check_in_out` | Admin, Manager, Team Lead, Employee |
| `POST /attendance/break/start` / `break/end` | `attendance.check_in_out` (router baseline) | same — always the caller's own record |
| `POST /attendance/me/breaks` / `me/times` | `attendance.check_in_out` (router baseline) | same — the service pins to `callerId(req)`; there is **no** `user_id` in the body, so these can only ever touch your own day |
| `GET /attendance/me/today` / `me` | `attendance.check_in_out` (router baseline) | same |
| `GET /attendance` | `attendance.read_team` | Admin, Manager, Team Lead |
| `PATCH /attendance/:id` | `attendance.correction_approve` | Admin, Manager, Team Lead |
| `POST /correction-requests` (submit) | router baseline **+ `attendance.correction_request`** | Admin, Manager, Team Lead, Employee |
| `GET /correction-requests` | router baseline **+ `attendance.correction_request`** (auto-filtered by service for non-reviewers) | same |
| `POST /correction-requests/:id/approve` / `reject` | `attendance.correction_approve` | Admin, Manager, Team Lead |
| `POST /correction-requests/:id/cancel` (M49) | router baseline `attendance.check_in_out` + service-layer owner gate | Owner of the request |

**Service-layer reinforcement** ([`ATTENDANCE_REVIEW_ROLES`](../../src/constants/attendance.ts) = `[ADMIN, MANAGER, TEAM_LEAD]`):
- `patchAttendance` and `assertCanReviewCorrections` still gate by **role string** (not permission). The route-level `requirePermission` is the primary gate; the service check is belt-and-braces against direct service callers in tests / cron.
- `listCorrections` auto-narrows `filter.user_id = caller_id` for `role === EMPLOYEE` — even if the employee passes `?user_id=<someone-else>`, the service overwrites it.

---

## Data model

### `attendance_records` ([`attendance-record.model.ts`](../../src/models/attendance-record.model.ts))

One document per `(user_id × local_date)`. `local_date` is IST-anchored ("YYYY-MM-DD" in `Asia/Kolkata`, the system default timezone — per-user TZ overrides are a v1.5 concern).

```ts
{
  _id, user_id, local_date,
  // BUG-040 — multi-segment source of truth
  segments: [{
    check_in:  { time, method: 'manual'|'qr', location_id, ip },
    check_out: { time, method, location_id, ip } | null,  // null while segment open
    breaks: [{                                            // breaks belong to a SEGMENT, not to the day
      break_type: 'lunch'|'tea'|'other',
      start: { time, source: 'app'|'slack' },
      end:   { time, source } | null,                     // null while the break is open
    }],
  }],
  // Denormalized aliases (legacy reads + reports keep working)
  check_in:  segments[0].check_in    | null,
  check_out: segments[last].check_out | null,
  total_worked_minutes: number | null,     // net of closed breaks
  overtime_minutes: number,                // ≥ 0, sum of CLOSED segments only
  total_break_minutes: number,             // ≥ 0, sum of CLOSED breaks only
  break_minutes_by_type: { lunch, tea, other },
  status: 'present'|'absent'|'on_leave'|'holiday'|'weekend'|'incomplete',
  flagged_for_correction: boolean,
  comp_off_accrued: boolean,               // DEAD — never read or written; see gotcha 8
  wfh: boolean,
  notes: string,
  last_corrected_by: ObjectId | null,
  last_corrected_at: Date | null,
  created_at, updated_at,
}
```

**Indexes**:
- `{user_id: 1, local_date: -1}` **unique** — the race-safe "one row per day" guarantee. The service catches Mongo E11000 and converts it into a friendly `ALREADY_CHECKED_IN` (409) when the latest segment is still open, or appends a new segment when the latest is closed.
- `{local_date: 1, status: 1}` — finalizer + admin status filter.
- `{flagged_for_correction: 1}` — admin queue (rows the finalizer marked incomplete).

### `attendance_correction_requests` ([`attendance-correction-request.model.ts`](../../src/models/attendance-correction-request.model.ts))

```ts
{
  _id, user_id, attendance_record_id,
  requested_changes: {
    segments?: [{ check_in: Date, check_out: Date | null,
                  breaks?: [{ break_type, start: Date, end: Date | null }] }],  // BUG-040 canonical
    check_in:  Date | null,                                     // legacy single-pair
    check_out: Date | null,                                     // legacy single-pair
    reason: string,
  },
  status: 'pending'|'approved'|'rejected'|'cancelled',          // M49 added 'cancelled'
  reviewer_id: ObjectId | null,
  reviewer_remarks: string,
  acted_at: Date | null,
  created_at, updated_at,
}
```

**Indexes**:
- `{user_id: 1, status: 1}` — "my pending corrections"
- `{status: 1, created_at: -1}` — admin queue, newest first
- `{attendance_record_id: 1, status: 1}` — "one pending per record" guard

**One pending per record** is enforced at the **service layer** via lookup-then-insert (`AttendanceCorrectionRequest.findOne({attendance_record_id, status: 'pending'})` → `CORRECTION_REQUEST_ALREADY_PENDING`). A partial-unique index was deliberately avoided — older Atlas free-tier Mongos didn't always honor them, and the lookup is cheap and explicit.

---

## Endpoints

All routes mount under `/api/v1/attendance`.

### Self-service

| Method | Path | Permission | Body / Query | Returns |
|---|---|---|---|---|
| `POST` | `/check-in` | router baseline | `{method: 'manual', lat?, lon?, wifi_ssid?}` OR `{method: 'qr', qr_token, lat?, lon?, wifi_ssid?}` | `201 created` — the new/updated record |
| `POST` | `/check-out` | router baseline | same shape as check-in | `200 ok` — the closed record |
| `POST` | `/break/start` | router baseline | `{break_type: 'lunch'\|'tea'\|'other'}` — **required, no default** | `200 ok` — the whole record |
| `POST` | `/break/end` | router baseline | **none** — the route carries no `validate()` at all, so any body is ignored | `200 ok` — the whole record |
| `POST` | `/me/breaks` | router baseline | `{breaks: [{break_type, start, end\|null}]}` — **max 20**, no minimum | `200 ok` — the whole record |
| `POST` | `/me/times` | router baseline | `{check_in?, check_out?\|null}` — at least one key required | `200 ok` — the whole record |
| `POST` | `/qr-verify` | router baseline | `{qr_token}` | `200 ok` — `{location: {id, name, address}}` |
| `GET` | `/me/today` | router baseline | — | `200 ok` — the today row OR `null` |
| `GET` | `/me` | router baseline | `?from_date&to_date&page&limit` (default limit 31, max 100) | `200 ok` — paginated rows |

### Team / admin

| Method | Path | Permission | Body / Query | Returns |
|---|---|---|---|---|
| `GET` | `/` | `attendance.read_team` | `?user_id&status&flagged_for_correction&from_date&to_date&page&limit` (default limit 20) | `200 ok` — paginated rows with `user.{id, full_name}` hydrated per row |
| `PATCH` | `/:id` | `attendance.correction_approve` | `{check_in?: {time, method?, location_id?}, check_out?: {time, …}, status?, notes?}` (at least one) | `200 ok` — the patched record |

### Corrections

| Method | Path | Permission | Body | Returns |
|---|---|---|---|---|
| `POST` | `/correction-requests` | router baseline | `{attendance_record_id, requested_changes: {segments? | check_in? | check_out?, reason}}` | `201 created` |
| `GET` | `/correction-requests` | router baseline (auto-filtered for employees) | `?user_id&status&page&limit` (strict — unknown keys rejected) | `200 ok` — paginated; each row has `user_full_name` hydrated |
| `POST` | `/correction-requests/:id/approve` | `attendance.correction_approve` | `{reviewer_remarks?}` (≤ 1000 chars) | `200 ok` — `{request, record}` |
| `POST` | `/correction-requests/:id/reject` | `attendance.correction_approve` | `{reviewer_remarks?}` | `200 ok` — the request |
| `POST` | `/correction-requests/:id/cancel` (M49) | `authenticate` only (owner-only at service) | `{}` | `200 ok` — the cancelled request |

### Date-range caps

Both `/me` and `/` validate `to_date - from_date ≤ ATTENDANCE_DATE_RANGE_MAX_DAYS` (92 days ≈ 3 months) via `dateRangeRefine` in the validator. Prevents pulling a year of records in a single shot.

---

## Check-in flow (BUG-040 multi-segment)

There are three valid entry points to a check-in:

1. **Brand-new day** — no row exists. `AttendanceRecord.create({segments: [{check_in: punch}], status: 'present', ...})`. The unique compound index catches concurrent creates and surfaces E11000 to the catch branch below.

2. **EOD placeholder row** — the finalizer (or some other cron) inserted a row with `segments: []` (absent / holiday / weekend / on_leave placeholder). On check-in, the catch branch sees `segments.length === 0` and seeds the first segment, flipping `status` from placeholder to `present`.

3. **Latest segment closed** — user already checked in and out today (e.g. left for lunch and is now back). The catch branch sees `lastSeg.check_out != null` and appends a new segment.

The only refusal is **"latest segment still open"** → `ALREADY_CHECKED_IN` (409). All other E11000s route to one of the three branches above.

```
POST /attendance/check-in
  ↓
enforceLocationPolicies(body, ip)   ← geofence + WiFi (both off by default)
  ↓
if method=qr: resolveLocation(qr_token) → location_id   ← INVALID_QR_TOKEN if no match
  ↓
try AttendanceRecord.create({...})
  ↓ E11000 (compound index collision — row already exists)
findOne → branch:
  • lastSeg open    → throw ALREADY_CHECKED_IN
  • segments empty  → seed segments[0]
  • lastSeg closed  → push new segment
syncAliasesFromSegments(record)
save
```

**Aliases** stay in lock-step with segments via `syncAliasesFromSegments`:
- `check_in = segments[0].check_in` (first arrival of the day)
- `check_out = segments[last].check_out` (null while latest segment is open)

Reports, exports, and the FE banner all read the aliases without knowing about segments.

### Geofence + WiFi gating (`enforceLocationPolicies`)

Both flags read from `system_settings.attendance.*` and **default to `false`** so attendance works out-of-the-box.

- **Geofence**: requires `body.latitude` + `body.longitude` to be valid numbers, then computes Haversine distance against the configured center. Beyond `radius_meters` → `LOCATION_NOT_ALLOWED` (403).
- **WiFi/IP**: client IP is prefix-matched against `allowed_ip_ranges` (e.g. `"10.0.0.0/24"` allows `"10.0.0.X"`). `body.wifi_ssid` must match `allowed_ssids` exactly. **Either** IP **or** SSID match is sufficient — both don't have to align. Full CIDR matching is tracked as a Phase-4 follow-up.

---

## Check-out flow

```
POST /attendance/check-out
  ↓
enforceLocationPolicies(body, ip)
  ↓
if method=qr: resolveLocation(qr_token)
  ↓
findOne({user_id, local_date})
  ↓
segs = record.segments
lastSeg = segs[last]
if !record || !lastSeg              → NOT_CHECKED_IN (409)
if lastSeg.check_out exists         → NOT_CHECKED_IN (409) — every segment closed
  ↓
openBreak on lastSeg?  → end = {time: now, source: 'app'}   ← auto-closed at the check-out instant
lastSeg.check_out = {time: now, method, location_id, ip}
computeWorkedAcrossSegments(segments)   ← sum CLOSED segments only, each NET of its CLOSED breaks
  total_worked_minutes = Σ max(0, segmentMinutes - segmentBreakMinutes)
  overtime_minutes = max(0, total - daily_expected_hours * 60)
  total_break_minutes + break_minutes_by_type = Σ closed breaks
syncAliasesFromSegments
markModified('segments')             ← Mongoose doesn't detect in-place subdoc edits
save
```

**`ALREADY_CHECKED_OUT` is no longer thrown** — when all segments are closed, the service returns `NOT_CHECKED_IN` because the user must check in again before they can check out. The legacy code is preserved in the error-codes catalog for older clients.

**`markModified('segments')`** is mandatory after mutating `lastSeg.check_out` in place — Mongoose doesn't always notice subdoc mutations, and skipping this leaves the save silently writing only the top-level aliases without the segment.

---

## Break flow (`break/start` + `break/end`)

A break lives **inside a segment**, not on the day. Both verbs operate on today's record only (`todayLocalDate()`); neither takes a date and neither takes a `user_id`.

```
POST /attendance/break/start {break_type}
  ↓
findOne({user_id, local_date: today})
lastSeg = segments[last]
if !record || !lastSeg || lastSeg.check_out   → NOT_CHECKED_IN (409)   ← must be INSIDE an open segment
if any break on lastSeg has end == null       → ALREADY_ON_BREAK (409) ← one open break at a time
  ↓
lastSeg.breaks.push({break_type, start: {time: now, source}, end: null})
markModified('segments') → persistTotals → save
```

```
POST /attendance/break/end
  ↓
findOne({user_id, local_date: today})
scan segments BACKWARDS, and each segment's breaks backwards,
  for the first entry with end == null                      ← ALL segments, not just the latest
if none → NOT_ON_BREAK (409)
  ↓
openBreak.end = {time: now, source}
markModified('segments') → persistTotals → save
```

**`source` is set by the caller, not the body.** The controllers pass `'app'`; [`slack-interactive.controller.ts`](../../src/controllers/slack-interactive.controller.ts) calls the same `startBreak` / `endBreak` services with `'slack'` off the App Home Block Kit buttons, and maps `ALREADY_ON_BREAK` / `NOT_ON_BREAK` to ephemeral Slack replies. There is no HTTP surface that can set `source`.

**The two verbs are not symmetric.** `startBreak` refuses unless the *latest* segment is open; `endBreak` closes the newest open break **anywhere in the day**, including one stranded on an already-closed segment. In practice check-out auto-closes the open break of the segment it closes, so a stranded open break only appears via `/me/breaks` (which can file an `end: null` break onto any segment) or a correction proposal.

**An open break contributes zero minutes** — `breakMinutes` returns `0` while `end` is null, and `breakTotalsAcrossSegments` skips it entirely. `startBreak` still calls `persistTotals`, so the totals are rewritten with unchanged values; the useful effect is that the record's saved totals are never stale relative to its segments.

### Worked minutes, breaks, and overtime

`computeWorkedAcrossSegments` is the single place all four write paths (check-out, breaks, `/me/*`, corrections, `PATCH /:id`) route through:

```
total_worked_minutes = Σ over segments of  max(0, gross_segment_minutes − closed_break_minutes_in_that_segment)
overtime_minutes     = max(0, total_worked_minutes − work_schedule.daily_expected_hours × 60)
```

- **Open segments contribute 0** (`segmentMinutes` returns 0 without a `check_out`), so an in-progress day reads as 0 worked minutes until check-out.
- **Only CLOSED breaks are subtracted.** A break left open is free time as far as the arithmetic is concerned.
- The per-segment `max(0, …)` floor means a segment whose breaks exceed its own length contributes 0 rather than a negative that would offset another segment.
- Because breaks come off worked minutes **before** the expected-hours subtraction, every closed break minute reduces `overtime_minutes` one-for-one (until overtime floors at 0).
- 🔴 **`settings.attendance.break_allowance_minutes` (default 60) is data-shape only.** It is modelled, defaulted, capped 0–480 and patchable through `PATCH /settings`, but **no service reads it**. Breaks are subtracted in full; there is no free allowance and no over-allowance flag. Same class of trap as `report_subscription.hour_local` — the field exists so the FE can ship the control, not because the BE honours it.

---

## Today-page immediate self-service (`POST /me/breaks`, `POST /me/times`)

> 🔴 **These two endpoints write the attendance record directly, with no approval and no audit row — and that is deliberate. They are today-only. The approval-gated correction-request flow is still the ONLY way to touch a past day.**
>
> Both services start from `local_date = todayLocalDate()` and `findOne({user_id, local_date})`. There is no date parameter anywhere in the route, validator, controller or service, so there is no input that can aim them at yesterday. If you are adding an edit path, this is the line you must not cross: **the moment an edit can name a date, it belongs behind `POST /correction-requests`**, not here.
>
> Why both paths exist: a same-day self-correction has nothing to police. The day is not closed (the EOD finalizer hasn't run), the numbers haven't been read by anyone, and the two things you can change are bounded — `/me/breaks` can only *remove* worked minutes, and `/me/times` can only move punches within a day that is still yours. A past day is the opposite: it has been finalized, may already be flagged `incomplete`, and is what a manager, a report or a payroll run reads. That edit needs a reviewer, and gets one.

### `POST /me/breaks` — replace, never append

The body is the **complete** break list for today. The service **wipes every segment's breaks first** (`for (const s of segs) s.breaks = []`) and then re-files each supplied entry:

```
findOne({user_id, local_date: today})
if !record || segments.length === 0 → NOT_CHECKED_IN (409) "Check in before adding a break"
  ↓
for each segment: breaks = []                      ← wholesale replace
for each supplied break:
  if end && start >= end                           → 400 (bare badRequest, no ERROR_CODES entry)
  idx = first segment whose [check_in, check_out ?? now] window contains `start`
  if no segment matches → idx = last segment       ← silent fallback, NOT a refusal
  segments[idx].breaks.push({break_type, start:{time,source:'app'}, end: end ? {...} : null})
  ↓
markModified('segments') → persistTotals → save
```

- **Cap is 20** (`.max(20)` on the array in [`attendance.validator.ts`](../../src/validators/attendance.validator.ts)). There is no `.min()`, so `{"breaks": []}` is a valid request that **deletes every break on today's record** — the wipe runs and nothing is re-added.
- **`source` is hard-coded `'app'`** for every entry, so a break originally opened from Slack loses that provenance the first time the user saves the Today page.
- The **only** temporal guard is `start < end` per break. Breaks may overlap each other, may sit in the future, and may fall entirely outside any work segment — the window match is a *routing* rule, not a validation, and the fallback quietly parks an unmatched break on the last segment where it will be subtracted from that segment's minutes.
- The wipe mutates the in-memory document before the per-break validation runs, so a body whose 5th break is inverted throws after 4 have been staged. Nothing is persisted (`save` is never reached), so the stored record is untouched — but don't refactor this into a partial-save.

### `POST /me/times` — the LATEST segment, on today

```
findOne({user_id, local_date: today})
if !record || segments.length === 0 → NOT_CHECKED_IN (409) "Check in before editing your times"
last = segments[last]                              ← BOTH punches land here
  ↓
reject any supplied time > now + 2 min             → 400 (clock-skew grace, not a policy window)
if check_in  supplied → last.check_in.time = t     ← metadata (method/location_id/ip) preserved
if check_out supplied:
   null      → last.check_out = null               ← REOPENS the session
   existing  → last.check_out.time = t
   absent    → last.check_out = {time: t, method: 'manual', location_id: null, ip: ''}
  ↓
re-assert check_in < check_out on EVERY segment    → 400 if violated
last.check_out ? (incomplete → present) : status = 'incomplete'
syncAliasesFromSegments → markModified → persistTotals → save
```

- **It edits the latest segment, not the first.** After a re-check-in, a `check_in` edit moves the *current* session's arrival, and the day's `check_in` alias (`segments[0].check_in`) is untouched. The function's own header comment says "Sets the first segment's check-in" — that comment is **wrong**; the inline comment at the edit site and the code both say latest.
- **`check_out: null` is a supported verb**, not a no-op: it clears the punch and forces `status = 'incomplete'`, which is how the Today page offers "resume work" after an accidental check-out.
- **`local_date` never moves.** Unlike an approved correction (which re-derives `local_date` from the first segment's check-in), moving a check-in across the IST midnight boundary here leaves the row filed under today. The row and its `check_in` timestamp disagree about which day they belong to, and nothing detects it.
- **`flagged_for_correction` is not cleared** and `last_corrected_by` / `last_corrected_at` are not stamped. A day the finalizer flagged, fixed by the employee through `/me/times`, flips `incomplete → present` but stays in the admin's flagged queue.

---

## Correction request flows

### Submit (`POST /correction-requests`)

1. `AttendanceRecord.findById(attendance_record_id)` — must exist AND belong to caller (cross-user → `ATTENDANCE_RECORD_NOT_FOUND`, hiding existence).
2. Look up `findOne({attendance_record_id, status: 'pending'})` — if any → `CORRECTION_REQUEST_ALREADY_PENDING` (409).
3. Persist the request. If the body carries `segments[]`, that path is preserved verbatim; otherwise the legacy single-pair fields are persisted.
4. `notifyAttendanceCorrectionSubmitted({request_id, requester_id, local_date})` — fans out to in-app + Slack + push (via `notification-dispatcher.service`).
5. `recordAudit(CORRECTION_SUBMIT, target=correction_request, after={status, requested_changes})`.

**Validator constraints**:
- `requested_changes.reason` — 5–1000 chars trimmed.
- If `segments[]` is supplied, **`.min(1)`** (H1 — empty arrays were treated as delete-all before).
- Inside `segments`: every entry needs `check_in`; only the **last** segment may have a null `check_out`; segments must be chronologically ordered and non-overlapping; per-segment `check_in < check_out`.
- A segment may also carry `breaks: [{break_type?, start, end?}]` — this is how a **past** day's breaks get corrected, since `/me/breaks` can't reach it. `break_type` defaults to `'other'` here (it is required with no default on `break/start`), and unlike `check_out` there is **no** ordering, overlap or last-only constraint on breaks.
- If `segments` is absent, at least one of `check_in` / `check_out` must be supplied.

### Approve (`POST /correction-requests/:id/approve`)

```
loadPendingCorrection(id)               ← 404 NOT_FOUND or 409 NOT_PENDING
  ↓
if reqDoc.user_id == reviewer_id → 403   ← separation of duties: never approve your own
  ↓
record = findById(reqDoc.attendance_record_id)
recordBeforeSnapshot = clone(record)    ← C1 audit before-snapshot
  ↓
if changes.segments?.length > 0:        ← BUG-040 multi-segment path
  for each proposed segment, preserve old punch metadata (method, location_id, ip)
  proposed breaks REPLACE that segment's breaks; omitted `breaks` KEEPS the old ones
  record.segments = proposed
  record.local_date = utcDateToLocalDate(segments[0].check_in.time)
                                        ← row may move to a different business day
else (legacy single-pair path):
  if changes.check_in:  patch segments[0].check_in;  local_date := derived from new check_in
  if changes.check_out: patch segments[last].check_out
  ↓
syncAliasesFromSegments
break totals recomputed UNCONDITIONALLY   ← closed breaks are valid even on a still-open day
if both check_in + check_out:
  recompute total_worked_minutes + overtime_minutes
  if status was 'incomplete' → flip to 'present'
  flagged_for_correction = false
last_corrected_by = reviewer_id
record.save()
  ↓
reqDoc.{status:'approved', reviewer_id, reviewer_remarks, acted_at}.save()
notifyAttendanceCorrectionDecided({decision:'approved'})
recordAudit(CORRECTION_APPROVE, before={request_status:'pending', record:<snapshot>}, after=...)
```

Returns `{request, record}` so the FE has both shapes in one round-trip.

**`local_date` can shift** when the corrected check-in falls on a different IST date than the original — the row physically moves to the new date in the `(user_id, local_date)` unique index. If the new date already has a row, the save throws E11000 and the controller surfaces a generic 500 (rare; this is a known edge case in the C5 review backlog).

### Reject (`POST /correction-requests/:id/reject`)

Sets `status='rejected', reviewer_id, reviewer_remarks, acted_at`. Notifies + audits. **Does not touch the attendance record.**

### Cancel (M49) (`POST /correction-requests/:id/cancel`)

Owner-only verb. Pre-M49 there was no way for an employee to withdraw a wrong proposal — re-submit tripped `CORRECTION_REQUEST_ALREADY_PENDING` and the only paths to clear were approve / reject (neither appropriate).

```
loadPendingCorrection(id)                       ← 404 / 409 as usual
if !reqDoc.user_id.equals(caller.id):
  throw ATTENDANCE_RECORD_NOT_FOUND             ← existence-hiding (NOT 403)
reqDoc.status = 'cancelled'; acted_at = now
recordAudit(CORRECTION_CANCEL)
```

No notification — the owner is the only party who cared about the request.

---

## Direct correction (`PATCH /attendance/:id`)

Reviewer (Admin/Manager/TL) can patch a record without going through the correction-request flow.

- **C1 audit before-snapshot** — `record.toObject()` snapshots `segments`, `status`, `notes`, `flagged_for_correction` BEFORE any mutation so the audit row's `before` block reflects pre-edit state.
- **Top-level `check_in` / `check_out` patches route into segments** — preserves the canonical multi-segment shape:
  - `check_in.time` → updates `segments[0].check_in` (seeds a single segment if `segments` is empty, e.g. correcting an EOD placeholder).
  - `check_out.time` → updates `segments[last].check_out`.
  - Method / location_id / ip metadata preserved from the existing punch when the patch doesn't override.
- **Breaks are not patchable here** — `patchAttendanceBodySchema` has no `breaks` key, so a reviewer fixing a past day's breaks must approve a correction request carrying `segments[].breaks` (the seeded-segment branch creates `breaks: []`, and the existing array is otherwise left alone).
- **Aliases re-synced**; minutes (worked + overtime + break totals) recomputed if both punches now exist. `flagged_for_correction = false` sits **inside** that same `if (check_in && check_out)` block, so patching only `status` or `notes` on a flagged `incomplete` row leaves the flag set. There is **no** `incomplete → present` flip here — unlike the approve path, `status` only changes if the patch body says so, so filling in a missing check-out without also sending `status` leaves the row reading `incomplete` with a complete pair of punches.
- `last_corrected_by` / `last_corrected_at` stamped.
- `recordAudit(ATTENDANCE_PATCH, before=<snapshot>, after=<post-edit state>)`.

---

## QR check-in (`POST /attendance/qr-verify` + `POST /check-in` with `method=qr`)

Two-step flow used by the mobile/SPA deep-link page:

1. **`POST /attendance/qr-verify {qr_token}`** — `resolveLocation` finds an active `office_location` by token; returns `{location: {id, name, address}}` for the FE to display. Token mismatch → `INVALID_QR_TOKEN` (400). Lets the user confirm "yes, I'm at Bangalore office" before committing the punch.
2. **`POST /attendance/check-in {method: 'qr', qr_token}`** — same resolver runs again; `location_id` is bound onto `punch.location_id`. Subsequent geofence/WiFi gates still apply.

Office QR tokens live on `office_locations.qr_code_token` and are regenerable via `POST /office-locations/:id/regenerate-qr` (see office locations module).

---

## EOD finalizer cron ([`attendance-finalizer.job.ts`](../../src/jobs/attendance-finalizer.job.ts))

**Schedule**: daily 23:00 IST (Asia/Kolkata). `runKey = attendanceFinalizerRunKey(now)` = **yesterday** in IST — `dayjs(now).tz(JOB_TIMEZONE).subtract(1, 'day')` (`constants/jobs.ts:223-225`). The same value is passed straight in as `targetDate`, so the 23:00 run closes the **previous** day, not the one just ending. The `job_runs {job_name, run_key}` unique index absorbs duplicate fires.

For every active internal user — `{status: ACTIVE, role: {$nin: CLIENT_SIDE_ROLES}}`, i.e. excluding **both** `client` and `representative`. (This used to exclude only `client`, so every active representative collected a nightly `absent` placeholder; fixed in the job, see its comment at `attendance-finalizer.job.ts:162-170`.)

**Step A — flip incompletes**:
```ts
AttendanceRecord.updateMany(
  { local_date: targetDate, check_in: { $ne: null }, check_out: null, status: { $ne: 'incomplete' } },
  { $set: { status: 'incomplete', flagged_for_correction: true } }
)
```

**Step A.1 — force-close open breaks** (undocumented until 2026-07-31, and it changes the outcome of the "break left open" narrative below): a second `updateMany` with
`arrayFilters: [{ 's.check_out': null, 's.breaks': {$elemMatch: {end: null}} }, { 'b.end': null }]`
closes every open break **inside a still-open segment**, synthesising `end = {time: 23:59:59 IST on targetDate, source: 'app'}`. It runs between A and B (`attendance-finalizer.job.ts:135-155`) and writes to `segments[].breaks[].end`.

**Step B — insert placeholders** for users with no row. Streams the user list via `User.find().cursor()` in batches of `JOB_USER_BATCH_SIZE` to keep memory flat as headcount climbs. For each user:

```ts
AttendanceRecord.updateOne(
  { user_id, local_date: targetDate },
  { $setOnInsert: {
      user_id, local_date,
      status: placeholderStatus,      // 'on_leave' | 'holiday' | 'weekend' | 'absent'
      check_in: null, check_out: null,
      total_worked_minutes: null, overtime_minutes: 0,
      flagged_for_correction: false, wfh: false, notes: '',
  } },
  { upsert: true }
)
```

**Placeholder status priority**:
1. User is on **approved leave** that covers `targetDate` → `on_leave`
2. Holiday on `targetDate` → `holiday`
3. Day-of-week NOT in `work_schedule.working_days` → `weekend`
4. Else → `absent`

`$setOnInsert` + the unique index together mean a concurrent check-in mid-finalizer keeps its `present` row — the cron's upsert finds the existing row and does nothing.

**Per-user errors are caught and counted** into `summary.user_errors`; a single bad row doesn't abort the run.

**`migrateAttendanceSegments` was removed (M16)** — the one-time backfill from legacy single-`check_in` rows to `segments[]` was running on every boot even after the DB was long-migrated.

---

## Audit actions

| Action | When | Target | Before / After |
|---|---|---|---|
| `attendance.patch` | `PATCH /:id` | `attendance_record` | `{segments, status, notes, flagged_for_correction}` snapshots |
| `correction.submit` | Submit | `correction_request` | `after: {status, requested_changes}` |
| `correction.approve` | Approve | `correction_request` | `before: {request_status:'pending', record: <snapshot>}`, `after: {request_status, reviewer_remarks, record: <post>}` |
| `correction.reject` | Reject | `correction_request` | `before: {status:'pending'}`, `after: {status, reviewer_remarks}` |
| `correction.cancel` (M49) | Owner cancels | `correction_request` | `before: {status:'pending'}`, `after: {status:'cancelled'}` |

No audit row for check-in / check-out — they're an event stream of their own (the records themselves), not a config-style mutation. **`break/start`, `break/end`, `/me/breaks` and `/me/times` don't audit either**, on the same reasoning: they are the caller editing their own open day, and the record *is* the trail. The consequence is real — a day's punches can be moved (within today) with no `before` snapshot anywhere, so the only reconstruction is whatever the FE last read. Anything that can touch a *past* day (`attendance.patch`, the four `correction.*` actions) audits with a full before/after. `attendance_finalizer` writes its own job-runs row via the runner; per-user upserts don't audit individually.

---

## Error codes

| Code | HTTP | When |
|---|---|---|
| `ALREADY_CHECKED_IN` | 409 | Check-in when the latest segment is still open |
| `NOT_CHECKED_IN` | 409 | Check-out when no row OR every segment is closed. `break/start` when the latest segment isn't open. `/me/breaks` + `/me/times` when today's row is missing or has no segments (different message, same code) |
| `ALREADY_ON_BREAK` | 409 | `break/start` while a break on the latest segment is still open |
| `NOT_ON_BREAK` | 409 | `break/end` with no open break anywhere in today's segments |
| `VALIDATION_ERROR` | 400 | `/me/breaks`: a break with `start >= end`. `/me/times`: a punch more than 2 min in the future, or an edit that leaves any segment with `check_in >= check_out`. All four are bare `AppError.badRequest(...)`, which **defaults to `VALIDATION_ERROR`** — so they arrive under the Zod code but with **no `details.errors[]`** to point at a field. The FE can only match on the message string |
| `INVALID_QR_TOKEN` | 400 | QR token doesn't match an active `office_location` |
| `LOCATION_NOT_ALLOWED` | 403 | Geofence: missing/invalid lat/lon, or outside radius. WiFi: IP not in `allowed_ip_ranges` AND SSID not in `allowed_ssids` |
| `ATTENDANCE_RECORD_NOT_FOUND` | 404 | Direct correction: id missing. Cross-user correction submit: existence-hiding |
| `CORRECTION_REQUEST_NOT_FOUND` | 404 | Approve/reject/cancel: id missing. Cross-user cancel: existence-hiding |
| `CORRECTION_REQUEST_ALREADY_PENDING` | 409 | Submit when a pending request already exists for the record |
| `CORRECTION_REQUEST_NOT_PENDING` | 409 | Approve/reject/cancel of a non-pending request (race or stale UI) |

---

## End-to-end flows

### Employee checks in on a normal day

1. Phone → `POST /attendance/check-in {method: 'manual'}`. No geofence/WiFi configured.
2. `enforceLocationPolicies` no-ops. `local_date = today IST`.
3. `AttendanceRecord.create({segments: [{check_in: punch}], status: 'present'})`. Unique index passes.
4. Response `201 created` with the new record. FE displays the day's banner.

### Employee re-checks in after lunch (multi-segment)

1. Same call. `create` fails with E11000.
2. `findOne({user_id, local_date})` returns the existing row.
3. `lastSeg.check_out != null` (the morning's segment was closed before lunch) → append a new segment `{check_in: punch, check_out: null}`.
4. `syncAliasesFromSegments` updates `check_in` to remain the morning's first arrival (unchanged) and `check_out = null` (the new segment is open).
5. Save → **`201 created`**. The append branch returns through the same controller as a first check-in, and `postCheckIn` unconditionally calls `created(res, data)` — so a second segment on an existing row still answers 201, matching the endpoint table above.

### Employee takes a lunch break without checking out

1. `POST /attendance/break/start {break_type: 'lunch'}` at 13:00. Latest segment is open → a break is pushed with `end: null`. Totals unchanged (open breaks count 0).
2. A second tap sends the same call → `ALREADY_ON_BREAK` (409).
3. `POST /attendance/break/end` at 13:45 → `end = {time: now, source: 'app'}`; `total_break_minutes = 45`, `break_minutes_by_type.lunch = 45`.
4. Check-out at 18:00: gross segment 09:00→18:00 = 540 min, minus 45 = **495 worked**, overtime `max(0, 495 − 480) = 15`.
5. Had step 3 been skipped, check-out would have auto-closed the break at 18:00 — 300 break minutes, 240 worked, zero overtime. Forgetting to end a break is expensive, and nothing warns.

### Employee fixes today's times from the Today page

1. U checked in at 09:00 but actually arrived 08:30. `POST /attendance/me/times {check_in: '2026-08-12T03:00:00Z'}`.
2. Not in the future, latest segment's `check_in.time` is moved, `check_in < check_out` still holds on every segment.
3. Totals recomputed, record saved — **immediately, no approver, no audit row**.
4. Next day U notices the same problem on *yesterday's* row. `/me/times` can't reach it (it only ever loads `local_date = today`), so U goes through `POST /correction-requests` and waits for a manager.

### Employee tries to check in twice without checking out

1. `create` fails with E11000.
2. `findOne` returns the row; `lastSeg.check_out === null` → throws `ALREADY_CHECKED_IN` (409).

### QR check-in at office

1. Phone scans QR → opens deep-link `/check-in?token=<qr_token>`.
2. FE calls `POST /attendance/qr-verify {qr_token}` → `{location: {name: 'Bangalore HQ'}}`. UI shows confirmation.
3. User taps "Check in" → `POST /attendance/check-in {method: 'qr', qr_token}`.
4. `resolveLocation` runs again on the BE; `location_id` is bound onto the punch. Standard check-in flow.

### EOD finalizer marks user absent

1. 23:00 IST cron runs for `target_date = yesterday (IST)`.
2. User U was active, no check-in today, no approved leave.
3. `holiday=false`, `working_day=true` (Wednesday) → `placeholderStatus = 'absent'`.
4. `$setOnInsert` writes a row `{user_id: U, local_date, status: 'absent', segments: []}`.
5. Next morning U opens the app and sees yesterday's "Absent" row in `/attendance/me`.

### Incomplete day flip

1. User U checks in at 09:00, never checks out (phone died).
2. **The next night's** 23:00 IST cron runs — the one on the same evening targets the day before, so the row is untouched for a further 24h. Step A: `updateMany` finds the row (check_in set, check_out null) → flips `status: 'incomplete', flagged_for_correction: true`.
3. U opens `/attendance/me` next day, sees the orange "Missing check-out" pill, taps "Request correction", proposes `{check_out: '17:30'}`.

### Correction request → approve → record updates

1. U submits: `POST /correction-requests {attendance_record_id, requested_changes: {check_out: '2026-08-12T17:30:00Z', reason: 'Phone died, left at 5:30pm'}}`.
2. Service validates own-record, no pending duplicate, persists, notifies manager M.
3. M opens `/admin/attendance/corrections`, sees the row, clicks Approve.
4. `POST /correction-requests/:id/approve {reviewer_remarks: 'Confirmed via Slack'}`.
5. Service: pre-edit snapshot → patches `segments[last].check_out` → recomputes minutes → flips `incomplete → present` → `flagged_for_correction = false` → saves both docs → audits with full before/after.
6. Notification fans out to U: "Your correction request was approved by M."

### Owner cancels a pending correction (M49)

1. U realises the time on their pending request is wrong. Pre-M49 they were stuck — re-submit would trip `ALREADY_PENDING`.
2. M49 verb: `POST /correction-requests/:id/cancel`. Service confirms `reqDoc.user_id === caller.id`, sets `status: 'cancelled'`, audits.
3. U can now submit a new request for the same record.

### Manager direct-corrects a row

1. M opens the admin attendance grid, sees U's day with the wrong check-in time (already approved by hand last week).
2. `PATCH /attendance/:id {check_in: {time: '2026-08-12T09:00:00Z'}}`.
3. Service: C1 before-snapshot → patches `segments[0].check_in` → recomputes minutes if both punches present → stamps `last_corrected_by = M, last_corrected_at = now` → audits `ATTENDANCE_PATCH`.
4. No correction-request row is created — direct correction is a separate audit trail.

---

## Gotchas

| # | Behavior | Why |
|---|---|---|
| 1 | `local_date` is IST-anchored ("YYYY-MM-DD" in `Asia/Kolkata`) — NOT UTC midnight | Working-day alignment for every user in v1; per-user TZ overrides are v1.5 |
| 2 | The `{user_id, local_date}` unique compound index is the race source-of-truth | Service catches E11000 and converts to friendly outcomes |
| 3 | BUG-040 — `segments[]` is canonical; `check_in`/`check_out` are aliases kept in sync via `syncAliasesFromSegments` | Reports / exports / FE banner read aliases without knowing about segments |
| 4 | A break belongs to a **segment**, not to the day; at most one may be open, and only on the latest segment | `startBreak` refuses with `ALREADY_ON_BREAK` while any break on that segment lacks an `end` |
| 5 | Overtime sums **closed** segments only (open segment doesn't contribute) | FE shows live elapsed time separately; overtime is a settled value |
| 6 | Only **closed** breaks are subtracted — an open break is worth 0 minutes | Check-out auto-closes the open break on the segment it closes; a break left open on an *earlier* segment is never counted and never will be until someone ends it |
| 7 | 🔴 `settings.attendance.break_allowance_minutes` (default 60) is **modelled, validated and patchable — and read by nothing** | Breaks are subtracted in full; there is no free allowance and no over-allowance flag. Same trap as `report_subscription.hour_local` |
| 8 | 🔴 `attendance_records.overtime_minutes` has **no reader left** — not in the BE, not in the FE — and `comp_off_accrued` is neither read nor written by anything | Comp-off moved to billable timesheet minutes with its own `comp_off_accrual_days` marker collection; the `attendance_overtime` ledger source is legacy with no writer, and `comp-off-accrual.job.ts`'s header comment still claims the flag is the idempotency key. Breaks reduce `overtime_minutes`, but nothing downstream reacts |
| 9 | `markModified('segments')` after in-place subdoc mutation is mandatory | Mongoose doesn't detect mutation of nested subdoc paths; without this the save loses the change. Every break/`/me/*` path calls it too |
| 10 | 🔴 `POST /me/breaks` **replaces** today's whole break list — it does not append | It clears every segment's `breaks` first. `{"breaks": []}` is a valid request that deletes them all. Cap is 20 (`.max(20)`), with no minimum |
| 11 | A `/me/breaks` entry whose `start` matches no segment window silently lands on the **last** segment | The window match is routing, not validation — and `source` is hard-coded `'app'`, so a Slack-opened break loses its provenance on the first Today-page save |
| 12 | `POST /me/times` edits the **LATEST** segment's check-in *and* check-out | The service's own header comment says "first segment's check-in" — the comment is wrong, the code and its inline comment say latest. After a re-check-in you are moving the current session, not the day's first arrival |
| 13 | 🔴 `/me/breaks` + `/me/times` are **today-only and apply immediately**, deliberately bypassing the approval-gated correction flow | Both hard-code `local_date = todayLocalDate()`; no route, validator, controller or service accepts a date. A **past** day can only be changed via `POST /correction-requests` (approver) or `PATCH /attendance/:id` (reviewer). Any new edit path that can name a date belongs behind those, not here |
| 14 | `/me/times` never re-derives `local_date` | Moving a check-in across IST midnight leaves the row filed under today, with a timestamp that disagrees. Contrast gotcha 20, where an approved correction *does* move the row |
| 15 | `/me/times` doesn't clear `flagged_for_correction` and doesn't stamp `last_corrected_by`/`_at` | A finalizer-flagged day the employee fixes themselves flips `incomplete → present` but stays in the admin's flagged queue |
| 16 | `break/end` scans **all** segments backwards, not just the latest | It will close a break stranded on an already-closed segment — asymmetric with `break/start`, which requires an open segment |
| 17 | `break/start` requires `break_type` with **no default**; the correction-request break schema defaults it to `'other'` | Two schemas for the same enum with different strictness — a client that omits it gets a 400 on one path and `'other'` on the other |
| 18 | `POST /break/end` carries **no `validate()`** on the route at all | No body schema exists; anything posted is ignored rather than rejected |
| 19 | None of the four break/`me` endpoints write an audit row | Same reasoning as check-in/out — but it means today's punches can be moved with no `before` snapshot anywhere. Past-day paths (`attendance.patch`, `correction.*`) all audit |
| 20 | After approving a correction with a different IST date, `record.local_date` shifts via `utcDateToLocalDate(segments[0].check_in.time)` | Row physically moves to the new date; rare E11000 if the new date already has a row |
| 21 | "All segments closed" → `NOT_CHECKED_IN` (NOT `ALREADY_CHECKED_OUT`) | Legacy code preserved for older clients but never thrown by current service |
| 22 | Geofence + WiFi default OFF in `system_settings.attendance.*` | Attendance works out-of-the-box on dev/local; admin opts in |
| 23 | WiFi/IP matcher is **prefix-based** (not full CIDR) | Phase-4 tightening tracked in `Build_Decisions §Geofence` |
| 24 | Cross-user correction submit returns `ATTENDANCE_RECORD_NOT_FOUND` (not 403) | Existence-hiding — prevents probing other people's records by id |
| 25 | Cross-user cancel returns `CORRECTION_REQUEST_NOT_FOUND` (not 403) | Same — existence-hiding |
| 26 | `listCorrections` for `role === EMPLOYEE` overrides `?user_id` to caller-id | Service-layer scoping; the route doesn't gate by `read_team` |
| 27 | "One pending per record" enforced at service layer (lookup-then-insert), NOT a partial-unique index | Older Atlas free-tier Mongos didn't always honor partial uniques |
| 28 | Date-range queries capped at 92 days (`ATTENDANCE_DATE_RANGE_MAX_DAYS`) | Prevents page-aggregation cost of a year-of-records read |
| 29 | Strict query validation on `GET /correction-requests` (`.strict()` rejects unknown keys) | Anti-typo guard — `?status=APPROVED` (wrong case) returns a 400 instead of "no rows" |
| 30 | M49 cancel adds **no route-level permission of its own** — but `router.use(authenticate, requirePermission(ATTENDANCE_CHECK_IN_OUT))` at `attendance.routes.ts:31` covers every route on the router, so it is not `authenticate`-only | Service-layer owner gate on top; admins can still reject if they need to terminate |
| 31 | M16 — `migrateAttendanceSegments` removed from boot path | Backfill was running every boot post-migration; preserved in git history if needed |
| 32 | Finalizer's run key is **yesterday** (IST), so the 23:00 run closes the previous day — an unclosed row sits open for ~24h before being flagged | Idempotency key matches the IST date being closed |
| 33 | EOD placeholder rows have `segments: []` (NOT a synthetic null-segment) | Check-in seeds the first segment cleanly, flipping `status` from placeholder to `present` |
| 34 | Finalizer `$setOnInsert` upsert means a concurrent check-in mid-cron keeps its `present` row | Race-safe by construction |
| 35 | `daily_expected_hours` defaults to 8 (settings.work_schedule) → overtime = `max(0, total − breaks − 480)` minutes | Per-user expected hours not modeled in v1; break minutes come off before the comparison, so each one cuts overtime one-for-one |
| 36 | C1 audit `before` snapshots use `record.toObject()` to deep-clone | Subsequent in-place mutations don't leak into the snapshot |
| 37 | The team list (`GET /attendance`) hydrates `user.{id, full_name}` per row via batched `User.find({_id: {$in}})` | No N+1; matches `loadActorDisplays` pattern in audit log |
| 38 | The corrections list (`GET /correction-requests`) emits `user_full_name` flat field per row | FE renders "deleted user" only when this is null; pre-fix every row arrived nameless |
