# Roles & RBAC — Backend

The **Roles & RBAC** module owns the permission catalog, the `roles` collection, the boot-time system-role seeder, the bootstrap migration that back-assigns `role_ids[]` to legacy users, custom-role CRUD, and the per-user role + extra-permission assignment endpoints. **`requirePermission(...)` middleware itself** is in the Auth module — see [`auth.md`](./auth.md). This module owns the **catalog** + the **assignment layer** that fills the JWT's `permissions[]` claim.

For how permissions are consumed inside a specific feature, see the corresponding module doc (each one has a "Roles & permissions" section). For the `authenticate` middleware, JWT design, and the `isCallerAdmin` check, see [`auth.md`](./auth.md).

---

## Scope

| Surface | In scope | Notes |
|---|---|---|
| Permission catalog (60 constants) | ✓ | `constants/permissions.ts` |
| 5 system roles + their permission bundles | ✓ | `constants/system-role-definitions.ts` |
| `roles` collection (key, display_name, description, permissions, is_system) | ✓ | |
| System-role seeder (`seedSystemRoles`) | ✓ | Idempotent; runs on boot + lazy on first lookup |
| Bootstrap migration (back-assign `role_ids`) | ✓ | One-time-per-user — also self-heals on login |
| Custom-role CRUD | ✓ | `POST/GET/PATCH/DELETE /roles` |
| Multi-role assignment (`PATCH /users/:user_id/roles`) | ✓ | Replace, not merge |
| Per-user extra-permissions (`PATCH /users/:user_id/extra-permissions`) | ✓ | Pattern B |
| Permission resolution at login + refresh (`resolvePermissionsForUser`) | ✓ | Role bundle ∪ extras |
| Service-layer `isAdminLike` / `isProjectAuthor` helpers | ✓ | `utils/role-check.ts` |
| `requirePermission` / `requirePermissionOrSelf` middleware | — | [`auth.md`](./auth.md) |
| JWT permission claim mechanics | — | [`auth.md`](./auth.md) |

---

## Permission catalog

[`src/constants/permissions.ts`](../../src/constants/permissions.ts) — **60 permission constants**. Naming: `<resource>.<verb>` dot-separated.

### Verb conventions

| Verb | Usage |
|---|---|
| `read` | list / get / detail |
| `write` | create / update / patch (bundled — splitting them produces 150+ entries with no real authorization daylight) |
| `delete` | when separate from write |
| Special verbs | `approve`, `archive`, `correction_approve`, `data_export`, `data_erasure`, `edit_out_of_window`, `read_team`, `check_in_out`, `slack_write`, etc. — exist where the RBAC contract genuinely separates operations |

### The wildcard

**`system.admin`** — held by the seeded Admin role only. The [`requirePermission`](../../src/middlewares/auth.middleware.ts) middleware treats it as "satisfies any permission check" via fast-path short-circuit. Per-row visibility scoping (`buildProjectVisibilityFilter`, etc.) keeps using the `role_keys.includes('admin')` check separately — see `auth.md`'s "Login flow" section.

### Catalog by domain

| Domain | Permissions |
|---|---|
| **Wildcard** | `system.admin` |
| **Users** | `user.read`, `user.write`, `user.deactivate`, `user.role_change`, `user.data_export`, `user.data_erasure` |
| **Roles** | `role.read`, `role.write`, `role.delete` |
| **Projects + structure** | `project.read`, `project.write`, `project.archive`, `project.members_write`, `project.clients_write`, `sprint.write`, `story.write` |
| **Tasks + collaboration** | `task.read`, `task.write`, `task_comment.write`, `task_attachment.write` |
| **Task templates** | `task_template.read`, `task_template.write` |
| **Timesheets + billing** | `timesheet.read`, `timesheet.write`, `timesheet.edit_out_of_window`, `billing_rate.read`, `billing_rate.write` |
| **Attendance** | `attendance.read_team`, `attendance.check_in_out`, `attendance.correction_request`, `attendance.correction_approve` |
| **Leaves** | `leave_type.read`, `leave_type.write`, `leave_balance.read_team`, `leave_balance.adjust`, `leave_request.read_team`, `leave_request.write`, `leave_request.approve`, `comp_off.read`, `comp_off.write` |
| **Holidays + office locations** | `holiday.read`, `holiday.write`, `office_location.read`, `office_location.write` |
| **Reports + exports** | `report.read`, `report_export.write` |
| **Audit + archive** | `audit_log.read`, `audit_archive.read` |
| **System settings** | `settings.read`, `settings.write`, `settings.slack_write` |
| **Project share-links** | `share_link.write` |
| **Dashboards** | `dashboard.admin`, `dashboard.manager`, `dashboard.employee`, `dashboard.client` |

**M3 removals** — `attendance.read_own`, `leave_balance.read_own`, `leave_request.read_own` were dead: catalogued + assigned, but no route ever called `requirePermission(...READ_OWN)`. The matching `/me*` endpoints already owner-scope at the service layer, so adding gates would be no-ops because every authed user held the bits. Removed to clean up the FE Roles UI; route-layer behaviour is unchanged.

### Adding a new permission

1. Append a constant to `PERMISSIONS` in [`constants/permissions.ts`](../../src/constants/permissions.ts).
2. Add it to the relevant system role's permission set in [`constants/system-role-definitions.ts`](../../src/constants/system-role-definitions.ts).
3. Mirror the constant in [`viljetech-platform-frontend/src/lib/permissions.ts`](../../../viljetech-platform-frontend/src/lib/permissions.ts) (BE remains the enforcing source of truth, but the FE drives UI visibility).
4. Wire the route — `requirePermission(PERMISSIONS.NEW_THING)` in the relevant `routes/*.routes.ts`.

The boot seeder reconciles role permissions on next start (adds new entries automatically). **Removals** are a privilege downgrade for active users and need a manual migration step.

---

## Data model

[`src/models/role.model.ts`](../../src/models/role.model.ts) — `roles` collection.

```ts
{
  _id, key (UNIQUE, lowercased, regex `^[a-z][a-z0-9_-]{0,39}$`),
  display_name (1–100 chars),
  description (≤ 500 chars),
  permissions: string[]   // validated against PERMISSION_VALUES allowlist
  is_system: boolean      // true for the 5 seeded roles, false for custom
  created_by, updated_by, created_at, updated_at
}
```

The `key` field is the **stable identifier** used by `caller.role_keys` checks at the service layer (where row-visibility scoping needs to know "is this caller an admin / manager" without resolving every permission bit). It mirrors the legacy `ROLES` enum strings (`admin`, `manager`, `team_lead`, `employee`, `client`) for the system roles so service code that branches on `caller.role_keys.includes('admin')` continues to work after the Step-47 migration.

Permissions are validated **at the schema layer** against `PERMISSION_VALUES` — a future code change that removes a permission constant would prevent the existing role doc from saving until the role is patched. The model's index list is intentionally minimal: `key` has a field-level unique index; the hot path is "resolve `user.role_ids[]` → role docs" which uses the implicit `_id` index.

---

## System roles

[`src/constants/system-role-definitions.ts`](../../src/constants/system-role-definitions.ts). Five system roles. The migration is **non-breaking by construction** for the four legacy roles — each system role's permission list is derived from the pre-Step-47 route allowlists, so a user whose pre-migration `role === 'admin'` gets exactly the permissions admin-only routes required.

### Bundle composition

Three composition tiers:

```
EMPLOYEE_BASE        →  USER_READ, PROJECT_READ, TASK_READ, TASK_WRITE,
                        TASK_COMMENT_WRITE, TASK_ATTACHMENT_WRITE,
                        TASK_TEMPLATE_READ, TIMESHEET_WRITE,
                        ATTENDANCE_CHECK_IN_OUT, ATTENDANCE_CORRECTION_REQUEST,
                        LEAVE_TYPE_READ, LEAVE_REQUEST_WRITE,
                        COMP_OFF_READ, COMP_OFF_WRITE,
                        HOLIDAY_READ, OFFICE_LOCATION_READ,
                        SETTINGS_READ, DASHBOARD_EMPLOYEE
                        (18 perms — what every internal user gets)

TEAM_LEAD_ADDITIONS  →  LEAVE_REQUEST_READ_TEAM, LEAVE_REQUEST_APPROVE,
                        ATTENDANCE_READ_TEAM, ATTENDANCE_CORRECTION_APPROVE,
                        TIMESHEET_READ, PROJECT_WRITE, PROJECT_ARCHIVE,
                        PROJECT_MEMBERS_WRITE, SPRINT_WRITE, STORY_WRITE,
                        TASK_TEMPLATE_WRITE, SHARE_LINK_WRITE,
                        DASHBOARD_MANAGER, ROLE_READ
                        (14 perms — first-line approvals + project authoring)

MANAGER_ADDITIONS    →  PROJECT_CLIENTS_WRITE, BILLING_RATE_READ,
                        REPORT_READ, REPORT_EXPORT_WRITE,
                        LEAVE_BALANCE_READ_TEAM, TIMESHEET_EDIT_OUT_OF_WINDOW
                        (6 perms — reports + billing + clients + admin overrides)
```

### Resolved bundles

| Role | Key | Permissions |
|---|---|---|
| **Admin** | `admin` | **just** `system.admin` (the wildcard handles everything via middleware short-circuit; listing every individual permission here would drift over time) |
| **Manager** | `manager` | EMPLOYEE_BASE ∪ TEAM_LEAD_ADDITIONS ∪ MANAGER_ADDITIONS = 38 perms |
| **Team Lead** | `team_lead` | EMPLOYEE_BASE ∪ TEAM_LEAD_ADDITIONS = 32 perms |
| **Employee** | `employee` | EMPLOYEE_BASE = 18 perms |
| **Client** | `client` | `project.read`, `task.read`, `task_comment.write`, `task_attachment.write`, `holiday.read`, `leave_type.read`, `settings.read`, `dashboard.client` (8 perms — read-only project view + task collaboration) |

### What Team Lead does NOT get (deliberate)

These stay manager-and-above:
- Billing rates (`billing_rate.*`) — financial surface
- Reports (`report.read`) — cross-team rollups
- User management (`user.write`, `user.deactivate`, `user.role_change`)
- Leave-balance adjust + leave-type CRUD
- Holiday / office-location writes
- Settings / audit / role CRUD

The per-row visibility filter at the service layer (e.g. `buildProjectVisibilityFilter`) **still scopes** Team Lead reads/writes to projects they're members of — same as Employee. The difference is what verbs they're allowed to run inside those projects (project author vs. IC), not how widely they see.

**BUG-039** — Team Lead holds `role.read` so the Roles tab on `/admin/users/:id` can render for them. Strictly metadata read; the writes (role assignment / extras) remain admin-only via `user.write` + `role.write` / `user.role_change`.

### Client bundle

Per-row visibility is enforced at the service layer (`PROJECT_CLIENT_SCOPED_ROLES = [ROLES.CLIENT]`) — a client only ever sees projects where they appear in `project.client_ids[]`. The 8 permissions above are the **maximum** any client can have; the row-level filter narrows that to "their" projects.

---

## Boot lifecycle

### `seedSystemRoles()`

Idempotently upserts the five system roles from `SYSTEM_ROLE_DEFINITIONS`. Runs on boot AND lazily from `getSystemRoleByKey()` on first lookup (a vitest harness that imports the service directly doesn't need a separate setup step).

```ts
await Role.updateOne(
  { key: def.key },
  {
    $setOnInsert: { key, is_system: true, created_by: null },
    $set: { display_name, description, permissions, updated_by: null }
  },
  { upsert: true }
);
```

The `$set` re-applies `permissions` on every seed run, so **adding a new permission to a system role takes effect on next boot without a manual migration**. Customer-amended overrides on system roles (Phase B PATCH) live alongside the defaults — operators who tune a system role's permissions accept that the next code deploy may re-tune them.

Concurrent callers share a single in-flight `systemSeedPromise` so two parallel `getSystemRoleByKey` calls during a cold start don't duplicate-write. The promise is cleared after settlement so a failure-recovery call re-runs the seed instead of returning a cached resolved value.

Per-role failures during seed are logged at `warn` (`System role seed write failed; will retry on next call`) and don't propagate — one bad role shouldn't block the rest of the seed or the boot path that called it.

### `bootstrapRolesMigration()`

One-shot boot-time migration. Runs `seedSystemRoles` first, then back-assigns `role_ids[]` to every user with `role_ids: { $size: 0 }` whose legacy `role` string maps to a system role:

```ts
const legacyUsers = await User.find({ role_ids: { $size: 0 } }).select('_id role').lean();
for (const u of legacyUsers) {
  if (!systemKeyValues.has(u.role)) {
    logger.warn(...);  // unknown legacy role, skip
    continue;
  }
  await ensureLegacyRoleAssigned(u._id, u.role);
  backfilled += 1;
}
```

**Idempotent.** Safe to run on every boot — already-migrated users get a single indexed read each. A user whose legacy `role` doesn't map (shouldn't happen — `users.role` is enum-validated) gets skipped with a warn; the on-login resolver will 403 them until an admin fixes the row by hand.

The lazy on-login self-heal in [`auth.service.resolveAuthContext`](../../src/services/auth.service.ts) covers the edge case where a user logs in BEFORE this migration finishes (e.g. a request lands during boot). The bootstrap is the eager catch-all so admin views / audits / reports don't depend on every user having logged in once.

Returns `{seeded: true, backfilled: <count>}` for log/observability.

### `ensureLegacyRoleAssigned(userId, legacyRole)`

Best-effort idempotent `$addToSet` of the system role matching the legacy `role` key. Used by:
- `bootstrapRolesMigration` — boot-time batch.
- `auth.service.resolveAuthContext` — lazy self-heal on login.
- `user.service.changeUserRole` — keeps `role_ids` in lockstep when the legacy single-role endpoint flips `users.role`.

---

## Permission resolution

[`resolvePermissionsForUser(userId)`](../../src/services/role.service.ts) — called by `auth.service.login` to populate the JWT and by `auth.service.refreshTokens` to refresh the cached set on every rotation.

```ts
1. Load user.role_ids + user.extra_permissions
2. Fast path: both empty → return { role_keys: [], permissions: [] }
3. Else: Role.find({ _id: { $in: role_ids } }).select('key permissions')
4. role_keys = roles.map(r => r.key)
5. permSet = ∪ each role's permissions[]
6. Add extra_permissions[] into permSet
7. return { role_keys, permissions: Array.from(permSet) }
```

Empty `role_keys` with non-empty `extra_permissions` is **allowed** — an admin who grants `extra_permissions` to an otherwise-roleless user is opting into exactly that. `requirePermission` remains the gate.

Empty both → the JWT carries `permissions: []` and `requirePermission` 403s every privileged route. Correct fail-closed behaviour for a brand-new pre-bootstrap-migration user.

**Critical refresh-flow detail** — on `/auth/refresh`, the service calls `resolveAuthContext` (which calls `resolvePermissionsForUser`) and bakes the **server-fresh** set into the new access token. This means a permission grant during the access-token's lifetime takes effect on the next refresh without forcing the user to log in again. See `auth.md`'s "Refresh flow" section.

---

## Endpoints

### Role CRUD

[`routes/role.routes.ts`](../../src/routes/role.routes.ts) — mounted at `/api/v1/roles`. All routes run `authenticate` then `requirePermission(...)` then `validate(...)`.

| Method | Path | Permission | Body / query |
|---|---|---|---|
| `GET` | `/roles` | `role.read` | `?is_system=true|false` |
| `POST` | `/roles` | `role.write` | `CreateRoleBody` |
| `GET` | `/roles/:id` | `role.read` | — |
| `PATCH` | `/roles/:id` | `role.write` | `PatchRoleBody` (partial — `display_name?`, `description?`, `permissions?`) |
| `DELETE` | `/roles/:id` | `role.delete` | — |

### Per-user assignment

A sibling router exported as `userRolesAssignRouter()` mounted on `/api/v1/users` (so the URL matches the natural resource hierarchy `users → roles / extra-permissions`):

| Method | Path | Permission | Body |
|---|---|---|---|
| `PATCH` | `/users/:user_id/roles` | `user.role_change` | `{role_ids: ObjectId[]}` (≥ 1, deduped, max = PERMISSION_VALUES.length) |
| `PATCH` | `/users/:user_id/extra-permissions` | `user.role_change` | `{extra_permissions: string[]}` (allowlist-validated, max = PERMISSION_VALUES.length) |

Both gate on `user.role_change` — same permission the legacy `POST /users/:id/change-role` endpoint uses. **Pattern B grants are admin-equivalent in blast radius** (an admin who can grant `extra_permissions: ['system.admin']` would effectively make the user an admin) so they share the gate. The wildcard itself is **rejected** at the service layer regardless of who's calling — see below.

---

## Detailed behaviour

### `POST /roles` — create custom role

[`createCustomRole`](../../src/services/role.service.ts):

1. **`assertNoWildcard(input.permissions)`** — `system.admin` in the supplied list → throw **422 `ROLE_INVALID_PERMISSIONS`**. Only the seeded Admin role holds the wildcard; granting it to any other role (system OR custom) would silently bypass every `requirePermission` check.
2. `Role.create({key, display_name, description, permissions, is_system: false, created_by: actor_id})`.
3. **E11000 unique-`key` collision** → catch and rethrow as **409 `DUPLICATE_RESOURCE`** with `"Role key "<key>" already exists"`. Cheaper than a pre-write existence check (which races).
4. Audit `ROLE_CREATE` with `metadata: {key, permission_count}` + `after: toPublicRole(doc)`.

### `GET /roles` — list

Optional `?is_system` filter. **No pagination** — the cap is small (5 system roles + however many custom roles, typically < 20). Sort: `{is_system: -1, key: 1}` so system roles bubble to the top.

### `PATCH /roles/:id`

Three layers of protection on system roles:

| Field | System role | Custom role |
|---|---|---|
| `key` | **Locked.** Validator doesn't accept it. | Locked (same reason) |
| `is_system` | **Locked.** Validator doesn't accept it. | Locked |
| `display_name` | Patchable | Patchable |
| `description` | Patchable | Patchable |
| `permissions` | Patchable (with one exception below) | Patchable |

**Admin role wildcard protection**: if the patch sets `permissions` on the Admin role AND the new list doesn't include `system.admin` → **422 `ROLE_INVALID_PERMISSIONS`** "The seeded Admin role must retain the `system.admin` wildcard. To narrow Admin grants, edit `system-role-definitions.ts` and redeploy."

Lockout-prevention: an admin who patches the Admin role and forgets to include `system.admin` would strip the wildcard, leaving the system with no working admin until the next boot (when the seeder re-applies it). Force-rejecting on save is cleaner than silently re-adding it.

**Other roles** (system non-Admin or custom): `assertNoWildcard(input.permissions)` runs — symmetric with create.

Patches use `findByIdAndUpdate` with `runValidators: true` so the model-level `permissions` allowlist applies. Concurrent delete between `findById` + update → 404 `ROLE_NOT_FOUND`.

Audit `ROLE_UPDATE` with `metadata: {key, is_system, fields_changed: [...]}`, `before` + `after` snapshots.

### `DELETE /roles/:id`

Two invariants:

1. **System roles cannot be deleted** — `is_system: true` → **422 `ROLE_IS_SYSTEM`** "System role \"<key>\" cannot be deleted".
2. **Role in use cannot be deleted** — `User.countDocuments({role_ids: role._id}).limit(1)` > 0 → **422 `ROLE_IN_USE`** "Role \"<key>\" is assigned to one or more users — reassign them before deleting".

The `.limit(1)` makes the in-use check a quick existence probe (no full count).

The actual delete is guarded: `Role.deleteOne({_id, is_system: false})`. If `deletedCount === 0`, a race flipped `is_system` to true or the doc was concurrently deleted → 404.

Audit `ROLE_DELETE` with `before: toPublicRole(role)`.

### `PATCH /users/:user_id/roles` — assign roles

[`assignRolesToUser`](../../src/services/role.service.ts):

1. Load target user. 404 `USER_NOT_FOUND` if missing.
2. Validate every supplied `role_id` resolves to a real role doc. Missing IDs → **404 `ROLE_NOT_FOUND`** with `"One or more roles not found: <comma-separated>"`. The FE gets a clear error instead of a silent no-op.
3. **Preserve order** — mongoose `find` returns in arbitrary order; reorder by the input `role_ids` so the legacy-`role` denorm picks the right "primary" (first in the input array).
4. Snapshot `before = {role, role_ids: [...]}`.
5. `set.role_ids = [...]` from input.
6. **Sync legacy `role` cache** — if the primary role's key matches a system role key (`admin | manager | team_lead | employee | client`), `set.role = primaryKey`. Otherwise **leave it as-is** — service-layer code that branches on `caller.role === 'manager'` won't see a surprise non-enum value (e.g. a custom role `'regional_manager'`).
7. `updateOne({_id: user_id}, {$set: set})`.
8. Audit `USER_ROLES_ASSIGN` with `metadata: {actor_id, role_keys: [...]}` + `before` + `after`.

**Replacement, not merge.** To grant or revoke a single role, the FE submits the full new list. This is consistent with the Step-15 user PATCH posture (`SELF_EDITABLE_FIELDS` whitelist, no field-level diff) and cheaper to reason about than computed diffs.

### `PATCH /users/:user_id/extra-permissions` — Pattern B

[`updateUserExtraPermissions`](../../src/services/role.service.ts):

1. `assertNoWildcard(input.extra_permissions)` — granting `system.admin` via Pattern B would silently make the user a super-admin without any record on the role layer.
2. Load target. 404 `USER_NOT_FOUND` if missing.
3. **Replace** — `user.extra_permissions = input.extra_permissions`. `save()`.
4. Audit `USER_EXTRA_PERMISSIONS_UPDATE` with `metadata: {actor_id, added: [...], removed: [...]}` (set diff) + `before` + `after`.

Same replacement semantics as `assignRolesToUser`. `{extra_permissions: []}` clears the array.

---

## Service-layer helpers

[`utils/role-check.ts`](../../src/utils/role-check.ts) exports two helpers other services consume:

### `isAdminLike(caller)`

```ts
caller.role === ROLES.ADMIN || (caller.role_keys ?? []).includes(SYSTEM_ROLE_KEYS.ADMIN)
```

Dual-signal check. Mirrors `auth.middleware.isCallerAdmin` exactly so the route gate and the service gate agree on what "admin" means. **R4 fix**: pre-R4 service code compared `caller.role === ROLES.ADMIN` only — a multi-role admin whose legacy `role` cache was something else (e.g. `'manager'`) passed the route gate (RBAC permission check) but got denied at the service layer.

### `isProjectAuthor(caller)`

```ts
{admin, manager, team_lead} via either legacy `role` OR `role_keys[]`
```

**H2 fix**: pre-H2 the gate was `caller.role !== ADMIN && caller.role !== MANAGER` — Team Lead held `sprint.write` / `story.write` / `task_template.write` per the bundle but was rejected at the service layer, contradicting the bundle's intent. The current helper accepts Admin / Manager / Team Lead from either signal.

Both helpers accept any shape with `role?: string` + `role_keys?: readonly string[]` (the `Caller` type other services declare).

---

## Audit actions produced

| Action | When |
|---|---|
| `ROLE_CREATE` | `POST /roles` — metadata: `{key, permission_count}` + `after` |
| `ROLE_UPDATE` | `PATCH /roles/:id` — metadata: `{key, is_system, fields_changed: [...]}` + `before` + `after` |
| `ROLE_DELETE` | `DELETE /roles/:id` — metadata: `{key}` + `before` |
| `USER_ROLES_ASSIGN` | `PATCH /users/:user_id/roles` — metadata: `{actor_id, role_keys: [...]}` + `before` + `after` |
| `USER_EXTRA_PERMISSIONS_UPDATE` | `PATCH /users/:user_id/extra-permissions` — metadata: `{actor_id, added: [...], removed: [...]}` + `before` + `after` |

`USER_ROLE_CHANGE` (legacy single-role swap via `POST /users/:id/change-role`) lives on the User Management module — different verb, same actor-perm.

---

## Error codes produced

| Code | HTTP | When |
|---|---|---|
| `ROLE_NOT_FOUND` | 404 | `findById` miss; `assignRolesToUser` with missing role_id |
| `ROLE_IS_SYSTEM` | 422 | DELETE on a system role |
| `ROLE_IN_USE` | 422 | DELETE on a role still assigned to users |
| `ROLE_INVALID_PERMISSIONS` | 422 | `system.admin` wildcard on a non-Admin role (create/patch); stripping wildcard from Admin role (patch) |
| `DUPLICATE_RESOURCE` | 409 | `POST /roles` with a duplicate `key` (E11000) |
| `USER_NOT_FOUND` | 404 | `PATCH /users/:user_id/roles|extra-permissions` for unknown user |
| `VALIDATION_ERROR` | 400 | Bad `key` shape; invalid permission in list; empty permissions array; both `role_ids` empty + extras empty |

---

## End-to-end flows

### Boot — fresh DB

1. Server starts.
2. `bootstrapRolesMigration()` runs.
3. `seedSystemRoles()` upserts 5 docs. Each `Role.updateOne(..., {upsert: true})`:
   - First-time-ever: `$setOnInsert` writes `{key, is_system: true, created_by: null}` and `$set` writes `{display_name, description, permissions, updated_by: null}`.
   - Subsequent boots: `$setOnInsert` is a no-op; `$set` refreshes display_name/description/permissions in case the code-level definitions changed.
4. `User.find({role_ids: {$size: 0}})` — no users yet, `legacyUsers = []`.
5. Return `{seeded: true, backfilled: 0}`.

### Boot — DB with legacy users (mid-Step-47 migration)

1. Same boot path.
2. After seed, `find({role_ids: {$size: 0}})` returns 47 users.
3. For each: `ensureLegacyRoleAssigned(user._id, user.role)`:
   - `getSystemRoleByKey(user.role)` returns the matching role doc.
   - `User.updateOne({_id, role_ids: {$ne: role._id}}, {$addToSet: {role_ids: role._id}})` — idempotent.
4. `logger.info({backfilled: 47}, 'Bootstrap migration: back-assigned role_ids on legacy users')`.

### Admin creates a "Regional Manager" custom role

1. Admin POSTs `/api/v1/roles` with `{key: 'regional_manager', display_name: 'Regional Manager', description: '...', permissions: ['project.read', 'project.write', 'leave_balance.read_team', ...]}`.
2. Validator: `key` matches regex, lowercased, each permission in the catalog allowlist.
3. `requirePermission(role.write)` passes.
4. Service: `assertNoWildcard(permissions)` — no `system.admin` in the list, OK.
5. `Role.create({...is_system: false, created_by: admin_id, updated_by: admin_id})`.
6. Audit `ROLE_CREATE`.
7. Return 201 `toPublicRole(doc)`.

### Admin assigns Bob the Regional Manager role

1. Admin PATCHes `/api/v1/users/{bobId}/roles` with `{role_ids: ['<regional_manager._id>', '<employee._id>']}`.
2. `requirePermission(user.role_change)` passes.
3. Service validates both ids resolve to real roles.
4. Reorder by input array — primary is `regional_manager`.
5. `regional_manager` is NOT a system role key, so `set.role` is **NOT** updated — the legacy `role` field stays whatever Bob had before (e.g. `'employee'`).
6. `set.role_ids = [regional_manager._id, employee._id]`. Save.
7. Audit `USER_ROLES_ASSIGN`.
8. Bob's next `/auth/refresh` or `/auth/login`: `resolveAuthContext(bob._id)` returns:
   - `role_keys = ['regional_manager', 'employee']`
   - `permissions = union(regional_manager.permissions, employee.permissions, bob.extra_permissions)`
9. JWT carries the union; `requirePermission(LEAVE_BALANCE_READ_TEAM)` now passes for Bob.

### Admin grants Bob a one-off extra permission

1. Bob needs `report.read` for Q3 but isn't on a Manager role.
2. Admin PATCHes `/api/v1/users/{bobId}/extra-permissions` with `{extra_permissions: ['report.read']}`.
3. `assertNoWildcard(extras)` — no `system.admin`, OK.
4. Update `bob.extra_permissions = ['report.read']`. Save.
5. Audit `USER_EXTRA_PERMISSIONS_UPDATE` metadata: `{added: ['report.read'], removed: []}`.
6. Next refresh: `resolveAuthContext` returns `permissions = union(role_perms, ['report.read'])`. JWT carries it.
7. End of Q3: admin PATCHes `{extra_permissions: []}` to revoke. Audit metadata: `{added: [], removed: ['report.read']}`.

### Admin tries to delete the seeded Admin role

1. DELETE `/api/v1/roles/{adminRoleId}`.
2. `requirePermission(role.delete)` passes (admin holds wildcard).
3. Service: `role.is_system === true` → throw 422 `ROLE_IS_SYSTEM` "System role \"admin\" cannot be deleted".

### Admin tries to delete a custom role that 3 users hold

1. DELETE `/api/v1/roles/{regionalManagerId}`.
2. `role.is_system === false` — passes the system check.
3. `User.countDocuments({role_ids: role._id}).limit(1)` returns 1.
4. Throw 422 `ROLE_IN_USE` "Role \"regional_manager\" is assigned to one or more users — reassign them before deleting".
5. Admin's recourse: `PATCH /users/.../roles` on each of the 3 users to remove the regional_manager role, then retry the delete.

### Admin tries to PATCH the Admin role and strip the wildcard

1. PATCH `/api/v1/roles/{adminRoleId}` with `{permissions: ['user.read', 'project.read', ...]}` — forgetting `system.admin`.
2. Validator: each permission in the catalog, OK.
3. Service: `before.key === 'admin'` AND `!input.permissions.includes('system.admin')` → throw 422 `ROLE_INVALID_PERMISSIONS` "The seeded Admin role must retain the `system.admin` wildcard. To narrow Admin grants, edit `system-role-definitions.ts` and redeploy."
4. The admin retries with `system.admin` included — the patch lands.

### Admin tries to grant `system.admin` to a custom role

1. PATCH `/api/v1/roles/{regionalManagerId}` with `{permissions: [..., 'system.admin']}`.
2. Validator: passes (allowlist accepts `system.admin`).
3. Service: `before.key !== 'admin'` → `assertNoWildcard(input.permissions)` → throw 422 `ROLE_INVALID_PERMISSIONS` "The `system.admin` wildcard cannot be granted to user-defined roles. Only the seeded Admin system role holds it."

---

## Gotchas

| # | Behaviour | Why |
|---|---|---|
| 1 | The validator allows `system.admin` in `permissions`; the service rejects on save | Schema-level enum keeps the allowlist single-source; service-level guard gives a clean error code (`ROLE_INVALID_PERMISSIONS`) instead of a generic 500 |
| 2 | The seeded Admin role MUST retain `system.admin` — patching it out fails | Lockout-prevention; bypassing the seed re-application would brick the system between deploys |
| 3 | Permission removal from `system-role-definitions.ts` does NOT auto-remove from existing role docs | A privilege downgrade for active users needs a manual migration step |
| 4 | Permission addition to `system-role-definitions.ts` DOES auto-add (next boot) | The seeder runs `$set: {permissions}` unconditionally; new perms appear after restart |
| 5 | System roles' `display_name` / `description` / `permissions` can be patched | Operators can broaden / narrow a system role without forking the key namespace |
| 6 | System role `key` and `is_system` are NOT patchable | Validator doesn't accept either field |
| 7 | System roles CANNOT be deleted (`ROLE_IS_SYSTEM`) | Defence at the service layer + the model-level `is_system: false` guard on `deleteOne` |
| 8 | A role that's in use CANNOT be deleted (`ROLE_IN_USE`) | Admin must reassign users first; uses `.limit(1)` so the check is a cheap existence probe |
| 9 | `assignRolesToUser` is **replace, not merge** | To grant or revoke one role, send the full new list |
| 10 | `assignRolesToUser` syncs `users.role` to the FIRST role's key ONLY if it matches a system key | Custom-role users keep their last-known legacy `role` for back-compat with service code that branches on it |
| 11 | `updateUserExtraPermissions` is **replace, not merge** | `{extra_permissions: []}` clears |
| 12 | Pattern B requires `user.role_change` perm (same as roles assignment) | Pattern B is admin-equivalent in blast radius |
| 13 | `assertNoWildcard` fires on both create and patch for any role except Admin | Granting `system.admin` to anyone but Admin would silently bypass every gate |
| 14 | `seedSystemRoles` coalesces concurrent calls behind a single in-flight promise | Cold-start race protection; `vitest` harnesses + boot path don't duplicate-write |
| 15 | Per-role seed failure logs warn and continues | One bad role definition shouldn't block the rest of the seed |
| 16 | `bootstrapRolesMigration` is idempotent — safe on every boot | Each already-migrated user costs one indexed read |
| 17 | `ensureLegacyRoleAssigned` is the lazy self-heal on login | A user who logs in before the boot migration finishes still gets a working permission set |
| 18 | A user with `role_ids: []` and non-empty `extra_permissions` gets the extras only | Admins opting into Pattern-B-only grants is legitimate |
| 19 | The hot lookup path is `Role.find({_id: {$in: role_ids}})` — implicit `_id` index | No need for additional indexes |
| 20 | Mongoose `find` returns roles in arbitrary order; the service re-orders by the input `role_ids[]` | Preserves the FE's notion of "primary role" |
| 21 | `isAdminLike` reads BOTH `caller.role` AND `caller.role_keys[]` (R4) | Multi-role admin with mismatched legacy cache still passes |
| 22 | `isProjectAuthor` includes Team Lead (H2) | Pre-H2 service-layer gate compared role-string against admin/manager only; contradicted the bundle |
| 23 | `requirePermission(...)` middleware lives in `auth.middleware.ts`, not here | This module owns the catalog + assignment; the gate lives with the rest of `authenticate` |
| 24 | Permission resolution happens **at login + at every refresh** | A grant takes effect on the next access-token rotation without forcing re-login (see `auth.md`) |
| 25 | `bootstrapRolesMigration` runs at boot but is also idempotent if started mid-traffic | Production deploys roll forward; no maintenance window needed for the migration |
