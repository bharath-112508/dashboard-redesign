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
| [`project-management.md`](docs/modules/project-management.md) | Projects + members + clients + custom statuses + sprints + stories + tasks (incl. subtasks/dependencies) + comments + activity + attachments + templates + share links + timeline (**all in one file**) |
| [`timesheets-billing.md`](docs/modules/timesheets-billing.md) | Daily entries + weekly view + manager approval + billing rates with forward-extension invariants + reminder cron |
| [`reports-exports.md`](docs/modules/reports-exports.md) | Sync report reads + async export pipeline (Azure Blob + inline fallback) + presets + subscriptions + cleanup cron |
| [`audit-compliance.md`](docs/modules/audit-compliance.md) | `audit_logs` + `audit_archives` (daily WORM + SHA-256 chain) + `audit_log_mirrors` (P1-7 hourly) |
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

Role keys ([`constants/role-keys.ts:22-28`](src/constants/role-keys.ts#L22-L28)) and bundled permissions ([`constants/system-role-definitions.ts`](src/constants/system-role-definitions.ts)):

| Role | Slug | Audience | Permission baseline |
|---|---|---|---|
| Admin | `admin` | Everything | `system.admin` wildcard — every `requirePermission` short-circuits true |
| Manager | `manager` | Team Lead bundle + 6 more | Adds `project.clients_write`, `billing_rate.read`, `report.read`, `report_export.write`, `leave_balance.read_team`, `timesheet.edit_out_of_window` |
| Team Lead | `team_lead` | Employee bundle + 12 more | Adds `leave_request.read_team`/`approve`, `attendance.read_team`/`correction_approve`, `timesheet.read`, `project.write`/`archive`/`members_write`, `sprint.write`, `story.write`, `task_template.write`, `share_link.write`, `role.read`, `dashboard.manager` |
| Employee | `employee` | Bulk of the user base | 19 perms — own task/timesheet/attendance/leave + project read + dashboard.employee |
| Client | `client` | External, project-scoped read-only | 8 perms — `project.read`, `task.read`, `task_comment.write`, `task_attachment.write`, `holiday.read`, `leave_type.read`, `settings.read`, `dashboard.client`. **No leave / attendance / timesheets / billing / reports.** |

Permission constants live in [`constants/permissions.ts`](src/constants/permissions.ts) (60 total, grouped by domain prefix: `user.*`, `role.*`, `project.*`, `task.*`, `timesheet.*`, `billing_rate.*`, `attendance.*`, `leave_type.*`, `leave_balance.*`, `leave_request.*`, `comp_off.*`, `holiday.*`, `office_location.*`, `report.*`, `audit_log.*`, `audit_archive.*`, `settings.*`, `share_link.*`, `dashboard.*`, `system.admin`). **BE is the source of truth.** The FE mirrors it in [`src/lib/permissions.ts`](../viljetech-platform-frontend/src/lib/permissions.ts) — zero drift today.

[`requirePermissionOrSelf(perm, paramName?)`](src/middlewares/auth.middleware.ts#L235-L260) lets a caller through if **either** they hold `perm` (or wildcard) **or** the URL param matches their JWT `user_id`. Currently used only on `PATCH /users/:id` ([`user.routes.ts:77-82`](src/routes/user.routes.ts#L77-L82)).

## Module catalog

### User management

- **Purpose** — Directory CRUD, profile, profile photo, MFA, sessions, deactivation, GDPR DSAR/erasure
- **Roles & visibility** — Admin: full. Manager/TL/Employee: read directory ([`user.read`](src/constants/permissions.ts)); patch own via `requirePermissionOrSelf`. Client: no directory access; `/me` self-fetch only.
- **Permissions** — `USER_READ`, `USER_WRITE`, `USER_DEACTIVATE`, `USER_ROLE_CHANGE`, `USER_DATA_EXPORT`, `USER_DATA_ERASURE`
- **Routes** — [`routes/user.routes.ts`](src/routes/user.routes.ts). `GET /users`, `POST /users` ([`USER_WRITE`](src/routes/user.routes.ts#L40)), `GET /users/:id`, `PATCH /users/:id` ([self-or-perm](src/routes/user.routes.ts#L77-L82)), `POST /users/:id/deactivate|reactivate` ([`USER_DEACTIVATE`](src/routes/user.routes.ts#L86)), `POST /users/:id/change-role` ([`USER_ROLE_CHANGE`](src/routes/user.routes.ts#L100)), `POST /users/:id/reset-password`, profile-photo upload-url/finalize/delete pairs for self + admin, `GET /users/:id/data-export` ([`USER_DATA_EXPORT`](src/routes/user.routes.ts#L146)), `POST /users/:id/data-erasure` ([`USER_DATA_ERASURE`](src/routes/user.routes.ts#L153))
- **Service** — [`services/user.service.ts`](src/services/user.service.ts) · **Model** — [`models/user.model.ts`](src/models/user.model.ts) · **Validator** — [`validators/user.validator.ts`](src/validators/user.validator.ts)
- **Flow** — create writes a `User` doc (bcrypt-hashed password) + welcome email + audit row. Deactivate revokes all active refresh tokens. Profile photo upload mints a write-SAS via Azure Blob, FE PUTs bytes, then BE finalizes the record. GDPR export streams NDJSON of user-owned rows (timesheet, leave, audit) — see [`user-gdpr.service.ts`](src/services/user-gdpr.service.ts). Erasure soft-deletes + PII scrub.
- **Gotchas** — single-admin rule enforced via `one_active_admin` partial-unique index on role + status; deactivate fails if it would leave zero admins. Self-edit whitelist limits which fields a non-admin can PATCH on themselves.

### Roles & RBAC

- **Purpose** — Custom role CRUD + per-user role/permission assignment (Step 47 RBAC)
- **Roles & visibility** — Admin: full. Team Lead+: `ROLE_READ` only (so the user-detail UI can render role-name badges).
- **Permissions** — `ROLE_READ`, `ROLE_WRITE`, `ROLE_DELETE`, `USER_ROLE_CHANGE`
- **Routes** — [`routes/role.routes.ts`](src/routes/role.routes.ts). CRUD: `GET /roles`, `POST /roles` ([`ROLE_WRITE`](src/routes/role.routes.ts#L45)), `PATCH /roles/:id`, `DELETE /roles/:id` ([`ROLE_DELETE`](src/routes/role.routes.ts#L68)). User-assignment sub-router: `PATCH /users/:user_id/roles`, `PATCH /users/:user_id/extra-permissions` (both [`USER_ROLE_CHANGE`](src/routes/role.routes.ts#L90)).
- **Service** — [`services/role.service.ts`](src/services/role.service.ts) · **Model** — [`models/role.model.ts`](src/models/role.model.ts)
- **Flow** — admin defines a custom role with a bundled permission set; assigns to users via `role_ids[]` on `User`. Per-user ad-hoc grants land in `extra_permissions[]`. Both flow into the JWT at next refresh; the BE's `requirePermission` always reads from the JWT, so a role/perm change requires a token rotation to take effect ([drift detection in FE](../viljetech-platform-frontend/src/lib/queries.ts)).
- **Gotchas** — system roles (admin/manager/team_lead/employee/client) are `is_system: true` and cannot be deleted or have their bundles edited. Delete refuses any role that's in-use.

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
[`routes/leave-request.routes.ts`](src/routes/leave-request.routes.ts) · [`services/leave-request.service.ts`](src/services/leave-request.service.ts). `POST /leaves/preview-split` (dry-run segment generation), `GET /leaves/calendar` (org-wide approved; gated on [`LEAVE_REQUEST_READ_TEAM`](src/routes/leave-request.routes.ts#L39) per C5 to prevent rank-and-file enumeration), `POST /leaves` (apply), `POST /leaves/:id/approve|reject|cancel`.
- **Flow** — apply → preview-split computes segments excluding holidays + non-working days → `withTransaction(LeaveBalance.pending++ via $gte CAS predicate, LeaveRequest.create)` → notify (Slack DM + push + in-app). On approve: `findOneAndUpdate({status: 'pending'}, {$set: {status: 'approved'}})` (race-safe gate) + `withTransaction(LeaveBalance.used++, LeaveBalance.pending--)` + audit row + Slack `chat.update` against the persisted `slack_message.{channel, ts}` so the same DM mutates in-place through the lifecycle.
- **Gotchas** — **C4 SL month attribution**: SL caps are per calendar month; on apply, the service replays historical requests in `created_at` order to reconstruct the cap state at the new request's apply time. **Self-approval refused** by service. **Cancel is author-only** even though the route has no perm gate.

#### Comp-off
[`routes/comp-off.routes.ts`](src/routes/comp-off.routes.ts) · [`services/comp-off.service.ts`](src/services/comp-off.service.ts) · [`models/comp-off-ledger.model.ts`](src/models/comp-off-ledger.model.ts). `GET /comp-off/me`, `GET /comp-off` ([`COMP_OFF_READ`](src/routes/comp-off.routes.ts#L21)), `POST /comp-off/adjust` ([`COMP_OFF_WRITE`](src/routes/comp-off.routes.ts#L28)). Balance is denormalized on `User.comp_off_balance` for hot-path reads; the [`comp_off_reconciliation` job](src/jobs/comp-off-reconciliation.job.ts) recomputes nightly from ledger truth. Earn rows come from attendance overtime; spend rows come from leave-type=comp-off requests.

### Holidays

- **Purpose** — Org holiday calendar consumed by leave-request segment generation and attendance summary
- **Roles & visibility** — All authed roles read via `HOLIDAY_READ`. Admin writes via `HOLIDAY_WRITE`.
- **Routes** — [`routes/holiday.routes.ts`](src/routes/holiday.routes.ts). CRUD + `POST /holidays/bulk` for CSV import.
- **Service** — [`services/holiday.service.ts`](src/services/holiday.service.ts) · **Model** — [`models/holiday.model.ts`](src/models/holiday.model.ts)

### Attendance management

- **Purpose** — Daily check-in/check-out (multi-session per day), correction workflow, geofence, office QR-code resolution
- **Roles & visibility** — Employee+: check in/out, view own, request corrections. Team Lead+: view team, approve corrections.
- **Permissions** — `ATTENDANCE_CHECK_IN_OUT`, `ATTENDANCE_READ_TEAM`, `ATTENDANCE_CORRECTION_REQUEST`, `ATTENDANCE_CORRECTION_APPROVE`
- **Routes** — [`routes/attendance.routes.ts`](src/routes/attendance.routes.ts). `POST /attendance/check-in|check-out|qr-verify`, `GET /attendance/me/today`, `GET /attendance/me`, correction-request sub-routes (cancel is owner-only per M49), `GET /attendance` (team), `PATCH /attendance/:id` (admin override).
- **Service** — [`services/attendance.service.ts`](src/services/attendance.service.ts) · **Models** — [`attendance-record.model.ts`](src/models/attendance-record.model.ts), [`attendance-correction-request.model.ts`](src/models/attendance-correction-request.model.ts)
- **Flow** — check-in validates geofence (if enabled in settings) and WiFi/IP restrictions, then `findOneAndUpdate` against the `{user_id, local_date}` unique compound index (Asia/Kolkata) — race produces friendly `ALREADY_CHECKED_IN` (409). Check-out closes the open segment and computes minutes. Overtime is summed across **closed** segments only (BUG-040). QR check-in resolves an office-location token, then runs the same check-in flow with location pre-bound.
- **Gotchas** — geofence + WiFi restrictions are **opt-in via settings**; both default off so attendance works out-of-the-box on dev. Local date is timezone-anchored to Asia/Kolkata for the unique constraint.

### Office locations

- **Purpose** — Office addresses with geofence coords + QR-code tokens for on-site check-in
- **Roles & visibility** — All authed roles read via `OFFICE_LOCATION_READ` (sidebar nav shows the list to admins). Admin writes via `OFFICE_LOCATION_WRITE`.
- **Routes** — [`routes/office-location.routes.ts`](src/routes/office-location.routes.ts). CRUD + `POST /office-locations/:id/regenerate-qr`.
- **Service** — [`services/office-location.service.ts`](src/services/office-location.service.ts) · **Model** — [`models/office-location.model.ts`](src/models/office-location.model.ts)

### Project management

Projects own the sprints/stories/tasks tree. Member/client rosters are arrays of user-ids on `Project` (employee/team-lead roster vs. client roster — see roles). Per-project custom task statuses are stored on the project doc.

The full surface — projects + members + clients + custom statuses + sprints + stories + tasks + subtasks + dependencies + comments + activity + attachments + templates + share links + timeline — is documented in a single deep-dive at [`docs/modules/project-management.md`](docs/modules/project-management.md). Highlights below.

- **Purpose** — Projects, members, clients, custom task statuses, sprints (time-boxed windows), stories (grouping layer with derived status from task rollup), tasks (subtasks + dependencies), task collaboration (comments / activity / attachments), task templates, share links, timeline (Gantt)
- **Roles & visibility** — Admin/Manager: see all. Team Lead/Employee: see projects where `member_ids ∋ caller`. Client: see projects where `client_ids ∋ caller`. Service-layer scoping in [`loadProjectForCaller`](src/services/project.service.ts) — every project read funnels through it. **All sub-resources reuse this engine** (sprint, story, task, comment, attachment, template, timeline services all import `loadProjectForCaller`/`buildProjectVisibilityFilter`).
- **Permissions** — `PROJECT_READ`/`WRITE`/`ARCHIVE`/`MEMBERS_WRITE`/`CLIENTS_WRITE`, `SPRINT_WRITE`, `STORY_WRITE`, `TASK_READ`/`WRITE`, `TASK_COMMENT_WRITE`, `TASK_ATTACHMENT_WRITE`, `TASK_TEMPLATE_READ`/`WRITE`, `SHARE_LINK_WRITE`
- **Routes** (top-level entry points, all under `/api/v1`):
  - Projects + custom statuses + bulk member/client roster — [`routes/project.routes.ts`](src/routes/project.routes.ts). `PATCH|DELETE /project-custom-statuses/:id` are on the [`customStatusRouter`](src/routes/sprint.routes.ts#L71-L90) exported from `sprint.routes.ts`.
  - Nested sprint/story/template/share-link list+create on the project router.
  - Sprints — [`routes/sprint.routes.ts`](src/routes/sprint.routes.ts) (item-level PATCH/DELETE/archive/unarchive at `/sprints/:id`).
  - Stories — [`routes/story.routes.ts`](src/routes/story.routes.ts).
  - Tasks — [`routes/task.routes.ts`](src/routes/task.routes.ts) (CRUD + reorder + assign-story + move-sprint + dependencies).
  - Task comments — [`routes/task-comment.routes.ts`](src/routes/task-comment.routes.ts) (`GET|POST /tasks/:task_id/comments`, `PATCH|DELETE /comments/:id`).
  - Task activity — [`routes/task-activity.routes.ts`](src/routes/task-activity.routes.ts) (`GET /tasks/:task_id/activity`, read-only).
  - Task attachments — [`routes/task-attachment.routes.ts`](src/routes/task-attachment.routes.ts) (two-step SAS upload: `upload-url` → `finalize`).
  - Task templates — [`routes/task-template.routes.ts`](src/routes/task-template.routes.ts).
  - Share links — [`routes/share-link.routes.ts`](src/routes/share-link.routes.ts) (three sub-routers, with the **public no-auth `GET /share-links/resolve/:token`** mounted last so it doesn't shadow authed routes).
  - Timeline — [`routes/timeline.routes.ts`](src/routes/timeline.routes.ts).
- **Gotchas** (per-area summary; full table in the module doc):
  - **G1** — `PROJECT_MEMBERS_WRITE` vs. `PROJECT_CLIENTS_WRITE` are split (Team Lead can manage members; only Manager+ manages clients). `PROJECT_ARCHIVE` (not `PROJECT_WRITE`) gates `DELETE /projects/:id`.
  - **F4** — Member/client bulk add/remove uses two atomic updates (`$pull` then `$addToSet`) inside `withTransaction` to avoid lost-write races between concurrent admin callers.
  - **R3** — Hard-delete project / sprint / custom-status refuses with `RESOURCE_HAS_DEPENDENTS` when anything still references it. Archive is the escape hatch.
  - **BUG-007** — Team Lead/Employee creating a project is auto-added to `member_ids` so they don't lose visibility of their own project.
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

- **Purpose** — User × project hourly rate with effective/end dates; joined into billing reports
- **Permissions** — `BILLING_RATE_READ` (Manager+), `BILLING_RATE_WRITE` (Manager+/Admin per seed)
- **Routes** — [`routes/billing-rate.routes.ts`](src/routes/billing-rate.routes.ts). CRUD + `POST /billing-rates/:id/end` (soft-end with effective date).
- **Service** — [`services/billing-rate.service.ts`](src/services/billing-rate.service.ts) · **Model** — [`models/billing-rate.model.ts`](src/models/billing-rate.model.ts)

### Reports & exports

- **Purpose** — Synchronous report reads + async PDF/XLSX/CSV export pipeline
- **Roles & visibility** — Manager+: `REPORT_READ` (read + sync responses), `REPORT_EXPORT_WRITE` (async export). Per-user rate limits stacked on top of the global per-IP cap.
- **Routes** — [`routes/report.routes.ts`](src/routes/report.routes.ts). Sync: `GET /reports/billing|utilization|attendance|leaves`. Async: `POST /reports/:name/export` (10/15min/user) + `GET /reports/exports/:id` (status poll).
- **Services** — [`services/report.service.ts`](src/services/report.service.ts) (builders), [`services/report-export.service.ts`](src/services/report-export.service.ts) (pipeline)
- **Flow** — sync builders aggregate live and return JSON. POST `/export` creates a `ReportExport` row, then either runs the worker inline (`EXPORT_WORKER_INLINE=true`, test seam) or async via `setImmediate`. Worker calls the same builder, renders via the format-specific exporter ([`services/report-exporters/`](src/services/report-exporters/)), uploads to Azure Blob, persists the blob key + size + hash, and mints a fresh download SAS on each poll. **Inline fallback** ([`report-export.controller.ts:74-118`](src/controllers/report-export.controller.ts#L74-L118)): if Azure isn't configured, the POST returns the file body directly with `X-Export-Inline: 1` so dev / on-prem deployments still work.
- **Gotchas** — orphaned `running` rows (worker crash) get swept to `failed` by the [`stuck_job_sweeper`](src/jobs/index.ts). Two concurrent enqueues from one user produce two rows — no global queue lock.

#### Report presets
[`routes/report-preset.routes.ts`](src/routes/report-preset.routes.ts) · owner-scoped CRUD of saved filter sets. Cross-user reads return 404 (anti-enumeration).

#### Report subscriptions
[`routes/report-subscription.routes.ts`](src/routes/report-subscription.routes.ts) · owner-scoped recurring exports. The dispatch cron is Phase-4 work — current endpoints are data-shape only.

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

### Dashboard

- **Purpose** — Role-gated aggregates surfaced on the FE landing page
- **Routes** — [`routes/dashboard.routes.ts`](src/routes/dashboard.routes.ts). One endpoint per role: `GET /dashboard/admin|manager|employee|client`. Each gated on the matching `DASHBOARD_*` permission.
- **Service** — [`services/dashboard.service.ts`](src/services/dashboard.service.ts)

### Search & command palette

- **Purpose** — Cross-collection search + Cmd-K action catalog
- **Routes** — [`routes/search.routes.ts`](src/routes/search.routes.ts), [`routes/command-palette.routes.ts`](src/routes/command-palette.routes.ts). Both auth-only; separate per-user rate-limit buckets (60/min each) so palette doesn't compete with the search page.
- **Services** — [`services/search.service.ts`](src/services/search.service.ts), [`services/command-palette.service.ts`](src/services/command-palette.service.ts)
- **Gotcha** — search buckets (tasks/projects/users) each scope per caller role at the service layer. Regex `$or` is expensive — keep the rate limit tight.

### Health & metrics

- **Routes** — [`/health`](src/index.ts#L203) (back-compat), [`/health/live`](src/index.ts#L207) (event-loop only), [`/health/ready`](src/index.ts#L260) (Mongo ping + scheduler check, cached 5 s). All under [`healthRateLimiter`](src/middlewares/rate-limit.middleware.ts) at 600/min/IP.
- **Metrics** — `GET /metrics` returns OpenMetrics text. Counters/histograms in [`utils/metrics.ts`](src/utils/metrics.ts): `http_requests_total`, `http_request_duration_seconds`, `job_runs_total`, `job_run_duration_seconds`, `stuck_job_sweeps_total`, `audit_writes_total`, `audit_snapshot_dropped_total`, `unhandled_rejection_total`, `jwt_verify_failures_total`, `refresh_tokens_issued_total`, `email_rate_limited_total`, `audit_log_mirror_lag_rows` (gauge).

## Cross-cutting concerns

- **Logging** — [`utils/logger.ts`](src/utils/logger.ts) is pino with 14+ redaction paths (password, token, mfa_secret_encrypted, slack_signing_secret, …). `x-request-id` header correlates every line; pino-http reads it or mints a ULID. App Insights bridge when `APPLICATIONINSIGHTS_CONNECTION_STRING` is set.
- **Error envelope** — [`utils/app-error.ts`](src/utils/app-error.ts) + [`middlewares/error-handler.middleware.ts`](src/middlewares/error-handler.middleware.ts). Wire shape: `{ error: { code, message, details? } }`. 60+ codes in [`constants/error-codes.ts`](src/constants/error-codes.ts).
- **`asyncHandler`** — [`utils/async-handler.ts`](src/utils/async-handler.ts). Promise-rejection bridge for controllers. **Always** wrap async controllers.
- **`withTransaction`** — [`utils/with-transaction.ts`](src/utils/with-transaction.ts). Wraps multi-write ops. Auto-falls-back to non-transactional execution on standalone `mongod` and on test-time `vi.mock`'d Mongoose. **Every model call inside MUST pass `{ session }`** or it runs outside the transaction silently.
- **Audit helper** — [`recordAudit`](src/services/audit.service.ts) (above).
- **Rate limiters** — [`middlewares/rate-limit.middleware.ts`](src/middlewares/rate-limit.middleware.ts). Per-IP general (120/min, env `GENERAL_RATE_LIMIT_MAX`), per-IP auth (10/15min, env `AUTH_RATE_LIMIT_MAX`), per-IP health (600/min), per-IP Slack webhook (30/min, before signature verify), per-user report-read (60/min), per-user export (10/15min), per-user search (60/min), per-user palette (60/min, separate bucket). In-memory per instance — multi-instance fleets see `instances × limit` effective ceiling.
- **Helmet / CSP** — [`index.ts:57-97`](src/index.ts#L57-L97). API-only `default-src 'none'`, `frame-ancestors 'none'`, `form-action 'none'`. Rationale: this is a JSON API, not a browser context.
- **Body-parser ordering** — Slack router mounted in [`index.ts:143`](src/index.ts#L143) **before** `compression` (line 150) and `express.json()` (line 152). Auth-body limit is 4 KB; global is 1 MB. **Don't reorder.**
- **Cron jobs** — [`jobs/index.ts`](src/jobs/index.ts) registers 13 jobs (IST):

  | Job | Schedule | Idempotency |
  |---|---|---|
  | `attendance_finalizer` | Daily 23:00 | Per-day |
  | `attendance_checkin_nudge` | Daily 11:00 | Per-day |
  | `attendance_checkout_reminder` | Daily 20:00 | Per-day |
  | `leave_year_rollover` | Jan 1 00:05 | Per-year |
  | `token_cleanup` | Sun 02:00 | Per-ISO-week |
  | `timesheet_reminder` | Daily 20:00 | Per-day |
  | `report_export_cleanup` | Daily 03:00 | Per-day |
  | `audit_archive` | Daily 04:00 | Per-day |
  | `recurring_task_sweep` | Daily 06:00 | Per-day + template `last_generated_at` |
  | `report_subscription_sweep` | Daily 07:00 | Per-day + subscription `last_sent_at` |
  | `stuck_job_sweeper` | */15 min | Per-15m-bucket |
  | `audit_log_mirror` | Hourly :07 | Per-hour |
  | `comp_off_reconciliation` | Daily 02:30 | Per-day |

  Overlap guard via `{job_name, run_key}` unique index on the `job_runs` collection. **`JOBS_ENABLED=true` must be set on exactly one instance** in a multi-instance fleet.
- **Env vars** — [`config/server.config.ts`](src/config/server.config.ts). Required: `MONGO_URI`, `JWT_SECRET`, `JWT_REFRESH_SECRET`, `MFA_ENCRYPTION_KEY`, `APP_BASE_URL`, `PASSWORD_RESET_URL_PATH`. Optional (defaulted): `NODE_ENV`, `PORT` (3001), `LOG_LEVEL`, `CORS_ORIGIN`, rate-limit caps, `JOBS_ENABLED`, `EMAIL_TRANSPORT` (stub/acs/mailjet), `EXPORT_WORKER_INLINE`. Azure Blob is lazy — first blob call throws `AzureNotConfiguredError` if missing; the rest of the BE runs fine without it.
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
- **Smoke suite** — [`scripts/smoke-all.sh`](scripts/smoke-all.sh) runs 18+ shell smokes against a live dev server (`:3001`). Re-seeds users via [`scripts/smoke-reset-users.ts`](scripts/smoke-reset-users.ts) + [`scripts/smoke-seed-user.ts`](scripts/smoke-seed-user.ts) unless `--no-reset` is passed. `npm run smoke` is the entry.

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
