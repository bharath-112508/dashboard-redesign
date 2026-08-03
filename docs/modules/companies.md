# Companies (clients) & representatives — Backend

The client organisation and its people. Two collections' worth of behaviour sitting on
one small model: `companies` (four fields) plus a role-scoped view over `users` filtered
by `client_profile.company_id`.

Ten endpoints on one router. This is the domain where the **client-vs-representative
visibility split** lives, and that split is the single thing readers get wrong.

Written against the source. Several behaviours below differ from the summary in
[`../../CLAUDE.md`](../../CLAUDE.md) §Companies; every difference is called out where it
matters and listed again under [Gotchas](#gotchas).

---

## 🔴 Vocabulary — read this before anything else

> **"Client" IS the company.** It is not a person who buys things and it is not the
> account owner. `client` is a **company-level role held by a person**, and there may be
> several such people for one company.
>
> **"Representative" is that company's project-scoped person.** Also a role on `users`,
> also belonging to exactly one company.
>
> **The two hold nearly identical permissions.** They differ almost entirely in
> **visibility scope**, and that scope is **service-layer, not RBAC**. No permission
> string anywhere encodes it.

| Role | Permissions | Sees which projects |
|---|---|---|
| `client` | `CLIENT_SIDE_BASE` (8) **+** `representative.write` **+** `project.representatives_write` | **Every** project where `projects.company_id` = their company |
| `representative` | `CLIENT_SIDE_BASE` (8) — nothing else | **Only** projects whose `representative_ids` contain them |

The `client` role gets company-wide project visibility deliberately, not generously: its
job is to **assign representatives to its company's projects**, and it cannot staff a
project it cannot see. Roster-scoping a `client` would deadlock every newly created
project. The reasoning is written into
[`PROJECT_COMPANY_SCOPED_ROLES`](../../src/constants/project.ts).

The company itself has **no login**. People hold the roles; the company row is inert
identity.

> **Consequence for this router:** a `representative` can reach **none of the ten
> endpoints below**. They hold neither `company.read` nor `representative.write`, so
> every route 403s at the gate. A representative cannot look up their own company's
> name here.

---

## Cross-references

- [`../../../Data_Model.md`](../../../Data_Model.md) §5.0 — the `companies` schema and its
  indexes. §5.1 covers `projects.company_id` / `representative_ids`. **That file owns the
  field list; this one owns the behaviour.**
- [`../../../API_Contract.md`](../../../API_Contract.md) §Companies (clients) &
  representatives — the endpoint index and gates.
- [`project-management.md`](./project-management.md) — `loadProjectForCaller` /
  `buildProjectVisibilityFilter`, where the visibility split is actually *enforced* for
  project reads. The roster endpoints here only **report** it.
- [`user-management.md`](./user-management.md) — `deactivateUser` / `reactivateUser`, which
  the remove/restore endpoints delegate to, including the share-link cascade.
- [`roles-rbac.md`](./roles-rbac.md) — the permission catalog and system-role bundles.
- [`invoicing.md`](./invoicing.md) — `engagements.company_id` is a hard reference into this
  collection; it is one of the reasons companies are never hard-deleted.

---

## Scope

| In | Out |
|---|---|
| Company CRUD (create / read / patch) + archive | Hard delete — **there is none** |
| A company's people roster, paginated + searchable | Staff users — see [`user-management.md`](./user-management.md) |
| Creating a representative under a company | Creating any other role (`POST /users`) |
| Removing / restoring a company's people | Arbitrary user deactivation (`POST /users/:id/deactivate`) |
| The per-role project derivation reported on each person | Enforcing project access — that is `project.service.ts` |
| The one-time `company_name` → `companies` migration | Ongoing company↔project rewiring (project routes) |

Route file [`company.routes.ts`](../../src/routes/company.routes.ts) ·
controller [`company.controller.ts`](../../src/controllers/company.controller.ts) ·
service [`company.service.ts`](../../src/services/company.service.ts) ·
model [`company.model.ts`](../../src/models/company.model.ts) ·
validator [`company.validator.ts`](../../src/validators/company.validator.ts).
Mounted at `/companies` in [`routes/index.ts`](../../src/routes/index.ts) — no prefix
overlap with any other router, so mount order is not load-bearing here.

---

## Roles & permissions

Three permissions touch this router.

| Permission | Constant | In which role bundle | Gates |
|---|---|---|---|
| `company.read` | `COMPANY_READ` | `MANAGER_ADDITIONS` | `GET /companies`, `GET /companies/:id` (OR'd with `representative.write`) |
| `company.write` | `COMPANY_WRITE` | **No bundle** — `system.admin` wildcard only | `POST /companies`, `PATCH /companies/:id`, `POST /companies/:id/archive` |
| `representative.write` | `REPRESENTATIVE_WRITE` | `client` role bundle | all five `/representatives` routes, and OR'd into the two company reads |

`requirePermission(A, B)` is **OR semantics** — holding either passes
([`auth.middleware.ts`](../../src/middlewares/auth.middleware.ts)).

### Why the two company reads accept `representative.write`

A `client` holds **only** `representative.write`, not `company.read`. Gating the list and
the detail on `COMPANY_READ` alone made the service-layer client-scoping **dead code**:
the route 403'd before `listCompanies` or `assertCallerOwnsCompany` ever ran. Both route
comments say so explicitly. This is the pattern to copy — a scope check in the service is
worthless if the route gate excludes the role it exists for.

### 🔴 A Manager holds `company.read` and is 403'd on every company **detail**

This is the one thing in this module that will waste an afternoon.

`assertCallerOwnsCompany` returns early on exactly two conditions:

```ts
if (isAdminLike(caller)) return;
if (caller.company_id && caller.company_id.equals(companyId)) return;
throw AppError.forbidden(...);
```

A Manager is neither. `caller.company_id` comes from `req.caller_company_id`, which
[`authenticate`](../../src/middlewares/auth.middleware.ts) sets from
`client_profile.company_id` — **undefined for every staff role**. So for a Manager:

| Endpoint | Result |
|---|---|
| `GET /companies` | **200, the full directory.** The narrowing branch in `listCompanies` only fires for `PROJECT_CLIENT_SIDE_ROLES`, and a Manager is not one |
| `GET /companies/:id` | **403 `FORBIDDEN`** — passes the gate, fails `assertCallerOwnsCompany` |
| `GET /companies/:id/representatives` | **403 `FORBIDDEN`** at the *gate* — the route requires `representative.write`, which is **not** in `MANAGER_ADDITIONS` (a Manager holds `project.representatives_write`, a different permission) |

So a Manager can list companies and open none of them. The frontend admits Managers to
both `/companies` and `/companies/:id`
([`routes.tsx`](../../../viljetech-platform-frontend/src/routes.tsx)), so clicking a row
in the directory produces a 403 page.

`../../CLAUDE.md` describes `COMPANY_READ` as "(admin + manager)", which is true of the
bundle and misleading about the reachable surface. Whether Managers *should* read company
details is a product question; the code today says no, and only for the detail routes.

### The narrowing branch is wider than it is reachable

```ts
if (!isAdminLike(caller) && PROJECT_CLIENT_SIDE_ROLES.includes(caller.role)) { … }
```

`PROJECT_CLIENT_SIDE_ROLES` is `['client', 'representative']`, but a `representative`
cannot pass the route gate. **Only `client` ever reaches this branch.** It is written
against the role set rather than the one reachable role, which is the right call for
future role additions — but do not read the branch as evidence that representatives can
list companies.

A `client` with **no `company_id`** gets `{data: [], meta: {page: 1, limit, total: 0,
total_pages: 0}}` — an explicit empty result, not an error and not the full list. That
matters: the migration script leaves clients with no resolvable `company_name` without a
`company_id`, and they land here.

### Where the scope check is, and is not

| Service function | Ownership check |
|---|---|
| `getCompany` | ✅ `assertCallerOwnsCompany` |
| `listCompanies` | ✅ filter narrowing (equivalent) |
| `listRepresentatives` / `getRepresentative` | ✅ |
| `createRepresentative` / `removeRepresentative` / `restoreRepresentative` | ✅ |
| `createCompany` | — (no target company exists yet) |
| **`patchCompany`** | ❌ **none** |
| **`archiveCompany`** | ❌ **none** |

The two write paths are safe **only because `company.write` is in no role bundle** — it is
reachable exclusively through the `system.admin` wildcard, and admins short-circuit the
check anyway. Grant `company.write` to a custom role and that role can rename or archive
**any** company, including one it has no relationship to. The read paths carry the
assertion; the write paths rely on the permission being admin-only. See Gotcha 4.

---

## Company identity: the collated unique name

`companies` carries four meaningful fields — see
[`../../../Data_Model.md`](../../../Data_Model.md) §5.0. Only the name index has behaviour
worth documenting.

```ts
companySchema.index({ name: 1 }, { unique: true, collation: { locale: 'en', strength: 2 } });
```

**`strength: 2` compares without regard to case or accents.** Combined with `trim: true`
on the schema **and** `.trim()` in the Zod schema, all of `"TCS"`, `"tcs"`, `"  TCS "`
collide on one row. This index is the whole point of the collection: it replaced the
free-text `User.client_profile.company_name`, where near-duplicate spellings silently
became unrelated companies with nothing linking their people.

Uniqueness is enforced **by the index only** — there is no pre-check `findOne`. Both
`createCompany` and `patchCompany` catch the write error and inspect it:

```ts
e.code === 11000 && Boolean(e.keyPattern?.name)   →  409 DUPLICATE_RESOURCE, details {name}
```

Checking `keyPattern.name` rather than just `code === 11000` matters: it means a future
second unique index on this collection surfaces as its own error instead of a wrong
"company name already exists" message.

### 🔴 What breaks when a query omits the collation

**MongoDB will not use a collated index for a non-collated query.** Two distinct
consequences, and people usually only think of the first:

1. **Performance** — the query falls back to a collection scan.
2. **Semantics** — a `name` equality or sort in a non-collated query is
   **case-sensitive**, so it can miss the row the index considers a duplicate.

`listCompanies` passes `.collation(NAME_COLLATION)` on the page query, so its
`.sort({name: 1})` interleaves `"acme"` and `"Acme"` rather than putting all uppercase
first.

Two places in the repo omit it, with different severity:

- **`Company.countDocuments(filter)` in `listCompanies`** — same `filter` object as the
  page (this is the point: one filter, two queries, so the pager cannot promise results a
  search does not have), but **no `.collation()`**. For the three filter shapes actually
  reachable — `status` (enum-validated lowercase), `_id` (ObjectId equality), and a
  case-insensitive `$regex` on `name` — the count agrees with the page. It costs the count
  the collated index, and it is a live trap for anyone who adds a `name` equality filter
  and updates only one of the two calls.
- 🔴 **`companies.findOne({ name: g.display })` in
  [`migrate-companies.ts`](../../scripts/migrate-companies.ts)** — the "does this company
  already exist?" check, run through the raw driver with no collation. A case-variant row
  is **not found**, so `insertOne` follows and throws an unhandled `E11000`; the script's
  top-level `.catch` prints it and `process.exit(1)` **mid-migration**. See
  [Migration](#migration).

---

## Endpoints

Ten routes, one router, `authenticate` applied via `router.use` at the top.

### Company

| Method | Path | Gate | Behaviour |
|---|---|---|---|
| `GET` | `/companies` | `company.read` **or** `representative.write` | Paginated. Client-side callers narrowed to their own company. Collated sort by `name`. No audit |
| `POST` | `/companies` | `company.write` | Creates `{name, created_by}`, `status` defaults `active`. 409 on a collated name collision. Audits `company.create` |
| `GET` | `/companies/:id` | `company.read` **or** `representative.write` | 404 `RESOURCE_NOT_FOUND` if absent; **403 `FORBIDDEN` unless admin or the caller's own company** (see the Manager note). No audit |
| `PATCH` | `/companies/:id` | `company.write` | `name` and/or `status`, at least one required. 409 on collision. Audits `company.update` with before/after `{name, status}` |
| `POST` | `/companies/:id/archive` | `company.write` | Sets `status: 'archived'`. **Idempotent** — already-archived returns the doc with **no write and no audit row**. Otherwise audits `company.archive` |

**Query params on `GET /companies`** —
[`listCompaniesQuerySchema`](../../src/validators/company.validator.ts):

| Param | Type | Default | Notes |
|---|---|---|---|
| `page` | int ≥ 1 | `1` | |
| `limit` | int 1–100 | `20` | |
| `status` | `active` \| `archived` | — | |
| `q` | string, **min 2**, max 100 | — | `$regex` on `name`, `$options: 'i'`, **regex-escaped** |

The schema is **`.strict()`**, so an unrecognised query parameter is a **400**, not
ignored. `?sort=name` fails the request. Same for the representatives query schema. This
is unusual for a query schema in this codebase — do not add a param client-side before
adding it here.

`PATCH` body is `.partial().strict()` plus a `.refine` requiring at least one key, so
`PATCH {}` is a 400 with `"At least one field must be provided"`.

### Representatives (a company's people)

All five gate on `representative.write` — held by **admin** (wildcard) and a company's own
`client`s, **and nobody else**.

| Method | Path | Behaviour |
|---|---|---|
| `GET` | `/companies/:id/representatives` | Paginated + searchable roster, each person carrying the projects they can open. No audit |
| `GET` | `/companies/:id/representatives/:user_id` | One person, same shape as a list row. **404, not 403, for someone in another company** |
| `POST` | `/companies/:id/representatives` | Creates a `representative` `User`. `role` and `company_id` are **server-derived**. Audits `representative.create` |
| `POST` | `/companies/:id/representatives/:user_id/restore` | Reactivates. Refuses on an archived company (422). Audits `user.reactivate` |
| `DELETE` | `/companies/:id/representatives/:user_id` | **Deactivates** — this is the platform soft-delete. Audits `user.deactivate` with `metadata.reason: 'removed_from_company'` |

**Who "belongs to" a company** is one shared predicate,
`peopleFilter(companyId)`, so the list and the fetch-one can never disagree:

```ts
{ role: { $in: PROJECT_CLIENT_SIDE_ROLES }, 'client_profile.company_id': companyId }
```

Note what is **absent**: any `status` clause. **Deactivated people still appear in the
roster** — which is exactly what makes the restore endpoint reachable from the UI. A
consumer that renders the roster as "active people" is wrong; read `status` per row.

Remove and restore use a second predicate, `loadCompanyMemberOrThrow`, which applies the
same three conditions against a `findById`. Sharing it is deliberate so the two verbs
cannot drift on membership.

### 🔴 `GET /companies/:id/representatives/:user_id` exists **because** the list is paginated

The profile page originally found its person by scanning the list response. Once the list
returns 10–20 rows, **anyone on page 2+ rendered "not found" on a direct link.** Fetching
by id is the only version that survives pagination. If you are tempted to remove this
endpoint as redundant, this is the regression you will reintroduce.

The route is declared before the `POST`/`DELETE` on the same prefix, which is irrelevant
(they differ by verb) — and it shadows nothing, because `:user_id` is an id and there are
**no literal sub-paths** under `/representatives`. Adding one (e.g.
`/representatives/bulk`) would require declaring it **before** this route.

---

## The visibility split, as reported by the roster

`shapePerson` in [`company.service.ts`](../../src/services/company.service.ts) is where
the client/representative distinction becomes a wire field. Both list and fetch-one use
it.

```ts
const isCompanyLevel = u.role === ROLES.CLIENT;
const assigned = isCompanyLevel
    ? projects                                              // ALL of the company's projects
    : projects.filter(p => (p.representative_ids ?? []).some(rid => rid.equals(u._id)));
```

`projects` is **every project of this company**, fetched once:
`Project.find({ company_id: id }).select('_id name code representative_ids').sort({name: 1})`.

| Role | Project list derived from | `project_access` |
|---|---|---|
| `client` | the project's `company_id` — **the roster is ignored** | `'company'` |
| `representative` | membership in `representative_ids` | `'assigned'` |

**`project_access` is the field that tells a consumer which rule applied.** It is on every
row and on the single-person response. A UI must not label a `'company'` list "assigned
to" — the person is not assigned to those projects, they can simply open all of them.

🔴 **A `client` is *also* written onto `representative_ids`,** and deriving their list from
it would be wrong. That entry is **denormalised** — it exists so the roster is one
explicit field — and it may drift. A client whose roster entry is missing still sees the
project, because `company_id` is authoritative for their access
([`project-management.md`](./project-management.md)). Deriving the displayed list from the
roster would therefore **under-report** projects they can genuinely open: the UI would
contradict what happens when they click through. Drift costs display accuracy, never
access — but only if you read the authoritative field.

A `representative` on no project gets `projects: []`, **not** the company list. The
`isCompanyLevel` branch is the only thing separating those two answers, and it keys on
`role` alone.

**The projects query is one query per request, not one per person.** Each person's list is
a pure in-memory derivation from that single result, so response cost is flat in the
number of people on the page. Do not "optimise" this into a per-person lookup.

### Response shapes — three different people

One router returns three different person shapes. This bites consumers.

| Endpoint | Shape |
|---|---|
| `GET .../representatives`, `GET .../representatives/:user_id` | `shapePerson`: `{id, full_name, email, role, status, project_access, projects[{id,name,code}]}` — **six user fields, nothing else** |
| `POST .../representatives` | `user.toJSON()` **minus `profile_photo_blob_key`** — the full user document, and **no `profile_photo_url`** |
| `DELETE` / `POST .../restore` | `toPublicUser(...)` from `user.service.ts` — the full user document **with `profile_photo_url`** |

The create path hand-rolls its redaction:

```ts
const json = created.toJSON() as unknown as Record<string, unknown>;
delete json.profile_photo_blob_key;   // internal storage pointer — never public
```

That manual `delete` is necessary because `profile_photo_blob_key` is **not** in the user
model's `SENSITIVE_FIELDS` list, so `toJSON` does not strip it. Every other user-returning
path funnels through `toPublicUser`, which strips the same field *and* signs a
`profile_photo_url`. This path does not. Consequence: a new non-stripped sensitive field
on `users` is handled by `toPublicUser` and **leaks here**.

---

## Creating a representative

### 🔴 Why this endpoint exists instead of `POST /users`

Creating a representative creates a `User`. `POST /users` is gated on **`user.write`, the
admin-wide bit** — granting it to a Client so they could add their own people would also
let them **create admins**.

So there is a second, narrower door. It is gated on `representative.write` and derives the
two dangerous fields server-side:

- **`role` is hard-coded** to `ROLES.REPRESENTATIVE`. It is never read from the body.
- **`company_id` comes from the URL**, and `assertCallerOwnsCompany` pins that URL to the
  caller's own company for a non-admin.

### What the body accepts, and what it refuses

[`createRepresentativeBodySchema`](../../src/validators/company.validator.ts):

| Field | Type | Required |
|---|---|---|
| `email` | trimmed, lowercased, `.email()` | ✅ |
| `full_name` | 1–200 chars | ✅ |
| `initial_password` | string, min 1 **at the schema** | ✅ |
| `phone` | ≤ 32 chars | — |
| `timezone` | string | — |

There is **no `role` field and no `company_id` field**, and the schema is **`.strict()`**.

🔴 **`.strict()` is load-bearing here, not stylistic.** A body carrying `role` or
`company_id` is **rejected with a 400**, not silently ignored. That is the difference
between an escalation attempt that surfaces in logs as a failed request and one that
passes quietly while the server happens to overwrite the field. The validator's own
comment says exactly this. Relaxing `.strict()` on this one schema is a security change,
not a convenience change.

Three unit tests pin the behaviour: role is hard-coded, a smuggled `role` never creates an
admin, and `company_id` comes from the URL rather than the body
([`company.service.test.ts`](../../src/services/company.service.test.ts)).

**`initial_password` is validated twice.** Zod only checks `min(1)`; the real policy is
`assertPasswordPolicy` in the service — **10–12 characters** with upper, lower, digit and
special ([`constants/auth.ts`](../../src/constants/auth.ts)), throwing **422
`PASSWORD_POLICY_VIOLATION`**. Note the *maximum* of 12: a long passphrase is rejected.

**Server-set fields not derivable from the body:** `status: 'active'`,
`client_profile.access_type: 'login'`, `created_by: caller.id`.

### Order of checks

1. `loadCompanyOrThrow` → 404 `RESOURCE_NOT_FOUND`
2. `assertCallerOwnsCompany` → 403 `FORBIDDEN`
3. **archived company** → 422 `VALIDATION_ERROR`
4. `assertPasswordPolicy` → 422 `PASSWORD_POLICY_VIOLATION`
5. `User.exists({email})` → 409 `EMAIL_ALREADY_EXISTS`
6. create → audit `representative.create`

The archived check precedes the password check, so a weak password against an archived
company returns the *archived* error. The email uniqueness check is a **read-then-write**,
not an index catch — `users.email` is unique, so a genuine race produces an unmapped
`E11000` (500) rather than the friendly 409. Low-frequency, but it is not the
duplicate-name pattern used elsewhere in this file.

There is **no transaction**. The user is created, then the audit row is written by the
non-throwing `recordAudit`.

---

## Removal and restore

Both are `representative.write`. Neither is `user.deactivate`.

### 🔴 The exact permission on `restore`, and why it is that one

`POST /companies/:id/representatives/:user_id/restore` is gated on
**`representative.write`**, not `user.deactivate` — which is the permission you would
expect, since restoring is reactivation.

The reason is a real privilege-escalation path, and it is *not* about deactivation:

> **`user.deactivate` also gates `POST /users/:id/reactivate` for ANY user.** Granting it
> to a Client so they could undo their own removals would let them **reactivate a
> deactivated admin.**

That is the whole argument, and it is symmetric with `DELETE`, where `user.deactivate`
would let a Client deactivate anyone including admins. Both hazards are the same shape as
`user.write` on creation, and both get the same fix: a **scoped route that can only reach
one company**, gated on a permission that means nothing outside it.

Consider a concrete escalation if `restore` were gated on `user.deactivate` and a Client
held it: deactivate the sole admin (or find one already deactivated), reactivate them, and
in between the platform has an admin-slot state the Client controls. `reactivateUser`
re-runs `assertSingleAdmin` and maps the race to 409 `ADMIN_ALREADY_EXISTS`, which limits
the damage — but the Client would never have needed to reach that code at all.

### The non-admin asymmetry, on both verbs

```ts
if (!isAdminLike(caller) && target.role !== ROLES.REPRESENTATIVE) {
    throw AppError.forbidden('Only an administrator can remove|restore a company-level client');
}
```

A non-admin may remove and restore **`representative`s only**. Two reasons, stated in the
source:

- Letting a Client remove other company-level `client`s (or themselves) risks **locking the
  company out of managing its own people**, recoverable only by an admin.
- On restore, the symmetry is what keeps the pair from being lopsided — but the real point
  is that **every company-level membership change stays with an admin.**

An admin may act on either role.

### What "remove" actually means

**Deactivation, not deletion, and not unlinking.** `client_profile.company_id` is
`required: true` on the schema, so a client-side user **cannot exist without a company** —
there is no unlink that leaves a valid account. Deactivation is the platform's
soft-delete: login revoked, history kept, reversible.

The endpoint runs its own guards **first** — `loadCompanyOrThrow` →
`assertCallerOwnsCompany` → `loadCompanyMemberOrThrow` → the non-admin role guard
(`company.service.ts:478`) — and only then delegates to `deactivateUser`, which also:

- **blocks self-removal** (403). A Client cannot remove themselves through this route, but
  not via this check: their own target role is `client`, so the role guard above rejects
  them first with *"Only an administrator can remove a company-level client"*. An admin
  self-targeting 404s even earlier, at `loadCompanyMemberOrThrow`, because staff roles are
  not in `PROJECT_CLIENT_SIDE_ROLES`. The conclusion holds; the error code and message do
  not match what this bullet implies;
- **revokes all active refresh tokens**;
- **cascades share-link revocation** for `client`-role targets
  (`revokeLinksForDeactivatedClient`) — each revoke independently audited, never throwing;
- writes the `user.deactivate` audit row.

Already-deactivated is a **no-op returning the user**, not an error.

`restoreRepresentative` delegates to `reactivateUser`, which re-runs the single-admin
guard and writes `user.reactivate`. **Restoring an already-active person is a no-op, not
an error** — the button can lose a race with another admin, and that should not surface as
a failure.

### The two verbs are not symmetric about archived companies

| | Archived-company check |
|---|---|
| `DELETE .../representatives/:user_id` | **none** — you may remove people from an archived company |
| `POST .../representatives/:user_id/restore` | **422 `VALIDATION_ERROR`** — "Cannot restore people in an archived company" |
| `POST .../representatives` (create) | **422 `VALIDATION_ERROR`** |

Deliberate and correct in direction: an archived company must not **gain** active logins,
but must still be able to shed them. Un-archive first (`PATCH {status: 'active'}`), then
restore.

On restore the archived check runs **before** `loadCompanyMemberOrThrow`, so restoring a
non-existent person in an archived company returns **422, not 404**.

### 404, not 403, for someone in another company

`loadCompanyMemberOrThrow` and `getRepresentative` both throw **404 `USER_NOT_FOUND`** for
a target who exists but belongs to a different company — or who is a staff user whose id
was guessed at this route.

The comment states the reasoning: the caller has **already passed the company scope
check**, so a 403 here would confirm the id exists elsewhere. It is an anti-enumeration
choice, and the same reasoning appears on report presets
([`reports-exports.md`](./reports-exports.md)).

---

## Pagination and search on the roster

[`listRepresentativesQuerySchema`](../../src/validators/company.validator.ts), `.strict()`:

| Param | Type | Default | Notes |
|---|---|---|---|
| `page` | int ≥ 1 | `1` | |
| `limit` | int 1–100 | **`20`** | Matches the companies list default. The UI asks for 5 |
| `q` | string, **min 2**, max 100 | — | Matches `full_name` **OR** `email` |

**`q` min-length 2 is not cosmetic.** A one-character search is a full-collection scan with
a rank ordering nobody wants; the same floor is applied to the companies list (tagged
**R15** in the validator).

**The search is applied at the DB layer, not to the fetched page.** Filtering in the
browser would only ever search the 10–20 rows on screen and quietly miss the rest — which
reads to a user as *"no results"* rather than *"not on this page."*

```ts
const filter: Filter = { ...peopleFilter(id) };
if (query.q) {
    const rx = { $regex: escapeRegex(query.q), $options: 'i' };
    filter.$or = [{ full_name: rx }, { email: rx }];
}
```

**The input IS escaped.** `escapeRegex` strips `.*+?^${}()|[]\` before interpolation.
Unescaped, `a(` is an invalid regex — **Mongo raises and the request 500s** — and `.`
silently matches any character, so a search for `a.b` would match `axb`. Both list
endpoints in this service escape; a test pins it (*"escapes regex metacharacters instead
of 500ing on them"*).

**The count uses the same `filter` object as the page.** One object, two queries:

```ts
User.find(filter)…skip(skip).limit(query.limit)   //  the page
User.countDocuments(filter)                        //  the total
```

If these diverged, the pager would promise results a search does not have. **Consumers
must read `meta.total`, never `data.length`.**

### 🔴 `total_pages` is computed two different ways in one file

| Function | Expression | Empty result |
|---|---|---|
| `listCompanies` | `Math.ceil(total / limit)` | **`0`** |
| `listRepresentatives` | `Math.max(1, Math.ceil(total / limit))` | **`1`** |

Same module, same `PaginationMeta` type, two different answers for "no rows". A test pins
the representatives behaviour (*"reports total_pages 1 for an empty company (never 0)"*);
nothing pins the companies behaviour. A shared pager component that trusts
`total_pages >= 1` breaks on the companies list, and one that renders `total_pages` as a
count breaks on the representatives list.

---

## Retirement: archive, never delete

🔴 **There is no hard delete.** No `DELETE /companies/:id` route, and **no delete function
in [`company.service.ts`](../../src/services/company.service.ts)** — the same
by-construction guarantee that engagements have ([`invoicing.md`](./invoicing.md)). It
cannot be forgotten, because there is nothing to forget.

The reason is referential: `projects.company_id`, `engagements.company_id`, and every
already-generated `invoices.company_id` **snapshot** point here, and historic references
must stay resolvable. Deleting a company would orphan invoices.

**The retirement path is `status: 'archived'`**, reachable two ways:

| Path | Audit action | Idempotent |
|---|---|---|
| `POST /companies/:id/archive` | `company.archive`, before/after `{status}` | ✅ already-archived → no write, **no audit row** |
| `PATCH /companies/:id {status: 'archived'}` | **`company.update`** | n/a — always writes |

🔴 **Two ways to archive, only one writes `company.archive`.** A query over `audit_logs`
for `company.archive` **under-counts archivals** — a `PATCH` produces a `company.update`
row whose `after.status` is `'archived'`. Un-archiving is `PATCH {status: 'active'}` only;
there is no `unarchive` route, and no `company.unarchive` audit action exists.

**Archiving cascades nothing.** It does not deactivate the company's people, does not
touch its projects, and does not end its engagements. Its only enforced effects are the
two 422 refusals above (create representative, restore representative) — and **`PATCH`
bypasses neither, because `PATCH` sets the status without consulting them.**

---

## Migration

[`scripts/migrate-companies.ts`](../../scripts/migrate-companies.ts) — the one-time
`client_profile.company_name` (free text) → first-class `companies` migration.

```bash
npx tsx scripts/migrate-companies.ts             # plan only (default)
npx tsx scripts/migrate-companies.ts --commit    # apply
```

**Dry-run by default**, which is the right default here because two of its decisions are
irreversible-in-effect and only a human can validate them.

What it does: groups `client` users by trimmed + case-folded `company_name` → one Company
per distinct name → sets `client_profile.company_id`, unsets `company_name` and
`point_of_contact` → per project, derives `company_id` from its legacy `client_ids`, sets
`representative_ids = client_ids`, unsets `client_ids` → reconciles the roster by
`$addToSet`-ing each company's `client`s onto every project of that company.

**Roles are deliberately untouched.** An existing `client` stays a `client` and simply
becomes company-level. Nobody gains a permission they did not already have.

Two things the plan output exists to be read for:

- **MERGES** — grouping is case-insensitive (matching the collated index), so `"TCS"` and
  `"TCS "` collapse into one company. Right if they are the same company, wrong if they are
  not. Every merge is listed with its source spellings.
- 🔴 **MULTI-COMPANY PROJECTS** — a project shared with clients from more than one company
  cannot migrate under one-company-per-project. Rule: **most reps on that project wins**,
  tie broken by earliest-created client. **Every dropped person is named, because they lose
  access to that project.**

It also processes projects whose legacy `client_ids` array is **empty**, not just
non-empty ones. Skipping the empties looks harmless and is not: they would keep a stale
`client_ids` and never gain `representative_ids`, and because `.lean()` reads do **not**
apply Mongoose defaults, `project.representative_ids.some(...)` would throw — a **500, not
a silent wrong answer**.

### Is it re-runnable?

**Yes in the ordinary case**, and the file contradicts itself about it. The header says
*"Re-runnable … A second run is a clean no-op"*; an inline comment at the skip branch says
*"this script isn't idempotent."* The **header is right** for a completed run:

- clients carrying a `company_id` are skipped as `alreadyDone`, so `groups` is empty and
  steps 1, 2 and 4 do nothing;
- the project pass matches on `client_ids: {$exists: true}`, a field it removes, so a
  second run finds no projects.

So re-running after a **partial** failure is safe — which is exactly the scenario the
dry-run default and the exit-on-error make likely.

🔴 **The one way a re-run can still fail:** the existence check is
`companies.findOne({ name: g.display })` through the **raw driver, with no collation**. It
does not use the collated unique index and **does not match a case-variant row**. If a
company named `"TCS"` exists and the group's display name is `"tcs"`, `findOne` misses,
`insertOne` throws `E11000`, and the top-level `.catch` exits `1` **partway through**.
This is the canonical instance of the collation rule in
[What breaks when a query omits the collation](#-what-breaks-when-a-query-omits-the-collation).

**Historic audit rows are not rewritten.** The script says so on completion: old
`audit_logs` keep the `{client_ids: [...]}` snapshot shape. They are immutable — **audit
readers must tolerate both shapes.**

---

## Audit actions

[`constants/audit.ts`](../../src/constants/audit.ts). Every call site is guarded by
`if (caller.audit)`, and `projectCallerFrom` always populates it via `buildAuditContext`,
so in the HTTP path the guard is always true. `recordAudit` **never throws**.

| Action | Written by | Target kind | Payload |
|---|---|---|---|
| `company.create` | `POST /companies` | `company` | `after {name, status}` |
| `company.update` | `PATCH /companies/:id` | `company` | before/after `{name, status}` |
| `company.archive` | `POST /companies/:id/archive` | `company` | before `{status:'active'}` / after `{status:'archived'}` — hardcoded, not read from the doc |
| `representative.create` | `POST .../representatives` | **`user`** | `after {email, role, company_id}` |
| `user.deactivate` | `DELETE .../representatives/:user_id` | `user` | via `deactivateUser`; `metadata.reason: 'removed_from_company'`, plus `share_links_revoked` for `client` targets |
| `user.reactivate` | `POST .../restore` | `user` | via `reactivateUser` |

🔴 **There is no `representative.delete` and no `representative.restore` audit action.**
Removal and restore are indistinguishable from an admin acting through
`POST /users/:id/deactivate` **except** by `metadata.reason === 'removed_from_company'`,
which only the removal path sets. **Restore sets no marker at all** — a restore through
this router and a reactivation through the user router produce identical audit rows.
A compliance query for "who changed a company's roster" cannot be answered from the action
name.

Note the target kind on `representative.create` is **`user`**, not `company` — correct
(the created thing is a user), and worth knowing before filtering audit rows by
`target_entity.kind: 'company'` expecting roster events.

Reads are not audited. Idempotent archive writes no row.

---

## Error codes

| Code | Status | Raised by |
|---|---|---|
| `VALIDATION_ERROR` | 400 | Zod — bad ObjectId in a param, unknown query/body key (`.strict()`), empty `PATCH`, `q` under 2 chars |
| `FORBIDDEN` | 403 | `assertCallerOwnsCompany`; the non-admin company-level-client guard on remove/restore; the route gate |
| `RESOURCE_NOT_FOUND` | 404 | `loadCompanyOrThrow` |
| `USER_NOT_FOUND` | 404 | `getRepresentative` / `loadCompanyMemberOrThrow` — including **another company's** person and a staff id |
| `DUPLICATE_RESOURCE` | 409 | collated `name` collision on create or patch; `details: {name}` |
| `EMAIL_ALREADY_EXISTS` | 409 | `POST .../representatives` |
| `VALIDATION_ERROR` | **422** | archived-company refusals — `AppError.unprocessable(msg, VALIDATION_ERROR)` |
| `PASSWORD_POLICY_VIOLATION` | 422 | `assertPasswordPolicy` on `initial_password` |
| `ADMIN_ALREADY_EXISTS` | 409 | `reactivateUser`, if a restore races into the admin slot |

🔴 **The archived-company refusals reuse `VALIDATION_ERROR` at 422.** So `VALIDATION_ERROR`
arrives at **two different statuses** from this router, and a client cannot distinguish
"the company is archived" from a Zod failure **by code** — only by HTTP status plus
message text. A frontend that maps error codes to messages will render the wrong copy
unless it also branches on status.

---

## End-to-end flows

### An admin onboards a new client company and its first person

1. `POST /companies {name: "Alnarp Holding AB"}` → 201, `status: 'active'`, audit
   `company.create`. A collated name collision here is a 409, not a second row.
2. `POST /companies/:id/representatives {email, full_name, initial_password}` → 201. Role
   is hard-coded `representative`; `company_id` is taken from the URL. Audit
   `representative.create` against target kind `user`.
3. To create a **company-level `client`** instead, use `POST /users` — this router only
   ever mints `representative`s. That asymmetry is the point of the router.

### A Client adds one of their own people

Same `POST /companies/:id/representatives`, but the id in the URL is scope-checked:
`assertCallerOwnsCompany` compares it to `req.caller_company_id`, which `authenticate`
read from the caller's own user row — **not** from the JWT, so a client reassigned to
another company loses the old scope immediately rather than at token expiry. A body
carrying `role: 'admin'` is a **400** from `.strict()`, before any of this runs.

### A Client opens their company page

`GET /companies` returns exactly one row (their own — the narrowing branch).
`GET /companies/:id` passes `assertCallerOwnsCompany`. `GET /companies/:id/representatives`
returns the roster; each row's `project_access` says `'company'` for the company-level
people and `'assigned'` for the representatives, and the `projects` array is derived
accordingly from **one** project query.

### A Manager opens the same page

`GET /companies` returns **every** company. Clicking one: **403.** Listing its people:
**403.** See the Manager note under [Roles & permissions](#roles--permissions).

### Someone searches the roster for `a(`

The `q` floor of 2 chars is satisfied, `escapeRegex` turns `a(` into `a\(`, and the query
returns no matches instead of **500ing on an invalid regex**. `meta.total` reflects the
filtered set, so the pager does not offer a page 2 that does not exist.

### A company stops being a customer

`POST /companies/:id/archive` → `status: 'archived'`, audit `company.archive`. Its projects
and invoices keep resolving `company_id`. New representatives are refused (422) and
removed people cannot be restored (422), but existing people **remain active and can still
log in** — archiving cascades nothing. Removing them is a separate act per person, and it
is still permitted against an archived company. Calling archive twice is a no-op with no
second audit row.

### Reversing a removal

`POST /companies/:id/representatives/:user_id/restore`. Refuses if the company is archived
(422, checked *before* the person is looked up). A non-admin may restore only a
`representative`. Already-active is a **no-op returning the user**, not an error — two
admins clicking the button do not produce a failure. Audit row is `user.reactivate`, with
nothing marking it as company-scoped.

---

## Gotchas

| # | Gotcha | Why it costs time |
|---|---|---|
| 1 | 🔴 **"Client" IS the company; "Representative" is its project-scoped person.** The two differ in **visibility scope**, which is **service-layer, not RBAC** | No permission string encodes the split, so reading the permission catalog gives you the wrong model of the domain |
| 2 | 🔴 **A Manager holds `company.read` but is 403'd on `GET /companies/:id`** and gate-403'd on the representatives list (`representative.write` is not in `MANAGER_ADDITIONS`) | `assertCallerOwnsCompany` passes only admins and a caller's own company; staff have no `company_id`. The FE admits Managers to both routes, so the directory links to a 403. `../../CLAUDE.md`'s "COMPANY_READ (admin + manager)" describes the bundle, not the reachable surface |
| 3 | **A `representative` can reach none of these ten endpoints** | They hold neither `company.read` nor `representative.write`. The `PROJECT_CLIENT_SIDE_ROLES` narrowing branch in `listCompanies` names them but is unreachable for them |
| 4 | 🔴 **`patchCompany` and `archiveCompany` carry no ownership check** | Safe **only** because `company.write` is in no role bundle. Grant it to a custom role and that role renames or archives any company. Every read path has the assertion; these two do not |
| 5 | 🔴 **`POST .../representatives` accepts no `role` and no `company_id`, and the schema is `.strict()`** — sending either is a **400**, not a silent ignore | The endpoint exists so a Client never needs `user.write`, which is admin-wide and would let them create **admins**. Relaxing `.strict()` here is a security change |
| 6 | 🔴 **`restore` is gated on `representative.write`, not `user.deactivate`** | `user.deactivate` also gates `POST /users/:id/reactivate` for *any* user — a Client holding it could revive a deactivated admin. Same shape of hazard as `user.write` on create, same fix: a company-scoped route |
| 7 | **A non-admin may remove/restore `representative`s only** | Letting a Client remove other company-level `client`s could lock the company out of managing its own people; keeping company-level changes with an admin is the invariant |
| 8 | 🔴 **A `client`'s project list comes from `projects.company_id`, NOT from `representative_ids`** — even though they are also on the roster | The roster entry is denormalised and may drift. Deriving from it **under-reports** projects they can genuinely open, so the UI contradicts what clicking through does. `project_access: 'company' \| 'assigned'` is the field naming which rule applied — never label a `'company'` list "assigned to" |
| 9 | **The roster has no `status` filter — deactivated people are listed** | That is what makes restore reachable. Read `status` per row; the roster is not "active people" |
| 10 | **`GET .../representatives/:user_id` exists because the list is paginated** | A consumer that found its person by scanning the list rendered "not found" for anyone past page 1. Do not delete it as redundant |
| 11 | 🔴 **`name` uniqueness is a collated index** (`locale: 'en', strength: 2`). **A query that omits the collation gets a collection scan AND case-sensitive semantics** | It can miss the very row the index treats as a duplicate. `Company.countDocuments` in `listCompanies` omits it (harmless for today's filters, a trap for a `name` filter); `migrate-companies.ts`'s existence check omits it and **can abort the migration mid-run** with an unhandled `E11000` |
| 12 | 🔴 **`total_pages` is `0` on an empty companies list and `1` on an empty roster** | Two expressions in one file — `Math.ceil` vs `Math.max(1, Math.ceil(...))`. A shared pager breaks on one of them. Only the roster behaviour has a test |
| 13 | **`q` is regex-escaped in both list endpoints, and min 2 chars** | Unescaped, `a(` is an invalid regex and **500s**; `.` silently matches anything. Min 2 (R15) stops a one-char full scan |
| 14 | **The count query uses the same `filter` object as the page** | Keep it that way — divergence makes the pager promise results a search does not have. Read `meta.total`, never `data.length` |
| 15 | 🔴 **Companies can never be hard-deleted — no route, no service function.** Archive is the only retirement | `projects`, `engagements` and already-generated `invoices` all reference `company_id`; deletion would orphan invoices |
| 16 | 🔴 **`PATCH {status:'archived'}` archives without writing a `company.archive` audit row** — it writes `company.update` | An audit query for `company.archive` **under-counts archivals**. There is no `unarchive` route and no `company.unarchive` action; `PATCH {status:'active'}` is the only way back |
| 17 | **Archiving cascades nothing** | People stay active and can still log in; projects and engagements are untouched. The only enforced effects are the two 422s (create/restore), and `PATCH` sets the status without consulting them |
| 18 | **Remove is allowed on an archived company; create and restore are not** | Deliberate — an archived company must not gain active logins but must be able to shed them. On restore the archived check runs **before** the person lookup, so a bad id yields 422, not 404 |
| 19 | **Cross-company and staff targets return 404, not 403** | The caller already passed the company scope check, so a 403 would confirm the id exists elsewhere. Anti-enumeration, not a bug |
| 20 | 🔴 **Three different person shapes come off one router** | `shapePerson` (six fields + `projects`) from the two reads; `toJSON()` minus `profile_photo_blob_key` and **without `profile_photo_url`** from create; `toPublicUser` **with `profile_photo_url`** from remove/restore. The create path hand-rolls its redaction because `profile_photo_blob_key` is **not** in the user model's `SENSITIVE_FIELDS` — a new non-stripped sensitive field is handled by `toPublicUser` and leaks here |
| 21 | **`initial_password` is capped at 12 characters** by `PASSWORD_REGEX`, checked in the service, not by Zod | Zod only enforces `min(1)`. A long passphrase is a **422 `PASSWORD_POLICY_VIOLATION`**, which reads as a server bug from the client side |
| 22 | **Duplicate email on create is a read-then-write, not an index catch** | A genuine race produces an unmapped `E11000` (500) instead of the friendly 409, unlike the duplicate-*name* path in the same file |
| 23 | 🔴 **No `representative.delete` / `representative.restore` audit action exists** | Removal is distinguishable from a plain user deactivation only by `metadata.reason: 'removed_from_company'`; **restore sets no marker at all.** "Who changed this company's roster" cannot be answered from the action name |
| 24 | **`representative.create` targets kind `user`, not `company`** | Filtering `audit_logs` on `target_entity.kind: 'company'` misses every roster event |
| 25 | 🔴 **The archived-company 422s reuse the `VALIDATION_ERROR` code** | So `VALIDATION_ERROR` arrives at both 400 and 422 from this router, and a client cannot tell "company is archived" from a Zod failure by code alone. Branch on status, or the wrong copy renders |
| 26 | **Both list query schemas are `.strict()`** | An unrecognised query param is a **400**, not ignored. `?sort=name` fails. Unusual for a query schema in this codebase — add the param here before adding it client-side |
| 27 | **The projects query in the roster is one query per request** | Each person's list is a pure in-memory derivation, so cost is flat in page size. Do not refactor it into a per-person lookup |
| 28 | **`migrate-companies.ts` is dry-run by default and re-runnable** — the file's own inline comment saying otherwise is wrong | A completed run makes a second run a no-op (clients skipped on `company_id`, projects matched on the removed `client_ids`). But read the MERGE and MULTI-COMPANY-PROJECT sections of the plan before `--commit`: merges are case-folding collapses only a human can validate, and **dropped people lose project access** |
| 29 | **Historic `audit_logs` keep the legacy `{client_ids: [...]}` snapshot shape** | The migration does not rewrite them — they are immutable. Audit readers must tolerate both shapes |

---

## Open questions

- **Is the Manager 403 on `GET /companies/:id` intended?** The bundle grants
  `company.read`, the frontend routes Managers to the detail page, and the service denies
  them. One of those three is wrong, and the source does not say which.
- **Should removal and restore have their own audit actions?** The absence is consistent
  (both delegate to `user.service`), but it leaves roster changes unattributable to this
  router. Nothing in the source states a decision either way.
