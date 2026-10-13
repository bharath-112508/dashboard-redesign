# Invoicing, Engagements & Cost Rates — Backend

The money path: a client **engagement** (the contract), the numbered **invoices**
generated from it, the per-person **cost rates** that sit opposite the bill rates, and
the **margin report** that nets the two.

Written against the source, not against `CLAUDE.md` — several behaviours below differ
from the quick-reference summary, and those differences are called out where they
matter.

> **Read [`timesheets-billing.md`](timesheets-billing.md) first if you are new to this
> area.** Invoices do not compute their own hours: they reuse the billing report's
> aggregation, so `billing_rates` and `timesheet_entries` semantics are prerequisites.

---

## Scope

| In | Out |
|---|---|
| Engagement CRUD + soft-end | Payment collection / gateway — none exists |
| Invoice generation from timesheets | Dunning, reminders, statements |
| Draft editing, status lifecycle, PDF | Emailing an invoice to a client |
| Per-user cost rates, effective-dated | Per-project cost dimension — cost rates are per-user only |
| Margin report + FX normalisation | Multi-currency payment, FX rate feeds (rates are hand-entered) |

Two phases shipped: **Phase 1** engagements + invoices
(`docs/superpowers/specs/2026-07-24-billing-invoicing-design.md`), **Phase 2** cost
rates + margin (`…-cost-margin-design.md`).

This closed a real gap. Billing *rates* and a billing *report* existed, but nothing
persisted a numbered bill — the report was recomputed on every read and never frozen.
An invoice is the durable snapshot.

---

## Roles & permissions

| Permission | Constant | Default holder |
|---|---|---|
| `invoice.read` | `INVOICE_READ` | Manager bundle |
| `invoice.write` | `INVOICE_WRITE` | **Admin only** — not in `MANAGER_ADDITIONS` |
| `cost_rate.read` | `COST_RATE_READ` | Manager bundle |
| `cost_rate.write` | `COST_RATE_WRITE` | **Admin only** |

`invoice.read`/`write` gate **both** engagements and invoices — there is no separate
engagement permission. A Manager can therefore read every engagement and invoice but
create none.

All four are ordinary `requirePermission` route gates with **no per-row scoping** —
each router says so in its header comment. Unlike projects, there is no
`loadXForCaller` equivalent: **anyone holding `invoice.read` sees every company's
invoices.** That is deliberate for an internal finance tool, but it means granting
`invoice.read` to a custom role grants the whole book.

🔴 **`GET /reports/margin` is gated on `cost_rate.read`, not `report.read`.** It is
registered in `report.routes.ts` *before* the blanket
`router.use(requirePermission(REPORT_READ))`, because margin exposes internal cost —
more sensitive than the other reports. A custom role with `cost_rate.read` and no
`report.read` still reaches it. Manager holds both, so this is invisible with stock
roles and surprising with custom ones.

---

## Data model

### `engagements` ([`engagement.model.ts`](../../src/models/engagement.model.ts))

The contract. One per commercial arrangement, scoped to a company.

| Field | Type | Notes |
|---|---|---|
| `company_id` | ObjectId → `companies` | required |
| `project_ids[]` | ObjectId[] → `projects` | **`[]` means ALL of the company's projects**, resolved at generation time — not a scope-less engagement |
| `name` | string | required |
| `currency` | string | ISO 4217, uppercased, exactly 3 chars |
| `billing_type` | enum | `hourly` \| `retainer` \| `fixed` \| `hybrid` |
| `setup_fee` / `setup_fee_invoiced` | number\|null / boolean | one-time fee + its bill-once latch |
| `retainer_amount` / `retainer_period` / `included_hours` | number\|null / enum\|null / number\|null | retainer component |
| `fixed_amount` | number\|null | flat fee component |
| `start_date` / `end_date` | `YYYY-MM-DD` / nullable | `end_date: null` = open |
| `status` | enum | default `active` |
| `notes`, `created_by` | string, ObjectId | |

**Index:** `{company_id: 1, status: 1}`.

🔴 **`billing_type` is weaker than it looks.** Line building keys off which *amount
fields are set*, not off `billing_type` — see the algorithm below. An engagement typed
`fixed` with a `retainer_amount` set will produce a retainer line.

### `invoices` ([`invoice.model.ts`](../../src/models/invoice.model.ts))

| Field | Type | Notes |
|---|---|---|
| `number` | string, **unique** | `{PREFIX}-{YYYY}-{NNNN}` |
| `company_id` / `project_ids[]` / `currency` | | 🔴 **snapshots** taken at generation — later edits to the engagement, company, or project never mutate an issued invoice |
| `engagement_id` | ObjectId → `engagements` | live reference |
| `period_start` / `period_end` | `YYYY-MM-DD` | |
| `line_items[]` | subdocument array | `kind`, `description`, `user_id`, `quantity_minutes`, `rate`, `amount` |
| `subtotal` / `tax_rate` / `tax_label` / `tax_amount` / `total` | numbers + string | `tax_amount = round2(subtotal × tax_rate / 100)`; `total = subtotal + tax_amount` |
| `status` | enum | `draft` \| `sent` \| `paid` \| `void` |
| `issue_date` / `due_date` / `paid_date` | `YYYY-MM-DD` \| null | issue/paid set automatically on transition |
| `notes`, `created_by` | | |

**Line kinds:** `hours` · `retainer` · `setup` · `overage` · `fixed` · `manual`.
`manual` is the free-form escape hatch; **a negative `amount` is how a discount is
expressed** — there is no discount field.

**Indexes:** `{company_id: 1, status: 1}`, plus the field-level unique on `number`.

### `invoice_counters` ([`invoice-counter.model.ts`](../../src/models/invoice-counter.model.ts))

One row per calendar year: `{year (unique), seq}`. Sole purpose is the numbering
sequence.

### `cost_rates` ([`cost-rate.model.ts`](../../src/models/cost-rate.model.ts))

The cost-side twin of `billing_rates` — but **per `user_id` only**, with no project or
task dimension.

| Field | Type | Notes |
|---|---|---|
| `user_id` | ObjectId → `users` | |
| `cost_per_hour` | number, min 0 | fully-loaded cost |
| `currency` | string | ISO 4217 — **may differ from the engagement's** |
| `effective_from` / `effective_to` | `YYYY-MM-DD` / nullable | both **inclusive**; `null` = current |

**Indexes:** `{user_id: 1, effective_from: -1}` for lookup, and a **unique**
`{user_id, effective_from}` (`cost_rates_user_effective_from_unique`) that turns a
parallel-create race into `E11000` → `409 DUPLICATE_RESOURCE`.

---

## The generation algorithm

[`invoice.service.ts`](../../src/services/invoice.service.ts) → `generateInvoice`. The
whole thing runs inside `withTransaction`.

**1 — Resolve project scope.** `engagement.project_ids`, or if empty, every project
with the engagement's `company_id`, resolved *now*. An engagement scoped to `[]`
therefore picks up projects created after it.

**2 — Overlap guard.** Looks for a **non-void** invoice on the same engagement whose
period overlaps. If found and `confirm` is not set, throws `409
INVOICE_PERIOD_OVERLAP` with the existing invoice's id.

> The quick-reference calls this a warning. It is not — the first attempt **fails**,
> and the caller must resend with `confirm: true`. The FE surfaces a confirmation
> dialog, which is where the "warning" description comes from.

The guard is **deliberately best-effort and non-transactional**, and the source says
why: a unique `(engagement_id, period)` index would break the legitimate *void an
invoice, regenerate the same period* flow. Two truly concurrent generates can both
succeed.

**3 — Build lines by component.** This is the part that does not follow
`billing_type`:

| Component | Fires when | Produces |
|---|---|---|
| Retainer | `retainer_amount != null` | one `retainer` line |
| Overage | retainer set **and** `included_hours != null` **and** actual > included | one `overage` line |
| Setup | `setup_fee > 0` **and** `setup_fee_invoiced === false` | one `setup` line, then latches the flag |
| Hourly | `billing_type` is `hourly`/`hybrid` **and `retainer_amount == null`** | one `hours` line **per user** |
| Fixed | `fixed_amount != null` | one `fixed` line |

🔴 **Hours are billed either as hourly lines or as overage, never both.** The hourly
block is explicitly suppressed when a retainer exists, because those hours are already
covered by the retainer plus any overage. A `hybrid` engagement *with* a retainer
produces no per-user `hours` lines at all.

🔴 **Overage uses a blended rate**, not each user's rate:
`blended = total_value ÷ total_hours` across everyone in the window, then
`amount = excess_hours × blended`. With one contributor that equals their rate; with
several it does not equal any individual's. This is invisible on the invoice, which
shows one `overage` line with the blended figure as `rate`.

**Hours themselves** come from `sumBillableByUser` + `resolveUserRates`, which reuse
the billing report's `$match` — `entry_type: 'task_linked'`, summing
`billable_total_minutes` over the engagement's projects in the window, grouped by
user, × the project-level `BillingRate` effective at the window end. **A missing rate
does not fail generation**: the line is still emitted with `rate: null, amount: 0`,
mirroring the billing report's degradation, so the gap is visible rather than silent.

**4 — Totals.** `tax_rate` is **0 on generate** and `tax_label` is `'No tax'` — tax is
applied by editing the draft, never at generation.

**5 — Number and persist as draft.**

```
{prefix}-{year}-{seq}      e.g.  INV-2026-0001
```

- **`prefix`** comes from `SystemSettings.billing.invoice_prefix`, defaulting to
  `'INV'`. It is **admin-configurable**, not hardcoded.
- **`year`** is `yearOf(period_end)` — **the period's year, not today's.** Generating a
  December-2025 invoice in January 2026 numbers it `2025`.
- **`seq`** from `nextInvoiceNumber`: `findOneAndUpdate({year}, {$inc: {seq: 1}},
  {upsert: true, new: true})`, zero-padded to 4. Same race-safe pattern as
  `projects.task_seq`. Numbers are **not** gap-free — a failed transaction after the
  increment burns a number.

### 🔴 The setup-fee race, and where it is still open

Billing the setup fee once is a check-then-write, and two concurrent `generateInvoice`
calls could both read `setup_fee_invoiced: false` and both bill it. The fix re-reads
the engagement **with the transaction's session** so the check and the flip land in
one transaction.

That fix only works when there **is** a session. The code falls back to the
already-loaded document when there is not — and `withTransaction` runs session-less on
a standalone `mongod` (see [`03-invariants.md`](../../../docs/handover/03-invariants.md)
§5 and [`cross-cutting.md`](cross-cutting.md)).

**So on a standalone local MongoDB the setup fee can still be double-billed.** The
source comment is explicit that this preserves pre-existing behaviour rather than
being an oversight. It is a good illustration of why the standalone fallback matters:
the guard reads as airtight and is not, on the topology most developers run locally.

---

## Invoice lifecycle

Two orthogonal rules. People conflate them, and they answer different questions.

### Status transitions — `POST /invoices/:id/status`

```
  draft ──► sent ──► paid
    │        │        │
    └────────┴────────┴──► void   (terminal)
```

`isLegalTransition` in three lines:

| To | Legal from | Side effect |
|---|---|---|
| `sent` | `draft` **only** | sets `issue_date` to today (IST) if unset |
| `paid` | `sent` **only** | sets `paid_date` (from the body, or today) |
| `void` | any non-`void` | — |

`draft → paid` is **illegal** — issue it first. **`void` is terminal**: nothing leaves
it. Anything else throws `409 INVOICE_INVALID_TRANSITION` with `{from, to}` in
`details`.

### The edit freeze — `PATCH /invoices/:id`

Independent of the above: **editing is frozen the moment status leaves `draft`.** A
draft is fully editable — line items (including free-form `manual` lines), `tax_rate`,
`tax_label`, `due_date`, `notes`. Anything past draft throws `409
INVOICE_NOT_DRAFT`.

`DELETE /invoices/:id` carries the same guard: **drafts only.** A `sent` or `paid`
invoice is voided, never deleted — that is what makes the collection an audit-grade
record.

---

## Endpoints

17 across three routers, all `authenticate` + a single `requirePermission`.

### Engagements ([`engagement.routes.ts`](../../src/routes/engagement.routes.ts))

| Method | Path | Permission |
|---|---|---|
| `GET` | `/engagements` | `invoice.read` |
| `GET` | `/engagements/:id` | `invoice.read` |
| `POST` | `/engagements` | `invoice.write` |
| `PATCH` | `/engagements/:id` | `invoice.write` |
| `POST` | `/engagements/:id/end` | `invoice.write` |

🔴 **There is no DELETE, and no delete service function.** `end` (soft-end) is the only
retirement path, so an invoice can never be orphaned from its engagement *by
construction* rather than by a guard someone could forget.

### Invoices ([`invoice.routes.ts`](../../src/routes/invoice.routes.ts))

| Method | Path | Permission |
|---|---|---|
| `GET` | `/invoices` | `invoice.read` |
| `POST` | `/invoices/generate` | `invoice.write` |
| `GET` | `/invoices/:id` | `invoice.read` |
| `GET` | `/invoices/:id/pdf` | `invoice.read` |
| `PATCH` | `/invoices/:id` | `invoice.write` (draft only) |
| `POST` | `/invoices/:id/status` | `invoice.write` |
| `DELETE` | `/invoices/:id` | `invoice.write` (draft only) |

### Cost rates ([`cost-rate.routes.ts`](../../src/routes/cost-rate.routes.ts))

| Method | Path | Permission |
|---|---|---|
| `GET` | `/cost-rates` | `cost_rate.read` |
| `POST` | `/cost-rates` | `cost_rate.write` |
| `PATCH` | `/cost-rates/:id` | `cost_rate.write` |
| `POST` | `/cost-rates/:id/end` | `cost_rate.write` |
| `DELETE` | `/cost-rates/:id` | `cost_rate.write` |

Plus `GET /reports/margin` on [`report.routes.ts`](../../src/routes/report.routes.ts),
gated on `cost_rate.read` (see the permissions note above).

---

## The invoice PDF

[`invoice-pdf.service.ts`](../../src/services/invoice-pdf.service.ts) →
`renderInvoicePdf`, HTML built by
[`invoice-pdf-template.ts`](../../src/services/invoice-pdf-template.ts) (a pure
string builder, unit-testable without Chromium), rendered by the same singleton
Chromium as payroll.

🔴 **Nothing is stored.** Unlike payslips and letters, the invoice PDF is rendered on
demand and streamed straight back — **no blob, no `blob_key`, no `content_hash`, no
row, and no audit entry.** Two consequences:

- The invoice *record* is the durable artifact; the PDF is a view of it. Re-rendering
  after a draft edit produces a different document under the same number.
- **Downloading an invoice leaves no trace.** Payslip and letter downloads are audited;
  this is not.

The response bypasses the `ok()` envelope — raw `Buffer` via `res.end`, with explicit
`Content-Type: application/pdf`, RFC 5987/6266 `Content-Disposition`, and
`Content-Length`. CR/LF/quote characters are stripped from the filename (header
injection).

Chromium must be installed or this 500s — same failure as payroll, and the same
Azure caveat applies (see [`payroll.md`](payroll.md) → PDF rendering).

---

## Margin report & FX

[`margin.service.ts`](../../src/services/margin.service.ts) → `buildMarginReport`. Per
project × user:

```
revenue = billable_hours × bill_rate      (engagement currency)
cost    = billable_hours × cost_rate      (cost rate's own currency)
                ↓ both normalised via FX ↓
margin     = revenue − cost
margin_pct = margin / revenue             bare ratio, NOT ×100; null when revenue is 0
```

**It reuses `sumBillableByUser` and `resolveUserRates` from `invoice.service.ts`** —
the same `$match` and rate resolution as invoices and the billing report. One money
path, three consumers; changing that aggregation changes all three.

**FX** — `SystemSettings.billing.reporting_currency` (default `INR`) plus
`billing.fx_rates[]` of `{currency, rate_to_base}`, read as *1 unit of `currency` =
`rate_to_base` reporting-currency units*. Hand-maintained via `PATCH /settings`; there
is no rate feed, so **stale rates silently misstate margin**.
[`utils/fx.ts`](../../src/utils/fx.ts) → `toReportingCurrency` short-circuits on a
same-currency conversion and throws `422 FX_RATE_MISSING` otherwise rather than
guessing.

**Degradation is by design.** A missing bill rate, missing cost rate, or missing FX
rate each becomes a **deduplicated warning plus a zero contribution** — the report
renders rather than failing. `FX_RATE_MISSING` is thrown by the util and caught here.

🔴 **A zero contribution is indistinguishable from genuinely zero margin in the
totals.** The warnings array is the only signal that a number is understated; a
consumer that renders the figures and drops the warnings is showing wrong money.

Project → currency resolves from the most-recently-started **active** engagement
covering it (explicit `project_ids` beats company-wide); with no covering engagement it
defaults to the reporting currency.

---

## Audit actions

| Action | Written by |
|---|---|
| `ENGAGEMENT_CREATE` / `ENGAGEMENT_UPDATE` / `ENGAGEMENT_END` | `engagement.service.ts` |
| `INVOICE_GENERATE` | `invoice.service.ts` — metadata carries `engagement_id`, `number`, period, `line_count`, `total` |
| `INVOICE_UPDATE` / `INVOICE_STATUS` / `INVOICE_DELETE` | `invoice.service.ts` — `INVOICE_STATUS` metadata carries `{from, to}` |
| `COST_RATE_CREATE` / `COST_RATE_UPDATE` / `COST_RATE_END` / `COST_RATE_DELETE` | `cost-rate.service.ts` |

**Reads are not audited** — including `GET /invoices/:id/pdf`.

---

## Error codes

| Code | Status | Raised when |
|---|---|---|
| `ENGAGEMENT_NOT_FOUND` | 404 | |
| `ENGAGEMENT_INVALID_RANGE` | 422 | `end_date` before `start_date` |
| `ENGAGEMENT_INVALID_SCOPE` | 422 | a `project_ids` entry outside the engagement's company |
| `INVOICE_NOT_FOUND` | 404 | |
| `INVOICE_PERIOD_OVERLAP` | 409 | overlapping non-void invoice, no `confirm` |
| `INVOICE_NOT_DRAFT` | 409 | PATCH or DELETE past `draft` |
| `INVOICE_INVALID_TRANSITION` | 409 | illegal status move |
| `COST_RATE_NOT_FOUND` | 404 | |
| `COST_RATE_INVALID_RANGE` | 422 | overlap that is not a forward extension |
| `COST_RATE_IN_USE` | 409 | delete blocked by timesheet entries in the window |
| `DUPLICATE_RESOURCE` | 409 | `{user_id, effective_from}` unique violation |
| `FX_RATE_MISSING` | 422 | thrown by `utils/fx.ts`; caught by margin, folded into a warning |

---

## End-to-end flows

### Generating July for a retainer engagement

`POST /invoices/generate` → scope resolves → overlap check → `retainer` line →
`included_hours` compared against actual → `overage` line at the blended rate if over
→ setup line if never billed → **no `hours` lines** (retainer present) → totals with
zero tax → `INV-2026-00NN` → persisted `draft` → `INVOICE_GENERATE` audit. All in one
transaction.

### Correcting an invoice already sent

Not editable — `INVOICE_NOT_DRAFT`. Void it (`POST /:id/status` → `void`, legal from
any non-void state), then regenerate the same period. The overlap guard fires on the
voided one? **No** — it only considers non-void invoices, which is exactly the flow
the guard was kept non-unique for.

### Applying tax

Generation always writes `tax_rate: 0` / `tax_label: 'No tax'`. `PATCH` the draft with
the real rate and label, then send. Tax cannot be applied after sending.

### Adding a discount

There is no discount field. Add a `manual` line with a **negative** `amount` while the
invoice is a draft.

### Reading margin with an unconfigured currency

Every conversion for that currency degrades to a warning and contributes 0. The report
returns 200 with numbers that are understated — check `warnings` before trusting
totals.

---

## Gotchas

| # | Gotcha |
|---|---|
| 1 | **Line building ignores `billing_type` for the retainer, setup, and fixed components** — it keys off which amount fields are set. `billing_type` is closer to a label than a switch. |
| 2 | **Hours are billed as hourly lines OR overage, never both.** A `hybrid` engagement with a retainer emits no per-user `hours` lines. |
| 3 | **Overage uses a blended rate** across all contributors, not per-user rates. |
| 4 | **Setup-fee double-billing is still possible on a standalone `mongod`** — the session re-read that closes the race needs a real transaction. |
| 5 | **The overlap guard is best-effort by design** and requires `confirm: true` to bypass — a 409 on first attempt, not a warning. |
| 6 | **Invoice numbers are not gap-free.** A rolled-back transaction burns a sequence number. |
| 7 | **The year comes from `period_end`, not today.** Backdated periods number into their own year. |
| 8 | **The number prefix is admin-configurable** (`SystemSettings.billing.invoice_prefix`) — do not hardcode `INV` in a consumer. |
| 9 | **`company_id` / `project_ids` / `currency` are snapshots.** Editing the source afterwards never changes an issued invoice. |
| 10 | **`project_ids: []` means "all the company's projects", resolved at generation time** — not "no projects". |
| 11 | **A missing bill rate does not fail generation** — the line lands with `rate: null, amount: 0`. |
| 12 | **The invoice PDF is never stored and never audited.** Regenerating after a draft edit yields a different document under the same number. |
| 13 | **Engagements cannot be deleted.** No route, no service function. |
| 14 | **Margin warnings are load-bearing** — a degraded contribution is 0 and looks like real zero margin in the totals. |
| 15 | **FX rates are hand-entered and never refreshed.** Stale rates misstate margin silently. |
| 16 | **`invoice.read` has no row scoping** — it grants the entire book across every company. |
| 17 | **Deleting a cost rate is blocked** (`COST_RATE_IN_USE`) if any timesheet entry for that user falls in its window. There is no project dimension to narrow by, unlike billing rates. |
