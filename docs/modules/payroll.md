# Payroll & Certificates — Backend

Per-user payroll master data (statutory + bank fields, versioned salary structures) and on-demand generation of **payslip** and **employee-letter** PDFs. Four collections, one rendering pipeline: adapt platform models → render-data → HTML template → headless-Chromium PDF → private Azure Blob → immutable row → short-lived download SAS.

Cross-references:
- [`user-management.md`](./user-management.md) — `internal_profile` (department, designation, date-of-joining, employee number) is the fallback source the render adapter reads before applying payroll-profile overrides.
- [`settings-notifications.md`](./settings-notifications.md) — `SystemSettings.payroll` holds the letterhead + signatory block shared by every template, edited through the normal `PATCH /settings`.
- [`audit-compliance.md`](./audit-compliance.md) — generation and deletion both write audit rows; preview does not.

> 🔴 **The frontend for this module exists but is unreachable through the UI.**
> Four routes, four pages, 18 React Query hooks and a settings section are all built and working — and `nav-config.ts` has **no Payroll entry**, with **no cross-link to `/admin/payroll*` anywhere in the frontend**. It is reachable only by typing the URL.
> See **§Suppressed surfaces** in [`viljetech-platform-frontend/CLAUDE.md`](../../../viljetech-platform-frontend/CLAUDE.md). This is a product decision, not an unfinished build; the open question about whether it ships or is deleted is tracked in [`06-ownership-and-accounts.md`](../../../docs/handover/06-ownership-and-accounts.md) §1.1.

> **Not built — Phase-2 deferred.**
> **No employee self-service.** There are no `/me` routes on any of the four routers. An employee cannot list or download their own payslips or letters; every read is an admin/manager act against another person's documents.
> **No bulk or batch generation.** Every payslip and letter is generated one person at a time by an explicit `POST`. There is no monthly payroll run, no "generate for all employees", and no scheduled job in `jobs/` for either.

---

## Scope

| Sub-module | Surface | Notes |
|---|---|---|
| **Payroll profiles** | `GET /payroll-profiles`, `GET\|PUT /payroll-profiles/:user_id` | One doc per user, unique on `user_id`; PUT is an upsert |
| **Salary structures** | `GET\|POST /salary-structures`, `GET /salary-structures/:id` | Append-only versions keyed by `effective_from`; no PATCH, no DELETE |
| **Payslips** | `POST`, `POST /preview`, `POST /preview-html`, `GET`, `GET /:id/download`, `DELETE /:id` | Immutable rows; preview persists nothing |
| **Letters** | same six shapes | Eight `type` values through one router |
| **PDF pipeline** | `services/payroll/` | Singleton headless Chromium; templates + render adapter |
| **Storage** | Private Azure Blob container | `blob_key` + `content_hash`; SAS minted per download |

Not in scope: payroll *calculation* beyond summing the structure's line items, statutory filing, and anything that reads these documents from an employee-facing surface.

---

## Roles & permissions

Route-level baseline on all four routers: `authenticate`, then a per-route `requirePermission`. There is **no per-row authorization anywhere in this module** — a caller holding the permission can act on any user's payroll data.

| Permission | Wire string | Held by | Gates |
|---|---|---|---|
| `PAYROLL_READ` | `payroll.read` | Admin, Manager | List/get profiles, list/get structures, list payslips, list letters |
| `PAYROLL_WRITE` | `payroll.write` | Admin, Manager | Upsert profile, create structure |
| `PAYSLIP_GENERATE` | `payslip.generate` | Admin, Manager | Generate **and** preview **and** download a payslip |
| `LETTER_GENERATE` | `letter.generate` | Admin, Manager | Generate **and** preview **and** download a letter |
| `PAYSLIP_DELETE` | `payslip.delete` | **Admin only** | `DELETE /payslips/:id` |
| `LETTER_DELETE` | `letter.delete` | **Admin only** | `DELETE /letters/:id` |

The first four are bundled into `manager` in `system-role-definitions.ts` (admin covers everything via the `system.admin` wildcard). **The two `*_DELETE` bits are in no role bundle at all** — only the wildcard grants them, which makes deletion admin-only by construction rather than by convention. Any custom role can be granted any of the six; they are ordinary `requirePermission` gates.

**Download is gated on `*_GENERATE`, not `PAYROLL_READ`.** Pulling a rendered PDF is treated as the sensitive act whether the bytes are fresh or a repeat fetch, so a read-only payroll reviewer holding `payroll.read` can see *that* a document exists in the list but cannot open it.

**Clients and representatives hold none of these.** The entire surface is invisible to the client-side roles.

---

## Data model

### `payroll_profiles` ([`payroll-profile.model.ts`](../../src/models/payroll-profile.model.ts))

One document per user — `user_id` is **unique**, which is what makes `PUT /payroll-profiles/:user_id` a safe upsert.

| Field | Type | Notes |
|---|---|---|
| `user_id` | ObjectId → users | **unique** |
| `pan` | string | Indian tax id. Default `''`, trimmed |
| `uan` | string | Universal Account Number (provident fund) |
| `pf_account_number` | string | Provident fund account |
| `esi_number` | string | Employees' State Insurance |
| `pran_number` | string | Permanent Retirement Account Number (NPS) |
| `bank_details` | string | Free text — account/IFSC as one blob, not structured |
| `location` | string | Work location printed on the payslip |
| `tax_regime` | string | Default **`'Regular Tax Regime'`** |
| `function_override` | string | See below |
| `designation_override` | string | See below |
| `date_of_joining_override` | string | See below |
| `updated_by` | ObjectId → users | **required** — who last wrote the profile |

**Indexes:** `{ user_id: 1 }` unique (inline). No others.

#### The three `*_override` fields

The render adapter sources employee identity from the **User record** (`internal_profile`), not from the payroll profile. The three override fields let an admin correct what appears on a generated document **without editing the user record**, which is the right split: the user record is the operational truth for the whole platform, while a document sometimes needs a different form of the same fact.

Resolution is a plain `||` fallback in [`render-adapter.service.ts`](../../src/services/payroll/render-adapter.service.ts) — an empty string means "no override":

| Override | Falls back to | Why it exists |
|---|---|---|
| `function_override` | `employee.department` | The department a person sits in is not always the function a letter should name |
| `designation_override` | `employee.designation` | Printed title may differ from the internal role title |
| `date_of_joining_override` | `internal_profile.date_of_joining` | Corrects a joining date on the document only |

`date_of_joining_override` has one extra behaviour worth knowing: `resolveDateOfJoining` runs it through the same `D-MMM-YYYY` formatting as the user-record value **when it parses as a date**, and if it is set but unparseable (free text) it is **used as-is rather than discarded**. So an override of `"On deputation from 2019"` prints literally.

#### PII

🔴 **This is the most sensitive collection in the platform.** PAN, UAN, PF, ESI, PRAN and bank details are, together, enough to identify and impersonate a person against Indian financial and statutory systems. Four consequences that are properties of the code, not policy suggestions:

- **No field-level redaction exists.** `toPublic` returns the whole document. Any caller holding `payroll.read` — which includes every Manager — reads every statutory number for every employee.
- **The list endpoint returns full documents.** `GET /payroll-profiles` paginates but does not project; a single call returns complete PII for a page of employees.
- **`render_snapshot` copies it forward.** Generated payslips freeze the resolved render data, so PII is duplicated into every `payslips` row and every stored PDF.
- **GDPR erasure covers `users`, not this collection.** Check `user-gdpr.service.ts` before assuming an erased user leaves no payroll trace.

### `salary_structures` ([`salary-structure.model.ts`](../../src/models/salary-structure.model.ts))

Per-user **versioned** structure. Each row is an immutable snapshot valid from `effective_from` onward.

| Field | Type | Notes |
|---|---|---|
| `user_id` | ObjectId → users | |
| `effective_from` | string | `YYYY-MM-DD`, schema-validated by regex |
| `earnings` | `[{label, amount}]` | Sub-documents, `_id: false` |
| `deductions` | `[{label, amount}]` | Same shape |
| `is_current` | boolean | **Denormalised convenience flag — see below** |
| `created_by` | ObjectId → users | |

**Indexes:**
- `{ user_id: 1, effective_from: -1 }` — the newest-first lookup path used by `listStructures` and `getCurrentStructure`
- `{ user_id: 1, effective_from: 1 }` — **unique**, named `salary_user_effective_unique`

#### Append-only versioning

There is **no PATCH and no DELETE** on this router. Correcting a mistake means creating a new version with a later `effective_from`; the wrong row stays, because a payslip generated from it is already in circulation and the snapshot must remain explicable.

`createStructure` runs inside `withTransaction`:

1. Assert the user exists (404 `USER_NOT_FOUND`).
2. Load the current newest row for that user.
3. Compute `isLatest = !latest || input.effective_from >= latest.effective_from` — **ties go to the new row**, since it is the one being written now.
4. If `isLatest`, clear `is_current` on every existing row for that user.
5. Insert with `is_current: isLatest`.

A **back-dated** insert therefore lands with `is_current: false` and leaves the existing latest row untouched — it is still the newest, so it stays current.

#### 🔴 Do not read `is_current` to answer "what applies on date X"

`is_current` answers exactly one question: *which row has the greatest `effective_from` for this user*. It is a denormalisation so list and detail screens can render a "current" badge without a second query.

It is **wrong** for any date-based question, and back-dated inserts are exactly where it misleads. Consider structures effective `2026-01-01` and `2026-06-01`, then a back-dated `2026-03-01` inserted later: the March row is correct for a March payslip and carries `is_current: false`, while the June row carries `is_current: true` and is wrong for March.

The authoritative accessor is **`getCurrentStructure(userId, onOrBefore = today IST)`**, which re-derives directly:

```
SalaryStructure.findOne({ user_id, effective_from: { $lte: onOrBefore } })
  .sort({ effective_from: -1 })
```

No match throws **422 `PAYROLL_NO_CURRENT_SALARY`**. Payslip generation, letter generation and payroll calculation all read through it. **Its signature is depended on downstream — do not change it.**

#### The unique index and its 409

`{ user_id, effective_from }` unique exists as defence in depth against a parallel-create race: two admins posting the same `effective_from` for the same user both pass the in-process check before either writes. The index turns the loser into a deterministic `E11000`, which `createStructure` catches and maps to **409 `DUPLICATE_RESOURCE`** with `{user_id, effective_from}` in `details` — instead of a silent duplicate version row that would make "what applies on date X" ambiguous.

### `payslips` ([`payslip.model.ts`](../../src/models/payslip.model.ts))

| Field | Type | Notes |
|---|---|---|
| `user_id` | ObjectId → users | required |
| `pay_period` | string | trimmed; free-form (e.g. `2026-07`) |
| `days_present` | number | min 0; supplied by the caller, not derived from attendance |
| `net_pay` | number | computed by `payslipNetPayFromData` at generation |
| `render_snapshot` | Mixed | **required** — see below |
| `blob_key` | string | pointer into the private container |
| `content_hash` | string | SHA-256 of the PDF bytes |
| `generated_by` | ObjectId → users | |

**Indexes:** `{ user_id: 1, pay_period: 1 }` — **not unique**, which is what permits repeat generation for the same period.

### `letters` ([`letter.model.ts`](../../src/models/letter.model.ts))

| Field | Type | Notes |
|---|---|---|
| `user_id` | ObjectId → users | **optional** — see the eight types below |
| `type` | enum | one of eight |
| `reference` | string | optional free-text reference |
| `render_snapshot` | Mixed | required |
| `blob_key`, `content_hash`, `generated_by` | | as payslips |

**Indexes:** `{ user_id: 1, type: 1, created_at: -1 }`.

---

## Immutability, regeneration, and `render_snapshot`

Payslip and letter rows are **append-only**. Neither router has a PATCH. Re-running generation inserts a **new row**; it never edits an existing one.

**Regeneration does not always produce a fresh `blob_key`.** The key embeds a content hash:

```
payslips/{user_id}/{pay_period}/{first 12 hex of sha256(pdf)}.pdf
letters/{user_id | 'unlinked'}/{type}/{first 12 hex of sha256(pdf)}.pdf
```

So regenerating with **identical inputs** produces byte-identical output, the same hash, the same key — a new DB row pointing at the same blob, which Azure de-dupes. Regenerating after **any** change to the underlying data produces different bytes, a different hash, and therefore a genuinely new blob. Both cases leave the earlier row intact and downloadable.

**`render_snapshot` freezes the exact render-data payload** — the resolved employee identity, the salary line items, the letterhead, everything the template consumed. It exists so a later audit or dispute can be resolved **without re-deriving payroll state that has since changed**: salary structures get new versions, users get renamed, settings get edited, and none of that may retroactively alter what a document said when it was issued. It is also what `downloadPayslip` reads to reconstruct the filename, which is why a row with a corrupt snapshot still downloads (the name degrades, the bytes do not).

The snapshot's shape differs by document: `LetterRenderData` for the five employee letter types, `OfferLetterRenderData` for `offer` and `joining`, and the internship-offer shape for `internship_offer`.

---

## The eight letter types

`LETTER_TYPES` in [`letter.model.ts`](../../src/models/letter.model.ts):

| Type | Template | `user_id` | Issued |
|---|---|---|---|
| `offer` | `offer-letter-template.ts` | **required** | Before joining |
| `joining` | `offer-letter-template.ts` | **optional** | On appointment |
| `internship_offer` | `internship-offer-letter-template.ts` | **optional** | **Start of an internship** |
| `relieving` | `letter-template.ts` | required | On exit |
| `experience` | `letter-template.ts` | required | On exit |
| `internship` | `letter-template.ts` | required | **End of an internship** |
| `hike` | `letter-template.ts` | required | On compensation change |
| `promotion` | `letter-template.ts` | required | On role change |

> 🔴 **`internship_offer` and `internship` are two different documents. Do not collapse them.**
> **`internship_offer`** is issued at the **start**: position, fixed window, work mode, paid/unpaid, responsibilities, terms. It has its own template.
> **`internship`** renders an **Internship Experience Letter**, issued at the **end**, and shares the generic employee-letter template with `relieving` / `experience` / `hike` / `promotion`.
> The names read as variants of one thing and are opposite ends of an engagement.

**Two types may name their subject manually.** `MANUAL_NAME_TYPES = ['joining', 'internship_offer']` in the validator's `superRefine`: each accepts either a `user_id` **or** a `candidate_name`, and requires at least one. The reason is stated in the validator — an intern or a new appointee is typically not a platform user yet, and requiring one would mean onboarding every applicant before you could offer them anything. Every other type requires `user_id`.

When a letter is generated without a `user_id`, `blob_key` uses the literal segment `unlinked`, and `letters.user_id` is absent.

**`offer` requires `candidate_name` even though it also requires `user_id`.** The validator enforces per-type required fields separately, because the flat schema makes every type-specific field optional — without the refine, `{ type: 'offer', user_id }` would validate and silently generate a blank "Dear Candidate" PDF with an empty CTC table, since every offer field falls back to `''`/`[]`.

**All three letter entry points share `resolveRender`** — generate, preview, and preview-html. They each used to carry their own copy of the per-type if/else, so a new type could be wired into two of them and render the **wrong template** in the live preview.

---

## Endpoints

18 routes across four routers. Every one is `authenticate` + a single `requirePermission`; none has per-row authorization.

### Payroll profiles ([`routes/payroll-profile.routes.ts`](../../src/routes/payroll-profile.routes.ts))

| Method | Path | Permission | Side effects |
|---|---|---|---|
| `GET` | `/payroll-profiles` | `payroll.read` | None. Paginated, sorted `updated_at: -1`. **Returns full PII per row** |
| `GET` | `/payroll-profiles/:user_id` | `payroll.read` | None. 404 `PAYROLL_PROFILE_NOT_FOUND` |
| `PUT` | `/payroll-profiles/:user_id` | `payroll.write` | **Upsert** (`findOneAndUpdate` + `upsert: true`). 404 `USER_NOT_FOUND` if the user does not exist. Audits `payroll_profile.upsert` with the full `after` |

### Salary structures ([`routes/salary-structure.routes.ts`](../../src/routes/salary-structure.routes.ts))

| Method | Path | Permission | Side effects |
|---|---|---|---|
| `GET` | `/salary-structures?user_id=` | `payroll.read` | None. All versions for one user, newest first. Not paginated |
| `POST` | `/salary-structures` | `payroll.write` | **Transactional.** May flip `is_current: false` on every other row for that user. Audits `salary_structure.create`. 404 `USER_NOT_FOUND`, 409 `DUPLICATE_RESOURCE` |
| `GET` | `/salary-structures/:id` | `payroll.read` | None. 404 `SALARY_STRUCTURE_NOT_FOUND` |

No PATCH and no DELETE — append-only by construction.

### Payslips ([`routes/payslip.routes.ts`](../../src/routes/payslip.routes.ts))

| Method | Path | Permission | Side effects |
|---|---|---|---|
| `POST` | `/payslips` | `payslip.generate` | **Renders PDF, writes a blob, inserts a row, audits `payslip.generate`, returns a 10-minute SAS.** Throws 422 `PAYROLL_NO_CURRENT_SALARY` if the user has no structure on `effective_on` |
| `POST` | `/payslips/preview` | `payslip.generate` | **Renders the identical PDF and persists nothing** — no blob, no row, no audit. Returns base64 |
| `POST` | `/payslips/preview-html` | `payslip.generate` | Returns the HTML only. **No Chromium launch** — the cheapest path, used by the live on-page editor |
| `GET` | `/payslips` | `payroll.read` | None. Paginated; filters `user_id`, `pay_period` |
| `GET` | `/payslips/:id/download` | `payslip.generate` | **Mints a fresh 10-minute SAS** against the stored `blob_key`. Does not re-render. 404 `PAYSLIP_NOT_FOUND` |
| `DELETE` | `/payslips/:id` | `payslip.delete` | **Deletes the blob, then the row**, then audits `payslip.delete`. Not reversible |

### Letters ([`routes/letter.routes.ts`](../../src/routes/letter.routes.ts))

Identical six shapes: `POST /letters`, `POST /letters/preview`, `POST /letters/preview-html`, `GET /letters`, `GET /letters/:id/download`, `DELETE /letters/:id`. Gates are `letter.generate` (generate/preview/download), `payroll.read` (list), `letter.delete` (delete). Side effects mirror payslips, with `letter.generate` / `letter.delete` audit actions and 404 `LETTER_NOT_FOUND`.

Note the router ordering: both `/preview` routes are registered **before** `/:id/download`, so a future param route cannot shadow the literal segments.

---

## PDF rendering ([`services/payroll/pdf.service.ts`](../../src/services/payroll/pdf.service.ts))

The whole file is ~50 lines and every line is load-bearing.

**Singleton browser.** `chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] })` is cached in a module-level `browserPromise`. Launching Chromium costs hundreds of milliseconds; a per-request launch would dominate generation time. Every render opens a fresh `page` and closes it in a `finally`, so pages never leak even when `setContent` throws.

**The `disconnected` listener.** `browser.on('disconnected', () => { browserPromise = null })`. If the browser dies or is killed, the cached promise would otherwise resolve forever to a dead handle and **every subsequent render would fail permanently** until the process restarted. Dropping the singleton makes the next render relaunch. This is what makes a Chromium crash a one-request failure instead of an outage.

**A failed launch is never cached.** The `.catch` resets `browserPromise = null` and rethrows. So a missing browser binary fails *this* request and the next one retries — installing the binary fixes it **without a restart**. That matters locally, where `npx playwright install chromium` is a separate step (see [`02-local-setup.md`](../../../docs/handover/02-local-setup.md) §1).

**`shutdownPdf()` in graceful shutdown.** Wired into `index.ts` as step 2 of the SIGTERM/SIGINT sequence, between `server.close()` and `stopScheduler()`, wrapped in its own try/catch that logs rather than aborting the rest of the shutdown. Without it Chromium lingers as an orphaned child process after Node exits — on a container that restarts often, that leaks processes until the host runs out.

**Page settings.** `waitUntil: 'networkidle'` so fonts and images resolve before rasterising. `format: 'A4'`, `printBackground: true`, and **zero PDF margin** — margins are owned by each template's `@page` rule, and setting both would double-pad.

### 🔴 `copy-payroll-assets.mjs` — the build step whose absence is silent

```
"build": "tsc && node scripts/copy-payroll-assets.mjs"
```

`tsc` compiles `.ts` → `.js` and **does not copy non-TS files**. The templates read the logo SVG, the signature and stamp PNGs, and the Kalice `woff2` fonts from `src/assets/payroll/**` at runtime, via a path relative to `dist/`. The post-step mirrors `src/assets` → `dist/assets`.

**Skip it and a production build silently renders those images blank.** The PDF generates, the request returns 200, the file downloads, and the letterhead, signature and stamp are simply missing. There is no error to grep for — the only detection is looking at a generated document from a production build. See [`03-invariants.md`](../../../docs/handover/03-invariants.md) §10.

The script no-ops cleanly when `src/assets` is absent, so it is safe in any tree.

### Templates and the render adapter

| File | Renders |
|---|---|
| [`payslip-template.ts`](../../src/services/payroll/payslip-template.ts) | Payslips; also exports `payslipNetPayFromData` |
| [`letter-template.ts`](../../src/services/payroll/letter-template.ts) | The five generic employee letter types |
| [`offer-letter-template.ts`](../../src/services/payroll/offer-letter-template.ts) | `offer` and `joining` |
| [`internship-offer-letter-template.ts`](../../src/services/payroll/internship-offer-letter-template.ts) | `internship_offer` |
| [`render-adapter.service.ts`](../../src/services/payroll/render-adapter.service.ts) | Platform models → render data. **Pure read/transform** — no HTTP concerns, no audit rows; the generation services own the audit trail |

---

## Storage

PDF bytes live in a **private** Azure Blob container, [`AZURE_BLOB_PAYROLL_DOCUMENTS_CONTAINER`](../../src/config/server.config.ts) — env-overridable, defaulting to `payroll-documents`.

- **`blob_key` is the only pointer.** Shape given above; the content-hash segment means identical renders collapse onto one blob.
- **`content_hash`** (SHA-256 of the PDF bytes) is a tamper-evidence check: recompute it against the fetched blob to prove the bytes are the ones that were issued.
- **No permanent public URL is ever stored or returned.** Every download mints a fresh SAS with `mintDownloadSas`, TTL **10 minutes** (`DOWNLOAD_TTL_MIN`), carrying an RFC 5987 `filename*` so the browser saves a human-readable name (`Payslip_{Name}_{period}.pdf`). Generation returns one immediately as `download_url`; `GET /:id/download` mints another later. The row is never re-rendered.
- **Azure is required for this module.** Unlike report exports, there is **no inline fallback** — with Azure unconfigured, `putBlob` throws `AzureNotConfiguredError` and generation fails. Preview and preview-html still work, since neither touches storage.

---

## `SystemSettings.payroll`

The letterhead and signatory block shared by every template, on the settings singleton ([`system-settings.model.ts`](../../src/models/system-settings.model.ts)):

| Field | Default |
|---|---|
| `company_legal_name` | `'M/S VILJA TECH LABS PRIVATE LIMITED'` |
| `company_address_lines` | `[]` |
| `company_email` | `''` |
| `cin_no` | `''` |
| `iec_code` | `''` |
| `signatory_name` | `''` |
| `signatory_title` | `'Human Resources'` |
| `hr_reply_to_address` | `''` |
| `hr_reply_to_name` | `''` |

Edited through the normal `PATCH /settings` body gated on `SETTINGS_WRITE` — **there is no separate payroll-settings route**. Every field defaults to `''` or a safe value, so the subsection is savable field-by-field from day one; the cost is that a document generated before the block is filled in prints with blank signatory and address lines rather than failing.

---

## Audit actions

| Action | Written by | Target kind |
|---|---|---|
| `payroll_profile.upsert` | `PUT /payroll-profiles/:user_id` | `payroll_profile` |
| `salary_structure.create` | `POST /salary-structures` | `salary_structure` |
| `payslip.generate` | `POST /payslips` — metadata `{user_id, pay_period, net_pay}` | `payslip` |
| `letter.generate` | `POST /letters` — metadata `{user_id, type}` | `letter` |
| `payslip.delete` | `DELETE /payslips/:id` | `payslip` |
| `letter.delete` | `DELETE /letters/:id` | `letter` |

`salary_structure.update` exists in `AUDIT_ACTIONS` but **no route writes it** — there is no update path. Neither preview route audits anything, by design.

---

## Error codes

| Code | Status | Raised by |
|---|---|---|
| `PAYROLL_PROFILE_NOT_FOUND` | 404 | `GET /payroll-profiles/:user_id` |
| `SALARY_STRUCTURE_NOT_FOUND` | 404 | `GET /salary-structures/:id` |
| `PAYSLIP_NOT_FOUND` | 404 | payslip download / delete |
| `LETTER_NOT_FOUND` | 404 | letter download / delete |
| `PAYROLL_NO_CURRENT_SALARY` | 422 | `getCurrentStructure` — no structure on or before the date |
| `USER_NOT_FOUND` | 404 | profile upsert, structure create |
| `DUPLICATE_RESOURCE` | 409 | structure create — the `(user_id, effective_from)` unique index |

---

## End-to-end flows

### Admin generates a payslip for July

1. `POST /payslips {user_id, pay_period: '2026-07', days_present, effective_on}`.
2. `buildPayslipRenderData` loads the user, the payroll profile, `SystemSettings.payroll`, and calls `getCurrentStructure(user_id, effective_on)` — 422 `PAYROLL_NO_CURRENT_SALARY` if there is none.
3. Overrides resolve over the user record; the letterhead comes from settings.
4. `renderPayslipHtmlFromData` → `htmlToPdf` (singleton Chromium) → Buffer.
5. `net_pay` from `payslipNetPayFromData`; `content_hash` = SHA-256 of the bytes.
6. `putBlob` to the private container at the hash-derived key.
7. `Payslip.create` with the full `render_snapshot`.
8. Audit `payslip.generate`.
9. Respond with the row plus a 10-minute `download_url`.

### The same payslip is generated again, unchanged

Steps 1–5 reproduce byte-identical output, so `content_hash` and therefore `blob_key` are the same. `putBlob` overwrites the same blob with identical bytes; **a second `Payslip` row is inserted**. Both rows are listed, both download the same PDF. The list is a record of generation *acts*, not of distinct documents.

### A salary structure is back-dated after a payslip was issued

The new row lands with `is_current: false` and does not disturb the existing latest row. **Already-issued payslips are unaffected** — their `render_snapshot` froze the numbers used. A payslip regenerated for a period the back-dated row now covers will pick it up through `getCurrentStructure` and produce different bytes, a different hash, a new blob, and a new row alongside the old one.

### Admin previews a letter before issuing it

`POST /letters/preview-html` returns HTML with no Chromium launch — instant, for the on-page editor. `POST /letters/preview` renders the real PDF and returns base64. Neither writes a blob, a row, or an audit entry. Only `POST /letters` commits.

### An offer letter for someone who is not a user yet

`POST /letters {type: 'internship_offer', candidate_name: 'X', ...}` with no `user_id`. The validator's `MANUAL_NAME_TYPES` branch accepts it. `blob_key` uses the `unlinked` segment and `letters.user_id` is absent, so the row cannot be found by user and will not appear in a per-user filter — it is reachable only through the unfiltered list.

---

## Gotchas

| # | Gotcha | Why |
|---|---|---|
| 1 | `is_current` must not answer "what applies on date X" | It marks the max `effective_from`, which is wrong after a back-dated insert. Use `getCurrentStructure` |
| 2 | `getCurrentStructure`'s signature is depended on by payslip, letter and payroll-calc paths | Changing it breaks three call sites that have no shared test |
| 3 | Regeneration does **not** always mint a new `blob_key` | The key embeds the content hash; identical inputs collapse onto one blob. A new **row** is always inserted |
| 4 | `days_present` is caller-supplied, not derived from attendance | Nothing cross-checks it against `attendance_records` |
| 5 | Download is gated on `*_GENERATE`, not `payroll.read` | A read-only reviewer can list documents but not open them |
| 6 | `*_DELETE` permissions are in no role bundle | Only `system.admin` grants them. Adding them to a custom role makes deletion available to that role |
| 7 | Deleting a payslip/letter deletes the blob too | Not reversible; the audit row is the only surviving trace |
| 8 | Missing `copy-payroll-assets` renders blank images with no error | See §PDF rendering |
| 9 | Azure is mandatory here — no inline fallback | Generation fails without it; preview still works |
| 10 | `GET /payroll-profiles` returns unredacted PII for a page of employees | No projection, no field-level redaction anywhere in the module |
| 11 | `internship_offer` ≠ `internship` | Start vs end of an internship; different templates |
| 12 | All three letter entry points must keep sharing `resolveRender` | They each used to carry a copy of the per-type if/else, so a new type could render the wrong template in preview only |
| 13 | `salary_structure.update` is a defined audit action with no writer | There is no update path; do not assume one exists |
| 14 | No `/me` routes, no bulk generation | Both Phase-2 deferred — see the note at the top |
