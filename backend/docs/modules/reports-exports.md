# Reports & Exports — Backend

Reports are the read-only aggregation layer over the operational collections (timesheets, leave balances, attendance records, billing rates). Four synchronous JSON endpoints (billing / utilization / attendance / leaves) feed two write-side surfaces — async exports (`report_exports`, format CSV/XLSX/PDF, blob-backed) and recurring email digests (`report_subscriptions`, weekly cron, inline-or-attachment) — both reusing the same builder + tabular shape so a saved filter is always re-runnable.

Cross-references:
- [`timesheets-billing.md`](./timesheets-billing.md) — billing report joins `timesheet_entries × billing_rates`; utilization counts working days × `daily_warn_threshold_hours`.
- [`attendance.md`](./attendance.md) — attendance report aggregates `attendance_records.status` counts.
- [`leave-management.md`](./leave-management.md) — leave report reads `leave_balances` per-year per-user.
- [`holidays-locations.md`](./holidays-locations.md) — utilization + attendance baseline subtracts holidays.

---

## Scope

| Sub-module | Surface | Notes |
|---|---|---|
| **Reports** | 4 sync GETs: `/reports/billing|utilization|attendance|leaves` | Manager+admin; per-user rate-limited |
| **Exports** | `POST /reports/:name/export` + `GET /reports/exports/:id` | Async pipeline (pending→running→ready/failed), 7-day retention, inline fallback for non-Azure deployments |
| **Presets** | `GET/POST/PATCH/DELETE /report-presets` | Owner-scoped, per-user cap 50 |
| **Subscriptions** | `GET/POST/PATCH/DELETE /report-subscriptions` + daily 07:00 sweep | Owner-scoped, per-user cap 20, weekly delivery |
| `report_export_cleanup` cron | Daily 03:00 IST | Delete expired blobs + rows |
| `report_subscription` cron | Daily 07:00 IST | Send to all subscriptions matching today's IST weekday |

---

## Roles & permissions

Every endpoint requires `report.read` at the route level. Reports cross user boundaries by design (billing rolls up per project, utilization spans the team), so employees + clients are an unconditional deny.

| Endpoint | Permission |
|---|---|
| All `/reports/*` GET reads | `report.read` (Admin, Manager) |
| `POST /reports/:name/export` | `report.read` + **`report_export.write`** |
| `GET /reports/exports/:id` | `report.read` + `report_export.write` (owner-scoped at service) |
| All `/report-presets/*` | `report.read` (owner-scoped at service) |
| All `/report-subscriptions/*` | `report.read` (owner-scoped at service) |

**Owner-scoped reads** — every preset / subscription / export endpoint filters by `user_id = caller.id` at the service. Cross-user IDs surface as `*_NOT_FOUND` (anti-enumeration; same pattern as notifications + refresh tokens). Even an admin can't see another admin's exports/presets/subscriptions via these endpoints — the cross-user view lives in the audit log (`GET /audit-logs`), which surfaces every action by every user.

---

## Rate limits (P2-9 — per-user, stacked on global per-IP)

| Endpoint | Limit | Why |
|---|---|---|
| `GET /reports/*` (all 4 reads) | 60 / minute / user (`reportReadRateLimiter`) | Read-heavy; matched to typical "click around the dashboard" cadence |
| `POST /reports/:name/export` | 10 / 15 min / user (`exportRateLimiter`) | Each export spins up a PDF/XLSX render in the background; tighter ceiling to back-pressure runaway loops |
| `GET /reports/exports/:id` | No extra limit (`report.read` 60/min applies) | Polling is unavoidable; rely on the global 60/min |

---

## Synchronous reports

### `GET /reports/billing` ([`report.service.ts:buildBillingReport`](../../src/services/report.service.ts))

Query: `{project_id, from_date, to_date, client_id?, group_by='employee'|'task'}` (`from_date ≤ to_date`, range ≤ 92 days per `REPORT_RANGE_MAX_DAYS`).

Algorithm:
1. **Load project** + assert `client_id` matches `project.client_ids[]` if supplied (M14 — was silently ignored before; now refuses with 404 to keep "report per (project, client)" pair meaningful).
2. **Single `$facet` aggregation** on `timesheet_entries`: matches `{project_id, local_date: {$gte, $lte}, entry_type: 'task_linked'}` — **general entries are excluded** (no task to attach a rate to). Branches: `rows` (grouped by `(user_id, task_id?)` depending on `group_by`) + `rangeTotals` (single bucket). Capped at `REPORT_ROW_CAP = 1000`.
3. **Hydrate users + tasks** (batched `User.find`, `Task.find`).
4. **Resolve billing rates — H23 batched lookup** (NOT N+1):
   - One `BillingRate.find({user_id: {$in: userIds}, project_id, effective_from: {$lte: to_date}, $and: [<not-yet-ended OR ended ≥ to_date>, <task in N OR task_id null>]}).sort({effective_from: -1, _id: -1})`.
   - Build TWO in-memory maps: `taskRateMap[user|task] → rate` (task-specific first-write-wins desc) and `projectRateMap[user] → rate` (project-level fallback).
   - **H23 follow-through** — secondary `{_id: -1}` sort makes tied `effective_from` deterministic (legitimate: two task rates inserted same day).
   - Per row: try `taskRateMap.get(user|task)`, else `projectRateMap.get(user)`, else `null`.
5. **Compute `billable_amount = round(billable_hours × hourly_rate)`** per row when rate exists; **rows without a rate keep their hours but contribute 0 to the total** (so silently understating billing is impossible — operator sees the missing rate).

Lookup date is `to_date` ("rate that applied at the end of the window") — a future enhancement could weight by per-entry rate at `local_date`, but this matches most billing systems.

Returns `{project: {id, name}, from_date, to_date, rows: [...], totals: {billable_minutes, non_billable_minutes, billable_amount}}`.

### `GET /reports/utilization` ([`buildUtilizationReport`](../../src/services/report.service.ts))

Query: `{from_date, to_date, team_id?, user_id?}` — `team_id` is **accepted and ignored** (no `team` collection in v1; field stays for FE-shape stability).

Algorithm:
1. Load settings → `dailyHours = settings.timesheet.daily_warn_threshold_hours` (fallback 8).
2. `holidayDates = Holiday.find({date: {$gte, $lte}})` → Set.
3. `workingDays = countWorkingDays(from, to, holidayDates)` (Mon–Fri minus holidays; org-uniform — per-user contracts deferred to v1.5).
4. `expectedPerUserMinutes = workingDays × dailyHours × 60`.
5. Load internal users (active, role IN {admin, manager, employee} — clients excluded so 0% rows don't skew the team average; row cap 1000).
6. Aggregate `timesheet_entries` grouped by `user_id` over the date window → `{billable_minutes, non_billable_minutes}`.
7. Per user: `utilization_pct = round((logged_total / expected) × 10000) / 100`; null when expected is 0.

Returns `{from_date, to_date, expected_per_user_minutes, rows: [{user: {id, full_name, role}, logged_billable_minutes, logged_non_billable_minutes, expected_minutes, utilization_pct}]}`.

### `GET /reports/attendance` ([`buildAttendanceReport`](../../src/services/report.service.ts))

Query: `{from_date, to_date, user_id?}`.

Algorithm:
1. Load internal users (clients excluded).
2. `attendance_records.aggregate({$match: {user_id: {$in}, local_date: {$gte, $lte}}, $group: {_id: {user_id, status}, count}})`.
3. Bucket per user → `{present, absent, on_leave, holiday, weekend, incomplete}` + `total_days = sum(buckets)`.

Returns `{from_date, to_date, rows: [{user, ...buckets, total_days}]}`.

### `GET /reports/leaves` ([`buildLeaveReport`](../../src/services/report.service.ts))

Query: `{year, user_id?}` — leave is per-year (`leave_balances` keyed by `(user, type, year)`).

Algorithm:
1. Load internal users.
2. `LeaveBalance.find({user_id: {$in}, year})` → all balances.
3. Load matching `LeaveType` rows → map `{id, key: lt.code, label: lt.name}` (LeaveType stores `code`+`name`; report's public shape names them `key`+`label` for FE-table consistency).
4. Per user: `by_type[]` sorted by label asc (stable sort across runs even when documents arrive in different orders).

Returns `{year, rows: [{user, by_type: [{leave_type, allocated, carried_forward, used, pending, adjusted, monthly_forfeited, available}]}]}`.

---

## Async exports

### `report_exports` ([`report-export.model.ts`](../../src/models/report-export.model.ts))

```ts
{
  _id, requested_by_user_id,
  report_name: 'billing'|'utilization'|'attendance'|'leaves',
  format:      'csv'|'xlsx'|'pdf',
  filters:     Mixed,                          // validator-coerced snapshot
  status:      'pending'|'running'|'ready'|'failed',
  blob_container: string | null,
  blob_key:       string | null,                // `exports/<_id>.<ext>`
  file_size_bytes: number | null,
  error_message:   string | null,               // ≤ 1000 chars
  error_code:      string | null,               // canonical, ≤ 80 chars
  started_at, completed_at, expires_at,         // expires = created + 7 days
  created_at, updated_at,
}
```

Indexes:
- `{requested_by_user_id: 1}` — owner-scoped polling reads.
- `{status: 1}` — cleanup + ops queries.
- `{expires_at: 1}` — cleanup cron scan.

**No Mongo TTL index** — the cleanup cron deletes the blob FIRST, then the row, in that order. A TTL would silently drop the row reference and orphan the file in Azure.

**No idempotency in v1** — two identical POSTs from the same user produce two rows, two worker runs, two blobs. Bounded downside (small file, 7-day retention) and a stricter idempotency-key surface is Phase 4.

### `POST /reports/:name/export` ([`report-export.controller.ts:postExport`](../../src/controllers/report-export.controller.ts))

Body: `{format: 'csv'|'xlsx'|'pdf', filters: <per-report-name>}` — strict, dispatched via [`parseExportBody(name, body)`](../../src/validators/report-export.validator.ts) which routes to the matching synchronous report's Zod schema (reused verbatim, so an export for a query the GET endpoint would reject can never be enqueued).

**Validation flow** — the controller catches the inner `ZodError` from `parseExportBody` and converts to `AppError.validation` so the response matches the canonical 400 VALIDATION_ERROR shape. The standard `validate({body})` middleware can't see `req.params.name` and so can't dispatch.

**Two code paths**:

#### Async path (Azure configured)
```
enqueueExport(input, caller):
  expires_at = now + 7 days
  ReportExport.create({...input, status: pending, expires_at})
  audit REPORT_EXPORT_CREATE {report_name, format, status: pending} + metadata {filters}
  scheduleWorker(row._id)        ← setImmediate(() => runExport(id))
  return {id, status: pending}
HTTP 202 Accepted
```

#### Inline path (BUG-069 — Azure NOT configured, e.g. dev / on-prem)
```
isAzureConfigured() === false →
  generateExportInline({name, format, filters}):
    table = REPORT_BUILDERS[name](filters)
    buffer = FORMAT_GENERATORS[format](table)
    fileName = buildExportFileName(name, format, now)
  audit REPORT_EXPORT_CREATE with target.id=null    ← M9: NO mint of fake ObjectId
                                                      "kind=report_export, no persisted target"
  metadata: {filters, inline: true, size_bytes}
  HTTP 200 with Content-Type, Content-Disposition (RFC 5987 — L14),
                X-Export-Inline: 1 (signals FE not to poll for status)
                Content-Length, raw bytes
```

**L14 — Content-Disposition encoding**:
```ts
const safeFileName = fileName.replace(/[\r\n"]/g, '');     // CR/LF + quote strip
res.setHeader(
  'Content-Disposition',
  `attachment; filename="${safeFileName}"; filename*=UTF-8''${encodeURIComponent(safeFileName)}`
);
```
- `filename=` (ASCII fallback) + `filename*=UTF-8''<encoded>` (RFC 5987 / 6266).
- Pre-L14 a non-ASCII or CRLF-bearing filename would either split the header (HTTP smuggling) or render as raw bytes; encoding makes it safe by construction. The CR/LF strip is belt-and-braces.

**M9 — inline audit `target.id = null`** — pre-M9 the controller minted a fresh `new Types.ObjectId()` so the audit row had a persisted-looking target id that pointed nowhere; an investigator following `target.id` would 404. Schema allows `target_entity.id = null`; use that to honestly say "no persisted target".

### Worker ([`report-export.service.ts:runExport`](../../src/services/report-export.service.ts))

```
runExport(id):
  row = ReportExport.findOneAndUpdate(
    {_id: id, status: 'pending'},
    {$set: {status: 'running', started_at: now}}, {new: true}
  )
  if !row: return       ← atomic flip; concurrent calls only one wins

  try (wrapped in withTimeout(EXPORT_WORKER_TIMEOUT_MS)):
    if !isAzureConfigured: throw StorageNotConfiguredError
    blobKey = `exports/<_id>.<ext>`
    table = REPORT_BUILDERS[report_name](filters)           ← same builders as sync reads
    buffer = FORMAT_GENERATORS[format](table)
    putBlob({container: EXPORT_BLOB_CONTAINER, blobKey, body, contentType: mime})

  on success:
    flip status=ready, blob_container, blob_key, file_size_bytes, completed_at
    recordSystemAudit REPORT_EXPORT_COMPLETE {size_bytes, file_name}

  on error (markFailed):
    flip status=failed, error_message (≤1000), error_code (≤80), completed_at
    recordSystemAudit REPORT_EXPORT_FAIL {error_code, error_message: ≤200}
    NEVER throws  — wrapper .catch logs any unexpected
```

`REPORT_BUILDERS` and `FORMAT_GENERATORS` are reused by both the worker and the subscription sweep. CSV (sync streaming), XLSX (exceljs), PDF (pdfkit fallback / puppeteer in Phase 5 when Container Apps lands; throws `PdfNotAvailableError` until then).

**`withTimeout(EXPORT_WORKER_TIMEOUT_MS)`** — wraps the full generate + upload so a runaway aggregation or stuck TCP doesn't leave the row in `running` forever. Throws `ExportTimeoutError` → mapped to `EXPORT_TIMEOUT` error code on the failed row.

**Test seam `EXPORT_WORKER_INLINE=true`** — `scheduleWorker` awaits the worker to completion before returning so tests can assert end-state without juggling timers + without racing `vi.resetAllMocks()`. Production never sets this flag.

### `GET /reports/exports/:id` ([`getExport`](../../src/services/report-export.service.ts))

Owner-scoped: `findOne({_id, requested_by_user_id: caller.id})` → 404 `EXPORT_NOT_FOUND` for cross-user OR missing.

Response `ExportSnapshot`:
```ts
{
  id, report_name, format, status,
  error_message, error_code,
  file_size_bytes,
  requested_at, started_at, completed_at, expires_at,
  download_url: string | null,                  // freshly minted SAS on every read
  download_url_expires_at: ISO | null,          // SAS expiry (15 min default)
  file_name: string | null,                     // <report>-<from-to>.<ext>
}
```

**Fresh SAS on every read** (`EXPORT_DOWNLOAD_SAS_TTL_MINUTES = 15`) — never persist the SAS. Lowering `EXPORT_DOWNLOAD_SAS_TTL_MINUTES` admin-side tightens going forward immediately; old polls already in flight expire on schedule.

---

## Presets ([`report-preset.service.ts`](../../src/services/report-preset.service.ts))

`report_presets` — saved filter shortcut: `{name, report_name (locked), filters (validated per name), user_id}`.

Indexes:
- `{user_id: 1, name: 1}` **unique** — accidental duplicate name prevention. Concurrent creates collide → E11000 → 409 `DUPLICATE_RESOURCE`.

**Lifecycle**:
- **Create**: per-user cap pre-check (`REPORT_PRESET_PER_USER_CAP = 50`) → `parsePresetFilters(report_name, filters)` (dispatched to per-report Zod schema; ZodError wrapped as `AppError.validation` with `filters.X` field paths) → insert.
- **Patch**: only `name` and `filters` editable; `report_name` is **locked at creation** (re-targeting = delete + recreate). Filters re-validated against the existing row's `report_name`.
- **Get/List**: owner-scoped.
- **Delete**: load row before delete so audit `before` has name + report_name.

**Audit** (H7): every mutation writes a row. Pre-H7 only subscriptions were audited; presets were the only saved-filter CRUD without a forensic trail.

---

## Subscriptions ([`report-subscription.service.ts`](../../src/services/report-subscription.service.ts))

`report_subscriptions` — saved query + weekly schedule + active flag.

```ts
{
  _id, user_id, name, report_name (locked), filters,
  day_of_week: 0..6,                            // 0=Sun..6=Sat, single weekday
  hour_local: 0..23,                            // forward-compat — NOT consumed by v1 cron
  output_format: 'inline'|'csv'|'xlsx'|'pdf',
  is_active: boolean,
  last_sent_at: 'YYYY-MM-DD' | null,            // CAS stamp on successful send
  created_at, updated_at,
}
```

Indexes:
- `{user_id: 1, name: 1}` **unique** — same dedup as presets.
- `{is_active: 1, day_of_week: 1}` — cron sweep filter.

**`hour_local` is forward-compat ONLY** — the v1 cron fires once daily at 07:00 IST and emails every active subscription matching today's weekday regardless of `hour_local`. Setting `hour_local: 17` does NOT delay your Monday email to 5pm — it still arrives at 07:00 IST. The field exists so the FE can offer a "send at" picker today and stay stable when a future Phase 5 hourly variant honours it.

**`output_format`** (V2-BE-13):
- `inline` (default) — report renders as HTML inside the email body.
- `csv` / `xlsx` / `pdf` — generates the attachment, sends a short notice email referencing it.

### Weekly sweep — `runWeeklyReportSweep` (cron 07:00 IST)

```
candidates = ReportSubscription.find({is_active: true, day_of_week: todayWeekday})
              .limit(REPORT_SUBSCRIPTION_MAX_PER_RUN = 500)

for each sub:
  if sub.last_sent_at === todayIso → skip (idempotency: same-day double-send)

  owner = User.findById(sub.user_id)
  if !owner || owner.status !== ACTIVE → skip + failures++ (self-heals tomorrow)

  result = REPORT_BUILDERS[sub.report_name](sub.filters)

  if output_format === 'inline':
    email = renderReportSubscriptionEmail(...)  ← HTML body
  else:
    built = buildSubscriptionAttachment(sub, result, todayIso):
      table = toTabularFor(sub.report_name, result)
      buffer = FORMAT_GENERATORS[output_format](table)
      if generator threw → fallback_reason='generation_failed', attachment=null
      if buffer > REPORT_SUBSCRIPTION_ATTACHMENT_MAX_BYTES (10 MB) → fallback_reason='attachment_too_large', attachment=null
    if built.attachment:
      email = renderReportSubscriptionAttachmentNotice(...)
      delivery_format = sub.output_format
    else:
      email = renderReportSubscriptionEmail(...)   ← controlled fallback
      delivery_format = 'inline'
      fallback_audit captured

  sendEmail({to: owner.email, subject, html, text, attachments?})

  stamp = findOneAndUpdate(
    {_id: sub._id, last_sent_at: sub.last_sent_at},     ← CAS on the prior value
    {$set: {last_sent_at: todayIso}},
    {new: true}
  )
  if !stamp:
    // Concurrent tick won the race → duplicate email ALREADY sent
    recordSystemAudit REPORT_SUBSCRIPTION_SEND {delivery: 'duplicate_sent'}
    failures++; continue

  recordSystemAudit REPORT_SUBSCRIPTION_SEND {
    delivery: 'sent', requested_format, delivered_format,
    attachment_filename?, size_bytes?,
    fallback_reason?, fallback_detail?,
  }
  emails_sent++

  on throw:
    log warn; recordSystemAudit REPORT_SUBSCRIPTION_SEND {delivery: 'failed', error_message}
    failures++
```

**Send-then-stamp ordering trade-off** — sends first so a mailer outage → no stamp → retry tomorrow. The cost is **possible duplicate-send on the very narrow CAS race window**; the audit `delivery: 'duplicate_sent'` makes the trade-off visible to ops.

**Per-subscription failure isolation** — one failing send increments `summary.failures` but doesn't abort the rest of the sweep. Audit row `metadata.delivery: 'failed'` lets operators grep for delivery problems without scraping logs.

**M24 — `recipient_email` removed from audit `metadata`** — pre-M24 the audit row carried the recipient email, which let `AUDIT_LOG_READ`-only holders pluck PII without going through the user-read gate. Now the audit target `{kind: REPORT_SUBSCRIPTION, id}` is the only identifier; resolving the email requires `USER_READ` on the owner.

**M13 — surface `attachment_filename + size_bytes` on success** — pre-M13 these were only captured on failure/fallback; ops walk-back ("which report, how big?") had to re-derive from the attachment build step.

---

## Cleanup cron — `report_export_cleanup` (daily 03:00 IST)

```
cleanupExpiredExports(now):
  expired = ReportExport.find({expires_at: {$lte: now}}).select('_id blob_container blob_key')
  for each row:
    if blob_container && blob_key:
      try { deleteBlob(container, key); blobsDeleted++ }
      catch { swallow — never let one bad row stall the loop }
  ReportExport.deleteMany({_id: {$in: ids}})
  return {rows_deleted, blobs_deleted}
```

Idempotency: `job_runs` unique on `(name, YYYY-MM-DD)`; same-day manual re-run collides. The underlying delete is naturally idempotent (a second pass finds rows already deleted).

**Why not Mongo TTL** — TTL deletes rows WITHOUT a hook into the application; the blob in Azure would still be around → orphaned bytes. The cron lets us delete blob → row, in the right order.

---

## Audit actions

| Action | Where |
|---|---|
| `report_export.create` | enqueue (async) OR inline path (target.id null per M9) |
| `report_export.complete` | worker success (system audit, no caller context) |
| `report_export.fail` | worker failure (system audit) |
| `report_preset.create` | create preset |
| `report_preset.update` | patch preset |
| `report_preset.delete` | delete preset |
| `report_subscription.create` | create subscription |
| `report_subscription.update` | patch subscription |
| `report_subscription.delete` | delete subscription |
| `report_subscription.send` | weekly sweep — `delivery: 'sent'|'duplicate_sent'|'failed'` |

**No audit on read reports** — they're immutable aggregates, no state change to audit.

---

## Error codes

| Code | HTTP | When |
|---|---|---|
| `INVALID_EXPORT_FORMAT` | 400 | Validator-level rejection of `format` (route validator narrows to CSV/XLSX/PDF) |
| `EXPORT_NOT_FOUND` | 404 | `GET /exports/:id` — unknown id OR cross-user |
| `STORAGE_NOT_CONFIGURED` | 503 (set on row) | Worker found Azure unset (inline path used instead at controller, so this only fires on the async path) |
| `EXPORT_TIMEOUT` | 408 (set on row) | Generate+upload exceeded `EXPORT_WORKER_TIMEOUT_MS` |
| `EXPORT_PDF_NOT_AVAILABLE` | 503 (set on row) | PDF requested before Container Apps + Puppeteer ships |
| `REPORT_PRESET_NOT_FOUND` | 404 | Cross-user OR missing |
| `REPORT_PRESET_LIMIT_EXCEEDED` | 422 | User at 50-preset cap |
| `REPORT_SUBSCRIPTION_NOT_FOUND` | 404 | Cross-user OR missing |
| `REPORT_SUBSCRIPTION_LIMIT_EXCEEDED` | 422 | User at 20-subscription cap |
| `DUPLICATE_RESOURCE` | 409 | `(user_id, name)` unique-index collision on preset or subscription |
| `VALIDATION_ERROR` | 400 | ZodError from `parseExportBody`/`parsePresetFilters`; field paths prefixed `filters.X` |
| `PROJECT_NOT_FOUND` | 404 | Billing report — project missing OR `client_id` doesn't match `project.client_ids` (M14) |

---

## End-to-end flows

### Manager opens the billing report

1. `GET /reports/billing?project_id=P&from_date=2026-05-01&to_date=2026-05-31&group_by=task`.
2. Validator: dates valid, range ≤ 92 days.
3. Service: load Project P. `$facet` aggregation on timesheet rows → 87 rows × 30 days.
4. Batched billing-rate lookup (one `find` for the (user, task) set) → in-memory maps → per-row rate resolution.
5. Returns `{project, from_date, to_date, rows: [...], totals}`. FE renders the table + amounts.

### Manager exports the same report as XLSX (Azure configured)

1. `POST /reports/billing/export {format: 'xlsx', filters: {project_id: P, from_date, to_date, group_by: 'task'}}`.
2. `parseExportBody('billing', body)` → coerces via `billingReportQuerySchema`.
3. `enqueueExport`: row created `{status: 'pending', expires_at: now + 7d}`, audit `report_export.create`, `setImmediate(runExport)`.
4. HTTP 202 with `{id}`. FE starts polling `GET /reports/exports/:id`.
5. Worker: atomic flip pending→running → builder → `generateXlsx(table)` → `putBlob` → flip running→ready with `blob_*`, `file_size_bytes`, `completed_at`. Audit `report_export.complete`.
6. Next FE poll returns `{status: 'ready', download_url: <fresh SAS>, file_name: 'billing-2026-05-01-2026-05-31.xlsx'}`. FE triggers browser download against the SAS URL.

### Same report on dev (Azure NOT configured) — BUG-069 inline fallback

1. Same POST. Controller checks `isAzureConfigured()` → false.
2. `generateExportInline({name, format, filters})` → buffer + filename + mime.
3. Audit `report_export.create` with `target.id = null` (M9), metadata `{inline: true, size_bytes}`.
4. HTTP 200 with `Content-Type: <mime>`, `Content-Disposition: attachment; filename="..."; filename*=UTF-8''...` (L14), `X-Export-Inline: 1`, raw bytes.
5. **FE detects `X-Export-Inline: 1`** → saves the response directly as a file; does NOT poll for status (there's no row to poll).

### Worker times out

1. Worker enters running state. Aggregation runs hot for 65s; `withTimeout(60000)` fires → `ExportTimeoutError`.
2. `markFailed` flips row to `failed` with `error_code: 'EXPORT_TIMEOUT'`, `error_message: 'Export exceeded 60000ms — aborted'`.
3. Audit `report_export.fail` (system).
4. FE poll surfaces `{status: 'failed', error_code: 'EXPORT_TIMEOUT', error_message: '...'}`. User retries with a narrower date range.

### Manager saves a billing-report preset

1. `POST /report-presets {name: 'Acme Q2 billing', report_name: 'billing', filters: {project_id, from_date, to_date, group_by: 'task'}}`.
2. Service: count check (< 50). `parsePresetFilters('billing', filters)` validates via the billing report schema (filters that the GET would reject can't be saved).
3. Create row. Audit `report_preset.create`.
4. Next time user opens the billing report, FE GETs `/report-presets?report_name=billing`, populates the form from the saved preset, then calls `GET /reports/billing` with the preset's filter.

### Manager subscribes to a weekly Monday digest

1. `POST /report-subscriptions {name: 'Monday utilization', report_name: 'utilization', filters: {from_date: '2026-06-01', to_date: '2026-06-30'}, day_of_week: 1, hour_local: 7, output_format: 'xlsx', is_active: true}`.
2. Service: cap check (< 20), filter validation, insert. Audit `report_subscription.create`.
3. Monday 07:00 IST cron sweep finds the subscription:
   - `last_sent_at !== '2026-06-08'` → process.
   - Build utilization report, `buildSubscriptionAttachment('xlsx', table)` → buffer (3.2 MB, under 10 MB cap) → attach.
   - Render "Your Monday utilization digest is attached" email body.
   - `sendEmail({to: owner.email, attachments: [{filename, mime, content}]})`.
   - CAS stamp `last_sent_at = '2026-06-08'`.
   - Audit `report_subscription.send {delivery: 'sent', requested_format: 'xlsx', delivered_format: 'xlsx', attachment_filename, size_bytes}`.

### Attachment too large → controlled fallback

1. Sub for a 90-day billing report. XLSX renders at 12 MB → over 10 MB cap.
2. `buildSubscriptionAttachment` returns `{attachment: null, fallback_reason: 'attachment_too_large', bytes: 12_582_912}`.
3. Service renders **inline HTML email** instead. Sends.
4. CAS stamp + audit `{delivery: 'sent', requested_format: 'xlsx', delivered_format: 'inline', fallback_reason: 'attachment_too_large', fallback_detail: '12582912 bytes (cap 10485760)'}`.
5. User still gets the data; ops can grep `fallback_reason: 'attachment_too_large'` to find subscriptions that need narrower filters.

### Subscription owner deactivated

1. Cron tick. Owner U is now `status: 'deactivated'`.
2. Service skips this send. `last_sent_at` NOT stamped. `summary.failures++`.
3. Tomorrow's tick will retry; if owner stays deactivated, retries forever. **Self-healing**: when admin reactivates U, the next matching weekday tick delivers normally.

### Daily 03:00 cleanup

1. Cron: `ReportExport.find({expires_at: {$lte: now}})` → 14 rows past their 7-day window.
2. For each: best-effort `deleteBlob`. 12 blobs deleted, 2 already gone (404 silently swallowed).
3. `deleteMany({_id: {$in}})` → 14 rows removed.
4. Job audit `{rows_deleted: 14, blobs_deleted: 12}`.

---

## Gotchas

| # | Behavior | Why |
|---|---|---|
| 1 | Reports cross user boundaries → manager+admin only; employee/client unconditionally denied | Aggregations span team; no row-level filter would make the surface safe |
| 2 | Synchronous reports cap output at `REPORT_ROW_CAP = 1000`; exports stream without the cap | JSON response bounded; export pipeline pulls full set |
| 3 | Working-day calculation is org-uniform (Mon–Fri minus holidays); per-user contracts deferred to v1.5 | Plan §3.4 — `team_id` accepted but ignored |
| 4 | Billing report excludes `entry_type: 'general'` entries | No task to attach a rate to |
| 5 | Billing rate lookup uses `to_date` ("rate at end of window") — NOT per-entry weighting | Matches what most billing systems report |
| 6 | H23 batched billing-rate lookup (one `find` not N+1 `findOne`) | Pre-H23 a 1000-row report fired ~2000 sequential queries — wall time was seconds of pure Mongo I/O |
| 7 | H23 secondary `{_id: -1}` sort makes tied `effective_from` deterministic | Without it, Mongo ties are implementation-defined; first-write-wins map population would flap |
| 8 | Rows without any matching billing rate contribute 0 to `billable_amount` BUT keep hours visible | Losing rate visibility silently would understate billing |
| 9 | M14 — `client_id` was previously ignored; now asserts project belongs to that client | Otherwise `?client_id=X` returned same data as omitting it |
| 10 | Leave report maps `LeaveType.code → key` + `.name → label` on the public shape | LeaveType stores code+name; report's public contract uses key+label for FE-table consistency |
| 11 | `team_id` accepted-and-ignored on utilization | No `team` collection in v1; field stays for FE-shape stability |
| 12 | Async exports have NO idempotency in v1 (two identical POSTs → two rows) | Bounded cost (small file, 7-day retention); idempotency keys are Phase 4 |
| 13 | BUG-069 — inline fallback when Azure not configured | Dev / on-prem deployments still get a working export — synchronous download with `X-Export-Inline: 1` header |
| 14 | M9 — inline audit `target.id = null` (NOT a minted fake ObjectId) | Honest "no persisted target"; pre-M9 the audit row pointed at a non-existent id |
| 15 | L14 — Content-Disposition uses RFC 5987 `filename*=UTF-8''<encoded>` + ASCII fallback + CRLF/quote strip | Non-ASCII filenames + header-injection safe by construction |
| 16 | Fresh download SAS minted on every GET (`EXPORT_DOWNLOAD_SAS_TTL_MINUTES = 15`); never persisted | Lowering TTL tightens going forward immediately |
| 17 | `expires_at` row deletion via cron (NOT Mongo TTL) | TTL would orphan blobs — we delete blob then row |
| 18 | Worker `withTimeout(EXPORT_WORKER_TIMEOUT_MS)` clamps generate+upload | Runaway aggregation or stuck TCP can't leave row stuck in `running` |
| 19 | Test seam `EXPORT_WORKER_INLINE=true` awaits worker in `enqueueExport` | Unit tests assert end-state without timers |
| 20 | Owner-scoped on every preset/subscription/export read (cross-user → `*_NOT_FOUND`) | Anti-enumeration, same as notifications + refresh tokens |
| 21 | `report_name` LOCKED at creation on preset + subscription | PATCH only re-validates filters against existing report_name; re-target = delete + recreate |
| 22 | Per-user caps: preset 50, subscription 20 | Subscription cap lower because each tick produces an outbound email |
| 23 | Subscription `(user_id, name)` unique → 409 `DUPLICATE_RESOURCE` on collision | Concurrent creates handled cleanly |
| 24 | `hour_local` on subscriptions is FORWARD-COMPAT only — v1 cron ignores it | Honest summary: setting hour_local: 17 doesn't delay your Monday email |
| 25 | Subscription cron CAS stamps `last_sent_at` AFTER send | Send-then-stamp tolerates mailer outage (no stamp → retry tomorrow); duplicate-send risk on narrow race is audit-visible |
| 26 | Per-subscription failure isolation — one failing send doesn't abort the sweep | `summary.failures++` + `recordSystemAudit {delivery: 'failed'}` |
| 27 | Deactivated owner → skip send; don't stamp `last_sent_at` | Self-heals when owner reactivated; tomorrow's tick retries |
| 28 | V2-BE-13 — `output_format` attachment fallback to inline on generator failure OR size > 10 MB | Recipient still gets data; fallback audited |
| 29 | M24 — `recipient_email` removed from subscription audit metadata | Pre-M24 let AUDIT_LOG_READ holders pluck PII without USER_READ on the owner |
| 30 | M13 — `attachment_filename + size_bytes` surfaced on success audit (was only on failure/fallback) | Ops walk-back doesn't have to re-derive |
| 31 | H7 — preset CRUD writes audit rows (`report_preset.{create,update,delete}`) | Sibling subscription was already audited; preset was the only saved-filter CRUD without a trail |
| 32 | `parseExportBody` / `parsePresetFilters` reuse the synchronous report Zod schemas verbatim | A saved/queued query is always re-runnable as a sync GET |
| 33 | ZodError → `AppError.validation` with `filters.X` field-path prefix (vs raw `X`) | Distinguishes a `filters.name` error from a top-level `name` error |
| 34 | PDF generator throws `PdfNotAvailableError` until Container Apps + Puppeteer ships | Logged at info (not warn) — known capability gap, not a regression |
| 35 | `target.id = null` on `report_export.create` for inline only; async path uses the row's `_id` | Inline path never persists a row |
