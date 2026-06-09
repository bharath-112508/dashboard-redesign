# Audit Log & Archive — Backend

The forensic substrate every other module writes into. Four layers of defense, in the order data flows:

1. **`audit.service.recordAudit`** — the **only** entry point for writing to `audit_logs`. Non-throwing; oversized snapshots dropped with a marker; `AUDIT_WRITE_FAILED` warn log on failure.
2. **`audit_logs` collection** — append-only, no TTL, 4 composite indexes aligned to the read query patterns.
3. **`audit_log_mirrors` (hourly cron)** — defense-in-depth against compromised-Mongo rewrites of the 0–90 day window. SHA-256 chain into immutable Blob WORM.
4. **`audit_archives` (daily cron)** — cold offload of rows past `AUDIT_ARCHIVE_AFTER_DAYS = 90`. SHA-256 chain. Independent integrity verification (`GET /audit-archives/:id/verify`).

The read surface (`GET /audit-logs`, `GET /audit-archives`) is admin-only and read-only — no public write endpoint exists.

Cross-references:
- Every module documented before this one writes through `recordAudit` (see their respective "Audit actions" tables).
- [`reports-exports.md`](./reports-exports.md) — `report_export.{complete,fail}` use `recordSystemAudit` (no caller context).
- [`leave-management.md`](./leave-management.md), [`attendance.md`](./attendance.md), [`timesheets-billing.md`](./timesheets-billing.md), [`project-management.md`](./project-management.md), etc. — caller-driven audit rows via `recordAudit(buildAuditContext(req), ...)`.

---

## Scope

| Layer | Surface | Notes |
|---|---|---|
| **Write** | `audit.service.recordAudit` + `recordSystemAudit` | Best-effort, never throws |
| **Read — logs** | `GET /audit-logs` + `GET /audit-logs/:id` | Admin-only |
| **Read — archives** | `GET /audit-archives` + `GET /audit-archives/:id` + `GET /:id/verify` | Admin-only |
| **Hourly mirror cron** | `audit_log_mirror` (P1-7) | Chained WORM batches of new rows |
| **Daily archive cron** | `audit_archive` (Step 39) | 90-day-old rows → gzip JSONL → WORM + delete from Mongo |

No FE writes. No POST/PATCH/DELETE on either resource.

---

## Roles & permissions

| Endpoint | Permission | Held by |
|---|---|---|
| `GET /audit-logs`, `GET /audit-logs/:id` | `audit_log.read` | Admin only |
| `GET /audit-archives`, `:id`, `:id/verify` | `audit_archive.read` | Admin only |

Even Manager has no read access — the surface is purely forensic and crosses user boundaries by definition. Writes happen from inside business services, never via API.

---

## Write path — `recordAudit`

Single public entry point — all 100+ audit verbs across the codebase funnel through here.

### Inputs

```ts
interface AuditContext {
  actor_id: ObjectId | null;
  actor_role: AuditActorRole;   // RoleType | 'system' | 'unauthenticated'
  ip?: string | null;
  user_agent?: string | null;   // sliced to 512 chars
  request_id?: string | null;   // T2 — pino-http req.id OR `x-request-id` header
}

interface RecordAuditInput {
  action: AuditAction | string;            // <resource>.<verb>, ≤ 80 chars
  target: { kind: AuditTargetKind | string; id: ObjectId | null };
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  metadata?: Record<string, unknown>;
}
```

### `buildAuditContext(req, opts?)` ([`utils/audit-context.ts`](../../src/utils/audit-context.ts))

Controller helper: builds an `AuditContext` from an Express request. Three branches:
1. `opts.overrideActor` set → use those values (unauthenticated routes that know the actor *after* token validation, e.g. `/auth/reset-password`).
2. `req.user.user_id` set → snapshot `actor_id` + `actor_role` from JWT.
3. Otherwise → `actor_id: null, actor_role: 'unauthenticated'`.

**T2 — `request_id`**: extracted from `(req as any).id` (`pino-http` mints a ULID per request) or the `x-request-id` header. Stored on every audit row so an investigator can pivot from a structured log line to the audit row it produced — and vice versa.

### Body-shape pipeline

```
recordAudit(ctx, input):
  beforeJson = toPlainJson(input.before)   ← .toJSON() if available, else JSON round-trip; strip Mongoose internals
  afterJson  = toPlainJson(input.after)
  ↓
  beforeOverflow = JSON.stringify(beforeJson).bytes > AUDIT_SNAPSHOT_BYTES_MAX   (16 KiB)
  afterOverflow  = same for after
  ↓
  build metadata from ctx (ip, user_agent, request_id) + input.metadata
  if beforeOverflow: metadata.before_snapshot_dropped = true; auditSnapshotDroppedTotal.inc({which: 'before'})
  if afterOverflow:  metadata.after_snapshot_dropped  = true; auditSnapshotDroppedTotal.inc({which: 'after'})
  ↓
  if metadata > AUDIT_METADATA_BYTES_MAX (4 KiB):
    strip to {metadata_truncated: true, ip, user_agent, request_id, before/after_snapshot_dropped}    (G4)
  ↓
  try AuditLog.create({actor_id, actor_role, action, target_entity, before: overflow ? null : beforeJson, after: …, metadata})
       auditWritesTotal.inc({outcome: 'ok'})
  except: auditWritesTotal.inc({outcome: 'failed'}); logger.warn({code: AUDIT_WRITE_FAILED, ...})  ← NEVER throws
```

**Key invariants**:

- **`recordAudit` NEVER throws.** A primary business write must always succeed even if the audit can't be persisted (transient Mongo failure / DB-level connection issue). Operators grep `AUDIT_WRITE_FAILED` to find dropped events.
- **Snapshot byte caps (`AUDIT_SNAPSHOT_BYTES_MAX = 16 KiB` each)** drop oversized blobs with a marker rather than truncating silently. The whole-of-system_settings before/after would otherwise bloat individual rows.
- **G4 — strip metadata carve-out** preserves `before/after_snapshot_dropped` across the strip. Pre-G4 the strip discarded everything except `ip`/`user_agent`/`request_id`/`metadata_truncated`, so an operator seeing `metadata_truncated: true` couldn't tell whether the snapshot was dropped or simply absent.
- **`toPlainJson`** — Mongoose Documents / Subdocuments have their own `.toJSON()`; otherwise we JSON round-trip to strip class prototypes. Returns `null` on serialization failure (malformed snapshot must not block the action).
- **`auditWritesTotal{outcome}`** + **`auditSnapshotDroppedTotal{which}`** Prometheus counters — `/metrics` exposes them for operator alerting.

### `recordSystemAudit(input)` convenience wrapper

For cron jobs and other system-triggered events. Sets `actor_id: null, actor_role: 'system'`, drops IP/UA fields, optional `request_id`. Used by:
- `report_export.{complete,fail}` (worker has no caller context)
- `report_subscription.send` (weekly cron)
- `task_template.recurrence_run` (daily cron auto-instantiate)

System rows are distinguishable in the audit UI by `actor_role: 'system'`.

---

## `audit_logs` collection ([`audit-log.model.ts`](../../src/models/audit-log.model.ts))

```ts
{
  _id, actor_id: ObjectId | null,
  actor_role: RoleType | 'system' | 'unauthenticated',
  action: string,                         // ≤ 80 chars, lowercase dot-form (e.g. 'leave.approve')
  target_entity: {kind: string, id: ObjectId | null},
  before: Mixed | null,
  after: Mixed | null,
  metadata: Mixed (default {}),
  created_at: Date,                       // ← timestamps: {createdAt: 'created_at', updatedAt: false}
}
```

**Append-only by convention** — no service exports `update` or `delete` against this collection. A compromised admin with Mongo shell access could still mutate; that's why the mirror + archive layers chain SHA-256 into immutable Blob.

**No TTL** — retained indefinitely (the archive cron moves cold rows out to Blob and removes them from Mongo).

**Indexes** (mirror Data_Model §7.2 exactly):
1. `{created_at: -1}` — global recency
2. `{actor_id: 1, created_at: -1}` — "what did user X do?"
3. `{'target_entity.kind': 1, 'target_entity.id': 1, created_at: -1}` — "history of resource Y"
4. `{action: 1, created_at: -1}` — "all role-changes recently"

The validator enforces `target_kind` whenever `target_id` is provided so a target-only filter can never bypass the composite index.

### Action namespace ([`constants/audit.ts:AUDIT_ACTIONS`](../../src/constants/audit.ts))

100+ verbs grouped by domain prefix: `user.*`, `auth.*`, `settings.*`, `leave.*`, `leave_balance.*`, `comp_off.*`, `holiday.*`, `attendance.*`, `correction.*`, `leave_type.*`, `office_location.*`, `project.*`, `sprint.*`, `story.*`, `task.*`, `comment.*`, `attachment.*`, `timesheet.*`, `billing_rate.*`, `share_link.*`, `settings.slack_update`, `slack.test_message`, `system.job_run`, `report_export.*`, `task_template.*`, `report_subscription.*`, `report_preset.*`, `push_subscription.*`, `role.*`, `user.roles_assign`, `user.extra_permissions_update`.

Each verb's documentation lives in `constants/audit.ts` next to the constant — the BE module docs reference them by tag.

### Target kinds ([`AUDIT_TARGET_KINDS`](../../src/constants/audit.ts))

27 stable kinds: `user`, `leave_request`, `leave_balance`, `comp_off_ledger`, `holiday`, `leave_type`, `office_location`, `attendance_record`, `correction_request`, `system_settings`, `job`, `project`, `sprint`, `story`, `task`, `task_comment`, `task_attachment`, `timesheet_entry`, `billing_rate`, `project_share_link`, `session`, `report_export`, `task_template`, `report_subscription`, `report_preset`, `push_subscription`, `role`.

`target.id` is nullable for collection-level events (e.g. `holiday.bulk_create` with `target.id: null` carrying `metadata.inserted_count`).

---

## Read endpoints

### `GET /audit-logs` ([`audit-log.service.ts:listAuditLogs`](../../src/services/audit-log.service.ts))

Query: `{actor_id?, action?, target_kind?, target_id?, from_date?, to_date?, page=1, limit=20 (max 100)}`. Strict — unknown params reject.

**Validation rule**: `target_id` requires `target_kind` (composite-index alignment). `from_date ≤ to_date` if both supplied.

**`from_date` / `to_date` → IST day boundaries**:
```ts
const toRangeStart = (isoDate) => dayjs.tz(isoDate, DEFAULT_TIMEZONE).startOf('day').toDate();
const toRangeEnd   = (isoDate) => dayjs.tz(isoDate, DEFAULT_TIMEZONE).endOf('day').toDate();
```
"Logs since 2026-04-15" in IST → 00:00:00.000 IST → UTC. End-of-day is inclusive (23:59:59.999 IST).

**Snapshots dropped on the list endpoint**:
```ts
AuditLog.find(filter).select('-before -after').sort({created_at: -1, _id: -1}).skip(skip).limit(query.limit)
```
`before` / `after` are 16 KiB EACH per row; a 100-row page with both populated could exceed 3 MB → reverse-proxy timeouts. The detail endpoint returns them.

**Actor display hydration** — `loadActorDisplays(actorIds)` batches `User.find({_id: {$in}}).select('_id full_name')` per page → Map. Per row: hydrate as `{id, full_name}`, or `{id, full_name: null}` for hard-deleted users (rare; we preserve the id for forensics). FE never has to N+1 against `/users/:id`.

Returns:
```ts
{
  data: [{
    id, action, actor: {id, full_name | null} | null,
    actor_role, target_entity: {kind, id: string | null},
    metadata, created_at,
  }],
  meta: {page, limit, total, total_pages},
}
```

### `GET /audit-logs/:id`

Returns the full detail row including `before` + `after`.

```ts
{
  ...listRow,
  before: Record<string, unknown> | null,
  after:  Record<string, unknown> | null,
}
```

---

## `audit_archives` (Step 39 — daily cold offload)

### Lifecycle of an audit row

1. Written to `audit_logs` by `recordAudit` (Step 12).
2. Read by admins via `GET /audit-logs` for the **recent 90-day window**.
3. Once older than `AUDIT_ARCHIVE_AFTER_DAYS = 90`: daily cron streams that day's rows into a single gzipped JSONL file, uploads to Blob, writes the `audit_archives` chain row, then **deletes the rows from `audit_logs`**.
4. Archived files are downloadable via `GET /audit-archives/:id`; their integrity is re-verifiable on demand via `GET /audit-archives/:id/verify`.

### Schema ([`audit-archive.model.ts`](../../src/models/audit-archive.model.ts))

```ts
{
  _id,
  archive_date: 'YYYY-MM-DD',           // IST content date (NOT upload date), UNIQUE
  blob_container: string | null,         // null only when row_count = 0
  blob_key: string | null,
  row_count: number ≥ 0,
  file_size_bytes: number | null,
  sha256_hash: string | null,            // 64-hex of gzipped bytes; null for empty-day rows
  previous_archive_id: ObjectId | null,
  previous_archive_hash: string | null,
  created_at, updated_at,
}
```

**Unique index on `archive_date`** — two concurrent cron ticks for the same day collide on E11000, only one wins.

**Append-only by convention** — service exports no `update` / `delete`. Only the cron creates rows.

### Archival algorithm (`archiveDay(isoDate)`)

```
1. Skip if AuditArchive.findOne({archive_date: isoDate}) exists.
   ↳ Self-heal partial-failure: if rows for this date are still live in audit_logs
     (previous run uploaded + wrote row but deleteMany failed), delete them now.
     Log a warn so the operator sees the recovery happened.

2. Compute day bounds: IST [00:00:00.000, 23:59:59.999] → UTC.

3. Empty-day shortcut: AuditLog.findOne({created_at: {$gte: startUtc, $lte: endUtc}}).
   If no row: create archive row with row_count=0, blob_*=null, sha256_hash=null,
   linked to the previous NON-EMPTY archive. Return.

4. Streaming pipeline (M29 — pre-M29 used in-memory accumulate + gzipSync):
   cursor → JSON-line generator → gzip Transform → PassThrough (sha256 update + size accumulate)
                                                  → BlockBlobClient.uploadStream
   ↳ Memory bounded by gzip chunk × upload concurrency (~16 MiB).
   ↳ JSONL row shape: stringified _id + actor_id + actor_role + action +
     target_entity + before + after + metadata + created_at.
   ↳ archivedIds[] accumulated for the final deleteMany targeting EXACT rows
     (NOT a re-query of the time range — late-arriving rows mustn't get deleted).

5. Look up most-recent NON-EMPTY archive (skipping empty-day rows so they don't
   sever the chain): AuditArchive.findOne({sha256_hash: {$ne: null}}).sort({archive_date: -1}).

6. AuditArchive.create({
     archive_date,
     blob_container, blob_key,
     row_count, file_size_bytes, sha256_hash,
     previous_archive_id, previous_archive_hash,
   })

7. AuditLog.deleteMany({_id: {$in: archivedIds}})    ← LAST, idempotent.
```

**Ordering invariant** — blob upload first, then chain row, then Mongo delete. If anything before step 7 fails, the source rows stay live and the next cron tick re-archives (the existing-row check in step 1 self-heals stranded subsets).

**Empty-day rows**: archive `sha256_hash: null, blob_*: null, row_count: 0`. The chain link still records `previous_archive_*` from the most recent **non-empty** archive — empty rows skip themselves as the parent so the chain stays anchored to verifiable bytes regardless of how many empty days happened in between.

### Sweep algorithm (`runArchivalSweep(now)`)

```
eligibleFrom = now (IST) - AUDIT_ARCHIVE_AFTER_DAYS
datesToArchive = []
for i in 0..AUDIT_ARCHIVE_MAX_DAYS_PER_RUN (30):
  candidate = eligibleFrom - i days
  if AuditArchive.findOne({archive_date: candidate}) → break (steady state)
  else datesToArchive.push(candidate)

datesToArchive.reverse()     ← archive oldest-first so chain writes chronologically

for date in datesToArchive:
  try archiveDay(date) → tally rows/bytes
  except: log warn; days_skipped++; continue   ← one failed day doesn't abort the sweep
```

**Two reasons for backward-walk-then-forward-archive**:
1. "Stop on already-archived" means steady-state is O(1) for the no-op case.
2. Chronological archive order keeps `previous_archive_hash` monotonically chained when catching up a backlog.

### Integrity verification — `GET /audit-archives/:id/verify`

```ts
verifyArchive(id):
  if !blob_container || !sha256_hash → integrity: 'empty_archive'
  try downloadBlob(container, key)
    except BlobNotFoundError → integrity: 'blob_missing'
  computed = createHash('sha256').update(bytes).digest('hex')
  return {
    id, archive_date,
    integrity: computed === doc.sha256_hash ? 'ok' : 'hash_mismatch',
    expected_hash, computed_hash, file_size_bytes: bytes.length,
  }
```

Returns a **structured result** (not a thrown error) on mismatch — the admin UI surfaces the diagnostic; ops decides what to do (file an incident, query Azure's immutability policy, etc.).

### Download SAS

`mintDownloadSas({container, blobKey, ttlMinutes: AUDIT_ARCHIVE_DOWNLOAD_SAS_TTL_MINUTES, fileName})` — 30-minute TTL. Freshly minted on every `getArchive` read — never persisted. Lowering the constant tightens forward immediately.

---

## `audit_log_mirrors` (P1-7 — hourly real-time-ish copy)

**Defense-in-depth against compromised Mongo rewriting recent audit history.** The archive (90 days) covers cold rows; the mirror covers the 0–90 day window with an hourly export.

### Design

```
Hourly cron (07 past the hour):
  previous = AuditLogMirror.findOne().sort({_id: -1})
  idCutoff = previous?.to_id ?? null

  totalBacklog = AuditLog.countDocuments({_id: {$gt: idCutoff}})
  auditLogMirrorLagRows.set(totalBacklog)
  if totalBacklog > AUDIT_LOG_MIRROR_MAX_ROWS_PER_RUN (5000):
    log warn AUDIT_LOG_MIRROR_BACKLOG
  rows = AuditLog.find({_id: {$gt: idCutoff}}).sort({_id: 1}).limit(5000).lean()

  Empty-batch (rows.length === 0):
    R13 — if no previous chain head AND no rows ever, skip (cold install — no noise rows)
    else: AuditLogMirror.create({from_id: idCutoff, to_id: idCutoff, row_count: 0,
                                  blob_*: null, sha256_hash: null,
                                  previous_*: previous.{_id, sha256_hash}})
    return

  jsonl = rows.map(ROW_SERIALIZE).join('\n') + '\n'
  gz = gzipSync(Buffer.from(jsonl))                       ← in-memory (5000 rows ≈ 10 MB cap)
  sha256 = createHash('sha256').update(gz).digest('hex')
  blobKey = mirrors/YYYY/MM/DD/<ISO timestamp>.jsonl.gz

  putBlob({container: 'audit-log-mirrors', blobKey, body: gz})    ← upload first
  AuditLogMirror.create({
    from_id: idCutoff, to_id: lastRow._id,
    watermark_at: lastRow.created_at,
    row_count, file_size_bytes, blob_*, sha256_hash,
    previous_mirror_id, previous_hash,
  })
```

**Why ObjectId-monotonic `_id` cutoff (not `created_at`)**: ObjectId carries a timestamp prefix so `{_id: {$gt: lastTo}}` is chronologically equivalent on a single shard AND uses the natural `_id` index. Avoids index gymnastics on `created_at`.

**R13 — cold-install special case**: skip the no-op chain row when neither a previous chain head nor any audit rows exist. Otherwise hundreds of `{from_id: null, to_id: null}` rows would accumulate over time as pure noise. Once the first real audit row + mirror happens, the chain starts and subsequent empty hours **do** legitimately need a chain row to defeat "skip an hour" tampering.

**Backlog awareness — R9**:
- `auditLogMirrorLagRows` gauge (Prometheus) — non-zero across multiple runs signals the mirror is falling behind.
- Per-run cap `5000` — protects against years-of-backlog catching up in one tick.

**Schema** ([`audit-log-mirror.model.ts`](../../src/models/audit-log-mirror.model.ts)):
```ts
{
  _id,
  from_id: ObjectId | null,                  // exclusive lower bound ($gt)
  to_id:   ObjectId | null,                  // inclusive upper bound (= last row's _id)
  watermark_at: Date,                        // last row's created_at — convenience for ops
  row_count: number, file_size_bytes: number | null,
  blob_container: string | null, blob_key: string | null,
  sha256_hash: string | null,
  previous_mirror_id: ObjectId | null, previous_hash: string | null,
  created_at,
}
```

The hourly mirror complements (not replaces) the daily archive — both write to WORM containers, together covering the full "since the row was written" window.

---

## Audit actions

This module doesn't write its own audit rows — it's the substrate every other module writes through. The relevant counters/metrics:

| Metric | What |
|---|---|
| `audit_writes_total{outcome}` | `recordAudit` writes — `outcome ∈ {ok, failed}` |
| `audit_snapshot_dropped_total{which}` | `before`/`after` snapshot exceeded 16 KiB cap — `which ∈ {before, after}` |
| `audit_log_mirror_lag_rows` | Gauge — backlog count at the start of each mirror tick (R9) |

Operators alert on:
- `rate(audit_writes_total{outcome='failed'}[5m]) > 0` — recordAudit is dropping events.
- `audit_log_mirror_lag_rows > 5000` for N consecutive ticks — mirror is falling behind.
- `audit_snapshot_dropped_total` non-zero — services pushing oversized snapshots; refactor needed.

---

## Error codes

| Code | HTTP | When |
|---|---|---|
| `AUDIT_WRITE_FAILED` | (log only) | `recordAudit`'s catch branch — never reaches the wire |
| `AUDIT_ARCHIVE_NOT_FOUND` | 404 | `GET /audit-archives/:id` — unknown id |
| `RESOURCE_NOT_FOUND` | 404 | `GET /audit-logs/:id` — unknown id |

`GET /audit-logs` and `GET /audit-archives` use the same `INSUFFICIENT_PERMISSIONS` from the permission gate for non-admin callers.

---

## End-to-end flows

### Admin approves a leave → audit row written

1. Manager `POST /leaves/:id/approve {approver_remarks: 'OK'}`.
2. `leave-request.service.approveLeave(...)` does the atomic CAS pending→approved, updates the balance row.
3. `recordAudit(buildAuditContext(req), {action: LEAVE_APPROVE, target: {kind: LEAVE_REQUEST, id}, before: <pending snapshot>, after: <approved snapshot>, metadata: {approver_remarks}})`.
4. `audit.service` serialises snapshots, checks 16 KiB cap, builds metadata (ip/ua/request_id), persists.
5. `auditWritesTotal.inc({outcome: 'ok'})`.

### Audit write fails mid-deactivate

1. Admin `POST /users/:id/deactivate`. Service deactivates the user + revokes refresh tokens.
2. `recordAudit({action: USER_DEACTIVATE, ...})` — Mongo connection blips.
3. Catch branch fires: `auditWritesTotal.inc({outcome: 'failed'})` + `logger.warn({code: AUDIT_WRITE_FAILED, action, target_kind, target_id, actor_id}, 'Audit log write failed')`.
4. Deactivate response is still 200 — the primary action succeeded.
5. Ops dashboard shows the spike in `audit_writes_total{outcome='failed'}`. Investigator pivots to the warn log via `code=AUDIT_WRITE_FAILED`.

### Oversized snapshot (after) gets dropped (G4)

1. Service patches all of `system_settings` in one go; the `after` snapshot is 22 KiB.
2. `afterOverflow = true` → `metadata.after_snapshot_dropped = true` + counter inc.
3. Row written with `after: null, before: <under-cap>, metadata: {…, after_snapshot_dropped: true}`.
4. Admin browsing `/audit-logs` sees the row; clicking detail shows `after: null` + a "snapshot dropped" UI hint.

### Admin filters logs by target

1. `GET /audit-logs?target_kind=leave_request&target_id=abc...&from_date=2026-06-01&to_date=2026-06-08`.
2. Validator: `target_id` requires `target_kind` ✓; `from <= to` ✓.
3. Filter applied via composite index `{target_entity.kind, target_entity.id, created_at}` → on-index scan.
4. `select('-before -after')` drops snapshots from list; per-page batch user-display hydration.
5. Returns paginated rows; admin clicks one → `GET /audit-logs/:id` returns full snapshots.

### Mirror cron at top of hour

1. 14:07 IST. Cron fires `runAuditLogMirror`.
2. `previous = {to_id: ABC, sha256_hash: 'def…'}`. `totalBacklog = 247` rows since then.
3. `auditLogMirrorLagRows.set(247)`. Under the 5000 cap.
4. Pull 247 rows, sort `_id: 1`, serialise → JSONL → gzip → sha256.
5. `putBlob('audit-log-mirrors', 'mirrors/2026/06/09/2026-06-09T08:37:00.000Z.jsonl.gz', gz)`.
6. `AuditLogMirror.create({from_id: ABC, to_id: <last>._id, watermark_at, row_count: 247, …, previous_mirror_id, previous_hash: 'def…'})`.

### Daily archive at 04:00 IST

1. `runArchivalSweep`. `eligibleFrom = today (IST) - 90 days = 2026-03-11`.
2. Walk backward looking for the latest non-archived date → `2026-03-11` (already archived) → break immediately (steady state).
3. Sweep summary: `{days_archived: 0, rows_archived: 0, days_skipped: 0, bytes_uploaded: 0}`.
4. `system.job_run` audit row with that summary.

### Catch-up after a 5-day outage

1. Cron resumed after 5 days off.
2. `eligibleFrom = today - 90 days`. Walk back: none of the last 5 days are archived.
3. `datesToArchive` collects 5 dates, reverses (oldest first).
4. For each date: `archiveDay(date)` → stream → upload → chain row → deleteMany.
5. Summary: `{days_archived: 5, rows_archived: 4200, bytes_uploaded: 850000}`.

### Integrity verify on a tampered archive

1. Admin: `GET /audit-archives/<id>/verify`.
2. Service downloads the blob, recomputes SHA-256.
3. Mongo says `sha256_hash: 'abc…'`; computed says `'def…'`.
4. Returns `{integrity: 'hash_mismatch', expected_hash: 'abc…', computed_hash: 'def…', file_size_bytes}`.
5. Admin UI surfaces the diagnostic in red. Ops files an incident → audit-archive container retention policy review.

### Archive sweep partial failure recovery

1. Day 5 of catch-up: blob upload to Azure succeeded; chain row write succeeded; `AuditLog.deleteMany` failed mid-loop (Mongo blip).
2. Next nightly tick: walk back finds `2026-04-04` archived → break. But there are stranded source rows in `audit_logs` for that date.
3. The next `archiveDay('2026-04-04')` call (manual or future re-attempt) hits the existing-row check: rows match the IST-day range → `deleteMany` cleans them up → log warn "self-heal: deleted stranded source rows". `skipped_reason: 'already_archived'`.

---

## Gotchas

| # | Behavior | Why |
|---|---|---|
| 1 | `recordAudit` NEVER throws — failures log `AUDIT_WRITE_FAILED` at warn | Primary action must succeed even if audit Mongo write fails |
| 2 | Snapshot byte caps `AUDIT_SNAPSHOT_BYTES_MAX = 16 KiB` each (before + after) | Runaway diff (all-of-system_settings) doesn't bloat one row |
| 3 | Oversized snapshots dropped with `metadata.{before,after}_snapshot_dropped = true` marker | Operator sees something was elided |
| 4 | G4 — strip carve-out preserves snapshot-dropped flags across metadata-overflow strip | Pre-G4 the dropped flag was lost when metadata also blew past 4 KiB |
| 5 | Metadata cap `AUDIT_METADATA_BYTES_MAX = 4 KiB` | IP + UA + extras can grow unchecked otherwise |
| 6 | `metadata.metadata_truncated = true` when the cap fires | Same elision-marker pattern |
| 7 | `toPlainJson` calls `.toJSON()` if available, else round-trips JSON — strips Mongoose internals + class prototypes | Returns null on serialization failure (never blocks) |
| 8 | T2 — `request_id` extracted from `pino-http req.id` OR `x-request-id` header | Pivot between pino log line and audit row |
| 9 | `actor_id` nullable for system events (`actor_role: 'system'`) | Cron / future scheduled jobs without synthetic user |
| 10 | `target.id` nullable for collection-level events | E.g. `holiday.bulk_create` with `metadata.inserted_count` |
| 11 | `audit_logs` append-only by convention (NOT model-enforced) | Compromised Mongo shell could still mutate → covered by mirror + archive chains |
| 12 | `audit_logs` has NO TTL — retained indefinitely | Archive cron is the offload path |
| 13 | List endpoint `select('-before -after')` drops snapshots | 16 KiB × 2 × 100 rows = >3 MB → reverse-proxy timeouts |
| 14 | Detail endpoint returns full snapshots | Direct fetch only |
| 15 | Per-page `loadActorDisplays` batched `User.find({$in})` | No N+1 against `/users/:id` |
| 16 | Hard-deleted user → row keeps actor_id, `full_name: null` | Forensic id preserved |
| 17 | Validator requires `target_kind` when `target_id` provided | Composite-index alignment |
| 18 | `from_date` / `to_date` → IST day boundaries (00:00:00.000 to 23:59:59.999) | "Logs since 2026-04-15" in admin's locale |
| 19 | Archive `archive_date` unique index → concurrent ticks for same day collide | E11000 → only one wins |
| 20 | Empty-day archive rows (`row_count: 0`, no blob, `sha256_hash: null`) | Chain link still recorded so verify walk can detect missing days |
| 21 | Chain links skip empty-day rows (parent = latest NON-empty archive) | Empty days don't sever the SHA-256 chain |
| 22 | Archive ordering: blob → chain row → Mongo delete | Idempotent on partial failure; existing-row self-heals stranded subsets |
| 23 | M29 — archive uses streaming pipeline (cursor → gzip transform → hash → upload) | Pre-M29 in-memory accumulate + gzipSync stalled the event loop on big days |
| 24 | `archivedIds[]` accumulated for the final deleteMany | Targets EXACT rows, not the time range (late-arrivals safe) |
| 25 | Sweep walks backward to find dates, archives forward (chronological) | Steady-state O(1); chain stays monotonic |
| 26 | Sweep `AUDIT_ARCHIVE_MAX_DAYS_PER_RUN = 30` | Years-of-backlog rolls in over a month of nightly runs |
| 27 | One failed day doesn't abort the sweep (`days_skipped++`, log warn) | Next tick retries |
| 28 | Verify returns STRUCTURED result on mismatch (NOT thrown) | Admin UI surfaces; ops decides remediation |
| 29 | Verify integrity values: `ok` / `hash_mismatch` / `blob_missing` / `empty_archive` | Each maps to a distinct UI state |
| 30 | Download SAS 30-minute TTL, freshly minted on every read | Lowering tightens forward immediately |
| 31 | Mirror uses ObjectId-monotonic `_id` cutoff (not `created_at`) | Natural `_id` index; chronological on a single shard |
| 32 | Mirror in-memory gzipSync per tick (NOT streaming like archive) | 5000-row cap = ~10 MB max; trivial vs streaming overhead |
| 33 | R13 — cold install skips no-op chain rows | Otherwise hundreds of `{from_id:null, to_id:null}` accumulate as noise |
| 34 | After first real chain row, empty hours DO write chain rows | Defeats "skip an hour" tampering |
| 35 | R9 — `auditLogMirrorLagRows` gauge + `AUDIT_LOG_MIRROR_BACKLOG` warn at backlog > cap | Operator signal mirror is falling behind |
| 36 | Mirror retention is short (~90 days, then rolled off); archive is long (~7 years) | Mirror covers fresh window; archive covers cold |
| 37 | Azure immutability policy MUST be configured on both containers at provisioning | Code uploads bytes; doesn't configure container retention. Hash chain is defense-in-depth |
| 38 | `recordSystemAudit` strips IP/UA; sets `actor_role: 'system', actor_id: null` | Cron context has no caller |
| 39 | Action names follow `<resource>.<verb>` dot-form | E.g. `leave.approve`, `task.dependency_add` |
| 40 | Free-form strings accepted on `action` + `target_kind` in validator | Allows querying older renamed actions; FE not blocked on enum updates |
