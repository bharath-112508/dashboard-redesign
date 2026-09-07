# Backend — CLAUDE.md

This file documents the **BE-specific modules and infrastructure** of the Viljetech company-management platform. For the repo layout, commands, and cross-package conventions, see [`../CLAUDE.md`](../CLAUDE.md). The platform is internal to Viljetech (not multi-tenant, not a product for sale); the role taxonomy, permission catalog, and module surface below reflect that scope.

## Deep-dive module docs

This file is the **quick-reference**. For the per-module deep-dive — data models, every endpoint, every audit action, every error code, end-to-end flows, and per-module gotchas tables — see [`docs/modules/`](docs/modules/). One file per module:

| Module doc | Covers |
|---|---|
| [`auth.md`](docs/modules/auth.md) | Login, refresh-token rotation, logout, password change/reset, MFA setup/disable/backup codes, sessions, brute-force protection |
| [`user-management.md`](docs/modules/user-management.md) | User CRUD, profile photo (two-step SAS), deactivation, GDPR export + erasure |
| [`roles-rbac.md`](docs/modules/roles-rbac.md) | Permission catalog, system roles, custom role CRUD, per-user role + extra-permissions assignment |
| [`leave-management.md`](docs/modules/leave-management.md) | Leave types, balances, requests (preview/apply/approve/reject/cancel), C4 SL replay, comp-off, year rollover cron |
| [`attendance.md`](docs/modules/attendance.md) | Check-in/out (multi-segment BUG-040), geofence + WiFi, QR, corrections, EOD finalizer cron |
| [`holidays-locations.md`](docs/modules/holidays-locations.md) | Holiday calendar + bulk import, office locations + QR tokens |
| [`project-management.md`](docs/modules/project-management.md) | Projects + members + representatives + custom statuses + sprints + stories + tasks (incl. subtasks/dependencies) + comments + activity + attachments + templates + share links + timeline (**all in one file**) |
| [`timesheets-billing.md`](docs/modules/timesheets-billing.md) | Daily entries + weekly view + manager approval + billing rates with forward-extension invariants + reminder cron |
| [`reports-exports.md`](docs/modules/reports-exports.md) | Sync report reads + async export pipeline (Azure Blob + inline fallback) + presets + subscriptions + cleanup cron |
| [`audit-compliance.md`](docs/modules/audit-compliance.md) | `audit_logs` + `audit_archives` (daily WORM + SHA-256 chain) + `audit_log_mirrors` (P1-7 hourly) |
| [`invoicing.md`](docs/modules/invoicing.md) | Client engagements + numbered invoices (the generation algorithm, the status transition table and the draft edit-freeze) + per-user cost rates + the margin report and its hand-maintained FX table |
| [`payroll.md`](docs/modules/payroll.md) | Payroll profiles (PII + the three `*_override` fields) + append-only salary structures (`getCurrentStructure`, not `is_current`) + payslip/letter generation, the eight letter types, the singleton Chromium PDF pipeline, and private-blob storage with per-download SAS |
| [`settings-notifications.md`](docs/modules/settings-notifications.md) | System settings + Slack (signed inbound webhooks + slash commands + Events API / App Home dashboard + attendance nudges + outbound `chat.update`/`views.publish`) + notification dispatcher + in-app + push |
| [`dashboard-search-palette.md`](docs/modules/dashboard-search-palette.md) | Per-role dashboards + global search + Cmd-K command palette |
| [`cross-cutting.md`](docs/modules/cross-cutting.md) | Boot order, error envelope, validation, `withTransaction`, logging + metrics, rate limiters, cron scheduler |

The quick-reference below uses fix-ID tags (BUG-xxx, C4, C5, C9, F1, F4, G1, H2, H4, H19, M11, M21, M36, M38, M46, M47, M48, M49, M51, T11, R3, R11, R15, L13, L14, L18, L19, P1-7, P2-9, etc.). The deep-dive docs explain each tag's reason and how to apply it.

## Architecture refresher

Strict layered request flow:

```
routes/*.routes.ts → middlewares (authenticate → requirePermission → validate)
                  → controllers/*.controller.ts   (HTTP shape only)
                  → services/*.service.ts          (business logic, all DB access)
                  → models/*.model.ts              (Mongoose schemas)
```

ESM + NodeNext. Every relative import in `.ts` must end with `.js`. Routes mount under `/api/v1` ([`API_PREFIX`](src/config/server.config.ts)) assembled in [`routes/index.ts`](src/routes/index.ts) — mount order matters where prefixes overlap (the public share-link router is mounted last so authed routes match first; the Slack router is mounted in [`index.ts`](src/index.ts) **before** body parsers so raw bytes survive for HMAC verification).

## Roles & permissions

Role keys ([`SYSTEM_ROLE_KEYS`](src/constants/role-keys.ts)) and bundled permissions ([`constants/system-role-definitions.ts`](src/constants/system-role-definitions.ts)):

| Role | Slug | Audience | Permission baseline |
|---|---|---|---|
| Admin | `admin` | Everything | `system.admin` wildcard — every `requirePermission` short-circuits true |
| Manager | `manager` | Team Lead bundle + 13 more | Adds `project.representatives_write`, `billing_rate.read`, `invoice.read`, `cost_rate.read`, `report.read`, `report_export.write`, `leave_balance.read_team`, `timesheet.edit_out_of_window`, `user.employment_write`, `payroll.read`/`write`, `payslip.generate`, `letter.generate` |
| Team Lead | `team_lead` | Employee bundle + 10 more | Adds `leave_request.read_team`/`approve`, `attendance.read_team`/`correction_approve`, `timesheet.read`, `project.archive`, `task_template.write`, `share_link.write`, `role.read`, `dashboard.manager`. **`project.write`, `project.members_write`, `sprint.write` and `story.write` moved down to Employee** — Team Lead still gets them, via that bundle. |
| Employee | `employee` | Bulk of the user base | 24 perms — own task/timesheet/attendance/leave + project read + dashboard.employee, **plus `project.write`, `project.members_write`, `sprint.write`, `story.write`, `company.read`, `company.write`**: anyone may start a project, staff it, plan the work, and create the client company it belongs to. `company.write` is **create-only** in practice — `company.service:assertCallerOwnsCompany` refuses rename/archive to any caller who is neither an admin nor a member of that company, and internal staff carry no `company_id`. Scope is per-row, not per-caller — see the two rules under §Project management. |
| Client | `client` | The client **company**, at the person level | `CLIENT_SIDE_BASE` (8) + `representative.write` + `project.representatives_write`. Sees **every** project of their company. **No leave / attendance / timesheets / billing / reports.** |
| Representative | `representative` | A client company's project-scoped person | `CLIENT_SIDE_BASE` (8) — `project.read`, `task.read`, `task_comment.write`, `task_attachment.write`, `holiday.read`, `leave_type.read`, `settings.read`, `dashboard.client`. Sees **only** projects they're rostered on. |

> **Vocabulary — this trips people up.** **"Client" IS the company** (the
> company-level role); a **"Representative"** is that company's project-scoped
> person. The two hold nearly identical *permissions* and differ almost entirely
> in **visibility scope**, which is service-layer, not RBAC. See §Companies.

Permission constants live in [`constants/permissions.ts`](src/constants/permissions.ts) (71 total, grouped by domain prefix: `user.*`, `role.*`, `company.*`, `representative.*`, `project.*`, `task.*`, `timesheet.*`, `billing_rate.*`, `cost_rate.*`, `invoice.*`, `attendance.*`, `leave_type.*`, `leave_balance.*`, `leave_request.*`, `comp_off.*`, `holiday.*`, `office_location.*`, `report.*`, `audit_log.*`, `audit_archive.*`, `settings.*`, `share_link.*`, `dashboard.*`, `system.admin`, and others — see the file for the full list). **BE is the source of truth.** The FE mirrors it in [`src/lib/permissions.ts`](../viljetech-platform-frontend/src/lib/permissions.ts) — zero drift today.

[`requirePermissionOrSelf`](src/middlewares/auth.middleware.ts) takes a `Permission` **or a readonly array** of them (OR semantics — holding any one passes) and lets a caller through if **either** they hold one of them (or wildcard) **or** the URL param matches their JWT `user_id`. Currently used only on `PATCH /users/:id` in [`user.routes.ts`](src/routes/user.routes.ts), which passes two: `[USER_WRITE, USER_EMPLOYMENT_WRITE]`.

## Module catalog

### User management

- **Purpose** — Directory CRUD, profile, profile photo, MFA, sessions, deactivation, GDPR DSAR/erasure
- **Roles & visibility** — Admin: full. Manager/TL/Employee: read directory ([`user.read`](src/constants/permissions.ts)); patch own via `requirePermissionOrSelf`. Client: no directory access; `/me` self-fetch only.
- **Permissions** — `USER_READ`, `USER_WRITE`, `USER_DEACTIVATE`, `USER_ROLE_CHANGE`, `USER_DATA_EXPORT`, `USER_DATA_ERASURE`
- **Routes** — [`routes/user.routes.ts`](src/routes/user.routes.ts). `GET /users`, `GET /users/assignable` (narrowed picker feed), `POST /users` (gates on `USER_WRITE`), `GET /users/:id`, `PATCH /users/:id` (gates on `USER_WRITE` or `USER_EMPLOYMENT_WRITE` with self access), `POST /users/:id/deactivate|reactivate` (gates on `USER_DEACTIVATE`), `POST /users/:id/change-role` (gates on `USER_ROLE_CHANGE`), `POST /users/:id/reset-password`, profile-photo upload-url/finalize/delete pairs for self + admin, `GET /users/:id/data-export` (gates on `USER_DATA_EXPORT`), `POST /users/:id/data-erasure` (gates on `USER_DATA_ERASURE`)
- **Service** — [`services/user.service.ts`](src/services/user.service.ts) · **Model** — [`models/user.model.ts`](src/models/user.model.ts) · **Validator** — [`validators/user.validator.ts`](src/validators/user.validator.ts)
- **Flow** — create writes a `User` doc (bcrypt-hashed password) + welcome email + audit row. Deactivate revokes all active refresh tokens. Profile photo upload mints a write-SAS via Azure Blob, FE PUTs bytes, then BE finalizes the record. GDPR export streams NDJSON of user-owned rows (timesheet, leave, audit) — see [`user-gdpr.service.ts`](src/services/user-gdpr.service.ts). Erasure soft-deletes + PII scrub.
- **Gotchas** — single-admin rule enforced via `one_active_admin` partial-unique index on role + status; deactivate fails if it would leave zero admins. Self-edit whitelist limits which fields a non-admin can PATCH on themselves.

### Roles & RBAC

- **Purpose** — Custom role CRUD + per-user role/permission assignment (Step 47 RBAC)
- **Roles & visibility** — Admin: full. Team Lead+: `ROLE_READ` only (so the user-detail UI can render role-name badges).
- **Permissions** — `ROLE_READ`, `ROLE_WRITE`, `ROLE_DELETE`, `USER_ROLE_CHANGE`
- **Routes** — [`routes/role.routes.ts`](src/routes/role.routes.ts). CRUD: `GET /roles`, `POST /roles` (gates on `ROLE_WRITE`), `PATCH /roles/:id`, `DELETE /roles/:id` (gates on `ROLE_DELETE`). User-assignment sub-router: `PATCH /users/:user_id/roles`, `PATCH /users/:user_id/extra-permissions` (both gate on `USER_ROLE_CHANGE`).
- **Service** — [`services/role.service.ts`](src/services/role.service.ts) · **Model** — [`models/role.model.ts`](src/models/role.model.ts)
- **Flow** — admin defines a custom role with a bundled permission set; assigns to users via `role_ids[]` on `User`. Per-user ad-hoc grants land in `extra_permissions[]`. Both flow into the JWT at next refresh; the BE's `requirePermission` always reads from the JWT, so a role/perm change requires a token rotation to take effect ([drift detection in FE](../viljetech-platform-frontend/src/lib/queries.ts)).
- **Gotchas** — all six system roles (admin/manager/team_lead/employee/client/representative) are seeded `is_system: true` by `seedSystemRoles()` and cannot be deleted or have their bundles edited. Delete refuses any role that's in-use.

### Leave management

Sub-modules with their own routers; grouped because they share `LeaveRequest`/`LeaveBalance` models and the leave-request engine.

- **Purpose** — Leave types, monthly/yearly balances, apply/preview/approve/reject/cancel, comp-off accrue+release, carry-forward, SL forfeiture
- **Roles & visibility** — Employee+: apply own, see own balance + calendar. Team Lead+: read team, approve. Manager+: read team balances, adjust. **Client has no leave UI** (only `LEAVE_TYPE_READ` so they can render a leave-type pill if a comment cites one).
- **Permissions** — `LEAVE_TYPE_READ`/`WRITE`, `LEAVE_BALANCE_READ_TEAM`/`ADJUST`, `LEAVE_REQUEST_WRITE`/`READ_TEAM`/`APPROVE`, `COMP_OFF_READ`/`WRITE`

#### Leave types
[`routes/leave-type.routes.ts`](src/routes/leave-type.routes.ts) · [`services/leave-type.service.ts`](src/services/leave-type.service.ts) · [`models/leave-type.model.ts`](src/models/leave-type.model.ts). Admin CRUD. Schema fields are `code` + `name` (not `key`/`label`).

#### Leave balances
[`routes/leave-balance.routes.ts`](src/routes/leave-balance.routes.ts) · [`services/leave-balance.service.ts`](src/services/leave-balance.service.ts). `GET /leave-balances/me` (auth-only — service pins to caller), `GET /leave-balances` (team scope), `POST /leave-balances/initialize-year`, `PATCH /leave-balances/:id`.

#### Leave requests
[`routes/leave-request.routes.ts`](src/routes/leave-request.routes.ts) · [`services/leave-request.service.ts`](src/services/leave-request.service.ts). `POST /leaves/preview-split` (dry-run segment generation), `GET /leaves/calendar` (org-wide approved; gated on `LEAVE_REQUEST_READ_TEAM` per C5 to prevent rank-and-file enumeration), `POST /leaves` (apply), `POST /leaves/:id/approve|reject|cancel`.
- **Flow** — apply → preview-split computes segments excluding holidays + non-working days → `withTransaction(LeaveBalance.pending++ via $gte CAS predicate, LeaveRequest.create)` → notify (Slack DM + push + in-app). On approve: `findOneAndUpdate({status: 'pending'}, {$set: {status: 'approved'}})` (race-safe gate) + `withTransaction(LeaveBalance.used++, LeaveBalance.pending--)` + audit row + Slack `chat.update` against the persisted `slack_message.{channel, ts}` so the same DM mutates in-place through the lifecycle.
- 🔴 **Freelancers accrue no leave.** `initializeBalancesForUserYear` returns 0
  for `internal_profile.employment_type === 'freelancer'`, and
  `initializeYearForAllUsers` excludes them in its query as well (that caller
  pre-resolves the joining date, which skips the per-user guard). Guarded at
  that one function because every path that can create a balance row funnels
  through it — `createUser`, the rollover cron, the manual initialize-year
  endpoint, the dashboard self-heal, and apply-leave's just-in-time init. A
  freelancer therefore has **no balance rows at all**, not zeroed ones.
  Freelancers ARE still counted in every headcount (they're `role: employee`;
  headcounts filter by role, never by employment type).
- 🔴 **Freelancers bank no comp-off** either — `processCompOffForDay` returns
  `reason: 'ineligible'` for them, alongside the existing client-side check.
  Comp-off is time off in lieu: it accrues from billable hours and is SPENT as
  leave, so granting it to someone who accrues no leave would hand them the
  only leave days they could take. They're paid for those hours by invoice.
- **Gotchas** — **C4 SL month attribution**: SL caps are per calendar month; on apply, the service replays historical requests in `created_at` order to reconstruct the cap state at the new request's apply time. **Self-approval refused** by service. **Cancel is author-only** even though the route has no perm gate.

#### Comp-off
[`routes/comp-off.routes.ts`](src/routes/comp-off.routes.ts) · [`services/comp-off.service.ts`](src/services/comp-off.service.ts) · [`models/comp-off-ledger.model.ts`](src/models/comp-off-ledger.model.ts) + [`comp-off-accrual-day.model.ts`](src/models/comp-off-accrual-day.model.ts). `GET /comp-off/me`, `GET /comp-off` (gates on `COMP_OFF_READ`), `POST /comp-off/adjust` (gates on `COMP_OFF_WRITE`).

The ledger is append-only and **lot-based**. Every `earned` row IS a lot: `remaining_days` starts at `days` and is drawn down **FIFO (oldest lot first)**, with each `consumed` row naming the lots it drew from in `allocations[]` so a cancelled leave can refund them precisely. **Balance is authoritative from lots** — `User.comp_off_balance = Σ remaining_days` over non-expired `earned` lots; `consumed`/`expired` rows are history and never enter the sum. The denormalized field is a hot-path cache only.

- **Earn** — lots are accrued by the `comp_off_accrual` job from a day's **billable timesheet hours** (`source_type: 'timesheet_billable'`), carrying `contributions[]` — the (date, project, minutes) tuples that fed the lot, which is what the comp-off page's accordion expands. `source_type: 'attendance_overtime'` rows are **legacy**, from the earlier attendance-finalizer accrual; the read paths still handle them but nothing writes them now.
- **Spend** — `consumed` rows written when a comp-off leave request is approved.
- **Expiry** — a lot expires `COMP_OFF_EXPIRY_MONTHS` (**3**, [`constants/leave.ts`](src/constants/leave.ts)) after its source date via `expires_at`. The `comp_off_expiry` job writes an `expired` movement and zeroes `remaining_days`; `expireDueLots` is per-lot transactional and re-checks inside, so a manual re-run never double-expires.
- **Repair** — the `comp_off_reconciliation` job recomputes nightly from lot truth and warns per drifted user. It runs at 02:30, **before** the 03:20 expiry sweep, so expiry reads just-repaired balances.

### Holidays

- **Purpose** — Org holiday calendar consumed by leave-request segment generation and attendance summary
- **Roles & visibility** — All authed roles read via `HOLIDAY_READ`. Admin writes via `HOLIDAY_WRITE`.
- **Routes** — [`routes/holiday.routes.ts`](src/routes/holiday.routes.ts). CRUD + `POST /holidays/bulk` for CSV import.
- **Service** — [`services/holiday.service.ts`](src/services/holiday.service.ts) · **Model** — [`models/holiday.model.ts`](src/models/holiday.model.ts)

### Attendance management

- **Purpose** — Daily check-in/check-out (multi-session per day), break tracking, correction workflow, geofence, office QR-code resolution
- **Roles & visibility** — Employee+: check in/out, take breaks, view own, request corrections. Team Lead+: view team, approve corrections.
- **Permissions** — `ATTENDANCE_CHECK_IN_OUT`, `ATTENDANCE_READ_TEAM`, `ATTENDANCE_CORRECTION_REQUEST`, `ATTENDANCE_CORRECTION_APPROVE`
- **Routes** — [`routes/attendance.routes.ts`](src/routes/attendance.routes.ts). `POST /attendance/check-in|check-out|qr-verify`, `POST /attendance/break/start|break/end` (open/close a break on the open segment), `POST /attendance/me/breaks` (replaces **today's** break list wholesale, max 20) + `POST /attendance/me/times` (edits the **latest** segment's check-in/check-out on today's record), `GET /attendance/me/today`, `GET /attendance/me`, correction-request sub-routes (cancel is owner-only per M49), `GET /attendance` (team), `PATCH /attendance/:id` (admin override).
- **Service** — [`services/attendance.service.ts`](src/services/attendance.service.ts) · **Models** — [`attendance-record.model.ts`](src/models/attendance-record.model.ts), [`attendance-correction-request.model.ts`](src/models/attendance-correction-request.model.ts)
- **Flow** — check-in validates geofence (if enabled in settings) and WiFi/IP restrictions, then `findOneAndUpdate` against the `{user_id, local_date}` unique compound index (Asia/Kolkata) — race produces friendly `ALREADY_CHECKED_IN` (409). Check-out closes the open segment and computes minutes. Overtime is summed across **closed** segments only (BUG-040). QR check-in resolves an office-location token, then runs the same check-in flow with location pre-bound.
- **Gotchas** — geofence + WiFi restrictions are **opt-in via settings**; both default off so attendance works out-of-the-box on dev. Local date is timezone-anchored to Asia/Kolkata for the unique constraint. **`/me/breaks` + `/me/times` are today-only and apply immediately** — they are the Today-page self-service path and deliberately bypass the approval-gated correction-request flow, which remains the only way to touch a *past* day.

### Office locations

> 🔴 **Gated OFF by default** (`OFFICE_LOCATIONS_ENABLED`) — single-office setup.
> Every route below 404s unless it is set. The office's coordinates and geofence
> radius live on `SystemSettings.attendance.geofence` instead, edited under
> Settings → Work schedule on the frontend.
>
> **Attendance is NOT switched off with it.** Geofence enforcement reads the
> settings document, and `POST /attendance/qr-verify` resolves a scanned token by
> reading the `office_locations` model **directly** rather than through this
> router — so codes already printed keep working. What goes away is the ability
> to list, create, edit or rotate them.

- **Purpose** — Office addresses with geofence coords + QR-code tokens for on-site check-in
- **Roles & visibility** — All authed roles read via `OFFICE_LOCATION_READ` (sidebar nav shows the list to admins). Admin writes via `OFFICE_LOCATION_WRITE`.
- **Routes** — [`routes/office-location.routes.ts`](src/routes/office-location.routes.ts). CRUD + `POST /office-locations/:id/regenerate-qr`.
- **Service** — [`services/office-location.service.ts`](src/services/office-location.service.ts) · **Model** — [`models/office-location.model.ts`](src/models/office-location.model.ts)

### Companies (clients)

- **Purpose** — The client organisation. **"Client" IS the company**; a **"Representative"** is that company's project-scoped person. The company has **no login** — people hold the roles.
- **Permissions** — `COMPANY_READ` (admin + manager), `COMPANY_WRITE` (admin), `REPRESENTATIVE_WRITE` (admin **and** a company's own `client`s)
- **Routes** — [`routes/company.routes.ts`](src/routes/company.routes.ts). `GET|POST /companies`, `GET|PATCH /companies/:id`, `POST /companies/:id/archive`, `GET|POST /companies/:id/representatives` (list is **paginated**), `GET|DELETE /companies/:id/representatives/:user_id`, `POST /companies/:id/representatives/:user_id/restore`
- **Service** — [`services/company.service.ts`](src/services/company.service.ts) · **Model** — [`models/company.model.ts`](src/models/company.model.ts) · **Validator** — [`validators/company.validator.ts`](src/validators/company.validator.ts)
- **Gotchas**:
  - 🔴 **`POST /companies/:id/representatives` accepts NO `role` and NO `company_id`.** Both are derived server-side (role hard-coded; company from the URL, pinned to the caller's own company for non-admins) and the body schema is `.strict()`, so sending either is a **400**, not a silent ignore. The endpoint exists precisely so a Client never needs `user.write` — that bit is admin-wide and would let them create **admins**.
  - **No `owner_id`** — several people may hold `client` for one company, so it survives any one of them leaving.
  - **`name` is unique case-insensitively** via a collated index (`locale: 'en', strength: 2`). Queries must pass the **same collation** or Mongo won't use it. Free-text `company_name` had no such guard, which is how near-duplicates ("TCS" / "TCS ") appeared.
  - **Archive, never hard-delete** — projects carry `company_id`.
  - A client-side caller listing companies is **narrowed to their own**, or they'd get the full customer list.
  - 🔴 **Restore is gated on `representative.write`, NOT `user.deactivate`** — same reasoning as removal. `user.deactivate` also governs `POST /users/:id/reactivate` for *any* user, so a Client holding it could revive a deactivated admin. A non-admin may restore `representative`s only.
  - **`exclude_role` on `GET /users` takes a comma-separated LIST.** It was a single value, and the list validator's role enum was missing `representative` entirely — so the staff directory's `exclude_role=client` couldn't hide them and 14 client-side people sat among the internal staff, inflating the headcount. The **write** body enum (`roleEnum`) deliberately still excludes `representative`: that role is created only via `POST /companies/:id/representatives`, which derives role + company server-side.
  - **The people list is paginated and searchable** (`?page=&limit=&q=`, default 20; `q` matches name or email, min 2 chars, and is **regex-escaped** — unescaped, `a(` makes Mongo raise `Regular expression is invalid`. `listCompanies` had this bug too and is now fixed). The count query uses the SAME filter as the page, or the pager promises results a search doesn't have. Counts must come from `meta.total`, not `data.length`. `GET .../representatives/:user_id` exists *because* of this — a consumer that found its person by scanning the list broke for anyone past page 1.
  - 🔴 **`GET /companies/:id/representatives` returns each person's projects, scoped BY ROLE.** A `client` gets **every** project of the company (their access is the project's `company_id`); a `representative` gets only projects naming them in `representative_ids`. The response says which rule applied via `project_access: 'company' | 'assigned'` — consumers must not label a `company` list "assigned to". A client is *also* on `representative_ids`, but that entry is denormalised and may drift, so deriving their list from it would under-report projects they can genuinely open.
- **Migration** — [`scripts/migrate-companies.ts`](scripts/migrate-companies.ts), dry-run by default, `--commit` to apply. Re-runnable.
- **FE surface** — `/companies` (renamed from `/clients` 2026-07-20; the old paths redirect).

### Project management

Projects own the sprints/stories/tasks tree. `member_ids` is the internal-staff roster; the client side is `company_id` + `representative_ids` (see Companies above). Per-project custom task statuses are stored on the project doc.

The full surface — projects + members + clients + custom statuses + sprints + stories + tasks + subtasks + dependencies + comments + activity + attachments + templates + share links + timeline — is documented in a single deep-dive at [`docs/modules/project-management.md`](docs/modules/project-management.md). Highlights below.

- **Purpose** — Projects, members, clients, custom task statuses, sprints (time-boxed windows), stories (grouping layer with derived status from task rollup), tasks (subtasks + dependencies), task collaboration (comments / activity / attachments), task templates, share links, timeline (Gantt)
- **Roles & visibility** — Admin/Manager: see all. Team Lead/Employee: see projects where `member_ids ∋ caller`. **Client: every project where `company_id` = their company** (NOT roster containment — they must be able to see a new project in order to staff it). **Representative: only projects where `representative_ids ∋ caller`.** Service-layer scoping in [`loadProjectForCaller`](src/services/project.service.ts) — every project read funnels through it. **All sub-resources reuse this engine** (sprint, story, task, comment, attachment, template, timeline services all import `loadProjectForCaller`/`buildProjectVisibilityFilter`).
- **Permissions** — `PROJECT_READ`/`WRITE`/`ARCHIVE`/`MEMBERS_WRITE`/`REPRESENTATIVES_WRITE`, `SPRINT_WRITE`, `STORY_WRITE`, `TASK_READ`/`WRITE`, `TASK_COMMENT_WRITE`, `TASK_ATTACHMENT_WRITE`, `TASK_TEMPLATE_READ`/`WRITE`, `SHARE_LINK_WRITE`
- **Routes** (top-level entry points, all under `/api/v1`):
  - Projects + custom statuses + bulk member/client roster — [`routes/project.routes.ts`](src/routes/project.routes.ts). `PATCH|DELETE /project-custom-statuses/:id` are on the [`customStatusRouter`](src/routes/sprint.routes.ts) exported from `sprint.routes.ts`.
  - Nested sprint/story/template/share-link list+create on the project router.
  - Sprints — [`routes/sprint.routes.ts`](src/routes/sprint.routes.ts) (item-level GET/PATCH/DELETE/archive/unarchive plus the lifecycle pair `POST /sprints/:id/start|complete`, all at `/sprints/:id`).
  - Stories — [`routes/story.routes.ts`](src/routes/story.routes.ts).
  - Tasks — [`routes/task.routes.ts`](src/routes/task.routes.ts) (CRUD + reorder + rank + assign-story + move-sprint + dependencies).
  - Task comments — [`routes/task-comment.routes.ts`](src/routes/task-comment.routes.ts) (`GET|POST /tasks/:task_id/comments`, `PATCH|DELETE /comments/:id`).
  - Task activity — [`routes/task-activity.routes.ts`](src/routes/task-activity.routes.ts) (`GET /tasks/:task_id/activity`, read-only).
  - Task attachments — [`routes/task-attachment.routes.ts`](src/routes/task-attachment.routes.ts) (two-step SAS upload: `upload-url` → `finalize`; plus `GET /tasks/:task_id/attachments`, `GET /attachments/:id/download-url`, `DELETE /attachments/:id`).
  - Task templates — [`routes/task-template.routes.ts`](src/routes/task-template.routes.ts).
  - Share links — [`routes/share-link.routes.ts`](src/routes/share-link.routes.ts) (three sub-routers, with the **public no-auth `GET /share-links/resolve/:token`** mounted last so it doesn't shadow authed routes).
  - Timeline — [`routes/timeline.routes.ts`](src/routes/timeline.routes.ts).
  - Client-side roster — `GET|POST /projects/:id/representatives`, `DELETE /projects/:id/representatives/:user_id` (was `/clients`).
- **Gotchas** (per-area summary; full table in the module doc):
  - **G1** — `PROJECT_MEMBERS_WRITE` vs. `PROJECT_REPRESENTATIVES_WRITE` are split (Team Lead can manage members; Manager+ and a company's own `client`s manage the client-side roster). `PROJECT_ARCHIVE` (not `PROJECT_WRITE`) gates `DELETE /projects/:id`.
  - **`company_id` is authoritative for a `client`'s access, not `representative_ids`.** Clients are *also* listed on the roster so it's one explicit field, but that entry is **denormalised** — if it drifts, a client still sees the project. Drift costs display accuracy, never access.
  - **Roster invariant** — every `representative_id` must be an active client-side user of THIS project's company. The company half is what stops company B's person being rostered onto company A's project. Changing `company_id` **resets** the roster.
  - **F4** — Member/client bulk add/remove uses two atomic updates (`$pull` then `$addToSet`) inside `withTransaction` to avoid lost-write races between concurrent admin callers.
  - **R3** — Hard-delete project / sprint / custom-status refuses with `RESOURCE_HAS_DEPENDENTS` when anything still references it. Archive is the escape hatch.
  - **BUG-007** — Team Lead/Employee creating a project is auto-added to `member_ids` so they don't lose visibility of their own project.
  - 🔴 **Two different scopes now govern an Employee's project writes — don't conflate them.**
    `assertCallerCanWrite` (project.service) gates the project SHELL — rename,
    status, members, custom statuses, delete — and for an Employee that means
    **`created_by === them`**. The WORK inside it (sprints, epics) is gated by
    `loadProjectForCaller` alone, so an Employee may plan **any project they're
    a member of**. That asymmetry is deliberate: you can help plan a project
    you're on without being able to rename or restaff it.
    Before this existed those six write paths had **no per-row check at all** —
    the route's `requirePermission` was the only gate, so any `project.write`
    holder could edit or delete any project by id, including ones the
    visibility filter hides. Don't remove the assert to "simplify".
  - **`isProjectAuthor` vs `isProjectWorkAuthor`** (`utils/role-check.ts`) —
    the first is admin/manager/team_lead and still gates `task_template.write`;
    the second adds Employee and gates sprints + stories. They are separate
    because folding Employee into the first would silently widen templates too.
    Both exist only to keep the **client side** out; WHICH project is always
    decided by `loadProjectForCaller`.
  - **T11** — Sprint archive lets a sprint with lingering tasks be decommissioned without forcing each task into a terminal status.
  - **F1** — Sprint list defaults to `is_archived: false` when the param is absent.
  - **H2** — Service-layer `isProjectAuthor` checks admin/manager/team_lead (not just admin/manager) so Team Leads who pass the route gate don't get 403'd inside the service.
  - **M11** — `GET /stories/:id/tasks` paginates at the DB layer (was in-memory `.slice` pre-M11).
  - **BUG-041** — A task marked `done` cannot have a future `due_date` (Zod refine when both `status` and `due_date` are in the payload).
  - **Subtask depth = 1** — `TASK_MAX_SUBTASK_DEPTH` enforces single-level subtasks; a subtask cannot itself be a parent. On task delete, subtasks are **detached** (`parent_task_id = null`), not cascade-deleted.
  - **Task status is a free string**, not an enum — valid set is `(defaults ∪ project.custom_task_statuses)` and is re-derived per write because Mongoose enums can't be per-project.
  - **`task.status` change moves the task to the END of the destination column** (avoids collisions in the dense per-column position integer).
  - **Employee scope on PATCH /tasks/:id** — restricted to creator-or-assignee AND a whitelist (`TASK_EMPLOYEE_PATCH_FIELDS = status / description / estimated_hours`) at the service layer.
  - **Reorder** (`POST /tasks/:id/reorder`) is allowed for admin/manager/team_lead **OR the task's `primary_assignee_id`** so the person owning the work can drag their own card.
  - **`assign-story` by a non-writer returns `STORY_WRITE_FORBIDDEN`** (not `TASK_WRITE_FORBIDDEN`) per API_Contract — semantically a story-write op.
  - **Dependencies** — embedded array on `Task`, capped at 50, BFS cycle detection (`wouldCreateCycle`) forward over the graph.
  - **Comment edit is author-only** (admin/manager cannot rewrite words). Delete is author OR moderator (admin/manager/team_lead). Soft-delete via `deleted_at`.
  - **Comment notification fan-out (BUG-068)** — mentions OR assignees, never both: if the comment has mentions, only mentioned users are notified; otherwise the task's assignees get a quiet in-app ping.
  - **Mentions** — validated via `assertMentionsBelongToProject` (single source of truth) — must be project members or clients.
  - **Activity feed** — `recordActivity` never throws; `recordActivityIfChanged` skips writes when from/to are equal (ObjectId-aware via `.equals`).
  - **Attachment SAS pins Content-Type** so a `.png` upload can't be served back as `text/html`. Blob key is `tasks/{task_id}/users/{uploader_id}/{ulid}-{safe_name}` — the uploader segment defends against the race-to-finalize-someone-else's-blob attack.
  - **Attachment finalize HEADs the blob** to verify presence + size match — catches metadata-only spoofs.
  - **Templates silently drop stale references** at instantiation (with a warn log) — a stale assignee/story/sprint doesn't hard-fail a recurring task; operator can investigate from logs.
  - **Recurring sweep** uses a CAS on `recurrence.last_generated_at` to stamp idempotently; concurrent ticks can't double-instantiate.
  - **C9** — Share-link token is hashed (`token_hash: sha256Hex(token)`) at rest; raw token is returned ONCE in the create response and never echoed elsewhere (incl. `audit_logs`).
  - **H19** — Public share-link resolve caps the payload at 50 sprints / 100 stories / 1000 tasks via the `limit+1` pattern; `truncated: {…}` surfaces the cap hit.
  - **H4** — `active_only` query param uses `booleanish` (string `"true"/"false"` accepted) rather than `z.coerce.boolean()` because `Boolean("false")` is truthy.
  - **Share-link cascade** — deactivating a client revokes all their open links via `revokeLinksForDeactivatedClient`; each revoke is independently audited; never throws.
  - **Public 410 doesn't echo `revoke_reason`** — would leak `client_deactivated` to a token holder.
  - **Timeline derived `start_date`** — read-time per task; `sprint.start_date` if task is sprinted, else `toIstDate(created_at)`. No schema migration; FE Gantt renders `[start_date, due_date]`.
  - **Timeline two-stage overlap filter** — DB anchors the right edge (`due_date >= from_date`), JS anchors the left edge (`derived_start <= to_date`) after the sprint join.
  - **Timeline caps**: `TIMELINE_RANGE_MAX_DAYS = 365`, `TIMELINE_TASK_CAP = 2000` with `truncated: true` flag. Read-only — never audits.

### Timesheets

- **Purpose** — Daily entries (per project/task), weekly view, manager approval, billing-rate join
- **Roles & visibility** — Employee+: own entries (`/me` routes are auth-only since the service pins to caller). Team Lead+ + Manager+: read team via `TIMESHEET_READ`. Manager+: out-of-window edits via `TIMESHEET_EDIT_OUT_OF_WINDOW` (separate audit action when used).
- **Permissions** — `TIMESHEET_READ`, `TIMESHEET_WRITE`, `TIMESHEET_EDIT_OUT_OF_WINDOW`, `BILLING_RATE_READ`
- **Routes** — [`routes/timesheet.routes.ts`](src/routes/timesheet.routes.ts). `GET /timesheets/me`, `/me/day/:date`, `/summary`, list/create/patch/delete at `/timesheets`.
- **Service** — [`services/timesheet.service.ts`](src/services/timesheet.service.ts) · **Model** — [`models/timesheet-entry.model.ts`](src/models/timesheet-entry.model.ts)
- **Gotchas** — soft policies (daily-threshold warn, overlaps-approved-leave warn) **don't block**; entry persists with the warning visible. Self-edit-window is configurable in settings; out-of-window manager edits fire a separate `timesheet.edit_out_of_window` audit action.

### Billing rates

> 🔴 **The API is GATED OFF, not just hidden.** Billing rates, cost rates, engagements,
> invoices and the Billing + Margin reports are out of scope for the current phase, so
> **every endpoint below 404s** unless `BILLING_MODULES_ENABLED=true`
> (`config/server.config.ts`, off by default in every environment including dev). The
> frontend hides the same set behind `VITE_BILLING_MODULES`; **both halves must be on** to
> work on the module.
>
> This used to read "the API is live; the UI is hidden" — the endpoints answered any caller
> with the right permission, so the data was one authenticated request away from a surface
> nobody could see. `requireBillingModules` (`middlewares/feature-flag.middleware.ts`)
> closes that at the mount point; `requireExportableReport` closes the matching
> `POST /reports/billing/export`, because an export renders the same builder as the
> synchronous GET and would otherwise be a way around the gate.
>
> **404, not 403** — the resource genuinely doesn't exist in this deployment, and 403 would
> confirm to a prober that an invoices API is there and merely closed to them. The gate is
> a phase switch layered ON TOP of the permission checks, not a replacement for them:
> flipping it on restores the ordinary `requirePermission` behaviour underneath, unchanged.
> Permissions stay granted and services stay compiled, so re-enabling is one env var.
>
> Fix before switching it on: **`invoice.read` is bundled into the `manager` role and has no
> row scoping**, so any Manager can read every company's engagements and invoices. The
> module is also unfinished — no bulk invoice run, no emailing, and the margin report
> degrades to a warnings banner wherever a bill or cost rate is missing.

- **Purpose** — User × project hourly rate with effective/end dates; joined into billing reports
- **Permissions** — `BILLING_RATE_READ` (Manager+), `BILLING_RATE_WRITE` (Manager+/Admin per seed)
- **Routes** — [`routes/billing-rate.routes.ts`](src/routes/billing-rate.routes.ts). CRUD + `POST /billing-rates/:id/end` (soft-end with effective date).
- **Service** — [`services/billing-rate.service.ts`](src/services/billing-rate.service.ts) · **Model** — [`models/billing-rate.model.ts`](src/models/billing-rate.model.ts)

### Cost rates & Margin

> 🔴 **The API is GATED OFF, not just hidden.** Billing rates, cost rates, engagements,
> invoices and the Billing + Margin reports are out of scope for the current phase, so
> **every endpoint below 404s** unless `BILLING_MODULES_ENABLED=true`
> (`config/server.config.ts`, off by default in every environment including dev). The
> frontend hides the same set behind `VITE_BILLING_MODULES`; **both halves must be on** to
> work on the module.
>
> This used to read "the API is live; the UI is hidden" — the endpoints answered any caller
> with the right permission, so the data was one authenticated request away from a surface
> nobody could see. `requireBillingModules` (`middlewares/feature-flag.middleware.ts`)
> closes that at the mount point; `requireExportableReport` closes the matching
> `POST /reports/billing/export`, because an export renders the same builder as the
> synchronous GET and would otherwise be a way around the gate.
>
> **404, not 403** — the resource genuinely doesn't exist in this deployment, and 403 would
> confirm to a prober that an invoices API is there and merely closed to them. The gate is
> a phase switch layered ON TOP of the permission checks, not a replacement for them:
> flipping it on restores the ordinary `requirePermission` behaviour underneath, unchanged.
> Permissions stay granted and services stay compiled, so re-enabling is one env var.
>
> Fix before switching it on: **`invoice.read` is bundled into the `manager` role and has no
> row scoping**, so any Manager can read every company's engagements and invoices. The
> module is also unfinished — no bulk invoice run, no emailing, and the margin report
> degrades to a warnings banner wherever a bill or cost rate is missing.

- **Purpose** — Billing Phase 2 "Cost Rates & Margin" (`docs/superpowers/specs/2026-07-24-cost-margin-design.md`). Per-person, effective-dated **cost rate** (fully-loaded cost/hour, own currency) — the cost-side twin of `billing_rates` but per-`user_id` only (no project/task dimension). Feeds a **Margin report** that nets bill-rate revenue against cost-rate cost, per project/per user, normalised into one reporting currency via an admin-managed FX table.
- **Permissions** — `COST_RATE_READ` (`cost_rate.read`, bundled into the manager role — needed to see the Margin report), `COST_RATE_WRITE` (`cost_rate.write`, admin-only by default, same pattern as `INVOICE_WRITE`). `constants/system-role-definitions.ts` is where the manager bundle is declared.
- **Model** — [`models/cost-rate.model.ts`](src/models/cost-rate.model.ts): `user_id`, `cost_per_hour`, `currency` (ISO 4217), `effective_from`/`effective_to` (nullable = current, both inclusive `YYYY-MM-DD`). **Unique** `{user_id, effective_from}` index (parallel-create race guard → `409 DUPLICATE_RESOURCE`), lookup index `{user_id, effective_from: -1}`.
- **Routes** — [`routes/cost-rate.routes.ts`](src/routes/cost-rate.routes.ts). CRUD + `POST /cost-rates/:id/end`, mirrors `billing-rate.routes.ts`'s shape (route-level `requirePermission` only).
- **Service** — [`services/cost-rate.service.ts`](src/services/cost-rate.service.ts). Same write invariants as `billing-rate.service.ts`: `effective_to >= effective_from`; **forward-extension auto-close** (a new open-ended rate starting after an existing open rate auto-closes the predecessor to `effective_from - 1`, inside `withTransaction`); anything else overlapping is a hard `COST_RATE_INVALID_RANGE` refusal. **Delete-in-use guard** — `deleteCostRate` blocks with `COST_RATE_IN_USE` (409) if any `TimesheetEntry` for that `user_id` falls inside the rate's effective window (no project/task dimension to narrow by, unlike billing-rate). `resolveCostRateForUser(userId, onDate)` is the rate-at-date lookup the margin service consumes.
- **FX config** — `SystemSettings.billing.reporting_currency` (default `'INR'`) + `billing.fx_rates[]` (`{currency, rate_to_base}`, "1 unit of `currency` = `rate_to_base` `reporting_currency`"), edited via the normal `PATCH /settings` (`SETTINGS_WRITE`). [`utils/fx.ts`](src/utils/fx.ts)`#toReportingCurrency(amount, fromCurrency, reportingCurrency, fxRates)` — same-currency short-circuits with no lookup; no matching rate throws `AppError` 422 `FX_RATE_MISSING` rather than silently mis-reporting.
- **Margin service** — [`services/margin.service.ts`](src/services/margin.service.ts)`#buildMarginReport`. Per project × user: `revenue = billable_hours × bill_rate` (project's engagement currency), `cost = billable_hours × cost_rate` (cost rate's own currency), both converted to the reporting currency via FX; `margin = revenue − cost`; `margin_pct = margin / revenue` (a bare ratio, not ×100 — `null` when revenue is 0). **Reuses** `sumBillableByUser` + `resolveUserRates` from `invoice.service.ts` (identical `$match`/rate-resolution as the billing report/invoices) so the money path stays in parity across invoices, billing report, and margin — one source of truth, not a re-query. Project → currency resolved from the most-recently-started **active** engagement covering it (explicit `project_ids` wins over company-wide); no covering engagement → defaults to the reporting currency. Missing bill rate / missing cost rate / missing FX rate each degrade to a **warning** (deduped in a `Set`) with a zero contribution rather than failing the whole report — `toReportingCurrency`'s thrown `FX_RATE_MISSING` is caught and folded into a warning at this layer.
- **Route** — `GET /reports/margin` ([`routes/report.routes.ts`](src/routes/report.routes.ts)) is registered **before** the blanket `router.use(requirePermission(REPORT_READ))` and gated only on `COST_RATE_READ` — margin exposes cost, which is more sensitive than the other reports, so a custom role holding `cost_rate.read` without `report.read` can still reach it. Manager holds both by default, so this reordering is invisible to out-of-the-box roles.

### Invoicing (client engagements + invoices)

> 🔴 **The API is GATED OFF, not just hidden.** Billing rates, cost rates, engagements,
> invoices and the Billing + Margin reports are out of scope for the current phase, so
> **every endpoint below 404s** unless `BILLING_MODULES_ENABLED=true`
> (`config/server.config.ts`, off by default in every environment including dev). The
> frontend hides the same set behind `VITE_BILLING_MODULES`; **both halves must be on** to
> work on the module.
>
> This used to read "the API is live; the UI is hidden" — the endpoints answered any caller
> with the right permission, so the data was one authenticated request away from a surface
> nobody could see. `requireBillingModules` (`middlewares/feature-flag.middleware.ts`)
> closes that at the mount point; `requireExportableReport` closes the matching
> `POST /reports/billing/export`, because an export renders the same builder as the
> synchronous GET and would otherwise be a way around the gate.
>
> **404, not 403** — the resource genuinely doesn't exist in this deployment, and 403 would
> confirm to a prober that an invoices API is there and merely closed to them. The gate is
> a phase switch layered ON TOP of the permission checks, not a replacement for them:
> flipping it on restores the ordinary `requirePermission` behaviour underneath, unchanged.
> Permissions stay granted and services stay compiled, so re-enabling is one env var.
>
> Fix before switching it on: **`invoice.read` is bundled into the `manager` role and has no
> row scoping**, so any Manager can read every company's engagements and invoices. The
> module is also unfinished — no bulk invoice run, no emailing, and the margin report
> degrades to a warnings banner wherever a bill or cost rate is missing.

- **Purpose** — Phase 1 "Client Engagements & Invoicing" (`docs/superpowers/specs/2026-07-24-billing-invoicing-design.md`). Models a client **Engagement** (contract: hourly / retainer / fixed / hybrid, scoped to a company and optionally specific projects), then generates and persists numbered **Invoices** from an engagement + period, with billable hours auto-pulled from timesheets. Closes the gap between the billing-rate/billing-report pieces (rates exist, but there was never a persisted, numbered bill) and unblocks the Slack Phase 3 invoice modal.
- **Permissions** — `INVOICE_READ` (`invoice.read`, bundled into the manager role alongside `BILLING_RATE_READ`/`REPORT_READ`), `INVOICE_WRITE` (`invoice.write`, admin-only by default — not in `MANAGER_ADDITIONS`, granted via `system.admin` wildcard or a custom role). `constants/system-role-definitions.ts` is where the manager bundle is declared.
- **Models** — [`models/engagement.model.ts`](src/models/engagement.model.ts) (`company_id`, `project_ids[]` where `[]` = all the company's projects, `billing_type: 'hourly'|'retainer'|'fixed'|'hybrid'`, `setup_fee`/`setup_fee_invoiced`, `retainer_amount`/`retainer_period`/`included_hours`, `fixed_amount`, `start_date`/`end_date`, `status`), [`models/invoice.model.ts`](src/models/invoice.model.ts) (`number` unique, `company_id`/`project_ids`/`currency` are **snapshots** taken at generation time — they don't follow later edits to the engagement/company/project — `line_items[]` with `kind: 'hours'|'retainer'|'setup'|'overage'|'fixed'|'manual'`, `subtotal`/`tax_rate`/`tax_label`/`tax_amount`/`total`, `status: 'draft'|'sent'|'paid'|'void'`), [`models/invoice-counter.model.ts`](src/models/invoice-counter.model.ts) (one row per calendar year for the numbering sequence).
- **Routes** — [`routes/engagement.routes.ts`](src/routes/engagement.routes.ts): `GET /engagements` + `GET /engagements/:id` (`INVOICE_READ`), `POST /engagements` + `PATCH /engagements/:id` + `POST /engagements/:id/end` (soft-end) (`INVOICE_WRITE`). [`routes/invoice.routes.ts`](src/routes/invoice.routes.ts): `GET /invoices` + `GET /invoices/:id` + `GET /invoices/:id/pdf` (`INVOICE_READ`), `POST /invoices/generate` + `PATCH /invoices/:id` (draft-only field edits) + `POST /invoices/:id/status` (legal-transition guard) + `DELETE /invoices/:id` (draft only — sent/paid are void-not-delete) (`INVOICE_WRITE`). Note **engagements have no DELETE route at all** — `end` (soft-end) is the only retirement path. Both routers mirror the `billing-rate.routes.ts` shape — route-level `requirePermission` only, no per-row override.
- **Services** — [`services/engagement.service.ts`](src/services/engagement.service.ts), [`services/invoice.service.ts`](src/services/invoice.service.ts) (`generateInvoice` — the core algorithm), [`services/invoice-number.service.ts`](src/services/invoice-number.service.ts) (`nextInvoiceNumber`).
- **Generation algorithm** (`generateInvoice({ engagement_id, period_start, period_end, actor })`) — **reuses the billing-report aggregation** (`report.service.ts` → `buildBillingReport`'s `$match`) so invoice `hours` amounts equal what the report would show for the same projects/window: sums `TimesheetEntry.billable_total_minutes` for `entry_type: 'task_linked'` in `[period_start, period_end]` on the engagement's projects, grouped by user, × the resolved `BillingRate` (project-level, effective at the window end). Builds one line per billing-type component: **retainer** → one `retainer` line for the period, plus an `overage` line (billed hourly) if actual hours exceed `included_hours`; **setup** → a `setup` line only if `setup_fee` is set and `setup_fee_invoiced === false` (flag flips inside the same transaction — bill-once guard); **hourly**/hybrid's hourly component → one `hours` line per user; **fixed** → one `fixed` line for `fixed_amount`. Rounds every line/subtotal/tax to 2dp; `total = subtotal + tax_amount`. Persists as **draft** with the next `INV-{YYYY}-{NNNN}` number (`nextInvoiceNumber`, race-safe `findOneAndUpdate({year}, {$inc:{seq:1}}, {upsert, new:true})` — same pattern as `projects.task_seq`). The whole generate (invoice create + counter increment + `setup_fee_invoiced` flip) runs inside `withTransaction`.
- **Lifecycle** — `POST /invoices/:id/status` enforces a **transition table**, not a free-for-all: `sent` is reachable **only** from `draft`; `paid` **only** from `sent` (so draft → paid is illegal — issue it first); `void` from **any** non-void state; and **`void` is terminal** — nothing leaves it. Anything else throws `INVOICE_INVALID_TRANSITION`. Orthogonal to that, editing is frozen at `sent`: a `draft` is fully editable (line items incl. free-form `manual` lines — negative amount = discount — plus `tax_rate`/`tax_label`/`due_date`/`notes`), and `PATCH /invoices/:id` on anything past draft throws `INVOICE_NOT_DRAFT`. Together these make the invoice the durable billing snapshot the (never-persisted) billing report never was.
- **Gotchas** — **hybrid bills overage OR hours, never both** — an engagement is either retainer-with-overage or hourly-with-per-user-lines for a given period, not both computed simultaneously for the same hours. **Setup fee bills exactly once** via `setup_fee_invoiced` — a second `generateInvoice` call on the same engagement won't re-add the `setup` line once it's flipped true. **No rate found** doesn't fail generation — the `hours` line still lists hours with `rate: null`, `amount: 0` (mirrors the billing report's degradation), surfaced as a warning for the admin to fix rates rather than silently dropped. **Overlap guard** on `POST /invoices/generate` warns (not hard-blocks) when a non-void invoice already covers an overlapping period for the same engagement — the FE confirms before proceeding. **An engagement can never be deleted** — there is no delete route and no delete service function; `POST /engagements/:id/end` (soft-end) is the only retirement path, so the invoices that reference it can't be orphaned by construction. `company_id`/`project_ids`/`currency` on an invoice are snapshots — editing the source engagement/company/project afterward never mutates an already-generated invoice.

### Payroll & Certificates

> 🔴 **The API is live; the feature is not usable end-to-end.** Everything below is
> accurate about the backend, and all of it is reachable with a token. Two things this
> section historically did not say:
>
> 1. **PDF generation returns 500 in every deployed environment.** `pdf.service.ts`
>    launches Playwright Chromium, which cannot run under App Service zipdeploy — both
>    bundling approaches were tried and both failed. It works locally once
>    `npx playwright install chromium` has been run, which is why it looks fine in
>    development. See [`docs/runbooks/pdf-generation-azure.md`](../docs/runbooks/pdf-generation-azure.md);
>    the fix is the Playwright container image and it is not started.
> 2. **The frontend surfaces are suppressed.** The payroll UI has no sidebar entry and no
>    cross-link anywhere — it is reachable only by typing the URL — and since 2026-07-31
>    payslip/letter **generation** is additionally hidden behind the `PAYROLL_PDF_ENABLED`
>    feature flag, so those pages are unreachable even by URL. Downloading an
>    already-issued document still works. See the frontend `CLAUDE.md` §Suppressed
>    surfaces.
>
> Read this before concluding from the endpoint list that payroll is a working feature for
> users. It is a working API with no reachable UI and a broken renderer in production.

- **Purpose** — Per-user payroll master data (statutory/bank details + versioned salary structure) and on-demand generation of payslip + employee-letter PDFs (offer, joining, internship_offer, relieving, experience, internship, hike, promotion). Foundation phase — no bulk monthly run yet.
- **Roles & visibility** — The first four permissions below are bundled into `manager` by default (alongside admin's `system.admin` wildcard); the two `*_DELETE` bits are **admin-only** — deliberately not in any role bundle, so only the `system.admin` wildcard grants them. All six are ordinary `requirePermission` gates, so any custom role can also be granted them. Employees have no self-service read/download today (no `/me` routes on these routers).
- **Permissions** — `PAYROLL_READ` (`payroll.read`, list/get profiles + salary structures + payslip/letter lists), `PAYROLL_WRITE` (`payroll.write`, upsert profile + create salary structure), `PAYSLIP_GENERATE` (`payslip.generate`, generate **and** preview **and** download — pulling a rendered PDF is treated as the sensitive act either way), `LETTER_GENERATE` (`letter.generate`, same rationale for letters), `PAYSLIP_DELETE` (`payslip.delete`) + `LETTER_DELETE` (`letter.delete`) — deleting an already-issued document, admin-only.
- **Routes**:
  - Profiles — [`routes/payroll-profile.routes.ts`](src/routes/payroll-profile.routes.ts): `GET /payroll-profiles`, `GET /payroll-profiles/:user_id`, `PUT /payroll-profiles/:user_id` (upsert).
  - Salary structures — [`routes/salary-structure.routes.ts`](src/routes/salary-structure.routes.ts): `GET /salary-structures`, `POST /salary-structures` (new version), `GET /salary-structures/:id`. Structures are immutable/versioned — there's no PATCH/PUT.
  - Payslips — [`routes/payslip.routes.ts`](src/routes/payslip.routes.ts): `POST /payslips` (generate), `POST /payslips/preview` (renders the identical PDF but persists **nothing** — no blob, no row, no audit) + `POST /payslips/preview-html` (HTML for the live on-page editor; no Playwright), `GET /payslips` (list, `PAYROLL_READ`), `GET /payslips/:id/download` (mints a short-lived SAS), `DELETE /payslips/:id` (`PAYSLIP_DELETE`).
  - Letters — [`routes/letter.routes.ts`](src/routes/letter.routes.ts): same shape as payslips — `POST /letters`, `POST /letters/preview`, `POST /letters/preview-html`, `GET /letters`, `GET /letters/:id/download`, `DELETE /letters/:id` (`LETTER_DELETE`) — one router covering all 8 `type` values.
- **Models** — [`models/payroll-profile.model.ts`](src/models/payroll-profile.model.ts) (one doc per user: PAN/UAN/PF/ESI/PRAN/bank details/`location`/tax regime, unique on `user_id`), [`models/salary-structure.model.ts`](src/models/salary-structure.model.ts) (versioned earnings/deductions line items keyed by `effective_from`; `is_current` is a denormalized convenience flag — the authoritative accessor is `getCurrentStructure`, which re-derives "what applies on date X" from `effective_from <= date` rather than trusting the flag), [`models/payslip.model.ts`](src/models/payslip.model.ts) and [`models/letter.model.ts`](src/models/letter.model.ts) (both immutable, append-only — re-running generation creates a new row with a fresh `blob_key`/`content_hash`, never edits in place; `render_snapshot` freezes the exact render-data payload for later audit/dispute).
- **Services** — [`services/payroll-profile.service.ts`](src/services/payroll-profile.service.ts), [`services/salary-structure.service.ts`](src/services/salary-structure.service.ts) (`getCurrentStructure` is depended on by payslip/letter generation — don't change its signature), [`services/payslip.service.ts`](src/services/payslip.service.ts), [`services/letter.service.ts`](src/services/letter.service.ts).
- **PDF rendering** — [`services/payroll/pdf.service.ts`](src/services/payroll/pdf.service.ts) launches a **singleton headless Chromium** via Playwright (`chromium.launch`), rendering HTML → PDF (`page.pdf`, A4, background printing on, zero page margin — margins are owned by each template's `@page` rule). The browser handle is cached across requests; a `disconnected` listener drops the singleton so a crash self-heals on the next render, and a failed launch is never cached so a missing browser binary can be retried once fixed. `shutdownPdf()` closes the browser and is wired into the graceful-shutdown sequence in [`index.ts`](src/index.ts) (alongside `stopScheduler`/`disconnectDB`) so SIGTERM/SIGINT don't leak a Chromium process. Templates — [`services/payroll/payslip-template.ts`](src/services/payroll/payslip-template.ts), [`services/payroll/letter-template.ts`](src/services/payroll/letter-template.ts), [`services/payroll/offer-letter-template.ts`](src/services/payroll/offer-letter-template.ts) (offer letters use ad-hoc data, not `buildLetterRenderData` — see comments in `letter.service.ts`) — are ported HTML/CSS templates, adapted from platform models via [`services/payroll/render-adapter.service.ts`](src/services/payroll/render-adapter.service.ts) (pure read/transform, no HTTP concerns, no audit rows — the generation services own the audit trail). Static assets (logo SVG, signature/stamp PNGs, Kalice woff2 fonts) live under [`src/assets/payroll/`](src/assets/payroll/) and are read at runtime relative to `dist/`; since `tsc` doesn't copy non-TS assets, [`scripts/copy-payroll-assets.mjs`](scripts/copy-payroll-assets.mjs) mirrors `src/assets` → `dist/assets` as a `build` post-step — a production build silently renders blank images if this step is skipped.
- **Storage** — PDF bytes live in a **private** Azure Blob container, [`AZURE_BLOB_PAYROLL_DOCUMENTS_CONTAINER`](src/config/server.config.ts) (env-overridable, defaults to `payroll-documents`). `blob_key` is the pointer, `content_hash` (SHA-256 of the PDF bytes) is a tamper-evidence check; there is never a permanent public URL — downloads always mint a fresh short-lived SAS via `mintDownloadSas`.
- **Settings** — `SystemSettings.payroll` ([`models/system-settings.model.ts`](src/models/system-settings.model.ts)) holds the company letterhead/signatory block (`company_legal_name`, `company_address_lines`, `company_email`, `cin_no`, `iec_code`, `signatory_name`, `signatory_title`, `hr_reply_to_address`, `hr_reply_to_name`) shared by every payslip/letter template. Edited via the normal `PATCH /settings` body (gated on `SETTINGS_WRITE`, same as every other settings subsection — no separate payroll-settings route). All fields default to `''`/safe defaults so the subsection is savable field-by-field from day one.
- 🔴 **`internship_offer` vs `internship`.** `internship_offer` is issued at the START of an internship (position, fixed window, work mode, paid/unpaid, responsibilities, terms — own template, `internship-offer-letter-template.ts`). `internship` renders an **Internship Experience Letter**, issued at the END. Different documents; don't collapse them. Like `joining`, `internship_offer` may name its subject manually (`candidate_name`) with no `user_id`, because an intern usually isn't a platform user when the offer goes out.
- **All three letter entry points share `resolveRender`** in `letter.service.ts` (generate / preview / preview-html). They each used to carry their own copy of the per-type if/else, so a new type could be wired into two of them and silently render the WRONG template in the live preview.
- 🔴 **Freelancers get no payslip and no letters.** Two guards, each on the one
  funnel its document type passes through, because in both cases generate /
  preview / preview-html would otherwise need three copies:
    - **Payslip** — `buildPayslipRenderData` throws `PAYSLIP_NOT_APPLICABLE`
      (422). Guarding `generatePayslip` alone would still let the two preview
      endpoints render a full payslip for someone who should never have one.
    - **Letters** — `letter.service:resolveRender` throws
      `LETTER_NOT_APPLICABLE` (422), covering **all eight types** including
      `offer` and `internship_offer`, which build their data ad-hoc and never
      touch `loadEmployeeCore` — a guard down there would have missed them.
      A **missing `user_id` is not refused**: `joining` / `offer` /
      `internship_offer` may name a candidate with no platform account, so
      there is simply nobody to check.
- **Gotchas** — Structures are append-only by version (`effective_from`), not editable — correcting a mistake means creating a new version, not patching the old one; a unique `(user_id, effective_from)` index turns a parallel-create race into a clean `E11000` the service maps to `409 DUPLICATE_RESOURCE`. Payslip/letter rows are likewise immutable — regenerating for the same period/type always inserts a new row rather than overwriting. No employee self-service yet (no `/me` payslip/letter routes) and no bulk/batch generation — both are **Phase-2 deferred**, along with emailing generated documents out automatically (see `PENDING_WORK.md`).

### Reports & exports

- **Purpose** — Synchronous report reads + async PDF/XLSX/CSV export pipeline
- **Roles & visibility** — Manager+: `REPORT_READ` (read + sync responses), `REPORT_EXPORT_WRITE` (async export). Per-user rate limits stacked on top of the global per-IP cap.
- **Routes** — [`routes/report.routes.ts`](src/routes/report.routes.ts). Sync: `GET /reports/billing|utilization|attendance|leaves`. Async: `POST /reports/:name/export` (10/15min/user) + `GET /reports/exports/:id` (status poll).
- **Services** — [`services/report.service.ts`](src/services/report.service.ts) (builders), [`services/report-export.service.ts`](src/services/report-export.service.ts) (pipeline)
- **Flow** — sync builders aggregate live and return JSON. POST `/export` creates a `ReportExport` row, then either runs the worker inline (`EXPORT_WORKER_INLINE=true`, test seam) or async via `setImmediate`. Worker calls the same builder, renders via the format-specific exporter ([`services/report-exporters/`](src/services/report-exporters/)), uploads to Azure Blob, persists `blob_container` + `blob_key` + `file_size_bytes` (there is **no** content hash on `report_exports` — only payslips and letters carry `content_hash`), and mints a fresh download SAS on each poll. **Inline fallback** in [`report-export.controller.ts`](src/controllers/report-export.controller.ts): if Azure isn't configured, the POST returns the file body directly with `X-Export-Inline: 1` so dev / on-prem deployments still work.
- **Gotchas** — orphaned `running` rows (worker crash) get swept to `failed` by the [`stuck_job_sweeper`](src/jobs/index.ts). Two concurrent enqueues from one user produce two rows — no global queue lock.

#### Report presets
[`routes/report-preset.routes.ts`](src/routes/report-preset.routes.ts) · owner-scoped CRUD of saved filter sets. Cross-user reads return 404 (anti-enumeration).

#### Report subscriptions
[`routes/report-subscription.routes.ts`](src/routes/report-subscription.routes.ts) · owner-scoped recurring exports. **The dispatch cron is live**: `report_subscription_sweep` ([`jobs/report-subscription.job.ts`](src/jobs/report-subscription.job.ts)) runs daily at 07:00 IST, builds + renders + emails every active subscription whose `day_of_week` matches today (IST), capped at `REPORT_SUBSCRIPTION_MAX_PER_RUN` (500) per tick. Per-subscription failures increment `summary.failures` and write a `report_subscription.send` audit row with `metadata.delivery: 'failed'` — they never abort the sweep.
- 🔴 **`hour_local` is data-shape only.** It is validated (0–23), patchable, and stored — but the sweep never reads it. Every subscription is delivered in the single 07:00 IST pass regardless of the hour chosen; setting `hour_local: 17` does **not** delay the email to 5 PM. The field exists so the FE can ship a "send at" picker whose UX stays stable when a future hourly-cron variant honours it. See the note in [`constants/report-subscription.ts`](src/constants/report-subscription.ts).

### Audit log & archive

- **Purpose** — Every mutating service writes an `AuditLog` row via [`recordAudit`](src/services/audit.service.ts). Daily cron archives old rows to immutable Azure Blob WORM with a tamper-detection signature.
- **Roles & visibility** — Admin: `AUDIT_LOG_READ` + `AUDIT_ARCHIVE_READ`.
- **Routes** — [`routes/audit-log.routes.ts`](src/routes/audit-log.routes.ts), [`routes/audit-archive.routes.ts`](src/routes/audit-archive.routes.ts). Both read-only.
- **Services** — [`services/audit.service.ts`](src/services/audit.service.ts), [`services/audit-archive.service.ts`](src/services/audit-archive.service.ts) · **Models** — [`models/audit-log.model.ts`](src/models/audit-log.model.ts), [`models/audit-archive.model.ts`](src/models/audit-archive.model.ts)
- **Audit row shape** — `actor_id`, `actor_role`, `action` (e.g. `LEAVE_REQUEST_APPROVE`), `target_entity {kind, id}`, `before`, `after`, `metadata {ip, user_agent, request_id, before_snapshot_dropped?, after_snapshot_dropped?}`. Snapshots over `AUDIT_SNAPSHOT_BYTES_MAX` are dropped with a marker.
- **Gotcha** — `recordAudit` **never throws**. Failures log at `warn` with `AUDIT_WRITE_FAILED`. The primary mutation always succeeds. **Audit writes inside `withTransaction` retry with the transaction** (intentional — keeps the audit ↔ state-change pair atomic).

### Settings

- **Purpose** — Singleton system settings: company branding, work schedule, leave policy, security, uploads, email, reminders, Slack
- **Roles & visibility** — `GET /settings/public` is **unauthenticated** (login-page branding only). `GET /settings` is authed; admin sections are redacted server-side for non-admin callers. Writes need `SETTINGS_WRITE` (or `SETTINGS_SLACK_WRITE` for the Slack sub-section).
- **Routes** — [`routes/settings.routes.ts`](src/routes/settings.routes.ts). Public branding → authed merged read → admin PATCH. Slack subsurface: `GET|PATCH /settings/slack`, `POST /settings/slack/test-message`.
- **Service** — [`services/settings.service.ts`](src/services/settings.service.ts), [`services/slack-settings.service.ts`](src/services/slack-settings.service.ts) · **Model** — [`models/system-settings.model.ts`](src/models/system-settings.model.ts)
- **Gotchas** — public route declared **before** `authenticate` so Express matches it first. Slack `bot_token` is AES-256-GCM encrypted at rest (reuses `MFA_ENCRYPTION_KEY`) and redacted to `has_bot_token: bool` on reads — redaction now uses **explicit field-picking** (a prior subdoc spread leaked the encrypted token + Mongoose internals `$__parent`/`_doc`). Audit metadata snapshots the presence flag only — never the token. The Slack section also carries `attendance_nudges {enabled, check_in_time, checkout_reminder_time}` for the App Home nudge crons.

### Slack integration

- **Purpose** — Inbound interactive webhooks + slash commands + Events API (App Home); outbound non-throwing dispatch
- **Routes** — [`routes/slack.routes.ts`](src/routes/slack.routes.ts) mounted at `/api/v1/slack` in [`index.ts`](src/index.ts) **before** body parsers. `POST /slack/interactive` (Block Kit button clicks — leave approve/reject, attendance check-in/out, home refresh), `POST /slack/commands/:command` (`/checkin`, `/checkout`, `/status`, `/mystatus`), `POST /slack/events` (Events API — `url_verification` challenge + `app_home_opened` → publishes the App Home dashboard).
- **App Home dashboard** — a role-scoped Home tab: own check-in/out header (Check In / Check Out buttons), my day, my leaves, who's out, today's attendance summary (`attendance.read_team`), pending leave approvals with inline Approve/Reject (reviewers), `home_refresh`. Aggregator [`services/slack-home.service.ts`](src/services/slack-home.service.ts) + pure builder [`utils/slack-home-blocks.ts`](src/utils/slack-home-blocks.ts); attendance/nudge Block Kit in [`utils/slack-attendance-blocks.ts`](src/utils/slack-attendance-blocks.ts). Who's-out is shown to all employees (Slack-only relaxation of `leave_request.read_team`); `read_team` is org-wide today (per-team scoping is future work).
- **Attendance nudge crons** — [`jobs/attendance-slack-nudge.job.ts`](src/jobs/attendance-slack-nudge.job.ts): `attendance_checkin_nudge` (11:00 IST) and `attendance_checkout_reminder` (20:00 IST). Gated by `JOBS_ENABLED` && `slack.enabled` && `slack.attendance_nudges.enabled`. Unmapped users eager-resolved via `users.lookupByEmail` (`resolveSlackIdByEmail`), caching `slack_user_id`. Fire-times read at scheduler boot (`startScheduler()` is now async). Setup: [`docs/runbooks/slack-attendance-setup.md`](../docs/runbooks/slack-attendance-setup.md).
- **Controller** — [`controllers/slack-interactive.controller.ts`](src/controllers/slack-interactive.controller.ts)
- **Outbound utilities** — [`utils/slack.ts`](src/utils/slack.ts) (`postSlackMessage`, `postOrUpdateSlackMessage`, `publishHomeView`).
- **Signature verification** — [`middlewares/slack-webhook.middleware.ts`](src/middlewares/slack-webhook.middleware.ts) captures raw bytes before any parser touches them, then [`utils/slack-signature.ts`](src/utils/slack-signature.ts) verifies HMAC-SHA256 `v0:<ts>:<body>` with a 5-min replay window. **Don't move the route's mount position** in `index.ts` — parsing first kills verification.
- **Outbound dispatch** — non-throwing. Failures log `SLACK_DISPATCH_FAILED` at warn and never block business writes. Leave messages mutate **in-place** via `chat.update` against the persisted `LeaveRequest.slack_message {channel, ts}` so the same DM walks the lifecycle (pending → approved/rejected). App Home publishes/re-publishes via `views.publish`.
- **Bot scopes** — `chat:write`, `im:write`, `users:read.email` (App Home + nudges) in addition to `commands` / `users:read` / `users:info`.
- **User mapping** — `User.slack_user_id` is cached on the user doc; reactive fallback to `users.info` email lookup (inbound), eager `users.lookupByEmail` for nudges.

### Push notifications

- **Purpose** — Web Push subscription registry + dispatch on business events
- **Routes** — [`routes/push.routes.ts`](src/routes/push.routes.ts). `POST /push/subscribe` (idempotent), `POST /push/unsubscribe` (canonical, M21), `DELETE /push/subscribe` (legacy alias for in-flight clients).
- **Service** — [`services/push-subscription.service.ts`](src/services/push-subscription.service.ts) · **Model** — [`models/push-subscription.model.ts`](src/models/push-subscription.model.ts)
- **Gotcha** — VAPID public key is **not** exposed by API; baked into the FE bundle via `VITE_VAPID_PUBLIC_KEY` to avoid an extra round-trip on first subscribe.

### In-app notifications

- **Purpose** — User-visible inbox; owner-scoped at the service layer
- **Routes** — [`routes/notification.routes.ts`](src/routes/notification.routes.ts). All endpoints `authenticate`-only — the service narrows to the caller.
- **Dispatch** — [`services/notification-dispatcher.service.ts`](src/services/notification-dispatcher.service.ts) is the fan-out point used by every business write (one in-app row + optional Slack DM + optional push). Per-user opt-out: `User.slack_notifications_enabled = false` skips the Slack leg even if `slack_user_id` is set.

### Real-time event stream (SSE)

- **Purpose** — Server-Sent Events channel the FE subscribes to for live data-change pushes (so an open list refetches when someone else mutates it)
- **Routes** — [`routes/events.routes.ts`](src/routes/events.routes.ts). One endpoint: `GET /api/v1/events/stream`, `authenticate`-only. Sets `text/event-stream` + `Cache-Control: no-cache, no-transform` + `X-Accel-Buffering: no`, flushes headers, then writes `: connected`. A `: ping` heartbeat comment every `SSE_HEARTBEAT_MS` ([`constants/realtime.ts`](src/constants/realtime.ts)) keeps idle proxies from closing the socket; the FE's `fetch-event-source` client auto-reconnects if dropped. `req.on('close')` clears the heartbeat and deregisters the client.
- **Service** — [`services/realtime.service.ts`](src/services/realtime.service.ts) (`addClient` / `removeClient` — the in-process connection registry). **In-memory per instance**: a multi-instance fleet only pushes to clients pinned to the emitting instance.
- 🔴 **Mount-ordering constraint — do not move.** The router is mounted in [`index.ts`](src/index.ts) at `API_PREFIX` **before `compression()`**, for the same class of reason the Slack router is mounted before the body parsers. `compression` buffers the response to decide whether to gzip it, so a stream mounted *after* it never flushes: the client's `EventSource` connects, receives nothing, and hangs until the heartbeat eventually forces a flush — events arrive in unpredictable clumps or not at all, with **no error anywhere on either side**. It looks like a broken feature, not a middleware-ordering bug, which is exactly what makes it expensive to diagnose.

### Dashboard

- **Purpose** — Role-gated aggregates surfaced on the FE landing page
- **Routes** — [`routes/dashboard.routes.ts`](src/routes/dashboard.routes.ts). **Three endpoints per role**, 12 in total: `GET /dashboard/{admin|manager|employee|client}` (the snapshot), `.../analytics` (`?range=`, default `month` — time-windowed section data) and `.../overview` (`?from=&to=`, both `YYYY-MM-DD`, defaulted to the current month, validated `from <= to` and span ≤ 366 days). Every one gated on the matching `DASHBOARD_*` permission.
- **Services** — [`services/dashboard.service.ts`](src/services/dashboard.service.ts) (snapshot + analytics), [`services/dashboard-overview.service.ts`](src/services/dashboard-overview.service.ts) (the `/overview` payload)

### Search & command palette

- **Purpose** — Cross-collection search + Cmd-K action catalog
- **Routes** — [`routes/search.routes.ts`](src/routes/search.routes.ts), [`routes/command-palette.routes.ts`](src/routes/command-palette.routes.ts). Both auth-only; separate per-user rate-limit buckets (60/min each) so palette doesn't compete with the search page.
- **Services** — [`services/search.service.ts`](src/services/search.service.ts), [`services/command-palette.service.ts`](src/services/command-palette.service.ts)
- **Gotcha** — search buckets (tasks/projects/users) each scope per caller role at the service layer. Regex `$or` is expensive — keep the rate limit tight.

### Health & metrics

- **Routes** — `GET /health` [`index.ts`](src/index.ts) (back-compat), `GET /health/live` [`index.ts`](src/index.ts) (event-loop only), `GET /health/ready` [`index.ts`](src/index.ts) (Mongo ping + scheduler check, cached 5 s). All under [`healthRateLimiter`](src/middlewares/rate-limit.middleware.ts) at 600/min/IP.
- **Metrics** — `GET /metrics` returns OpenMetrics text. Counters/histograms in [`utils/metrics.ts`](src/utils/metrics.ts): `http_requests_total`, `http_request_duration_seconds`, `job_runs_total`, `job_run_duration_seconds`, `stuck_jobs_swept_total`, `audit_writes_total`, `audit_snapshot_dropped_total`, `unhandled_rejection_total`, `jwt_verify_failures_total`, `refresh_tokens_issued_total`, `email_rate_limited_total`, `audit_log_mirror_lag_rows` (gauge).

## Cross-cutting concerns

- **Logging** — [`utils/logger.ts`](src/utils/logger.ts) is pino with 14+ redaction paths (password, token, mfa_secret_encrypted, slack_signing_secret, …). `x-request-id` header correlates every line; pino-http reads it or mints a ULID. App Insights bridge when `APPLICATIONINSIGHTS_CONNECTION_STRING` is set.
- **Error envelope** — [`utils/app-error.ts`](src/utils/app-error.ts) + [`middlewares/error-handler.middleware.ts`](src/middlewares/error-handler.middleware.ts). Wire shape: `{ error: { code, message, details? } }`. 140 codes in [`constants/error-codes.ts`](src/constants/error-codes.ts).
- **`asyncHandler`** — [`utils/async-handler.ts`](src/utils/async-handler.ts). Promise-rejection bridge for controllers. **Always** wrap async controllers.
- **`withTransaction`** — [`utils/with-transaction.ts`](src/utils/with-transaction.ts). Wraps multi-write ops. Auto-falls-back to non-transactional execution on standalone `mongod` and on test-time `vi.mock`'d Mongoose. **Every model call inside MUST pass `{ session }`** or it runs outside the transaction silently.
- **Audit helper** — [`recordAudit`](src/services/audit.service.ts) (above).
- **Rate limiters** — [`middlewares/rate-limit.middleware.ts`](src/middlewares/rate-limit.middleware.ts). Per-IP general (120/min, env `GENERAL_RATE_LIMIT_MAX`), per-IP auth (10/15min, env `AUTH_RATE_LIMIT_MAX`), per-IP health (600/min), per-IP Slack webhook (30/min, before signature verify), per-user report-read (60/min), per-user export (10/15min), per-user search (60/min), per-user palette (60/min, separate bucket). In-memory per instance — multi-instance fleets see `instances × limit` effective ceiling.
- **Helmet / CSP** — [`index.ts`](src/index.ts). API-only `default-src 'none'`, `frame-ancestors 'none'`, `form-action 'none'`. Rationale: this is a JSON API, not a browser context.
- **Body-parser ordering** — Slack router mounted in [`index.ts`](src/index.ts) **before** `compression` and `express.json()` (raw bytes must survive for HMAC verification); the SSE `events` router mounted **before `compression`** too (a buffered `text/event-stream` never flushes). Auth-body limit is 4 KB; global is 1 MB. **Don't reorder.**
- **Cron jobs** — [`jobs/index.ts`](src/jobs/index.ts) registers 15 jobs (IST):

  | Job | Schedule | Idempotency |
  |---|---|---|
  | `attendance_finalizer` | Daily 23:00 | Per-day (yesterday) |
  | `comp_off_accrual` | Daily 23:15 | Per-day (yesterday) |
  | `attendance_checkin_nudge` | Daily 11:00 | Per-day |
  | `attendance_checkout_reminder` | Daily 20:00 | Per-day |
  | `leave_year_rollover` | Jan 1 00:05 | Per-year |
  | `token_cleanup` | Sun 02:00 | Per-ISO-week |
  | `timesheet_reminder` | Daily 20:00 | Per-day |
  | `comp_off_reconciliation` | Daily 02:30 | Per-day |
  | `report_export_cleanup` | Daily 03:00 | Per-day |
  | `comp_off_expiry` | Daily 03:20 | Per-day + per-lot re-check |
  | `audit_archive` | Daily 04:00 | Per-day |
  | `recurring_task_sweep` | Daily 06:00 | Per-day + template `last_generated_at` |
  | `report_subscription_sweep` | Daily 07:00 | Per-day + subscription `last_sent_at` |
  | `stuck_job_sweeper` | */15 min | Per-15m-bucket |
  | `audit_log_mirror` | Hourly :07 | Per-hour |

  Two ordering dependencies are deliberate: `comp_off_accrual` runs right after `attendance_finalizer` so it accrues against the same just-closed day, and `comp_off_expiry` (03:20) runs after `comp_off_reconciliation` (02:30) so the expiry sweep reads just-repaired balances.

  Overlap guard via `{job_name, run_key}` unique index on the `job_runs` collection. **`JOBS_ENABLED=true` must be set on exactly one instance** in a multi-instance fleet.
- **Feature gates** — [`middlewares/feature-flag.middleware.ts`](src/middlewares/feature-flag.middleware.ts). `requireBillingModules` / `requireExportableReport` 404 the money surfaces unless `BILLING_MODULES_ENABLED=true`. A gate answers "does this exist yet"; `requirePermission` answers "may THIS caller do it" — they layer, and a gate never replaces a permission check. Applied at the mount point in [`routes/index.ts`](src/routes/index.ts) so the mount list still shows what's gated rather than hiding that anything is switched off.
- **Env vars** — [`config/server.config.ts`](src/config/server.config.ts). Required: `MONGO_URI`, `JWT_SECRET`, `JWT_REFRESH_SECRET`, `MFA_ENCRYPTION_KEY`, `APP_BASE_URL`, `PASSWORD_RESET_URL_PATH`. Optional (defaulted): `NODE_ENV`, `PORT` (3001), `LOG_LEVEL`, `CORS_ORIGIN`, rate-limit caps, `JOBS_ENABLED`, `BILLING_MODULES_ENABLED` (off), `OFFICE_LOCATIONS_ENABLED` (off), `EMAIL_TRANSPORT` (stub/acs/mailjet), `EXPORT_WORKER_INLINE`. Azure Blob is lazy — first blob call throws `AzureNotConfiguredError` if missing; the rest of the BE runs fine without it.
- **Azure Blob** — [`utils/azure-blob.ts`](src/utils/azure-blob.ts). `mintSas` (15-min upload SAS, `create` only, content-type pinned), `mintDownloadSas` (download SAS with optional RFC 5987 `filename*` override per L14), `putBlobStream` (streaming uploads — used by audit archive + GDPR export to keep the worker out of buffer-the-world territory).
- **Email transports** — [`utils/email-transports/`](src/utils/email-transports/). `stub` (default — logs only), `acs` (Azure Communication Services), `mailjet`. Cache reset via `__resetEmailTransportCache()` for tests that swap `EMAIL_TRANSPORT`.

## Where do I add X?

| Intent | Folder |
|---|---|
| New endpoint | [`src/routes/`](src/routes/) → wire the route, mount in [`routes/index.ts`](src/routes/index.ts) |
| Request-body validation | [`src/validators/`](src/validators/) (Zod) — applied via `validate({body, query, params})` middleware |
| Business logic | [`src/services/`](src/services/) — all Mongo access lives here, controllers stay thin |
| New Mongo collection | [`src/models/`](src/models/) — define schema + indexes; do NOT query from anywhere except its owning service |
| Background job | [`src/jobs/`](src/jobs/) + register schedule in [`jobs/index.ts`](src/jobs/index.ts) + add idempotency key constant in [`constants/jobs.ts`](src/constants/jobs.ts) |
| Permission constant | [`src/constants/permissions.ts`](src/constants/permissions.ts) (BE) **and** mirror in [`viljetech-platform-frontend/src/lib/permissions.ts`](../viljetech-platform-frontend/src/lib/permissions.ts) |
| Error code | [`src/constants/error-codes.ts`](src/constants/error-codes.ts) — keep in sync with [FE `error-codes.ts`](../viljetech-platform-frontend/src/lib/error-codes.ts) |
| Audit action | [`src/constants/audit.ts`](src/constants/audit.ts) (`AUDIT_ACTIONS`, `AUDIT_TARGET_KINDS`) |
| New env var | Document in [`.env.example`](.env.example), read it in [`config/server.config.ts`](src/config/server.config.ts), never `process.env.X` directly in services |
| Slack inbound handler | Branch inside [`controllers/slack-interactive.controller.ts`](src/controllers/slack-interactive.controller.ts) — **do not** add new routes (Slack knows the signed URLs `/interactive`, `/commands/:command`, and `/events` (App Home)) |
| Slack outbound message | Use [`utils/slack.ts`](src/utils/slack.ts) — never throw on dispatch failure |
| Notification fan-out | [`services/notification-dispatcher.service.ts`](src/services/notification-dispatcher.service.ts) — one entry point for in-app + Slack + push |

## Test conventions

- **Vitest, collocated** — `*.test.ts` next to the source it covers. Excluded from coverage roll-up.
- **`vi.mock(modulePath)`** at module scope; `vi.hoisted(() => ({...}))` for mocks the factory needs to reference.
- **Model mocks** — stub `findOne`, `findOneAndUpdate`, `find` (which returns a chainable query stub — see `queryStub` helpers in existing tests), `create`, `countDocuments`, `aggregate` as needed.
- **`withTransaction`** doesn't need explicit mocking — when Mongoose is `vi.mock`'d, `readyState !== 1`, so the helper detects no live session and runs the callback bare.
- **`recordAudit`** — usually mocked to a `vi.fn()` so assertions can check what was audited without depending on a real `AuditLog` collection.
- **HTTP-level tests** — use `supertest` + the mounted Express app. Hit real validators + middleware; mock the services.
- **Smoke suite** — [`scripts/smoke-all.sh`](scripts/smoke-all.sh) runs 15 shell smokes (`DEFAULT_SMOKES`) against a live dev server (`:3001`). Re-seeds users via [`scripts/smoke-reset-users.ts`](scripts/smoke-reset-users.ts) + [`scripts/smoke-seed-user.ts`](scripts/smoke-seed-user.ts) unless `--no-reset` is passed. `npm run smoke` is the entry.

## Conventions checklist (pre-PR)

- [ ] `npm run type-check` clean
- [ ] `npm run lint` clean (or new warnings are intentional)
- [ ] `npm test` passing (or pre-existing skip noted)
- [ ] Every new mutating service writes an audit row
- [ ] Every multi-write op is in `withTransaction`
- [ ] Every public input is Zod-validated at the route layer (no raw `req.body` inside services)
- [ ] No new `process.env.X` outside [`config/server.config.ts`](src/config/server.config.ts)
- [ ] Permission + error-code constants synced FE↔BE if added
- [ ] Slack/push/email dispatch wrapped in fire-and-forget; business write doesn't fail if the side-effect fails
