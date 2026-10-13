# Holidays & Office Locations — Backend

Two small admin-managed reference catalogs, paired here because both feed the **Attendance** module: holidays drive the EOD finalizer's placeholder status (rows for missing days get `status='holiday'` when the date matches), and office locations carry the QR token + future geofence anchor that QR check-in resolves.

This module is the **lookup-table layer** for attendance, with no engine of its own. The Leave Management module's segment generator also reads `holidays.date` to skip non-working days when computing leave segments.

Cross-references:
- [`attendance.md`](./attendance.md) — finalizer placeholder logic + QR check-in flow + geofence resolution.
- [`leave-management.md`](./leave-management.md) — segment generator's holiday skip.
- Settings module (work_schedule.working_days, attendance.geofence) is documented separately.

---

## Scope

| Sub-module | Surface | Notes |
|---|---|---|
| **Holidays** | `GET/POST/PATCH/DELETE /holidays` + `POST /holidays/bulk` | Org-wide IST calendar. Hard delete (no FK back-references) |
| **Office Locations** | `GET/POST/PATCH/DELETE /office-locations` + `POST /:id/regenerate-qr` | Soft delete via `is_active=false`. Server-generated QR token |

---

## Holidays

### Roles & permissions

| Endpoint | Permission | Held by |
|---|---|---|
| `GET /holidays` | `holiday.read` | **Everyone authenticated** — every system role including Client |
| `POST /holidays`, `POST /holidays/bulk`, `PATCH`, `DELETE` | `holiday.write` | Admin only (via `system.admin` wildcard) |

Why every role reads — the leave Apply dialog renders holiday badges on the calendar, the attendance Today banner shows "Today is a holiday" UI, and client portal task views show holiday strips next to task due dates. Clients need read access for the same UI hints.

### Data model — `holidays` ([`holiday.model.ts`](../../src/models/holiday.model.ts))

```ts
{
  _id, date: 'YYYY-MM-DD',     // IST — unique
  name: string,                 // ≤ 100 chars
  type: 'public'|'optional'|'special',
  description: string,          // ≤ 500 chars, free text
  created_by: ObjectId,
  created_at, updated_at,
}
```

**Indexes**:
- `{date: 1}` **unique** — the canonical join key for the segment engine + finalizer. E11000 → 409 `DUPLICATE_RESOURCE`.

**`type` semantics** ([`constants/holiday.ts`](../../src/constants/holiday.ts)):
- `public` (default) — gazetted / mandatory.
- `optional` — opt-in (regional / restricted / cultural).
- `special` — one-off org-declared (pandemic, mourning, election).

**Engine behavior is identical across all three types** — every row marks the date as a non-working holiday. Type is informational so the FE can render distinct chips. If a real opt-in flow is ever built (per-employee opt-in for `optional` days), that's a new feature on top of this enum, not a rewiring of the engine.

**Hard delete is OK**: nothing stores a foreign key to a holiday row. The segment engine + finalizer both read by `date` string. Deleting a holiday means "we got the calendar wrong"; both engines re-evaluate working days at runtime, so a deleted holiday immediately becomes a working day on next read.

### Endpoints

| Method | Path | Permission | Body / Query | Returns |
|---|---|---|---|---|
| `GET` | `/holidays` | `holiday.read` | `?from_date&to_date&year&type` | `200` — `{data: [...], meta: {total, from_date?, to_date?}}` (sidecar meta, NOT paginated) |
| `POST` | `/holidays` | `holiday.write` | `{date, name, type?, description?}` | `201` — created row |
| `POST` | `/holidays/bulk` | `holiday.write` | `{items: [{date, name, type?, description?}, ...]}` (1–200) | `201` — `{inserted, skipped: [{date, reason}]}` |
| `PATCH` | `/holidays/:id` | `holiday.write` | partial `{date?, name?, type?, description?}` (≥ 1 field) | `200` — updated row |
| `DELETE` | `/holidays/:id` | `holiday.write` | — | `204 No Content` |

**Route order**: `/bulk` is declared **before** `/:id` so Express doesn't try to parse the literal string `"bulk"` as an ObjectId param.

### Query semantics (`GET /holidays`)

**`year` is convenience-only**: expands to `from_date=YYYY-01-01, to_date=YYYY-12-31` **only when neither `from_date` nor `to_date` was passed**. Mixing wins for explicit range: `{from_date, to_date, year}` ignores `year`. This lets clients say "year=2026" OR "from_date=2025-12-15&to_date=2026-01-15" — never both.

**Range validation**:
- `from_date <= to_date` required when both present.
- Range span capped at `LIST_MAX_RANGE_YEARS = 5` years — multi-year planner without unbounded payload.
- If only `from_date` OR only `to_date` is passed → 400 with "the other is required".

**`type` filter** — exact match against one of `public|optional|special`.

### Bulk-create flow

```
POST /holidays/bulk {items: [{date, name, type?, description?}, ...]}
  ↓
Validator:
  - 1 ≤ items.length ≤ 200 (BULK_INSERT_MAX)
  - No duplicate `date` inside the payload (superRefine)
  - Each item validates against createHolidayBodySchema
  ↓
Service.bulkCreateHolidays:
  1. Precheck — Holiday.find({date: {$in: requestedDates}}) → existingDates set
  2. toInsert = items.filter(i => !existingDates.has(i.date))
  3. skipped = existingDates.map(d => ({date: d, reason: 'already_exists'}))
  4. if toInsert.length === 0 → return {inserted: [], skipped}
  5. Holiday.insertMany(toInsert, {ordered: false})    ← partial-duplicate tolerance
     - On BulkWriteError: harvest insertedDocs + tag remaining as 'race_condition_duplicate'
  6. Single audit row (I1) with action HOLIDAY_BULK_CREATE
     - target.id = null (collection-level)
     - after: {items: insertedRows}
     - metadata: {inserted_count, skipped_count, requested_count}
```

**`ordered: false`** is essential — between the precheck and the insertMany, a single concurrent create could race in for one of the dates. Without `ordered: false`, the whole batch aborts on the first conflict; with it, the conflicting row is reported in `writeErrors` and the rest go through.

**Single audit row, not per-item** (I1) — a 50-row import would otherwise flood the audit log. The inserted dates are still recoverable from `after.items` for forensics.

### Audit actions

| Action | When |
|---|---|
| `holiday.create` | `POST /holidays` |
| `holiday.bulk_create` | `POST /holidays/bulk` (single row with summary metadata) |
| `holiday.update` | `PATCH /holidays/:id` |
| `holiday.delete` | `DELETE /holidays/:id` (before-snapshot only) |

---

## Office Locations

### Roles & permissions

| Endpoint | Permission | Held by |
|---|---|---|
| `GET /office-locations` / `GET /:id` | `office_location.read` | Admin, Manager |
| `POST /office-locations`, `PATCH`, `DELETE`, `POST /:id/regenerate-qr` | `office_location.write` | Admin only |

Employees + Team Leads + Clients have no `office_location.read` — they don't need the registry. The attendance QR flow takes the token (anonymous) and resolves it internally; the QR landing page never lists locations.

### Data model — `office_locations` ([`office-location.model.ts`](../../src/models/office-location.model.ts))

```ts
{
  _id, name, address,
  qr_code_token: string,            // server-generated, unique, never accepted from client
  qr_code_image_url: string | null, // forward-compat — Azure Blob URL when wired; currently null
  is_active: boolean,                // soft-delete flag
  created_by: ObjectId,
  created_at, updated_at,
}
```

**Indexes**:
- `{qr_code_token: 1}` **unique** — the resolver's join key.
- `{is_active: 1, created_at: -1}` — cheap status filter for the default list.

**Soft delete only**: `DELETE /:id` sets `is_active = false`. Hard delete is forbidden because `attendance_records.check_in.location_id` references must stay resolvable for audit/reports. Reactivation via `PATCH {is_active: true}`.

**Per-location geofence / WiFi fields are NOT modeled** (Phase 4 / Step 35). Today the geofence lives on `system_settings.attendance.geofence` (org-wide, single anchor). Per-location enforcement is a planned schema migration.

### Endpoints

| Method | Path | Permission | Body / Query | Returns |
|---|---|---|---|---|
| `GET` | `/office-locations` | `office_location.read` | `?page&limit&is_active&show_deleted&q` (strict) | `200` — paginated, each row carries fresh `qr_data_url` |
| `POST` | `/office-locations` | `office_location.write` | `{name, address}` | `201` — new row with `qr_data_url` |
| `GET` | `/office-locations/:id` | `office_location.read` | — | `200` — row with `qr_data_url` |
| `PATCH` | `/office-locations/:id` | `office_location.write` | partial `{name?, address?, is_active?}` (≥ 1 field) | `200` — updated row |
| `DELETE` | `/office-locations/:id` | `office_location.write` | — | `204` — `is_active=false` |
| `POST` | `/office-locations/:id/regenerate-qr` | `office_location.write` | — | `200` — row with rotated `qr_data_url` |

**Field caps**: `name` 200 chars, `address` 500 chars. Deliberately generous to fit "Bangalore HQ — 4th Floor, Tower B, Embassy Tech Village" while still rejecting pathological pastes that would blow the QR PNG size.

**`qr_code_token` is server-only** — the create + patch validators don't accept it, and `qr_code_image_url` is also not patchable from the API (set by the service after Blob upload, when that ships).

### QR token + image rendering ([`utils/office-location-qr.ts`](../../src/utils/office-location-qr.ts))

**Token generation**: `randomBytes(24).toString('base64url')` → 32 chars → 192 bits of entropy → effectively no collision risk. Base64url chosen over hex for URL-safety + compactness (hex would be 48 chars and the printed QR would be physically larger).

**Image** (`renderCheckInQrDataUrl`): renders the URL `${APP_BASE_URL}${CHECK_IN_URL_PATH}?token=<qr_code_token>` as a base64 PNG data URL on **every read** — no caching. Cost is O(<1ms) per location. Trade-off: zero stale-cache surface; the moment a token rotates, every subsequent read shows the new QR.

`errorCorrectionLevel: 'M'` (medium) — comfortable for phone-camera scanning even when partially obscured. Same setting as the MFA setup QR.

### Insert + regenerate retry loop (`QR_TOKEN_REGENERATION_RETRY_LIMIT = 5`)

```
attempt N (max 5):
  doc.qr_code_token = generateQrToken()
  doc.qr_code_image_url = null         ← stale image nulled out
  try doc.save()
  except E11000 on qr_code_token:
    continue
  except other:
    rethrow
else: AppError.internal("Failed to allocate a unique QR token after 5 attempts")
```

192 bits of entropy means the loop almost never iterates more than once. Five retries is purely defense-in-depth; hitting the limit suggests a programming error (e.g. RNG mis-seeded), and we surface as 500.

### List filter scrubbing (BUG-002)

The validator accepts `is_active`, `show_deleted`, and `q`. The controller **scrubs privileged params for callers without `OFFICE_LOCATION_WRITE`**:

```ts
if (!callerHasPermission(req, PERMISSIONS.OFFICE_LOCATION_WRITE)) {
  query.show_deleted = false;
  if (query.is_active === false) delete query.is_active;
}
```

- `show_deleted=true` → forced to `false` (read-only callers can't see the soft-deleted bucket).
- `is_active=false` → deleted (read-only callers can't filter to "show me only the deleted ones").

Then the service applies the BUG-002 default: when neither `is_active` nor `show_deleted` is supplied → `is_active = true` (hide soft-deleted rows by default). An explicit `is_active` always wins.

### Search (`?q=`)

Regex `$or` against `name` and `address` (case-insensitive). The `q` term is escaped (`replace(/[.*+?^${}()|[\]\\]/g, '\\$&')`) so user input doesn't accidentally become a regex. **R15 — minimum 2 chars** at the validator boundary to avoid full-collection regex scans on `?q=a`.

### Response shape — `qr_data_url`

Every response (list / get / create / patch / regenerate) re-renders `qr_data_url` from the current `qr_code_token`. This is the only client-facing source of the QR image until Azure Blob is wired:

```ts
{ id, name, address,
  qr_code_token,           // visible to writers (admin); FE typically only renders the PNG
  qr_code_image_url: null, // until Phase 1 Step 22
  qr_data_url: 'data:image/png;base64,iVBOR...',  // computed on every read
  is_active, created_by, created_at, updated_at }
```

### Audit actions

| Action | When | Snapshot |
|---|---|---|
| `office_location.create` | `POST` | `after: {id, name, address, is_active}` |
| `office_location.update` | `PATCH` | `before`/`after`: `{id, name, address, is_active}` |
| `office_location.deactivate` | `DELETE` (soft) | `before: {is_active: true}`, `after: {is_active: false}` |
| `office_location.qr_rotate` | `POST /:id/regenerate-qr` | **No before/after** — token is a secret |

**I1 — audit projections strip `qr_code_token` + `qr_data_url`** ([`toAuditSnapshot`](../../src/services/office-location.service.ts)):
- `qr_code_token` is a check-in **secret**; landing it in the audit log would let anyone with `AUDIT_LOG_READ` bypass geofence enforcement by harvesting tokens from history.
- `qr_data_url` is a base64 PNG (typically 2–5 KiB per location) that would blow past `AUDIT_SNAPSHOT_BYTES_MAX = 16 KiB` and cause **every** office-location audit row to silently drop both snapshots.

The remaining fields (`name`, `address`, `is_active`) are what an operator actually needs to see "who changed what" later. QR rotation deliberately writes a content-less row — the rotation event itself is the signal.

---

## End-to-end flows

### Admin imports a year of holidays via bulk

1. Admin pastes a CSV "26 rows" → FE POSTs `/holidays/bulk {items: [{date, name, type:'public'}, ...]}`.
2. Validator: 26 items ≤ 200 cap, no in-payload duplicate dates, each item shape-valid.
3. Service: precheck `Holiday.find({date: {$in: 26 dates}})` → 3 existing.
4. `toInsert = 23`, `skipped = 3` with `reason: 'already_exists'`.
5. `insertMany(23, {ordered: false})` → 22 inserted, 1 race-collision tagged `race_condition_duplicate`.
6. Single audit row `holiday.bulk_create` with `metadata: {inserted_count: 22, skipped_count: 4, requested_count: 26}` + `after.items: [22 docs]`.
7. Response: `{inserted: [22], skipped: [3 + 1]}`. UI shows "22 imported, 4 skipped (dates already on the calendar)".

### Admin deletes a holiday

1. `DELETE /holidays/:id`.
2. `findByIdAndDelete` removes the row. Audit `holiday.delete` with `before` snapshot.
3. Subsequent attendance finalizer runs against this date now use `holiday=false` → placeholder becomes `absent` / `weekend` / `on_leave` instead of `holiday`.
4. Subsequent leave Apply previews don't skip this date — it's a working day again.

### Admin creates a new office location and prints the QR

1. `POST /office-locations {name: 'Bangalore HQ', address: '...'}`.
2. Service: `insertWithUniqueToken` — `generateQrToken()` → 32-char base64url → `Holiday.create(...)` (one attempt almost always wins).
3. Audit `office_location.create` with `{id, name, address, is_active: true}` (token stripped).
4. Response includes `qr_data_url = 'data:image/png;base64,...'` — FE shows it in a dialog with a Print button.
5. Phone scans the printed PNG → opens `${APP_BASE_URL}/check-in?token=<qr_code_token>` → attendance QR flow.

### Admin rotates a QR token

1. `POST /office-locations/:id/regenerate-qr`.
2. Service retry loop: `generateQrToken()` + `qr_code_image_url = null` + save. E11000 retries up to 5; the first attempt almost always wins.
3. Audit `office_location.qr_rotate` — **no before/after** (token is a secret).
4. Response: row with new `qr_data_url`. Every previously-printed QR is now invalid.
5. A phone that scans an old QR → `POST /attendance/qr-verify` → `INVALID_QR_TOKEN` (400). User must scan the freshly-printed sheet.

### Manager lists active locations

1. `GET /office-locations`. Manager has `OFFICE_LOCATION_READ` but not `WRITE`.
2. Controller scrubs: forces `show_deleted=false`, strips `is_active=false`.
3. Service default: `is_active=true` (BUG-002).
4. Response: paginated active locations, each with fresh `qr_data_url`.

### Admin lists deleted locations

1. `GET /office-locations?is_active=false`. Admin has `OFFICE_LOCATION_WRITE`, so the controller doesn't scrub.
2. Service applies `filter.is_active = false` (explicit narrowing wins over the default).
3. Response: only the soft-deleted bucket.

### Employee tries to list locations

1. `GET /office-locations`. Employee has no `OFFICE_LOCATION_READ` → 403 `INSUFFICIENT_PERMISSIONS` at the route guard.
2. Their QR check-in flow goes through `POST /attendance/qr-verify` instead, which has its own permission gate (`attendance.check_in_out`).

---

## Error codes

| Code | HTTP | When |
|---|---|---|
| `DUPLICATE_RESOURCE` | 409 | Holiday create / patch where `date` already exists. Details: `{date}` |
| `RESOURCE_NOT_FOUND` | 404 | Holiday or office-location id missing |
| `INTERNAL_ERROR` | 500 | QR token retry loop exhausted (5 collisions in a row — essentially impossible) |

Bulk holiday create does NOT throw `DUPLICATE_RESOURCE` — duplicates are reported per-item in the `skipped` array.

---

## Gotchas

| # | Behavior | Why |
|---|---|---|
| 1 | Holiday types (`public`/`optional`/`special`) are **all** treated as non-working days by the segment engine + finalizer | Type is informational; engine behavior identical. Real opt-in flow is a future feature |
| 2 | Holiday hard-delete is safe (no FK back-references) | Engines read by `date` string; deleted holiday immediately becomes a working day on next read |
| 3 | Bulk-create emits ONE audit row (not per-item) | A 50-row import would otherwise flood the audit log; rows recoverable from `after.items` |
| 4 | `/holidays/bulk` route MUST be declared before `/holidays/:id` | Express would parse "bulk" as an ObjectId param |
| 5 | `year` query param ignored when `from_date` or `to_date` is set | Explicit range wins; convenience-only |
| 6 | `from_date` / `to_date` are required as a pair (can't pass one alone) | Avoids ambiguous "from-here-forever" range scans |
| 7 | List range capped at 5 years | Multi-year planner without unbounded payload |
| 8 | Holiday `GET` returns `{data, meta}` (sidecar) NOT paginated `{data, meta:{page,limit,total,total_pages}}` | Holidays are bounded by year-range so pagination is unnecessary; api.ts envelope-preserve rule keeps `meta` intact for the FE |
| 9 | Office-location `qr_data_url` re-rendered on every read | Zero stale-cache surface; cost O(<1ms) per location |
| 10 | Office-location DELETE is **soft** (`is_active=false`) | `attendance_records.check_in.location_id` references must stay resolvable for audit |
| 11 | BUG-002 — `show_deleted` + `is_active=false` scrubbed for non-writers | Read-only callers can't see the soft-deleted bucket via query params |
| 12 | BUG-002 — default filter `is_active=true` when neither `is_active` nor `show_deleted` supplied | Hide deleted rows by default; explicit `is_active` wins |
| 13 | R15 — `?q=` requires min 2 chars | Avoids full-collection regex scans on `?q=a` |
| 14 | `q` regex chars escaped at the service layer | User input doesn't become a regex |
| 15 | I1 — audit snapshots strip `qr_code_token` (security) | Token is a check-in secret; audit-read shouldn't be a backdoor |
| 16 | I1 — audit snapshots strip `qr_data_url` (size) | 2–5 KiB PNG would blow past `AUDIT_SNAPSHOT_BYTES_MAX = 16 KiB` |
| 17 | `office_location.qr_rotate` audit has NO before/after | Rotation event is the signal; token is secret |
| 18 | QR retry limit = 5 (192 bits entropy makes >1 attempt essentially never happen) | Pure defense-in-depth; hitting limit = 500 (programming error) |
| 19 | `qr_code_image_url` always null today (Azure Blob not wired) | Forward-compat field; FE consumes `qr_data_url` instead |
| 20 | `errorCorrectionLevel: 'M'` for QR rendering | Comfortable for camera scan even when partially obscured; matches MFA QR |
| 21 | Per-location geofence/WiFi fields NOT modeled (Phase 4) | Geofence lives on `system_settings.attendance.geofence` — single org-wide anchor today |
| 22 | Validator dedupe of in-payload bulk dates | Cheaper than catching the DB error and rolling back |
| 23 | `insertMany({ordered: false})` for bulk | Race-condition duplicate doesn't tank the whole batch |
