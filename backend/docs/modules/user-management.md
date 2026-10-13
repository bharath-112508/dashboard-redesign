# User Management — Backend

The **User Management** module owns the `users` collection and everything attached to a user as a *record*: directory CRUD, profile editing, profile photo, deactivation/reactivation, single-role swap (legacy), admin-triggered password reset, GDPR DSAR + right-to-erasure, and the `/users/assignable` directory used by project pickers.

Three closely related concerns live elsewhere and are linked at the boundary:
- **Authentication flows** (login, MFA challenge, password change, session revocation, refresh-token rotation) → `auth.md`
- **Custom roles + multi-role assignment** (`PATCH /users/:user_id/roles`, `PATCH /users/:user_id/extra-permissions`, role CRUD) → `roles-rbac.md`
- **Project rosters** (members / clients per project) → [`project-management.md`](./project-management.md)

---

## Scope

| Surface | In scope | Notes |
|---|---|---|
| User CRUD (`POST/GET/PATCH /users`, `GET /users/:id`) | ✓ | |
| Self-edit subset on `PATCH /users/:id` | ✓ | `requirePermissionOrSelf(USER_WRITE)` |
| Deactivation / reactivation | ✓ | Revokes all sessions; client deactivation cascades share-link revoke |
| Legacy single-role swap (`POST /users/:id/change-role`) | ✓ | Keeps `role` + `role_ids[0]` in lockstep |
| Admin-triggered password reset | ✓ | Reuses forgot/reset infrastructure; admin doesn't see the secret |
| Profile photo (self + admin-on-behalf) | ✓ | Two-step SAS upload, fixed 5 MiB cap, image-only allowlist |
| GDPR DSAR (`GET /users/:id/data-export`) | ✓ | Admin-only; NDJSON streaming (M43) |
| GDPR erasure (`POST /users/:id/data-erasure`) | ✓ | Anonymises user doc; preserves `_id` for referential integrity |
| `/users/assignable` directory picker | ✓ | Project-scoped (C6); used by task assignee dropdowns |
| MFA enrol/verify/disable | — | Auth module — endpoints live under `/auth/mfa*` |
| Sessions list + revoke | — | Auth module — `/auth/sessions*` |
| Password change (self-initiated) | — | Auth module — `/auth/change-password` |
| Multi-role assignment + custom roles | — | Roles & RBAC module |

---

## Roles & permissions

| Permission | Held by (default bundles) | Gates |
|---|---|---|
| `user.read` | Manager, Team Lead, Employee, Client(?) | `GET /users` (directory list); `GET /users/:id` for non-self callers |
| `user.write` | Admin, Manager | `POST /users`, `PATCH /users/:id` (admin-side), `POST /users/:id/reset-password`, all `/users/:id/profile-photo*` admin endpoints, `PATCH /users/:id` via `requirePermissionOrSelf` |
| `user.deactivate` | Admin (typically; also Manager per bundle) | `POST /users/:id/deactivate`, `POST /users/:id/reactivate` |
| `user.role_change` | Admin | `POST /users/:id/change-role` (legacy single-role swap) |
| `user.data_export` | Admin (granular — granted separately for legal/HR) | `GET /users/:id/data-export` |
| `user.data_erasure` | Admin (granular — separate from export so an org can grant audit-read without erasure) | `POST /users/:id/data-erasure` |

**`requirePermissionOrSelf(USER_WRITE)`** on `PATCH /users/:id` ([auth.middleware.ts](../../src/middlewares/auth.middleware.ts)) lets either:
- a caller with `USER_WRITE`, OR
- the user themself (`req.params.id === req.user.user_id`)

through. The service layer **re-checks** this (M2 defence-in-depth — `isAdminLike(caller) || isSelf`) so a future refactor that drops the middleware doesn't open the route.

### Self-edit field whitelist

Non-admin self-PATCH is restricted at the service layer to:

```ts
SELF_EDITABLE_FIELDS = {full_name, phone, timezone, slack_user_id, slack_notifications_enabled, internal_profile}
SELF_EDITABLE_INTERNAL_PROFILE_FIELDS = {emergency_contact}
```

A self-caller's PATCH gets stripped to these keys before mutation. Disallowed top-level fields are silently dropped; if every key in the patch is disallowed (e.g. self caller sending `{role: 'admin'}`) the service throws **403** with "No fields in this patch are editable by the caller". The Zod schema is liberal — it accepts every legal field — and authorization lives in the service.

---

## Data model

[`src/models/user.model.ts`](../../src/models/user.model.ts) — `users` collection. Single collection for **all** user types; role-specific fields live in sub-docs.

```ts
{
  _id, email (UNIQUE, lowercased, indexed), password_hash (select: false),
  full_name, phone?,
  profile_photo_blob_key,             // raw blob key; SAS URL minted per-read
  role,                                // legacy denormalised cache of role_keys[0]
  role_ids: ObjectId[],                // Step-47 RBAC — references to `roles` docs
  extra_permissions: string[],         // Step-47 Pattern B — per-user ad-hoc grants
  status,                              // 'active' | 'deactivated'
  timezone,                            // default 'Asia/Kolkata' (DEFAULT_TIMEZONE)
  slack_user_id, slack_notifications_enabled (default true),
  push_notifications_enabled (default true),
  comp_off_balance,                    // denormalised; reconciled nightly
  internal_profile?: {                 // admin/manager/team_lead/employee only
    employee_id, job_title, department,
    date_of_joining,                   // 'YYYY-MM-DD'
    reporting_manager_id,
    emergency_contact?: { name, phone, relation }
  },
  client_profile?: {                   // client only
    company_name, point_of_contact?,
    access_type: 'login' | 'readonly_link'
  },
  // MFA (opt-in, select: false on the secrets)
  mfa_enabled (default false),
  mfa_secret_encrypted (select: false),
  mfa_backup_codes_hashed (select: false),
  // Brute-force counters (select: false)
  failed_login_attempts, last_failed_login_at, locked_until,
  // Audit timestamps
  last_login_at, last_password_changed_at,
  created_by, deactivated_at, created_at, updated_at
}
```

### Sensitive fields

**T8** — these fields are `select: false` so a `.lean<UserDocument>()` doesn't accidentally pull them into a log line or response payload:

- `password_hash`
- `mfa_secret_encrypted`, `mfa_backup_codes_hashed`
- `failed_login_attempts`, `last_failed_login_at`, `locked_until`

Existing readers opt in via `+password_hash` projection. The model's `toJSON` runs `sensitiveToJSON(SENSITIVE_FIELDS)` so even a doc that was loaded with the sensitive fields gets them stripped from any serialised response.

### Indexes

- `{email: 1}` — unique (sole identifier on login)
- `{role: 1, status: 1}` — role-filtered list
- `{'internal_profile.reporting_manager_id': 1}` — "my reports" lookup
- `{'internal_profile.employee_id': 1}` — unique + sparse (employees only; clients exempt)
- `{status: 1, created_at: -1}` — **M39** — covers the default `GET /users` sort+predicate path; pre-M39 Mongo either collection-scanned or pulled `{role, status}` and in-memory sorted
- `{role: 1}` partial-unique on `{role: 'admin', status: 'active'}` — **R6 single-active-admin invariant backstop** (see below)
- Text index on `{full_name, email, internal_profile.employee_id, internal_profile.job_title}` — ahead of the Phase-4 `$text` migration; current list uses regex

### Single-active-admin invariant (R6)

The platform contract is **exactly one active admin per deployment**. `assertSingleAdmin` checks for an existing admin before `User.create` / `reactivateUser` / `changeUserRole` sets `role=admin`, but **two concurrent calls can both observe no existing admin and both insert** — a TOCTOU race the friendly check can't close.

The **partial-unique index** `{role: 1}` filtered on `{role: 'admin', status: 'active'}` makes the database the source of truth. Two concurrent inserts/updates with that tuple collide on E11000; the second one is caught by `isOneActiveAdminViolation(err)` and re-thrown as **409 `ADMIN_ALREADY_EXISTS`**. The partial filter means a *deactivated* admin doesn't block a fresh admin promotion, and non-admin users have no constraint here.

### Public projection

`toPublicUser(user, photoTtlMinutes)`:

1. `user.toJSON()` strips sensitive fields via `sensitiveToJSON`.
2. `profile_photo_blob_key` is **dropped** from the public surface (it's an internal storage pointer).
3. A freshly-minted, short-lived SAS URL is added as `profile_photo_url` via `signProfilePhotoUrl` — `null` when no photo OR Azure isn't configured.

The TTL knob (`system_settings.uploads.sas_token_ttl_minutes`) is passed in so list endpoints load it **once** and reuse the value across every row instead of hitting the settings collection per user.

---

## Endpoints

All under `/api/v1`, mounted by [`routes/user.routes.ts`](../../src/routes/user.routes.ts). Router-level `authenticate` is set once at the top.

### Directory

| Method | Path | Permission | Body / query |
|---|---|---|---|
| `GET` | `/users/assignable` | `authenticate` only | `?project_id=*&role=` — **C6** project_id REQUIRED |
| `GET` | `/users` | `user.read` | `?page&limit&role&exclude_role&status&show_deleted&q&sort` |
| `POST` | `/users` | `user.write` | `CreateUserBody` |
| `GET` | `/users/:id` | `authenticate` + service narrows (admin/manager/team_lead via `user.read` OR self) | — |
| `PATCH` | `/users/:id` | `requirePermissionOrSelf(USER_WRITE)` + service re-checks | `UpdateUserBody` (partial) |
| `POST` | `/users/:id/deactivate` | `user.deactivate` | `{reason?: string}` |
| `POST` | `/users/:id/reactivate` | `user.deactivate` | — |
| `POST` | `/users/:id/change-role` | `user.role_change` | `{new_role: RoleKey}` |
| `POST` | `/users/:id/reset-password` | `user.write` | — (no body — admin only triggers the email flow) |

### Profile photo

Two parallel surfaces: `/me/*` (caller is always the subject) and `/:id/*` (admin acts on behalf).

| Method | Path | Permission |
|---|---|---|
| `POST` | `/users/me/profile-photo-upload-url` | `authenticate` only |
| `POST` | `/users/me/profile-photo` (finalize) | `authenticate` only |
| `DELETE` | `/users/me/profile-photo` | `authenticate` only |
| `POST` | `/users/:id/profile-photo-upload-url` | `user.write` |
| `POST` | `/users/:id/profile-photo` (finalize) | `user.write` |
| `DELETE` | `/users/:id/profile-photo` | `user.write` |

### GDPR

| Method | Path | Permission |
|---|---|---|
| `GET` | `/users/:id/data-export` | `user.data_export` — admin only |
| `POST` | `/users/:id/data-erasure` | `user.data_erasure` — admin only |

### Multi-role assignment (Step-47 RBAC — documented here for completeness)

These two endpoints **live on the Role router** ([`role.routes.ts`](../../src/routes/role.routes.ts)) but operate on a user. Full mechanics are in `roles-rbac.md`:

| Method | Path | Permission |
|---|---|---|
| `PATCH` | `/users/:user_id/roles` | `user.role_change` |
| `PATCH` | `/users/:user_id/extra-permissions` | `user.role_change` |

---

## Detailed behaviour

### Create (`POST /users`)

[`createUser`](../../src/services/user.service.ts):

1. `assertPasswordPolicy(input.initial_password)` — runtime length + character-class check (surfaces as **422 `PASSWORD_POLICY_VIOLATION`**).
2. If `role === 'admin'`, `assertSingleAdmin()` — friendly check.
3. Email uniqueness check (cheap; a second-line defence is the unique index — **409 `EMAIL_ALREADY_EXISTS`**).
4. `hashPassword(input.initial_password)` (bcrypt).
5. Build the doc with role-specific sub-doc (`client_profile` for clients, `internal_profile` for everyone else).
6. **H1** — `withTransaction` wraps `User.create([doc], {session})` + `initializeBalancesForUserYear` so a balance-init failure rolls back the user too. Pre-H1 the balance init was best-effort; a quiet failure silently locked new joiners out until an admin re-ran init.
   - For internal users with `date_of_joining`, initialize leave balances for both `joining_year` AND `thisYear` (IST-anchored — `getUTCFullYear()` on Jan 1 IST would return last year).
7. If `withTransaction` throws E11000 on `one_active_admin`, the catch translates to **409 `ADMIN_ALREADY_EXISTS`** (R6 race protection).
8. Best-effort `notifyUserInvited({recipient_user_id, invited_by, initial_password})` — welcome email with creds. Logs `NOTIFICATION_DISPATCH_FAILED` if the mailer chokes; never blocks the create.
9. Audit `USER_CREATE` with `metadata: {created_role}`.

The `initial_password` is in plaintext in the request body. The **welcome email contains it** — by design, since the admin can't otherwise communicate it to the new user. Users are expected to change it on first login.

### List (`GET /users`)

[`listUsers`](../../src/services/user.service.ts):

- **BUG-002 soft-delete UX** — when `show_deleted` is absent AND no explicit `status` is set, the filter is forced to `status: 'active'`. An explicit `?status=deactivated` overrides (lets a permitted caller list only the deleted bucket). The **controller scrubs `show_deleted` + `status=deactivated`** for callers without `USER_WRITE` so non-privileged surfaces can't bypass the active-only default.
- Search `q` requires ≥ 2 chars (R15) — `$or` over `{email, full_name}` with regex specials escaped.
- **`role` and `exclude_role` are mutually exclusive** (validator-level — `.refine()` 400s if both set). `exclude_role` is for "internal staff only" surfaces (e.g. timesheets pickers hiding clients).
- **BUG-033** — sort spec always includes `_id: 1` as tiebreaker, even when sorting on a low-cardinality column like `status`. Without it, rows within a group come back in arbitrary storage order, making the same query return different orderings across page-flips ("shuffles"). Default sort is `{created_at: -1, _id: 1}`.
- Sortable fields whitelisted at validator level (`USER_SORT_FIELDS = {full_name, email, role, status, created_at}`) — sort param shape is `field:asc|desc`.
- Pagination: `page` 1-based, `limit` 1–100 (default 20). `meta.total_pages = Math.max(1, Math.ceil(total / limit))`.

### Get one (`GET /users/:id`)

The route gate is just `authenticate`. The controller narrows ([M1](../../src/controllers/user.controller.ts)):

```ts
const isPrivileged = callerHasPermission(req, PERMISSIONS.USER_READ);
if (!isPrivileged && !caller.equals(target)) throw 403;
```

So: admin/manager/team_lead see anyone via `user.read`; everyone else can fetch themself. Pre-M1 this compared `req.user.role` strings — a custom-role admin whose legacy `role` cache was something else got incorrectly 403'd despite holding `USER_READ`. The current `callerHasPermission` resolves against the full permission set.

### Patch (`PATCH /users/:id`)

Service layer (M2 + R4 defence-in-depth):

1. Load target. 404 if missing.
2. `isAdmin = isAdminLike({role: caller_role, role_keys: caller_role_keys})`. `isSelf = caller_id.equals(target._id)`. **403 if neither.**
3. **If not admin**: strip the patch to `SELF_EDITABLE_FIELDS` (top-level) and `SELF_EDITABLE_INTERNAL_PROFILE_FIELDS` (inside `internal_profile`). If the resulting patch is empty → **403 "No fields in this patch are editable by the caller"**.
4. Role/profile consistency:
   - `client_profile` set on a non-client → **422** "client_profile is only valid for a client user"
   - `internal_profile` set on a client → **422** "internal_profile is not valid for a client user"
5. Sub-doc patches use shallow merge (preserves unset fields). `reporting_manager_id` is coerced from hex string to ObjectId.
6. Save.

### Deactivate (`POST /users/:id/deactivate`)

[`deactivateUser`](../../src/services/user.service.ts):

1. **Self-deactivation refused** — `caller_id === target_id` → 403 "You cannot deactivate your own account". Prevents an admin from accidentally locking themselves out.
2. Idempotent — if already deactivated, returns the existing record (no-op success).
3. Set `status = 'deactivated'`, `deactivated_at = new Date()`. Save.
4. **`revokeAllRefreshTokens(target._id)`** — `RefreshToken.updateMany({user_id, revoked_at: null}, {revoked_at: new Date()})`. The user's existing sessions die on next refresh or immediately (when the access token expires).
5. **Step-24 cascade for clients** — `revokeLinksForDeactivatedClient({client_id, revoked_by, audit})` revokes any public share-links the deactivated client created. Audit metadata captures `share_links_revoked: <count>`.
6. Audit `USER_DEACTIVATE`. Metadata carries optional `reason` and `share_links_revoked` (clients only).

### Reactivate (`POST /users/:id/reactivate`)

1. 404 if missing.
2. Idempotent — if already active, returns the record.
3. **If `role === 'admin'`**: `assertSingleAdmin(target._id)` checks for any *other* active admin. Re-throws `ADMIN_ALREADY_EXISTS` on E11000 (R6).
4. Set `status = 'active'`, `deactivated_at = null`. Save.
5. Audit `USER_REACTIVATE`.

Refresh tokens are **not** re-issued — the reactivated user must log in again.

### Change role (legacy, `POST /users/:id/change-role`)

[`changeUserRole`](../../src/services/user.service.ts):

1. **Self-role-change refused** — 403 "You cannot change your own role".
2. 404 if target missing.
3. No-op if `target.role === new_role`.
4. If `new_role === 'admin'`, `assertSingleAdmin(target._id)`.
5. **Cross-axis swap refused** — client ↔ non-client transitions via this endpoint throw **422**: "Cannot change role between client and non-client via this endpoint — deactivate and recreate the user instead." Different sub-doc shapes (`client_profile` vs `internal_profile`) would be left stale.
6. Set `target.role = new_role`. **Reset `role_ids` to `[new_system_role._id]`** via `getSystemRoleByKey(new_role)` — keeps legacy `role` and Step-47 `role_ids` in lockstep (without this, the legacy endpoint leaves `role = 'manager'` but `role_ids = [employee_role_id]`, and `requirePermission` 403s privileged routes because the resolved permission union is the OLD role's set).
7. Save (E11000-translates to `ADMIN_ALREADY_EXISTS` on R6 race).
8. **`revokeAllRefreshTokens(target._id)`** — old role might have permissions the new role doesn't; force the user to re-login so the JWT carries the new bundle.
9. Audit `USER_ROLE_CHANGE` with `before: {role, role_ids}` and `after: {role, role_ids}`.

For multi-role assignment use `PATCH /users/:user_id/roles` (Roles & RBAC module). This legacy endpoint is single-role-only.

### Admin-triggered password reset (`POST /users/:id/reset-password`)

[`postAdminResetPassword`](../../src/controllers/user.controller.ts) → [`adminInitiatePasswordReset`](../../src/services/password-reset.service.ts) (in the Auth module).

Mints a one-time reset token for the target user and emails them a link. **The link is NOT in the response** — the admin's job is to *trigger* the reset, not see the secret. Audited as `auth.admin_password_reset` with the admin as actor; when the user consumes the link, a separate `auth.password_reset` audit records the user as actor.

Reuses the same forgot/reset infrastructure as the user-initiated `/auth/forgot-password` flow; only the actor and audit action differ. Returns `204` (no body).

### Profile photo

[`profile-photo.service.ts`](../../src/services/profile-photo.service.ts). Separate from `task-attachment.service` because:

- **Data model is different** — no `task_attachments`-style row. Each user owns at most one current photo, identified by `users.profile_photo_blob_key`. Re-uploading **replaces the pointer in place** + best-effort deletes the old blob.
- **Policy is fixed in code**, not driven by `system_settings.uploads`. An image-only allowlist + 5 MiB hard cap. Constants in [`profile-photo.ts`](../../src/constants/profile-photo.ts) — an admin can't widen this and admit a scriptable type like `image/svg+xml`.

#### Two-step flow

1. **`POST /users/me/profile-photo-upload-url`** (or `/users/:id/...` for admin):
   - `assertAzureConfigured()` → 503 `STORAGE_NOT_CONFIGURED` if missing
   - `assertSizeAllowed(input.file_size)` against `PROFILE_PHOTO_MAX_BYTES` (5 MiB)
   - `assertMimeAllowed(input.mime_type)` against `PROFILE_PHOTO_ALLOWED_MIME_TYPES` (case-insensitive lookup — RFC 2045 §5.1)
   - `buildBlobKey(subjectId, fileName)` → `users/{subjectId}/{ulid}-{safe_filename}`
   - `mintUploadSas({container, blobKey, ttlMinutes, contentType})` — write-only SAS with `Content-Type` pinned
2. **FE PUTs raw bytes** to `upload_url` with `x-ms-blob-type: BlockBlob` + the exact `Content-Type` from `required_headers`. No bearer token.
3. **`POST /users/me/profile-photo`** (finalize):
   - Re-validate size + MIME against the **current** policy (admin may have changed it between mint and finalize)
   - **Path validation** — `blob_key` must start with `users/{subjectId}/` AND `blob_container` must match `AZURE_BLOB_PROFILE_PHOTOS_CONTAINER`. Mismatch → 422 `ATTACHMENT_BLOB_KEY_MISMATCH`. Defends against finalizing a key minted for someone else.
   - `headBlob(...)` → 422 `ATTACHMENT_BLOB_MISSING` if the blob isn't there; 422 `ATTACHMENT_SIZE_MISMATCH` if Azure size != claimed size. Re-check policy against actual size.
   - **Pointer swap** — set `user.profile_photo_blob_key = input.blob_key`, save.
   - **Best-effort delete previous blob** — done after the pointer swap so a transient Azure failure can't leave the user pointing at a deleted blob. The new blob is already verified.

#### Admin-on-behalf

The `/users/:id/profile-photo*` routes pass `targetUserId` to the same service functions. The audit actor is still the admin (`caller.audit`), but the `blob_key` is namespaced under the **subject's** id, not the actor's. The path-prefix validation uses the subject id too.

#### Clear (`DELETE /users/me/profile-photo` or `/users/:id/profile-photo`)

Idempotent. If no current photo → no-op. Otherwise: set `profile_photo_blob_key = null`, save, best-effort `deleteBlob(...)`. If Azure isn't configured, logs `STORAGE_NOT_CONFIGURED` and still nulls the pointer.

#### `signProfilePhotoUrl(blobKey, ttlMinutes)`

Used by `toPublicUser`. Returns `null` when no photo OR Azure isn't configured (callers serialising for `/auth/me`, `/users/:id`, `GET /users` must not fail when the platform is being bootstrapped without storage — a missing avatar is the correct fallback). Otherwise returns a SAS URL that the FE can drop into `<img src>` until `expires_at`. **No `Content-Disposition` override** — profile photos render inline.

Known limitations (accepted; Phase-3 reconciliation pass):
- **Orphan blob on transient mongo failure** — pointer swap happens AFTER blob verification. If `save()` throws, the blob exists with no DB pointer. Wasted storage but no user impact.
- **Concurrent finalize + DELETE for the same user** — find/save isn't atomic. Self-inflicted race; `findOneAndUpdate` with a guard would close it cleanly when revisited.

### `/users/assignable`

[`listAssignable`](../../src/services/user.service.ts) — used by task assignee dropdowns. **C6 pre-fix** this returned the full non-client user directory (up to 500 users) to any authenticated caller, including clients. Post-fix:

- `project_id` is **required** at the validator layer
- Service loads the project + asserts caller can read it (mirrors `project.service.assertCallerCanRead`):
  - admin/manager: all projects
  - team_lead/employee: only projects where `member_ids ∋ caller.id`
  - client: only projects where `client_ids ∋ caller.id`
- Returns active users whose `_id ∈ project.member_ids` (or matches the optional `role` filter)
- Default `?role` omitted → excludes clients
- Capped at 500, sorted by `full_name`
- Projection: `{id, full_name, role, job_title}` (job_title from `internal_profile`)

---

## GDPR

[`user-gdpr.service.ts`](../../src/services/user-gdpr.service.ts) — admin-only DSAR + right-to-erasure.

### Export

**`GET /users/:id/data-export`** streams NDJSON (`application/x-ndjson`) — **M43** — one row per line. Pre-M43 the JSON-tree variant `exportUserData` ran 12 unbounded `.find().lean()` queries in parallel and returned the whole tree as one JS object. For a 3-year-tenured user that's ~50k audit rows × ~1KB = ~50 MB resident before serialisation; a single concurrent export could pin a worker for seconds and OOM on a 256-MB heap.

Streaming flow:
1. **`meta` line** — `{kind: 'meta', exported_at, user_id, refresh_tokens_active_count}`
2. **`user` line** — `{kind: 'user', data: <safeUser>}` — safe user is the doc with `password_hash`, `mfa_secret_encrypted`, `mfa_backup_codes_hashed` stripped. These are creds, not GDPR "user data"; an export with a bcrypt hash in it is a credential-leak vector if mishandled downstream.
3. **Per-collection cursor walk** — 14 collections processed sequentially, each as a Mongoose cursor:
   - `attendance_record` (by `user_id`)
   - `attendance_correction_request` (by `user_id`)
   - `leave_request` (by `user_id`)
   - `leave_balance` (by `user_id`)
   - `comp_off_ledger` (by `user_id`)
   - `notification` (by `user_id`)
   - `task_comment` (by `author_id`)
   - `task_activity` (by `actor_id`)
   - `timesheet_entry` (by `user_id`)
   - `audit_log_actor` (by `actor_id`)
   - `audit_log_target` (by `target_entity.kind = 'user', target_entity.id`)
   - `report_preset` (by `created_by`)
   - `report_subscription` (by `created_by`)
   - `report_export` (by `requested_by`)
   - Each row written as `{kind, data}` with `__v` stripped.
4. **`meta_end` line** — `{kind: 'meta_end', row_counts: {...}}` so a consumer can verify completeness.

Memory bounded by the cursor's batch size (Mongoose default 1000) × row size. Audit row written via the controller after the stream ends: `USER_DATA_EXPORT` with `metadata: {collections_count, row_counts}`.

The non-streaming `exportUserData` (returns the full tree as a JS object) is **kept** for the existing unit tests + any in-process caller; only the HTTP controller switches over.

### Erasure

**`POST /users/:id/data-erasure`** — anonymises the user document while preserving `_id` for referential integrity.

Design decisions (captured so future contributors don't "delete more aggressively"):

| Decision | Rationale |
|---|---|
| **DO NOT hard-delete audit rows** | GDPR allows retention for legal compliance; audit is the basis for every forensic investigation |
| **DO NOT hard-delete tasks / leave / comments** | Business records, may be referenced by other users (e.g. a task assigned to me) |
| **DO delete refresh + reset tokens** | Pure authentication artifacts; dangerous lingering creds once the user is gone |
| **DO delete profile-photo blob** | Image is unique to the user, not a business record |

Anonymisation payload ([`buildAnonPayload`](../../src/services/user-gdpr.service.ts)):

```ts
{
  full_name: `Deleted user ${stamp}`,               // stamp = last 8 chars of _id
  email: `deleted-${stamp}@anonymised.invalid`,     // unique (can't be null — email is unique-indexed)
  phone: null,
  slack_user_id: null,
  slack_notifications_enabled: false,
  profile_photo_blob_key: null,
  'internal_profile.employee_id': `DEL-${stamp}`,   // dotted-path sub-doc surgery
  'internal_profile.emergency_contact': null,
  'client_profile.point_of_contact': null,
  password_hash: 'erased',                           // locks the account; synthetic email can't reset
  mfa_enabled: false, mfa_secret_encrypted: null, mfa_backup_codes_hashed: [],
  deactivated_at: new Date(),
  status: USER_STATUSES.DEACTIVATED,                 // T7 — was 'disabled' string (out-of-enum, silently accepted by updateOne)
}
```

The stamp is **stable per user** — re-running erasure produces the same shape (idempotent). It's `_id`-derived, not a counter — counters would leak how many users have been erased.

Operation order:
1. Revoke every active refresh token — `RefreshToken.updateMany({user_id, revoked_at: null}, {revoked_at: new Date()})`
2. Delete password-reset tokens — `PasswordResetToken.deleteMany({user_id})`
3. Anonymise the user document (`User.updateOne({_id}, {$set: anon})`)
4. **R1 profile-photo blob delete** — best-effort. If Azure isn't configured, logs `STORAGE_NOT_CONFIGURED`. If the blob delete fails, `PROFILE_PHOTO_BLOB_DELETE_FAILED` at warn; **re-running erasure retries the blob delete idempotently** (the doc-side anonymisation is a no-op the second time).
5. Audit `USER_DATA_ERASE` with `before: {email, full_name, phone, status}`, `after: {email, full_name, status}` (anonymised), `metadata: {sessions_revoked, reset_tokens_deleted, profile_photo_blob_deleted}`. The before-snapshot makes the operation trivially reversible at audit-review time IF legal requires it.

---

## Audit actions produced

| Action | When |
|---|---|
| `USER_CREATE` | `POST /users` — metadata: `created_role` |
| `USER_DEACTIVATE` | `POST /users/:id/deactivate` — metadata: `reason?`, `share_links_revoked` (clients) |
| `USER_REACTIVATE` | `POST /users/:id/reactivate` |
| `USER_ROLE_CHANGE` | `POST /users/:id/change-role` — before/after: `{role, role_ids}` |
| `USER_PROFILE_PHOTO_SET` | Finalize profile photo (self or admin) — metadata: `{blob_key, previous_blob_key, size_bytes, mime_type}` |
| `USER_PROFILE_PHOTO_CLEAR` | Delete profile photo — metadata: `{previous_blob_key}` |
| `USER_DATA_EXPORT` | `GET /users/:id/data-export` — metadata: `{collections_count, row_counts}` |
| `USER_DATA_ERASE` | `POST /users/:id/data-erasure` — before/after: `{email, full_name, status}`, metadata: `{sessions_revoked, reset_tokens_deleted, profile_photo_blob_deleted}` |
| `auth.admin_password_reset` | `POST /users/:id/reset-password` — actor is admin; downstream `auth.password_reset` records user actor when link consumed |

PATCH `/users/:id` does **not** emit an audit row in the current implementation (gap — PATCH should ideally write `USER_UPDATE`).

---

## Error codes produced

| Code | HTTP | When |
|---|---|---|
| `USER_NOT_FOUND` | 404 | `findById` miss |
| `EMAIL_ALREADY_EXISTS` | 409 | Duplicate email at create |
| `ADMIN_ALREADY_EXISTS` | 409 | R6 — create/reactivate/change-role would produce a second active admin |
| `PASSWORD_POLICY_VIOLATION` | 422 | `initial_password` fails length / character-class check |
| `FORBIDDEN` | 403 | Self-deactivate; self-role-change; self-PATCH with no editable fields; non-admin non-self PATCH; cross-axis role swap |
| `VALIDATION_ERROR` | 400 | Profile/role mismatch (e.g. `client_profile` on non-client); cross-axis role swap |
| `STORAGE_NOT_CONFIGURED` | 503 | Profile-photo endpoints when Azure isn't wired |
| `FILE_TOO_LARGE` | 422 | Profile photo > 5 MiB |
| `FILE_TYPE_NOT_ALLOWED` | 422 | Profile photo MIME not in `PROFILE_PHOTO_ALLOWED_MIME_TYPES` |
| `ATTACHMENT_BLOB_KEY_MISMATCH` | 422 | Profile-photo finalize path doesn't match `users/{subjectId}/` |
| `ATTACHMENT_BLOB_MISSING` | 422 | Profile-photo finalize but no blob exists at the supplied key |
| `ATTACHMENT_SIZE_MISMATCH` | 422 | Profile-photo Azure size != claimed size |
| `RESOURCE_NOT_FOUND` | 404 | GDPR export/erasure target missing; `/users/assignable` unknown project_id |
| `INVALID_PROJECT_MEMBER_ROLE` | 422 | (Forwarded from `project.service` when create flows touch project rosters) |

---

## End-to-end flows

### Admin creates a new employee

1. Admin POSTs `/api/v1/users` with `{email, full_name, role: 'employee', initial_password, internal_profile: {employee_id, job_title, department, date_of_joining: '2026-04-01', ...}}`.
2. `validate({body: createUserBodySchema})` — `email` lowercased; `phone` E.164-normalised via libphonenumber-js (BUG-044); `timezone` validated against IANA (BUG-045); `internal_profile` required for non-client roles (`.superRefine`).
3. Controller calls `createUser`.
4. `assertPasswordPolicy(initial_password)` runs.
5. `User.exists({email})` → uniqueness check.
6. `hashPassword(initial_password)` (bcrypt).
7. `withTransaction`:
   - `User.create([doc], {session})` writes the row.
   - `initializeBalancesForUserYear` runs twice — for `joining_year` (2026) and `thisYear` (e.g. 2026 — same).
8. `notifyUserInvited({recipient_user_id, invited_by, initial_password})` — best-effort welcome email.
9. Audit `USER_CREATE`.
10. Response: `201 toPublicUser(...)` with a freshly-signed `profile_photo_url: null` (no photo yet).

### Employee updates their own phone number

1. Employee PATCHes `/api/v1/users/{ownId}` with `{phone: '+15555550123', role: 'admin'}` (attempting privilege escalation).
2. `validate` passes — Zod schema is liberal.
3. `requirePermissionOrSelf(USER_WRITE)` passes (caller is self).
4. Service: `isAdmin = false`, `isSelf = true`.
5. **Patch stripping** — `{phone, role}` → `phone` survives the `SELF_EDITABLE_FIELDS` filter; `role` is dropped silently.
6. `target.phone = '+15555550123'` ; save.
7. Response: 200 `toPublicUser(target)`.

Same call as admin would PATCH the role — the route returns the patched user with the new role. The Zod schema doesn't include `role`, so a self-caller's "role" key is dropped silently and never even reaches the stripping step. (Adding `role` to the schema would let an admin patch it through `/users/:id`, but currently roles only change via `POST /users/:id/change-role` or `PATCH /users/:user_id/roles`.)

### Admin deactivates a Client

1. Admin POSTs `/api/v1/users/{clientId}/deactivate` with `{reason: 'contract ended'}`.
2. `requirePermission(user.deactivate)` passes.
3. Service: caller is not target (admin can't deactivate self). Target's role is `client`.
4. `status = 'deactivated'`, `deactivated_at = new Date()`. Save.
5. `revokeAllRefreshTokens(target._id)` — client's existing logins die.
6. **Step-24 cascade** — `revokeLinksForDeactivatedClient({client_id, revoked_by, audit})` revokes every public share-link the client created. Returns `{revoked_count: 3}`.
7. Audit `USER_DEACTIVATE`, metadata `{reason: 'contract ended', share_links_revoked: 3}`.

### GDPR DSAR export for a 2-year-tenured employee

1. Legal (with `USER_DATA_EXPORT` grant) hits `GET /api/v1/users/{id}/data-export`.
2. Controller sets `Content-Type: application/x-ndjson; charset=utf-8`, `Content-Disposition: attachment; filename="user-<id>-data-export.ndjson"`, `Cache-Control: no-store`.
3. Service writes `meta` line → `user` line (with credentials stripped) → cursors over 14 collections sequentially, one JSONL line per row.
4. Service ends with `meta_end` line including `row_counts`.
5. Controller calls `recordAudit(USER_DATA_EXPORT, metadata: {collections_count, row_counts})` (after the stream ends).
6. Response stream completes. The actor's NDJSON file is downloaded by their browser.

Memory bounded by Mongoose's default 1000-row cursor batch.

### GDPR right-to-erasure

1. Admin (with `USER_DATA_ERASURE`) POSTs `/api/v1/users/{id}/data-erasure`.
2. Service loads user → captures `previousPhotoBlobKey`.
3. `RefreshToken.updateMany(...)` — revoke active sessions.
4. `PasswordResetToken.deleteMany(...)`.
5. `User.updateOne({_id}, {$set: anonPayload})` — anonymise.
6. Best-effort `deleteBlob(profile-photos, previousPhotoBlobKey)` — set `profile_photo_blob_deleted: true/false` in audit metadata.
7. Audit `USER_DATA_ERASE`. Includes `before: {email, full_name, phone, status}` for legal reversibility.
8. Response: `{user_id, anonymised_at, sessions_revoked, reset_tokens_deleted, profile_photo_blob_deleted}`.

### R6 race — two admins try to promote a user simultaneously

1. Admin A POSTs `/users/userX/change-role` with `{new_role: 'admin'}`.
2. Admin B POSTs `/users/userY/change-role` with `{new_role: 'admin'}` at the same instant.
3. Both pass `assertSingleAdmin` (no other admin exists at observation time).
4. Both try to save. One succeeds. The other gets E11000 on the `one_active_admin` partial-unique index.
5. `isOneActiveAdminViolation(err)` catches it; service re-throws **409 `ADMIN_ALREADY_EXISTS`**.
6. The losing admin sees the error; the user they tried to promote still has the old role.

---

## Gotchas

| # | Behaviour | Why |
|---|---|---|
| 1 | `password_hash`, MFA secrets, brute-force counters are `select: false` (T8) | A future `.lean<UserDocument>()` can't accidentally pull them into a log line or response |
| 2 | `email` is lowercased + unique + indexed | Case-insensitive de-facto uniqueness; sole login identifier |
| 3 | `internal_profile.employee_id` is **unique + sparse** | Clients have no `internal_profile`; sparse index lets them skip the constraint |
| 4 | **Exactly one active admin** invariant enforced via partial-unique index (R6) | The friendly `assertSingleAdmin` check can race; the index is the source of truth |
| 5 | `assertSingleAdmin` is called on create, reactivate, change-role | All three paths can produce a new active admin |
| 6 | Self-deactivate is **refused** | An admin accidentally locking themselves out would be unrecoverable on a single-tenant deployment |
| 7 | Self-role-change is **refused** | Avoids privilege-escalation foot-guns; admin must be changed by another admin |
| 8 | Cross-axis role swap (client ↔ non-client) is **refused** via `change-role` | Different sub-doc shapes; admin must deactivate + recreate |
| 9 | `change-role` resets `role_ids` to `[new_system_role._id]` | Keeps legacy `role` and Step-47 `role_ids` in lockstep — otherwise `requirePermission` 403s privileged routes |
| 10 | Self-PATCH whitelist is enforced at the **service**, not the Zod schema | Schema is liberal so the same endpoint serves admin + self; service strips disallowed keys |
| 11 | Deactivation revokes **all** refresh tokens; reactivation does **not** issue new ones | Reactivated user must re-login |
| 12 | Client deactivation **cascades** to share-link revocation | The deactivated client's tokens can't log in, but their share links are still publicly resolvable until revoked (Step 24) |
| 13 | `GET /users` defaults to `status: active` when `show_deleted` and `status` are both absent | BUG-002 soft-delete UX; controller scrubs `show_deleted` for non-`USER_WRITE` callers |
| 14 | List sort always carries `_id` as tiebreaker (BUG-033) | Low-cardinality sort columns would otherwise return different orderings across page-flips |
| 15 | `role` and `exclude_role` query params are mutually exclusive (`.refine` 400s) | Avoids ambiguity at the validator layer |
| 16 | `GET /users/:id` is `authenticate`-only at the route; controller narrows to `USER_READ` OR self (M1) | Custom-role admin without legacy `role === 'admin'` still passes via `callerHasPermission` |
| 17 | `PATCH /users/:id` uses `requirePermissionOrSelf(USER_WRITE)` (M2) + service re-checks via `isAdminLike || isSelf` | Defence-in-depth — service guard wouldn't survive a route refactor alone |
| 18 | `R4` — service-layer `isAdminLike` reads `role_keys` so a custom-role admin whose legacy `role` cache is something else still passes | Step-47 RBAC propagation |
| 19 | Profile photo policy is fixed in code (5 MiB, image-only), not driven by `system_settings.uploads` | An admin can't widen and admit scriptable types like `image/svg+xml` |
| 20 | Profile-photo finalize path-prefix is `users/{subjectId}/`, not `users/{caller.id}/` for admin uploads | Admin acts on behalf; subject's id is the namespace |
| 21 | Profile-photo `signProfilePhotoUrl` returns `null` (not 503) when Azure isn't configured | Bootstrap deployments must serialise users without storage; a missing avatar is the correct fallback |
| 22 | Old profile-photo blob is deleted **after** the pointer swap, not before | A transient Azure failure mid-delete can't leave the user pointing at a deleted blob |
| 23 | GDPR export streams NDJSON (M43), one row per line | Pre-M43 the full tree was materialised in memory — could OOM on a 256-MB heap for a tenured user |
| 24 | GDPR erasure keeps `_id` + anonymises the doc; does NOT delete tasks/leave/audit rows | Business records must survive; user identity is gone via the anonymised user doc |
| 25 | GDPR erasure uses dotted-path `$set` for sub-doc PII so `updateOne` skips validators | Direct surgery on `internal_profile.employee_id` etc.; T7 fix uses canonical `USER_STATUSES.DEACTIVATED` not the out-of-enum `'disabled'` |
| 26 | GDPR erasure is **idempotent** — re-running on an already-erased user is a no-op on the doc; retries the blob delete | Audit row written every time the operation runs |
| 27 | Anonymised email is `deleted-{stamp}@anonymised.invalid` where stamp = last 8 chars of `_id` | Unique-indexed email can't be null; stamp is stable per-user (re-runs idempotent) and not a counter (no count-leak) |
| 28 | Admin-triggered password reset does NOT return the link | Admin can trigger but not see the secret; user must consume the link via email |
| 29 | `/users/assignable` requires `project_id` (C6 fix) | Pre-fix it returned the full user directory to any authenticated caller including clients |
| 30 | `notifyUserInvited` and audit writes happen AFTER the create transaction commits | External / logging side effects shouldn't dictate atomicity of the user-create + balance-init pair (H1) |
