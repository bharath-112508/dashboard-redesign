# Project Management — Backend

The biggest module in the platform. The Project sits at the root of the work hierarchy and owns visibility for every collection beneath it. Sprints are time-boxed windows inside a project. Stories group tasks. Tasks are the unit of work — they carry comments, activity, attachments, dependencies, and subtasks. Templates create reusable task definitions (with optional recurring instantiation). Share Links grant public read-only access. Timeline serves the Gantt view.

This module owns:
- **Projects** — root entity, member + client rosters, custom task statuses, built-in status ordering, visibility-scoping engine other services consume.
- **Sprints** — time-boxed windows within a project.
- **Stories** — grouping layer between project and tasks (derived status from task rollup).
- **Tasks** — unit of work; subtasks, dependencies, position, reorder, assign-story, move-sprint.
- **Task Comments** — sanitised body, mentions, soft-delete, mention-or-watcher fan-out.
- **Task Activity feed** — UI-facing change history written by hooks.
- **Task Attachments** — two-step SAS upload to Azure Blob.
- **Task Templates** — reusable task definitions; manual + recurring (daily cron) instantiation.
- **Project Share Links** — token-gated public read-only project view; C9 token-hashed at rest.
- **Project Timeline** — Gantt-shape rollup of project + sprints + tasks with derived `start_date`.

Cross-references: [`auth.md`](./auth.md) for `requirePermission` and JWT shape; [`audit-compliance.md`](./audit-compliance.md) for the audit substrate; [`user-management.md`](./user-management.md) for the share-link auto-revoke cascade on client deactivation.

---

## Scope summary

| Sub-surface | Key files |
|---|---|
| Projects | [`project.routes.ts`](../../src/routes/project.routes.ts), [`project.service.ts`](../../src/services/project.service.ts), [`project.model.ts`](../../src/models/project.model.ts) |
| Sprints | [`sprint.routes.ts`](../../src/routes/sprint.routes.ts), [`sprint.service.ts`](../../src/services/sprint.service.ts), [`sprint.model.ts`](../../src/models/sprint.model.ts) |
| Stories | [`story.routes.ts`](../../src/routes/story.routes.ts), [`story.service.ts`](../../src/services/story.service.ts), [`story.model.ts`](../../src/models/story.model.ts) |
| Tasks | [`task.routes.ts`](../../src/routes/task.routes.ts), [`task.service.ts`](../../src/services/task.service.ts), [`task.model.ts`](../../src/models/task.model.ts) |
| Task comments | [`task-comment.routes.ts`](../../src/routes/task-comment.routes.ts), [`task-comment.service.ts`](../../src/services/task-comment.service.ts), [`task-comment.model.ts`](../../src/models/task-comment.model.ts) |
| Task activity | [`task-activity.routes.ts`](../../src/routes/task-activity.routes.ts), [`task-activity.service.ts`](../../src/services/task-activity.service.ts), [`task-activity.model.ts`](../../src/models/task-activity.model.ts) |
| Task attachments | [`task-attachment.routes.ts`](../../src/routes/task-attachment.routes.ts), [`task-attachment.service.ts`](../../src/services/task-attachment.service.ts), [`task-attachment.model.ts`](../../src/models/task-attachment.model.ts) |
| Task templates | [`task-template.routes.ts`](../../src/routes/task-template.routes.ts), [`task-template.service.ts`](../../src/services/task-template.service.ts), [`task-template.model.ts`](../../src/models/task-template.model.ts) |
| Share links | [`share-link.routes.ts`](../../src/routes/share-link.routes.ts), [`share-link.service.ts`](../../src/services/share-link.service.ts), [`project-share-link.model.ts`](../../src/models/project-share-link.model.ts) |
| Timeline | [`timeline.routes.ts`](../../src/routes/timeline.routes.ts), [`timeline.service.ts`](../../src/services/timeline.service.ts) |

---

## Visibility — the engine other services consume

Computed in [`buildVisibilityFilter`](../../src/services/project.service.ts) + `assertCallerCanRead`. Every project-scoped read (sprint, story, task, comment, attachment, activity, template, timeline) funnels through one of these:

| Role | Sees |
|---|---|
| Admin | All projects (`{}`) |
| Manager | All projects (`{}`) |
| Team Lead | Only projects where `member_ids ∋ caller.id` |
| Employee | Only projects where `member_ids ∋ caller.id` |
| Client | Only projects where `client_ids ∋ caller.id` |
| Unmapped role | Nothing (defence-in-depth — `{_id: ObjectId('0…0')}`) |

The same helpers `buildProjectVisibilityFilter` and `loadProjectForCaller` are exported for every dependent service. **Other services MUST NOT re-implement this rule** — they import these helpers. This is the **single source of truth** for the role → filter mapping.

`loadProjectForCaller(id, caller)` fetches the project and runs `assertCallerCanRead`. Used by sprint/story/task/comment/attachment/template/timeline services. The 404-vs-403 mapping inside the loader keeps existence-probing blocked (cross-project reads return 404 not 403).

---

## Roles & permissions (catalog)

| Permission | Held by | Gates |
|---|---|---|
| `project.read` | Everyone authenticated | Project read, sub-resource list, custom-status list, timeline, member/client list |
| `project.write` | Admin, Manager, Team Lead | Project create/patch, custom-status CRUD, default-status reorder |
| `project.archive` | Admin, Manager, Team Lead | `DELETE /projects/:id` (G1 — split from `project.write` so a custom role can grant write without delete) |
| `project.members_write` | Admin, Manager, Team Lead | Member roster bulk + per-id |
| `project.clients_write` | Admin, Manager (**not Team Lead**) | Client roster bulk + per-id (G1 — split from members_write so Team Leads can manage staff but not external clients) |
| `sprint.write` | Admin, Manager, Team Lead | Sprint create/patch/delete/archive/unarchive |
| `story.write` | Admin, Manager, Team Lead | Story create/patch/delete/reorder |
| `task.read` | Everyone authenticated | Task list/get, reorder (service narrows), comment list, activity feed, attachment list/download URL |
| `task.write` | Admin, Manager, Team Lead, Employee | Task CRUD (employee scope narrowed at service); dependency CRUD |
| `task_comment.write` | Admin, Manager, Team Lead, Employee, Client | Comment create/patch/delete |
| `task_attachment.write` | Admin, Manager, Team Lead, Employee, Client | Mint upload URL, finalize, delete attachment |
| `task_template.read` | Admin, Manager, Team Lead, Employee | List / get templates |
| `task_template.write` | Admin, Manager, Team Lead | Template CRUD + manual instantiate |
| `share_link.write` | Admin, Manager, Team Lead | List / create / revoke (resolve is **public** — no permission) |

**Service-layer narrowing (defence in depth)** — the route gate is the outer wall; the service tightens further when role + endpoint together imply a stricter rule (e.g. Employee PATCH on `/tasks/:id` is restricted to creator-or-assignee with whitelisted fields; assignee gets reorder permission; etc.). Per-area service narrowing is documented inline below.

**H2** — pre-fix the service-layer `isProjectAuthor` check compared role-string against admin/manager only, which 403'd Team Leads (who hold the bundle per Step-47) after they'd already passed the route gate. The current `isProjectAuthor` accepts admin / manager / team_lead.

---

# Section 1 — Projects

## Data model ([`project.model.ts`](../../src/models/project.model.ts))

```ts
{
  _id, code (UNIQUE, uppercase), name, description,
  start_date,                       // 'YYYY-MM-DD' (required)
  end_date,                         // 'YYYY-MM-DD' | null
  status,                           // 'active' | 'completed' | 'on_hold'   (default 'active')
  is_archived: boolean,             // archive without losing history
  member_ids:  ObjectId[],          // internal staff (≤ 200)
  client_ids:  ObjectId[],          // external client users (≤ 50)
  custom_task_statuses: [{          // ≤ 12 sub-docs, each with its own _id
    _id, key, label, order, is_terminal, is_active
  }],
  default_status_orders: [{         // EXACTLY 4 entries — to_do/in_progress/review/done
    key, order, is_active
  }],
  created_by:  ObjectId,
  created_at, updated_at
}
```

### Field constraints ([`constants/project.ts`](../../src/constants/project.ts))

| Field | Cap / shape |
|---|---|
| `name` | 1–200 chars, trimmed |
| `code` | 1–40 chars, uppercased on write, regex `^[A-Z][A-Z0-9_-]{0,39}$`, **unique** across all projects |
| `description` | ≤ 5,000 chars |
| `start_date` / `end_date` | ISO `YYYY-MM-DD`; `end_date` must be `>= start_date` (both Zod refine AND a service-layer guard for partial PATCH) |
| `member_ids` | ≤ 200 user-ids |
| `client_ids` | ≤ 50 user-ids |
| `custom_task_statuses[].key` | 1–40 chars, regex `^[a-z][a-z0-9_]{0,39}$` (lower_snake) — **must not collide** with `to_do` / `in_progress` / `review` / `done` |
| `custom_task_statuses[].label` | 1–60 chars |
| `custom_task_statuses[]` | ≤ 12 per project |

### Indexes

- `code` — field-level unique (powers `PROJECT_CODE_TAKEN` on duplicate insert)
- `{status: 1, is_archived: 1, created_at: -1}` — **M41**, covers the default list filter + sort
- `{status: 1, is_archived: 1}` — left in place because it shares the prefix
- `{member_ids: 1}` — drives the Team Lead / Employee visibility filter
- `{client_ids: 1}` — drives the Client visibility filter
- `{'custom_task_statuses._id': 1}` with `partialFilterExpression: {'custom_task_statuses.0': {$exists: true}}` — powers `PATCH|DELETE /project-custom-statuses/:id` reverse lookup
- `{name: 'text', code: 'text', description: 'text'}` — text index ahead of a future `$text` migration

### Built-in statuses

The four built-in keys (`to_do` / `in_progress` / `review` / `done`) are **implicit on every project** — they're NOT stored as sub-docs in `custom_task_statuses[]`. Each project carries a `default_status_orders[]` array that orders + toggles the visibility of those four columns. Seeded on create with `{100, 200, 300, 400, is_active:true}` so customs can interleave at e.g. `150` without renumbering.

The model validates that each canonical key appears exactly once — no drift, no duplicates.

## Project endpoints

| Method | Path | Permission | Body / query | Returns |
|---|---|---|---|---|
| `GET` | `/projects` | `project.read` | `?page=1&limit=20&status&is_archived&member_id&client_id&q=` | `Paginated<ProjectRecord>` |
| `POST` | `/projects` | `project.write` | `CreateProjectBody` | `201 ProjectRecord` |
| `GET` | `/projects/:id` | `project.read` | — | `ProjectRecord` |
| `PATCH` | `/projects/:id` | `project.write` | `PatchProjectBody` (partial) | `ProjectRecord` |
| `DELETE` | `/projects/:id` | `project.archive` | — | `204` (hard-delete; see below) |

**List query** — schema [`listProjectsQuerySchema`](../../src/validators/project.validator.ts). Defaults: `page=1, limit=20`. `q` requires ≥ 2 chars (R15). Service builds `$or` over `{name, code, description}` with regex specials escaped.

**PATCH semantics** — accepts `name`, `description`, `start_date`, `end_date`, `status`, `is_archived` only. **`member_ids`, `client_ids`, `custom_task_statuses` are intentionally NOT accepted** — those use dedicated bulk endpoints so a partial update never silently truncates a 50-member array to zero because the FE forgot to send it.

**Archive vs hard-delete** — to archive, `PATCH /projects/:id` with `{is_archived: true}`. To hard-delete, `DELETE /projects/:id` — but the BE refuses with **409 `RESOURCE_HAS_DEPENDENTS`** if any Task, Story, or Sprint references the project (R3). Intended flow: archive when there's history; delete only an empty placeholder.

**Code conflicts** — `POST /projects` with a duplicate `code` returns **409 `PROJECT_CODE_TAKEN`** (the unique-index E11000 is caught and translated).

**Member auto-add (BUG-007)** — when a Team Lead or Employee creates a project, the service auto-adds the caller to `member_ids` if they're not already in the body. Without this, they'd lose visibility of the project they just made (their visibility filter is `member_ids ∋ caller.id`). Admins and Managers bypass the visibility filter, so the service doesn't pollute their `member_ids`.

## Members

| Method | Path | Permission | Body | Returns |
|---|---|---|---|---|
| `GET` | `/projects/:id/members` | `project.read` | — | `ProjectMember[]` (hydrated with `full_name`, `email`, `role`, `status`) |
| `POST` | `/projects/:id/members` | `project.members_write` | `{add: string[], remove: string[]}` (≥ 1 non-empty) | `ProjectRecord` |
| `DELETE` | `/projects/:id/members/:user_id` | `project.members_write` | — | `ProjectRecord` |

**Bulk semantics** — `add` and `remove` arrays in one call. **Idempotent**: re-running the same payload converges on the same end-state. Dedupes inside; ignores unknown removes.

**Role validation** — `add` candidates must be active Admin / Manager / Team Lead / Employee users. Mismatches throw **422 `INVALID_PROJECT_MEMBER_ROLE`** with `{invalid_user_ids: [...]}`. **Only truly new IDs are validated** — re-adding someone already on the roster is a no-op and a stale role change on an existing member doesn't make the call fail.

**F4 atomic list mutation** — pre-F4 this was read → mutate-in-JS → `doc.save()`, and two concurrent admin calls could observe v1, each compute their own next state, and the loser's change was dropped (with a successful audit row). Current shape:

1. Read the doc once (for validation + before-snapshot).
2. Inside `withTransaction`: `$pull` removes, then `$addToSet $each` adds (two separate atomic updates, both idempotent and commutative).
3. Re-read for the after-snapshot.
4. Both operators converge to `original − all_removes + all_adds` regardless of interleaving order.

Audit metadata captures the actually-changed `added[]` and `removed[]` arrays.

**`DELETE /projects/:id/members/:user_id`** delegates to `updateProjectMembers({add: [], remove: [userId]})`. Returns **404 `PROJECT_MEMBER_NOT_FOUND`** if the user isn't on the roster.

**Member list order** — `listProjectMembers` preserves `doc.member_ids` ordering so the FE renders in admin-curated order.

## Clients

| Method | Path | Permission | Body | Returns |
|---|---|---|---|---|
| `GET` | `/projects/:id/clients` | `project.read` | — | `ProjectClient[]` (hydrated with `full_name`, `email`, `status`, `company_name`) |
| `POST` | `/projects/:id/clients` | `project.clients_write` | `{add: string[], remove: string[]}` (≥ 1 non-empty) | `ProjectRecord` |
| `DELETE` | `/projects/:id/clients/:user_id` | `project.clients_write` | — | `ProjectRecord` |

Same F4 atomic-mutation pattern as members. Candidate validation requires active **role=client** users — mismatches throw **422 `INVALID_PROJECT_CLIENT_ROLE`**. `company_name` is sourced from `User.client_profile.company_name` (nullable).

## Custom task statuses

Routes under the project router (`/projects/:id/...`):

| Method | Path | Permission | Body | Returns |
|---|---|---|---|---|
| `GET` | `/projects/:id/custom-statuses` | `project.read` | — | `{defaults: [...], custom: [...]}` |
| `POST` | `/projects/:id/custom-statuses` | `project.write` | `CreateCustomStatusBody` | `201 CustomStatusItem` |
| `PATCH` | `/projects/:id/default-status-orders` | `project.write` | `{orders: [{key, order, is_active?}] (×4)}` | `{defaults: [...]}` |

Two additional routes on the [`customStatusRouter`](../../src/routes/sprint.routes.ts) exported from `sprint.routes.ts`, mounted top-level so the URL doesn't depend on the project id:

| Method | Path | Permission | Body | Returns |
|---|---|---|---|---|
| `PATCH` | `/project-custom-statuses/:id` | `project.write` | `PatchCustomStatusBody` (partial) | `CustomStatusItem` |
| `DELETE` | `/project-custom-statuses/:id` | `project.write` | — | `204` |

Reverse lookup by sub-doc `_id` is served by the partial-filter index. The URL uses the sub-doc id (stable across `key` renames).

**`GET /projects/:id/custom-statuses`** returns both the four built-ins (with their project-scoped `order` + `is_active`) and the custom statuses. The FE merges and sorts by `order`.

**Add semantics**:
- Key collisions with the four defaults are rejected at the Zod layer.
- Key collisions within the project are rejected at the service layer with **409 `CUSTOM_STATUS_KEY_TAKEN`**.

**Delete semantics (R3)** — refuses with **409 `RESOURCE_HAS_DEPENDENTS`** if any Task in the project still has `status === sub.key`. Admin must PATCH each affected task onto a different status first, then re-issue the delete. The check is a single `Task.countDocuments({project_id, status})`.

**Default-status reorder** — `PATCH /projects/:id/default-status-orders` accepts an `orders[]` array of exactly four entries, each canonical key appearing exactly once. The service replaces the array atomically (no partial updates so the "each key exactly once" invariant is trivially enforced). The `is_active` flag is optional per entry — when omitted, the service preserves the existing value, so older callers that only reorder keep working.

---

# Section 2 — Sprints

## Data model ([`sprint.model.ts`](../../src/models/sprint.model.ts))

```ts
{
  _id, project_id (required),
  name,                        // 1–120 chars, trimmed
  goal,                        // ≤ 1,000 chars (default '')
  start_date, end_date,        // both 'YYYY-MM-DD' strings, required
  status,                      // 'planned' | 'active' | 'completed'  (default 'planned')
  is_archived: boolean,        // T11 — escape hatch for "decommission with lingering tasks"
  created_by, created_at, updated_at
}
```

Indexes:
- `{project_id: 1, start_date: -1}` — most-recent-sprint-first reads
- `{project_id: 1, status: 1}` — status-filtered reads
- `{project_id: 1, is_archived: 1}` — **F1** — default list excludes archived
- `{name: 'text', goal: 'text'}` — text index ready for `$text` migration

### Status transitions are NOT enforced

The model declares `status` as a static enum but **does not enforce `planned → active → completed` transitions**. Data_Model deliberately leaves this open so an admin can mark a sprint completed without ever activating it (e.g. cancelled mid-plan). The only date-related guardrails:

- `end_date >= start_date` (Zod refine on create + patch)
- Sprint window must fit within the parent project's window: `assertWithinProjectWindow` — sprint `start_date >= project.start_date` AND (if project has an `end_date`) sprint `end_date <= project.end_date`. **Open-ended projects** (`project.end_date = null`) allow sprints to extend arbitrarily.

## Sprint endpoints

Nested list + create on the project router; item ops on the sprint router.

| Method | Path | Permission | Body / query |
|---|---|---|---|
| `GET` | `/projects/:project_id/sprints` | `project.read` | `?page&limit&status&is_archived` |
| `POST` | `/projects/:project_id/sprints` | `sprint.write` | `CreateSprintBody` |
| `GET` | `/sprints/:id` | `project.read` | — |
| `PATCH` | `/sprints/:id` | `sprint.write` | `PatchSprintBody` (partial) |
| `DELETE` | `/sprints/:id` | `sprint.write` | — |
| `POST` | `/sprints/:id/archive` | `sprint.write` | — |
| `POST` | `/sprints/:id/unarchive` | `sprint.write` | — |

### List query

Default sort: `{start_date: -1}` (most recent first).

**F1 archived filter** — when `?is_archived` is **absent**, the service forces `is_archived: false`. The caller must pass `?is_archived=true` explicitly to see the archive bucket. This default-active contract means a `GET /projects/:id/sprints` from a UI that doesn't know about archives still gets a clean active-only response.

### Archive vs delete (T11 escape hatch)

**Delete refuses (R3 `RESOURCE_HAS_DEPENDENTS`)** when any Task references the sprint:

```
{tasks: <count>}
"Sprint has tasks; archive it first (POST /sprints/:id/archive) or PATCH each task to a different sprint before deleting."
```

Intended workflow: archive when there's lingering work; delete only an empty sprint. Once `is_archived: true`, `deleteSprint` **permits the delete even with dependant tasks** — the archive flag is the operator's explicit acknowledgement that this sprint is decommissioned and the row should disappear despite task references. Those orphaned tasks keep their `sprint_id` pointing at the deleted sprint until somebody PATCHes them; they're not auto-detached on sprint delete (deliberate — a manager who deletes a sprint rarely wants the work to vanish from any sprint at all).

Archive + unarchive are **idempotent** — calling on an already-archived sprint is a no-op success.

---

# Section 3 — Stories

## Data model ([`story.model.ts`](../../src/models/story.model.ts))

**Minimal by design** — derived fields are computed on read:

```ts
{
  _id, project_id (required),
  title,                       // 1–200 chars, trimmed
  description,                 // ≤ 10,000 chars (required-but-can-be-empty — keeps API shape stable)
  position,                    // dense integer per project; reorder shifts neighbours
  created_by, updated_by, created_at, updated_at
}
```

**Derived fields** (`derived_status`, `task_count`, `done_task_count`, `sprint_ids[]`, `progress_percent`) are **NOT persisted**. They're recomputed at read time via a single aggregation over the `tasks` collection. Persisting them would mean reconciling on every task write — the exact treadmill we want to avoid in Phase 1.

Indexes:
- `{project_id: 1, position: 1}` — story-board ordering (the dominant read)
- `{project_id: 1, created_at: -1}` — "newest first" feeds
- `{title: 'text', description: 'text'}` — text index ready for `$text` migration

### Derived-status rule cascade

[`constants/story.ts`](../../src/constants/story.ts) + `story.service.evaluateDerivedStatus`. For one story's task rollup:

| Condition | `derived_status` |
|---|---|
| No tasks | `empty` |
| Any task has status `blocked` | `blocked` |
| Any task has status in `IN_PROGRESS_TASK_STATUS_KEYS = ['in_progress', 'review']` | `in_progress` |
| **All** task statuses are terminal (default `done` ∪ project's custom statuses with `is_terminal: true`) | `done` |
| Otherwise | `to_do` |

The rule order matters — `blocked` wins over `in_progress`, `in_progress` wins over `done` (so a story with one `blocked` task and the rest `done` shows as `blocked`, not `done`).

Story statuses are a **fixed enum** — projects can't add custom story statuses. The `BLOCKED_TASK_STATUS_KEY` is the literal string `'blocked'`; if a project's custom task statuses include this key, any task in it counts as a blocker.

### Aggregation pipeline

[`utils/story-task-queries.ts:aggregateStoryDerivedRows`](../../src/utils/story-task-queries.ts):

```js
[
  { $match: { project_id, story_id: { $in: storyIds } } },
  { $group: {
      _id: '$story_id',
      task_count: { $sum: 1 },
      sprint_ids: { $addToSet: '$sprint_id' },
      statuses:   { $addToSet: '$status' },
      done_count: { $sum: { $cond: [{ $in: ['$status', terminalArr] }, 1, 0] } }
  }},
  { $project: { …, sprint_ids: { $filter: { input: …, cond: { $ne: ['$$sid', null] } } } } }
]
```

One round-trip indexed by `{project_id, story_id}`. Nulls are filtered out of `sprint_ids` so backlog tasks (`sprint_id = null`) don't surface as a phantom sprint id. `terminalStatusKeys` is project-specific (default `done` plus any custom with `is_terminal: true`) and is passed in so `done_count` lands in the pipeline without a second round-trip.

### `progress_percent`

```ts
task_count === 0 ? 0 : Math.round((100 * done_task_count) / task_count)
```

Computed in `buildPublicStory`, never persisted.

## Story endpoints

| Method | Path | Permission | Body / query |
|---|---|---|---|
| `GET` | `/projects/:project_id/stories` | `project.read` | `?page&limit&status&q` |
| `POST` | `/projects/:project_id/stories` | `story.write` | `CreateStoryBody` |
| `GET` | `/stories/:id` | `project.read` | — |
| `PATCH` | `/stories/:id` | `story.write` | `PatchStoryBody` (partial — `title`, `description`, `position`) |
| `DELETE` | `/stories/:id` | `story.write` | — |
| `POST` | `/stories/:id/reorder` | `story.write` | `{position: number}` |
| `GET` | `/stories/:id/tasks` | `project.read` | `?page&limit` |

### List query (`GET /projects/:project_id/stories`)

Sort: `{position: 1, created_at: 1}` (board order; created_at breaks ties). `q` requires ≥ 2 chars (R15). The `status` filter applies **after** server-side derivation — the client doesn't know which custom statuses count as "blocked"; only the project does, and the derivation happens on the BE.

Pagination + count run against the raw set; the filter is then applied to the materialised page. This means `meta.total` reflects pre-filter count; filter-aware pagination would require a second pass and isn't worth the cost at Phase-1 scale.

### Create (`POST /projects/:project_id/stories`)

If `position` is omitted, the service computes `max(position) + 1` via `findOne({project_id}).sort({position: -1})`. We avoid using `count` because a deletion-induced gap would let two `count`-based callers collide on the same position. Positions are NOT unique by design — equal-position rows tiebreak on `created_at` on the FE. A fresh story has zero tasks so `derived_status = empty`.

### Get (`GET /stories/:id`)

Returns the story + derived fields PLUS a `tasks_by_sprint[]` array grouped by sprint id (null bucket = backlog):

```json
{
  "id": "...", "project_id": "...", "title": "...", "description": "...",
  "position": 3, "derived_status": "in_progress",
  "task_count": 8, "done_task_count": 3, "sprint_ids": ["..."],
  "progress_percent": 38, "created_at": "...", "updated_at": "...",
  "tasks_by_sprint": [
    { "sprint": null, "tasks": [/* backlog */] },
    { "sprint": { "id": "..." }, "tasks": [/* sprint A */] }
  ]
}
```

`findTasksByStoryId` is **capped at 500** (`STORY_TASKS_BOARD_CAP`). Story board renders every task within a story (grouped by sprint), so the read has to hand back the full set — but a runaway story with thousands of tasks would pull the entire list into memory and break the board anyway. 500 is the design ceiling per story; beyond that the UI is unusable.

The 500 cap is enforced on `created_at: 1, _id: 1` sort (BUG-033 pattern) so truncation is deterministic — the first 500 are always the oldest 500. For paginated reads of a story's tasks, callers should use `GET /stories/:id/tasks` instead (DB-level skip/limit, no in-memory slice).

### Patch (`PATCH /stories/:id`)

Accepts `title`, `description`, `position` only. Position changes go through `reorderInternal` (same shift logic as `POST /stories/:id/reorder`) so PATCH and the dedicated reorder endpoint share one mutation path. Other fields save in a single round-trip.

After save the service re-runs the aggregation for this one story so the response includes fresh derived fields.

### Reorder (`POST /stories/:id/reorder`)

`reorderInternal` shifts neighbours rather than using fractional ranks. For Phase 1's hundreds-per-project target this is fine.

```
maxPos     = Story.findOne({project_id}).sort({position:-1}).position
newPos     = clamp(body.position, 0, maxPos)  // can't create a gap
oldPos     = story.position
if newPos === oldPos: no-op
if newPos > oldPos:  decrement positions in (oldPos, newPos]
else:                increment positions in [newPos, oldPos)
story.position = newPos
```

Clamping to `[0, maxPos]` (not `maxPos + 1`) means a caller asking for "position 999" in a 5-story project lands at the bottom of the list, not at a gap.

### Delete (`DELETE /stories/:id`)

Two-phase:

1. **Detach tasks first** via `detachStoryFromTasks(storyId)` — `find({story_id}) → updateMany({story_id}, {$set: {story_id: null}})`. The two-phase pattern (find → update) keeps the audit accurate even if a concurrent writer touches the same task between phases — we record what we **found**, not what we speculatively might have detached.
2. **Delete the story doc**.
3. **Close the position gap** — `updateMany({project_id, position: {$gt: story.position}}, {$inc: {position: -1}})`. Idempotent.

Response: `{deleted: true, unset_task_ids: ['...']}`. Audit metadata includes the full `unset_task_ids` list plus a `detached_count` so the audit row can reconcile against the FE's view.

### List story tasks (`GET /stories/:id/tasks`)

**M11** — DB-level pagination via `findTasksByStoryIdPaginated`. Pre-M11 the endpoint fetched all tasks and `.slice()`'d in Node — a 5k-task story would pull 5k rows on every `?page=42` hit. Now `skip/limit` happen at Mongo, and a parallel `countDocuments` gives the wire envelope a real total without materialising the unread rows.

Projection: `{_id, title, status, sprint_id, primary_assignee_id}`. Sort `{created_at: 1, _id: 1}` (BUG-033 tiebreak).

---

# Section 4 — Tasks

## Data model ([`task.model.ts`](../../src/models/task.model.ts))

```ts
{
  _id, project_id (required), sprint_id, story_id,
  parent_task_id,                     // null = top-level; only one level of subtasks supported
  title, description,
  status,                             // free string — validated against (defaults ∪ project.custom_task_statuses)
  priority,                           // 'high' | 'medium' | 'low'  (default 'medium')
  due_date,                           // 'YYYY-MM-DD' string (required) — stored as text to avoid timezone drift
  estimated_hours,                    // ≥ 0, ≤ TASK_ESTIMATED_HOURS_MAX (1000)
  primary_assignee_id,                // single user; null = unassigned
  collaborator_ids:      ObjectId[],  // ≤ 50
  depends_on_task_ids:   ObjectId[],  // ≤ 50, embedded; same project; no cycles; no self
  position: number,                   // dense int per (project_id, status); reorder shifts neighbours
  created_by, updated_by, created_at, updated_at
}
```

### Field constraints ([`constants/task.ts`](../../src/constants/task.ts))

| Field | Cap |
|---|---|
| `title` | 1–200 chars, trimmed |
| `description` | ≤ 20,000 chars |
| `status` | 1–40 chars (free string — semantic validation at the service) |
| `priority` | enum `['high', 'medium', 'low']` (default `medium`) |
| `estimated_hours` | 0 ≤ x ≤ 1000 |
| `collaborator_ids` | ≤ 50 |
| `depends_on_task_ids` | ≤ 50 |
| `position` | non-negative integer |
| **Subtask depth** | **1 level only** (`TASK_MAX_SUBTASK_DEPTH = 1`) — a subtask cannot itself be a parent |

### Status is a free string, not an enum

The schema declares `status` as `String` with no `enum`. The valid set is **per project** (defaults `to_do | in_progress | review | done` ∪ `project.custom_task_statuses[].key`), and Mongoose enums are static. The service composes the set fresh on every status-touching write (`allowedStatusKeys(project)`) and rejects anything else with **422 `TASK_INVALID_STATUS`**.

### `due_date` is a `YYYY-MM-DD` string

Stored as text so the local calendar date doesn't drift to UTC midnight on a JS `Date` round-trip. ISO 8601 dates are lexicographically sortable, so all date comparisons (`due_before` filter, BUG-041 future-date check) work with plain string comparison.

### Subtasks

Modeled as **self-referential `parent_task_id`** — no separate "subtask" collection. Depth is capped at 1 (`TASK_MAX_SUBTASK_DEPTH`):

- `assertParentTaskUsable` confirms the candidate parent is in the **same project** and is **not itself a subtask**.
- On task delete: subtasks are **detached** (`parent_task_id` set to null) rather than cascade-deleted. Same policy as story → tasks. The parent's audit row records the original parent in `before`, so the link is recoverable from logs.
- On task create: if `parent_task_id` is supplied, a second activity row `subtask_added` is written **on the parent** so the parent's feed shows "John created subtask X".

### Dependencies

`depends_on_task_ids` is an embedded array (not a separate `task_dependencies` collection per Data_Model §5.4). The service enforces, on `POST /tasks/:id/dependencies`:

1. **Not self** — `depId.equals(task._id)` → **422 `TASK_DEPENDENCY_SELF`**
2. **Not duplicate** — already in array → **409 `TASK_DEPENDENCY_EXISTS`**
3. **Cap** — `length >= 50` → **422 `TASK_DEPENDENCY_EXISTS`** (cap reached)
4. **Same project** — dep's `project_id` must equal task's → **422 `TASK_DEPENDENCY_PROJECT_MISMATCH`**
5. **No cycle** — `wouldCreateCycle(taskId, depId)` runs **BFS forward** over the dependency graph starting at the candidate. If the BFS reaches `taskId`, adding the edge would close a cycle → **422 `TASK_DEPENDENCY_CIRCULAR`**. Bounded by node count (≤ 50 per task × graph fan-out); a depth-N chain is at most N reads.

On task delete the service runs `Task.updateMany({depends_on_task_ids: task._id}, {$pull: ...})` so dangling references vanish from peers.

### Position

Dense integer per `(project_id, status)` column. Two helpers:

- `nextPositionInColumn(projectId, status)` — `findOne({project_id, status}).sort({position:-1})` plus 1. Used by create + status-changing PATCH to **append to the end of the destination column**.
- `shiftNeighboursInColumn(task, newPosition)` — `$inc` neighbours up or down by 1 to make room. Same pattern as `story.service`'s reorder.

Status changes (PATCH or reorder-with-status) **always move the task to the END of the destination column** to avoid colliding with existing rows. Pure intra-column reorders shift neighbours.

### Indexes

| Index | Purpose |
|---|---|
| `{project_id: 1, sprint_id: 1}` | Sprint board reads |
| `{project_id: 1, status: 1, position: 1}` | Kanban column ordering — the hot path |
| `{project_id: 1, story_id: 1}` | Story board reads + story rollup |
| `{story_id: 1}` | Reverse lookup from story page |
| `{primary_assignee_id: 1, status: 1}` | "My tasks" inbox |
| `{collaborator_ids: 1}` | "Tasks I collaborate on" |
| `{parent_task_id: 1}` | Subtask listing |
| `{due_date: 1}` | Cross-project due-date dashboards |
| `{title: 'text', description: 'text'}` | Global search (current list endpoint uses regex; text index ready for migration) |

## Task endpoints

[`routes/task.routes.ts`](../../src/routes/task.routes.ts). Every route runs `authenticate` → `requirePermission(...)` → `validate(...)`.

| Method | Path | Permission (route) | Service narrow | Body / query |
|---|---|---|---|---|
| `GET` | `/tasks` | `task.read` | Visibility filter via project scoping | `?page&limit&project_id&sprint_id&story_id&assignee_id&status&priority&due_before&parent_task_id&q` |
| `POST` | `/tasks` | `task.write` | `requireWriter` (admin/manager/team_lead) | `CreateTaskBody` |
| `GET` | `/tasks/:id` | `task.read` | Visibility on the task's project | — |
| `PATCH` | `/tasks/:id` | `task.write` | `assertEmployeePatchScope` (employee = owner + whitelist) | `PatchTaskBody` (partial) |
| `DELETE` | `/tasks/:id` | `task.write` | `requireWriter` | — |
| `POST` | `/tasks/:id/reorder` | **`task.read`** | Admin / manager / team_lead OR assignee | `{position: number, status?: string}` |
| `POST` | `/tasks/:id/assign-story` | `task.write` | `requireWriter` — returns `STORY_WRITE_FORBIDDEN` on failure | `{story_id: string | null}` |
| `POST` | `/tasks/:id/move-sprint` | `task.write` | `requireWriter` | `{sprint_id: string | null}` |
| `POST` | `/tasks/:id/dependencies` | `task.write` | `requireWriter` | `{depends_on_task_id: string}` |
| `DELETE` | `/tasks/:id/dependencies/:dep_id` | `task.write` | `requireWriter` | — |

### Service-layer narrowing

| Operation | Rule |
|---|---|
| `POST /tasks`, `DELETE /tasks/:id`, `POST /tasks/:id/move-sprint`, dependency add/remove | `requireWriter` — admin / manager / team_lead only. **Employee and Client always blocked.** |
| `PATCH /tasks/:id` (as Employee) | Must be the **task's creator OR the primary assignee** AND only the whitelisted fields in [`TASK_EMPLOYEE_PATCH_FIELDS`](../../src/constants/task.ts) (`status`, `description`, `estimated_hours`). Any other field → `TASK_WRITE_FORBIDDEN`. Clients are blocked outright. |
| `POST /tasks/:id/reorder` | Admin / manager / team_lead **OR the task's `primary_assignee_id`**. Lets a person drag their own Kanban card without a manager round-trip. |
| `POST /tasks/:id/assign-story` | Admin / manager / team_lead. Returns `STORY_WRITE_FORBIDDEN` (not `TASK_WRITE_FORBIDDEN`) per API_Contract §8.2a — story membership is semantically a story-write op. |
| `GET /tasks` for non-admin/manager | Filter expands to all projects where `member_ids ∋ caller.id` (employee, team_lead) or `client_ids ∋ caller.id` (client), via `buildProjectVisibilityFilter`. |

### List query (`GET /tasks`)

- **`story_id` and `parent_task_id` accept the literal string `'null'`** as a sentinel for "no story" / "top-level (no parent)". You can't pass `null` in a query string, so this sentinel lets the FE filter for those cases.
- `q` requires ≥ 2 chars (R15) — prevents `?q=a` full-collection regex scans.
- **Project scoping**: when `project_id` is supplied, the service validates the caller can read it. Otherwise — for non-admin/manager callers — the service resolves visible-project ids (capped at 1,000) and filters `task.project_id ∈ {…}`.
- Sort: `{position: 1, created_at: 1}` so the board renders in column order.

### Create (`POST /tasks`)

1. **`requireWriter`** — admin / manager / team_lead.
2. **`loadProjectForCaller`** — visibility check.
3. **`assertValidStatus`** — against (defaults ∪ project customs).
4. **Sprint** belongs to project; **story** belongs to project; **parent** is in the same project AND not itself a subtask.
5. **Assignee** + **collaborators** are active internal users (admin/manager/team_lead/employee).
6. **Dependencies** (if any) — cap check; all dep ids exist in the same project; no cycle check (the new task has no in-edges yet).
7. **Position** — explicit override OR `nextPositionInColumn(projectId, status)`.
8. `Task.create({...})`.
9. **Audit** `TASK_CREATE` + **activity** `created`. If a `parent_task_id` was supplied, write a second activity `subtask_added` on the **parent** task.

### Patch (`PATCH /tasks/:id`)

- **`project_id` is intentionally not patchable** — moving a task between projects is a different multi-step operation that doesn't ship in v1.
- For Employees: `assertEmployeePatchScope` enforces creator-or-assignee + whitelisted fields.
- **Status change** → `assertValidStatus`, then `nextPositionInColumn(...)` so the task lands at the end of the destination column. The position is taken from the destination column whether the caller asked for a position or not.
- **Position-only change** (status didn't change) → `shiftNeighboursInColumn(...)`.
- **BUG-041 future-date guard** (Zod): a task marked `done` cannot have a future `due_date`. The rule fires only when both `status` and `due_date` are present in the payload (PATCH may omit either).
- After save: best-effort `recordAudit(TASK_UPDATE)` + `emitPatchActivities(...)` which writes **one activity row per meaningfully changed field** (status_changed, priority_changed, due_date_changed, estimate_changed, assignee_changed, sprint_changed, story_changed, plus per-user collaborator_added / collaborator_removed). Title and description changes are deliberately silent on the feed — the spec enum has no matching type and "title changed" rows are noisy.

### Delete (`DELETE /tasks/:id`)

- `requireWriter`.
- **Detach subtasks** — `Task.updateMany({parent_task_id: task._id}, {parent_task_id: null})`. Cascade-delete is not used in Phase 1.
- **Strip from dependants** — `Task.updateMany({depends_on_task_ids: task._id}, {$pull: ...})`.
- **Delete the task** — `task.deleteOne()`.
- **Close the position gap** in the source column — `$inc: {position: -1}` for everything with `position > task.position` in `(project_id, status)`.
- Audit `TASK_DELETE`.

### Reorder (`POST /tasks/:id/reorder`)

Route gate is `task.read`; service narrows to admin/manager/team_lead OR `primary_assignee_id`. Flow:

1. **Cross-column move** (`body.status` differs from current): validate destination, save with `position = nextPositionInColumn(...)`, then **close the gap in the source column** (`$inc -1` for `position > oldPosition`), then apply any within-new-column shift.
2. **Pure intra-column reorder**: `shiftNeighboursInColumn(...)`.

Activity feed: cross-column moves emit `status_changed`. Pure intra-column reorders are silent.

### Assign-story / Move-sprint

Both are isolated endpoints (separate from PATCH) so the audit log can record per-edge events:

- `assign-story` validates the story belongs to the project; sets `task.story_id`; writes `TASK_ASSIGN_STORY` audit + `story_changed` activity.
- `move-sprint` validates the sprint belongs to the project; sets `task.sprint_id`; writes `TASK_MOVE_SPRINT` audit + `sprint_changed` activity.

Per API_Contract §8.2a, non-writer callers hitting `assign-story` receive **`STORY_WRITE_FORBIDDEN`** (semantically a story-write), while `move-sprint` returns the standard `TASK_WRITE_FORBIDDEN`.

### Dependencies

- `POST /tasks/:id/dependencies` — runs all 5 validations above, pushes the id, writes `TASK_DEPENDENCY_ADD` audit + `dependency_added` activity.
- `DELETE /tasks/:id/dependencies/:dep_id` — filters the array, returns **404 `TASK_DEPENDENCY_NOT_FOUND`** if the edge wasn't present.

---

# Section 5 — Task Comments

## Model

[`src/models/task-comment.model.ts`](../../src/models/task-comment.model.ts). Soft-delete model: `deleted_at` is the only marker. Reads exclude deleted rows by default; the audit log keeps the original body for the regulatory trail. `is_edited` flips to `true` on the first PATCH and stays true forever (Slack/GitHub UX).

```ts
{
  task_id (required), author_id (required), body, mentioned_user_ids: ObjectId[],
  is_edited: boolean, deleted_at: Date | null, created_at, updated_at
}
```

Caps: `body ≤ COMMENT_BODY_MAX`, `mentioned_user_ids ≤ COMMENT_MENTIONS_MAX`. Indexes: `{task_id, created_at}` and `{mentioned_user_ids}`.

## Routes

[`src/routes/task-comment.routes.ts`](../../src/routes/task-comment.routes.ts). Two routers (nested + top-level):

| Method | Path | Permission |
|---|---|---|
| `GET` | `/tasks/:task_id/comments` | `task.read` |
| `POST` | `/tasks/:task_id/comments` | `task_comment.write` |
| `PATCH` | `/comments/:id` | `task_comment.write` |
| `DELETE` | `/comments/:id` | `task_comment.write` |

List query: `?page&limit&include_deleted`. `include_deleted` is admin/manager-only — other roles silently ignore the flag (the service drops it).

## Sanitisation

[`utils/comment-sanitiser.ts`](../../src/utils/comment-sanitiser.ts) is called in the service (not the validator). HTML tags are stripped; markdown text is kept intact. The FE renders markdown client-side — we deliberately do NOT pre-render to HTML so we can change the renderer without rewriting history.

If sanitisation reduces the body to whitespace (e.g. body that was `"<script>x</script>"` alone), the service throws **`VALIDATION_ERROR`** with "Comment body is empty after sanitisation".

## Mention scoping

`assertMentionsBelongToProject` is the **single source of truth** for who's mentionable. Every mention must be a member or client of the project. De-dupes mention ids; rejects anything outside the project with **422 `MENTION_NOT_PROJECT_MEMBER`** + `{invalid_user_ids: [...]}`.

## Notification fan-out (BUG-068)

On create:
- **If the comment has mentions** → notify ONLY the mentioned users (`notifyTaskCommentMention`) — in-app + email.
- **Otherwise** → notify the people **assigned to the task** (primary assignee + collaborators) via `notifyTaskCommentWatchers` — quiet in-app only, no email.
- **Neither mentions nor assignees** → no notification.
- Prior commenters and the task creator are **NOT** in the recipient list. Only people explicitly tied to the task get pinged.

On edit: only **newly-introduced** mentions trigger fan-out (the delta vs. the previous mention list) — re-saving the same mention list shouldn't re-notify everyone. Same `notifyTaskCommentMention` path.

## Author / moderator rules

**Edit (`PATCH /comments/:id`) is author-only** — even admins/managers cannot rewrite somebody else's words. They can soft-delete instead. Matches the Slack/GitHub authorship model.

**Delete (`DELETE /comments/:id`) is author-or-moderator** — Author OR admin/manager/team_lead. Employees and clients cannot delete other people's comments — even an employee who's an assignee on the underlying task. Soft-delete (`deleted_at = new Date()`). Audit metadata captures `deleted_by: 'author' | 'moderator'`.

## Hydration (M36)

`loadAuthorDisplays(ids)` batch-loads `{id, full_name}` for the unique author ids on a page and stamps `author: {...}` onto each row. 100 comments authored by 30 unique people = **1 round-trip** here vs. 30 in the pre-M36 FE. A hard-deleted author (rare) surfaces as `{id, full_name: null}`.

## Audit + activity per write

| Op | Audit action | Activity type |
|---|---|---|
| Create | `COMMENT_CREATE` | `comment_added` |
| Patch | `COMMENT_UPDATE` (metadata includes `new_mention_count`) | `comment_edited` |
| Delete | `COMMENT_DELETE` (metadata includes `deleted_by: 'author' | 'moderator'`) | `comment_deleted` |

---

# Section 6 — Task Activity feed

[`src/models/task-activity.model.ts`](../../src/models/task-activity.model.ts) — `task_activities` collection. **Distinct from `audit_logs`** (system-wide compliance trail) — activity is the UI-facing change history rendered on the task detail screen. Same domain event may legitimately write to both.

## Shape

```ts
{
  task_id (required), actor_id (required), activity_type (enum),
  from_value: Mixed,    // string | ObjectId | number | null
  to_value:   Mixed,    // same
  metadata:   { ... },  // per activity_type
  created_at, updated_at
}
```

Indexes: `{task_id, created_at: -1}` powers the feed; `{actor_id, created_at: -1}` reserved for future "what did this user do" view.

## Activity types

[`constants/task-activity.ts`](../../src/constants/task-activity.ts) — the enum (`TASK_ACTIVITY_TYPES`):

`created`, `status_changed`, `priority_changed`, `due_date_changed`, `estimate_changed`, `assignee_changed`, `collaborator_added`, `collaborator_removed`, `sprint_changed`, `story_changed`, `dependency_added`, `dependency_removed`, `subtask_added`, `attachment_added`, `attachment_removed`, `comment_added`, `comment_edited`, `comment_deleted`.

## `recordActivity` is never-throw

Same contract as `recordAudit`. DB failures are caught and logged at `warn` with `ACTIVITY_WRITE_FAILED`. The primary task action always succeeds.

There's also `recordActivityIfChanged({from, to, ...})` for diff-driven callers — skips the write when `from === to` (ObjectId-aware via `.equals`). Returns `false` when suppressed.

## Routes

[`src/routes/task-activity.routes.ts`](../../src/routes/task-activity.routes.ts) — read-only.

| Method | Path | Permission |
|---|---|---|
| `GET` | `/tasks/:task_id/activity` | `task.read` |

Query: `?page&limit&activity_type&actor_id&include_subtasks=true`. **`include_subtasks=true`** rolls in activities for the task's direct subtasks (one level — matches the FE/model cap). The service does a single `parent_task_id = task._id` lookup; no recursion.

Sort: `{created_at: -1, _id: -1}` (newest first).

## Hydration (M38)

Same pattern as comments — `loadActorDisplays` batch-loads `{id, full_name}` for the page's unique actor ids; the response includes `actor: {...}` on each row. A hard-deleted user surfaces as `{id, full_name: null}`.

---

# Section 7 — Task Attachments

## Model

[`src/models/task-attachment.model.ts`](../../src/models/task-attachment.model.ts) — `task_attachments` collection.

```ts
{
  task_id (required), uploaded_by (required),
  file_name, file_size, mime_type,
  blob_container, blob_key,
  deleted_at: Date | null, created_at, updated_at
}
```

Indexes: `{task_id, created_at}` (chronological list) and **`{blob_key}` unique** (defence-in-depth so a re-finalize with the same blob_key cannot create a duplicate row pointing at the same storage object).

## Two-step SAS upload flow

The blob lives in a **private Azure Blob container** (typically `task-attachments`). The metadata row is the authoritative pointer; **SAS URLs are minted on demand and never persisted**. The flow:

1. **`POST /tasks/:task_id/attachments/upload-url`** → mints a write-SAS:
   - Confirms Azure is configured (else **503 `STORAGE_NOT_CONFIGURED`**).
   - Loads current upload policy from [`system_settings.uploads`](../../src/services/settings.service.ts) — `max_file_size_mb`, `allowed_mime_types[]`, `sas_token_ttl_minutes`.
   - **Validates size + MIME** against the policy.
   - Builds a deterministic blob key: `tasks/{task_id}/users/{uploader_id}/{ulid}-{safe_filename}`.
   - Calls `mintUploadSas({...})` — returns a short-lived SAS URL with `create` permission only (no `write`), `Content-Type` **pinned** into the SAS so a `.png` upload can't be served back as `text/html`.
   - Returns `{upload_url, blob_container, blob_key, expires_at, method: 'PUT', required_headers: {'x-ms-blob-type': 'BlockBlob', 'Content-Type': mime}}`.
2. **FE PUTs the raw bytes** to `upload_url` with the **exact** required headers. The PUT does NOT carry the BE bearer token (Azure SAS embeds its own auth; sending a bearer would 403).
3. **`POST /tasks/:task_id/attachments/finalize`** → records the metadata row:
   - Re-validates against the **current** policy (admin may have tightened it between mint and finalize).
   - **Path validation** — `blob_key` must start with `tasks/{task_id}/users/{caller.id}/` AND `blob_container` must match the configured container. Otherwise **422 `ATTACHMENT_BLOB_KEY_MISMATCH`** — protects against finalizing a key minted for some other task / uploader.
   - **`headBlob(container, blob_key)`** — confirms the blob actually exists. If not → **422 `ATTACHMENT_BLOB_MISSING`** (caller forgot the PUT). If size differs from what the caller is claiming → **422 `ATTACHMENT_SIZE_MISMATCH`** (anti-spoof). The actual size from Azure is then re-checked against the policy.
   - `TaskAttachment.create({...})`. On E11000 (unique `blob_key`) → **409 `DUPLICATE_RESOURCE`** (re-finalize is idempotent on the client but conflicts here).

### Why the uploader segment in the blob key

The upload SAS is minted **before any DB row exists**, so for the window between mint and finalize there's nothing tying the blob to a specific user. Without the uploader segment, any project member who learns somebody else's blob_key (network logs, leaked subscription event, opportunistic guess) could call `/finalize` first and become the recorded uploader of someone else's file. Embedding `uploader_id` in the path lets `/finalize` refuse keys whose path doesn't match the caller — no extra DB state needed.

The ULID guarantees uniqueness for the same filename re-uploaded twice and provides natural ordering by upload time. The filename is sanitised to ASCII alphanumerics + `.-_` for storage-tooling safety (the display name keeps the original verbatim).

## Routes

[`src/routes/task-attachment.routes.ts`](../../src/routes/task-attachment.routes.ts):

| Method | Path | Permission |
|---|---|---|
| `GET` | `/tasks/:task_id/attachments` | `task.read` |
| `POST` | `/tasks/:task_id/attachments/upload-url` | `task_attachment.write` |
| `POST` | `/tasks/:task_id/attachments/finalize` | `task_attachment.write` |
| `GET` | `/attachments/:id/download-url` | `task.read` |
| `DELETE` | `/attachments/:id` | `task_attachment.write` |

## Download flow

`GET /attachments/:id/download-url` re-loads the attachment + asserts project visibility, then calls `mintDownloadSas({container, blobKey, ttlMinutes, fileName})`. The TTL is the same `sas_token_ttl_minutes` policy. The response carries the URL plus the metadata the FE renders (file name, MIME, size). The browser handles the redirect.

## Delete (`DELETE /attachments/:id`)

- Uploader OR admin/manager/team_lead.
- Soft-delete (`deleted_at = new Date()`).
- **Best-effort blob delete** — `deleteBlob(container, blob_key)` swallows its own errors (logs `BLOB_DELETE_FAILED`). The row is already soft-deleted by the time we get here, so a transient Azure failure shouldn't flip the user's success signal.
- If Azure isn't configured, logs `STORAGE_NOT_CONFIGURED` at warn but still soft-deletes the row.
- Audit + activity: `ATTACHMENT_DELETE` + `attachment_removed`, metadata `deleted_by: 'uploader' | 'moderator'`.

## List query

`?page&limit&include_deleted`. `include_deleted` is admin/manager/team_lead-only — silently ignored for other roles.

---

# Section 8 — Task Templates

[`src/services/task-template.service.ts`](../../src/services/task-template.service.ts) (Phase 4 Step 40). Reusable task definitions per project; optional recurring auto-instantiation.

## Model

[`src/models/task-template.model.ts`](../../src/models/task-template.model.ts):

```ts
{
  _id, project_id (required, indexed),
  name,              // admin-facing template name in the list
  title,             // becomes the title of the instantiated task
  description, priority,
  default_assignee_id,
  default_collaborator_ids: ObjectId[],
  default_story_id, default_sprint_id,
  default_due_offset_days,   // null = inherit today
  default_estimated_hours,
  recurrence: {              // optional sub-doc; null = manual-only
    enabled, frequency: 'daily' | 'weekly' | 'monthly',
    weekdays: number[],      // weekly only (0..6 Sun..Sat)
    day_of_month,            // monthly only (1..28)
    start_date, end_date,
    last_generated_at        // YYYY-MM-DD of the most recent successful auto-instantiation
  } | null,
  is_archived: boolean,
  created_by, updated_by, created_at, updated_at
}
```

Indexes: `{project_id, is_archived}` (project templates panel); `{recurrence.enabled, is_archived}` (recurrence sweep).

## Routes

| Method | Path | Permission |
|---|---|---|
| `GET` | `/projects/:project_id/task-templates` | `task_template.read` |
| `POST` | `/projects/:project_id/task-templates` | `task_template.write` |
| `GET` | `/task-templates/:id` | `task_template.read` |
| `PATCH` | `/task-templates/:id` | `task_template.write` |
| `DELETE` | `/task-templates/:id` | `task_template.write` |
| `POST` | `/task-templates/:id/instantiate` | `task_template.write` |

`requireWriter` uses [`isProjectAuthor`](../../src/utils/role-check.ts) — admin / manager / team_lead.

## Reference resilience at instantiation

Inside `materialiseTaskFromTemplate`, references can become stale between template creation and instantiation. The flow silently drops stale references and emits a `warn` per drop so an operator sees "template X had a stale reference" without the (recurring) instantiation hard-failing:

| Reference | Validation | If stale |
|---|---|---|
| `primary_assignee_id` | `filterValidUserIds` — active user, internal role | Dropped to `null`, warn `dropped_assignee` |
| `collaborator_ids` | Same | Stale ones removed from array, warn `dropped_count` |
| `story_id` | `validateStoryRef` — exists in same project | Dropped to `null`, warn `dropped_story_id` |
| `sprint_id` | `validateSprintRef` — same | Dropped to `null`, warn `dropped_sprint_id` |
| `due_date` | Override > offset from today > today | `dayjs().tz('Asia/Kolkata').add(offset, 'day').format('YYYY-MM-DD')` |

After resolving references, the service hands off to `task.service.createTask(...)` so the resulting task inherits every Task-side invariant (status validation, parent-task check, dependency caps, audit + activity emission). No code path duplication.

## Recurring sweep (`runRecurringTaskSweep`)

Daily cron entry point (registered as `recurring_task_sweep` in [`jobs/index.ts`](../../src/jobs/index.ts), 06:00 IST). For each `recurrence.enabled: true, is_archived: false` template:

1. **Window check** — `todayIso < start_date` OR `todayIso > end_date` → skip.
2. **Already-today check** — `recurrence.last_generated_at === todayIso` → skip (`skipped_already_today++`).
3. **Schedule fires today?**
   - `daily` — always.
   - `weekly` — `weekdays.includes(today.day())`.
   - `monthly` — `day_of_month === today.date()`.
4. **Materialise** — `materialiseTaskFromTemplate(tpl, {}, systemCaller)` where `systemCaller.id = tpl.created_by` (the resulting task's `created_by` is honest), `role = ADMIN` (bypasses the role gate for the cron-driven create).
5. **Atomic stamp** — `findOneAndUpdate({_id, 'recurrence.last_generated_at': priorValue}, {$set: {'recurrence.last_generated_at': todayIso}})`. A concurrent tick that already stamped this template returns `null` from the CAS, and the duplicate task is logged for operator cleanup.
6. **System audit** — `recordSystemAudit({action: TASK_TEMPLATE_RECURRENCE_RUN, metadata: {project_id, created_task_id, fire_date, frequency}})`.
7. **Failures** are logged at warn (`Recurring task instantiate failed; will retry tomorrow`) and don't abort the sweep — the loop continues with the next template.

Cap: `TASK_TEMPLATE_RECURRENCE_MAX_PER_RUN` templates per tick.

Returns a summary `{templates_scanned, tasks_created, skipped_already_today, failures}` consumed by the cron's job-run log.

---

# Section 9 — Project Share Links

## Schema ([`project-share-link.model.ts`](../../src/models/project-share-link.model.ts))

```ts
{
  _id, project_id,
  token_hash: string,                           // SHA-256 hex of the raw token; source of truth for lookups
  token: string | null,                          // Legacy plaintext (pre-C9); cleared by boot migration. New rows always null
  owner_client_id: ObjectId | null,              // When set, deactivating that client auto-revokes
  created_by: ObjectId,
  expires_at: Date | null,                        // null = never expires
  revoked_at: Date | null,
  revoked_by: ObjectId | null,
  revoke_reason: 'manual' | 'client_deactivated' | null,
  last_accessed_at: Date | null,                  // Single timestamp, NOT an event log
  created_at, updated_at,
}
```

**Indexes**:
- `{token_hash: 1}` **unique** (`project_share_links_token_hash_unique`) — the resolver's primary lookup. Pre-C9 the index was on `token`.
- `{project_id: 1}` — nested list query.
- `{owner_client_id: 1}` — fires the user-deactivation cascade.

## C9 — token at rest is now a hash

**Pre-fix:** raw token was persisted in `token` and queried via `findOne({token})`. Any read-only DB exposure (backup, replica, mongo-express misconfig, BSON dump in a log line) handed an attacker live ungated read access to every project the link grants.

**Post-fix:** only `sha256Hex(token)` is persisted in `token_hash`. The raw token is returned ONCE in the create response, lives in the URL the admin shares, and is **never in the DB**. Mirrors the password-reset + refresh-token patterns.

Boot migration (`migrateShareLinkTokensToHashed`):
```
for each row where token is set:
  row.token_hash = sha256Hex(row.token)
  row.token = null
  row.save()
```
Idempotent (post-migration rows have `token: null` and are skipped); never throws (warn log + boot continues; a still-plaintext row simply 404s next time it's resolved).

The legacy `token` field stays as a nullable transitional column until every deployment has booted with the migration at least once.

## Share link endpoints

| Method | Path | Auth | Body / Query | Returns |
|---|---|---|---|---|
| `GET` | `/projects/:project_id/share-links` | `share_link.write` | `?page&limit&active_only=true|false` (strict; H4 booleanish) | Paginated rows, **token + token_hash stripped** |
| `POST` | `/projects/:project_id/share-links` | `share_link.write` | `{owner_client_id?, expires_at?}` (both optional, both default null) | `{...row, token: <raw 43-char base64url>}` — token surfaced ONCE |
| `POST` | `/share-links/:id/revoke` | `share_link.write` | — | The updated row (idempotent on already-revoked) |
| `GET` | `/share-links/resolve/:token` | **none — public** | path: `:token` | `{project, sprints, stories, tasks, last_accessed_at, truncated?}` |

The resolve route is **deliberately unauthenticated**. The token IS the credential. Global per-IP rate limiter (`/api/*`) is the brute-force defence; 256 bits of entropy makes that already impractical.

## Token generation + retry (paranoia ceiling)

```ts
generateToken() = randomBytes(SHARE_LINK_TOKEN_BYTES = 32).toString('base64url')   // 43 chars, ~256 bits

for attempt in 0..SHARE_LINK_TOKEN_MAX_ATTEMPTS (5):
  candidate = generateToken()
  try ProjectShareLink.create({token_hash: sha256Hex(candidate), token: null, ...})
  except E11000: continue                      ← retry on token_hash collision
  rawToken = candidate; break
else: AppError.internal('Failed to generate a unique share-link token')
```

Birthday collision against 1M issued links at 256 bits ≈ 1e-65 — the retry loop is paranoia, not a real path.

## Create response — the only place the raw token exists on the wire

```ts
return {...toPublic(created), token: rawToken};
```

`toPublic(doc)` strips `token` AND `token_hash` from the JSON. The raw token rides alongside in `{token}` — admin copies the URL out of the dialog. If they lose the URL: revoke + create new. There's no recovery path because the FE list view never gets the token back.

**Audit row carries `toPublic` shape** (no token, no token_hash) so a forensic read of `audit_logs` doesn't leak the credential either.

## Revoke

```ts
revokeLink(id, caller):
  link = findById(id) || 404 SHARE_LINK_NOT_FOUND
  if link.revoked_at !== null: return toPublic(link)           ← IDEMPOTENT
                                                               // Re-revoke would shift the "when did it stop"
                                                               // audit boundary; double-click safe.
  link.{revoked_at: now, revoked_by: caller.id, revoke_reason: 'manual'}.save()
  audit SHARE_LINK_REVOKE {before, after, metadata: {project_id, owner_client_id, reason: 'manual'}}
  return toPublic(link)
```

## Resolve (public, no auth)

```ts
resolveLink(token):
  // C9 — hash-then-find, NOT compare-against-stored-plaintext
  link = findOne({token_hash: sha256Hex(token)})
  if !link: 404 SHARE_LINK_NOT_FOUND

  status = isLinkLive(link, now):
    if revoked_at !== null  → {live: false, reason: 'revoked'}
    if expires_at && expires_at <= now → {live: false, reason: 'expired'}
    else → {live: true}

  if !live:
    if reason === 'revoked': 410 SHARE_LINK_REVOKED {revoked_at}    ← revoke_reason NOT echoed
    if reason === 'expired': 410 SHARE_LINK_EXPIRED {expires_at}

  link.last_accessed_at = now; link.save()                      ← bump timestamp

  project = Project.findById(link.project_id).select('-member_ids -client_ids -created_by')
  if !project: 404 SHARE_LINK_NOT_FOUND                          ← stale pointer; honest 404

  // H19 — pull limit+1 to detect truncation without a countDocuments round-trip
  sprintsRaw = Sprint.find({project_id}).limit(SHARE_LINK_SPRINT_CAP + 1)     // cap 50
  storiesRaw = Story.find({project_id}).limit(SHARE_LINK_STORY_CAP + 1)        // cap 100
  tasksRaw   = Task.find({project_id}).limit(SHARE_LINK_TASK_CAP + 1)          // cap 1000

  truncated = clipped-flags-per-collection || undefined
  return {project, sprints, stories, tasks, last_accessed_at: now, truncated?}
```

**410 vs 404 distinction**: `410 Gone` for revoked/expired links — the caller had a previously-valid reference. `404 Not Found` for unknown tokens — anti-enumeration; "this token doesn't exist" and "this token was revoked" must look different to a token holder, identical to a guesser.

**`revoke_reason` NOT echoed on the public 410** — the literal `client_deactivated` would disclose to a token holder that a specific client account was deactivated. Audit log keeps the reason for ops.

## Field projections strip enumeration vectors

The public payload strips:
- `member_ids`, `client_ids` — bulk ObjectId arrays of internal users
- `created_by`, `updated_by`, `collaborator_ids` — admin-history bookkeeping

Keeps `primary_assignee_id` (per-task) for FE avatar tile. An authenticated user reading the same project through `/projects/:id` gets the full document.

## H19 — payload caps

| Collection | Cap |
|---|---|
| Sprints | 50 |
| Stories | 100 |
| Tasks | 1000 (matches `REPORT_ROW_CAP`) |

`truncated` field surfaces `{sprints?, stories?, tasks?}` when any collection hit its cap. Pre-H19 unbounded `.find()` on a large project rendered multi-MB JSON per anonymous request — usable DOS amplification + heap-pressure.

## `revokeLinksForDeactivatedClient` — user-deactivation cascade

Invoked from [`user.service.deactivateUser`](../../src/services/user.service.ts) when the target is a client:

```ts
revokeLinksForDeactivatedClient({client_id, revoked_by, audit}):
  open = ProjectShareLink.find({owner_client_id: client_id, revoked_at: null})
  for each link:
    try revokeOne(link, revoked_by, reason: 'client_deactivated', audit)
    revokedCount++
    catch err: log warn SHARE_LINK_AUTO_REVOKE_FAILED; continue
  return {revoked_count: revokedCount}
```

**Each revoke is independently audited** (one `share_link.revoke` row per link with `metadata.reason: 'client_deactivated'`). The Step-31 audit UI correlates them to the parent `user.deactivate` event via `revoked_by` + timestamp.

**`revoked_by` is the deactivating admin** (NOT the link owner). The audit row points at the human who triggered the cascade.

**Never throws.** A failure mid-cascade still leaves the user deactivated. Failures log under `SHARE_LINK_AUTO_REVOKE_FAILED`.

---

# Section 10 — Project Timeline

## Endpoint

```
GET /projects/:project_id/timeline?from_date=&to_date=&sprint_id?&story_id?&include_completed=false
```

Read-only. No mutations, no audit, no notifications. Mirrors the report surface's discipline (strict query, capped range, derived row-shape).

## Query rules

```ts
{
  from_date: YYYY-MM-DD,
  to_date:   YYYY-MM-DD,
  sprint_id?: ObjectId,
  story_id?: ObjectId,
  include_completed: boolean (default false),
}
```

- Strict mode — unknown keys rejected.
- Cross-field refine: `from_date ≤ to_date` AND span ≤ `TIMELINE_RANGE_MAX_DAYS = 365`. Same `dateRangeRefine` pattern as the report validators.
- `include_completed: false` (default) excludes tasks with `status === DONE` — the typical Gantt view focuses on what's left. FE flips this on for retro / "completed work" views.

## Response shape

```ts
{
  project: {id, name, start_date, end_date},
  sprints: [{id, name, start_date, end_date, status}],
  tasks: [{
    id, title, status, priority,
    start_date: 'YYYY-MM-DD',         // ← DERIVED per task (see below)
    due_date: 'YYYY-MM-DD',
    sprint_id, story_id, parent_task_id,
    primary_assignee_id,
    depends_on_task_ids: string[],
    position: number,                  // explicit position for stable group ordering
  }],
  truncated: boolean,                  // true when task list hit TIMELINE_TASK_CAP
}
```

## Derived `start_date` per task (Step 41 — no schema migration)

Tasks today don't carry an explicit `start_date` column. Adding one is a Phase-5 enhancement (heavy blast radius on existing task validators / service / tests). The service derives one per task at read time:

```
1. If task.sprint_id set AND that sprint is in the loaded set:
   → sprint.start_date
2. Otherwise:
   → toIstDate(task.created_at)
```

The FE Gantt renders a bar from `[start_date, due_date]` per task using this derived field.

## Overlap filter — two-stage

```
DB-side (uses {project_id, due_date} index):
  filter: {project_id, due_date: {$gte: from_date}, status?: {$ne: DONE}, sprint_id?, story_id?}

JS-side (after start_date derivation):
  skip task if derived_start > to_date     ← anchors bar's left edge to be in-or-before window
```

DB filter anchors the bar's **right edge** to be in-or-after the window; JS filter anchors the bar's **left edge** to be in-or-before the window. Together they catch every task whose `[start_date, due_date]` interval overlaps the window.

The JS-side filter can't move to the DB because the derived start depends on a JOIN with sprints.

## Sprint window filter

```
filter: {project_id, start_date: {$lte: to_date}, end_date: {$gte: from_date}}
```
Index-friendly via `{project_id, start_date}`. A sprint with `start_date: 2026-01-01, end_date: 2026-03-31` shows up for a window of `2026-02-15 → 2026-04-15`.

## `TIMELINE_TASK_CAP = 2_000` (defense in depth)

Even with the 365-day cap, a project with an unusually dense backlog shouldn't blow the response. Cap surfaces `truncated: true` so FE can prompt the user to narrow. `Task.find(...).limit(TIMELINE_TASK_CAP + 1)` — same `limit+1` pattern as share-link resolve to detect truncation without a `countDocuments` round-trip.

## Sort order

```ts
.sort({position: 1, created_at: 1})
```

`position` is the explicit per-task ordering set when an admin reorders cards on the Kanban board. `created_at` is the deterministic tiebreaker for tasks with identical position values.

---

# End-to-end flows

### Create a project

1. Caller hits `POST /api/v1/projects` with `{name, code, description, start_date, end_date, status, member_ids[], client_ids[], custom_task_statuses[]}`.
2. `authenticate` validates the JWT; `requirePermission(project.write)` checks the bundle; `validate({body: createProjectBodySchema})` runs the Zod refine (code uppercase + regex, end ≥ start, custom-status keys unique + no default collisions).
3. Controller builds the caller context and calls `service.createProject`.
4. Service dedupes `member_ids` / `client_ids`. If the caller is a member-scoped role (`team_lead` / `employee`), it auto-adds the caller to `member_ids` (BUG-007) so they don't lose visibility of the project they just made.
5. `validateMemberCandidates` and `validateClientCandidates` fetch the candidate users in one query each; reject with **422 `INVALID_PROJECT_MEMBER_ROLE` / `_CLIENT_ROLE`** on shape mismatch.
6. `Project.create({...})` runs.
7. On E11000 with `keyPattern.code`, the service translates to **409 `PROJECT_CODE_TAKEN`** with `{code: input.code}`.
8. Audit row written via `recordAudit({action: PROJECT_CREATE, ...})`.
9. Controller returns `201` with the public projection.

### List projects (Team Lead)

1. `GET /api/v1/projects?status=active&is_archived=false&q=acme&page=1&limit=20`.
2. `validate({query: listProjectsQuerySchema})` coerces page/limit/is_archived, rejects `q` shorter than 2 chars.
3. `service.listProjects` calls `buildVisibilityFilter({id, role: 'team_lead'})` → `{member_ids: caller.id}`.
4. Applies optional filters. For `q`, escapes regex specials and adds `$or: [{name: regex}, {code: regex}, {description: regex}]`.
5. Runs `Project.find(filter).sort({created_at: -1}).skip(skip).limit(limit)` and `Project.countDocuments(filter)` in parallel.
6. Returns `{data: [...], meta: {page, limit, total, total_pages}}`.

### Bulk-edit the member roster

1. `POST /api/v1/projects/:id/members` with `{add: [u1, u2], remove: [u3]}`.
2. Service loads the project; computes `addIds = dedupe(body.add)`, `removeIds = body.remove.map(ObjectId)`.
3. Validates only the **truly new** add candidates (not already on the roster).
4. Snapshots `before = doc.member_ids.map(String)`.
5. `withTransaction`:
   - if removes: `Project.updateOne({_id}, {$pull: {member_ids: {$in: removeIds}}}, {session})`
   - if adds: `Project.updateOne({_id}, {$addToSet: {member_ids: {$each: addIds}}}, {session})`
   - re-read inside the txn for the after snapshot
6. Audit row with `metadata: {added: [...], removed: [...]}` filtered to changes that actually happened.

### Delete a custom status when tasks still use it

1. `DELETE /api/v1/project-custom-statuses/:id`.
2. Service reverse-looks-up the project via `Project.findOne({'custom_task_statuses._id': statusId})`.
3. `Task.countDocuments({project_id: doc._id, status: sub.key})` runs.
4. If count > 0 — **409 `RESOURCE_HAS_DEPENDENTS`** with `{tasks: count, status_key: sub.key}`. Caller must PATCH the tasks onto a different status first.
5. If count = 0 — pull the sub-doc, save, audit `PROJECT_CUSTOM_STATUS_DELETE`, return `204`.

### Create a sprint that overruns the project window

1. Admin POSTs `/api/v1/projects/:project_id/sprints` with `{name, start_date: '2026-06-01', end_date: '2027-01-15'}`.
2. Zod refine: `end_date >= start_date` ✓.
3. `loadProjectForCaller` → returns the project.
4. `assertWithinProjectWindow`: if the project's `end_date` is `'2026-12-31'` and the sprint's `end_date` is `'2027-01-15'` → throws **422 `SPRINT_DATE_INVALID`**.

If the project is open-ended (`project.end_date = null`), the same body succeeds.

### Archive a sprint then delete it

1. Admin POSTs `/api/v1/sprints/:id/archive` → `is_archived: true`, audit `SPRINT_ARCHIVE`.
2. Some time later DELETE `/api/v1/sprints/:id`. The service sees `is_archived = true` and **skips the task-count check** — the delete proceeds even though 12 tasks still reference the sprint.
3. Audit `SPRINT_DELETE`.

### Read the story board for a project

1. `GET /api/v1/projects/:project_id/stories?limit=50`.
2. `Story.find({project_id})` + `Story.countDocuments(...)` run in parallel.
3. Stories are page-sliced (sort `position:1`, then `created_at:1`).
4. `aggregateStoryDerivedRows(projectId, [...storyIds], [...terminalKeys])` — one round-trip rolls up task counts, sprint ids, and terminal-status counts per story.
5. Each story's `derived_status` is evaluated via the rule cascade; `progress_percent` is computed from `done_count / task_count`.
6. If `?status=in_progress` was supplied, the response is filtered AFTER derivation; `meta.total` reflects the pre-filter count.

### Reorder a story past the bottom of the list

1. `POST /api/v1/stories/:id/reorder` with `{position: 999}` in a project with 5 stories.
2. `reorderInternal`: `maxPos = 4`. `newPos = clamp(999, 0, 4) = 4`.
3. If `oldPos === 4`, no-op. Otherwise the neighbours shift and the story lands at position 4.
4. Audit `STORY_REORDER`.

### Delete a story that has 47 tasks

1. `DELETE /api/v1/stories/:id`.
2. `detachStoryFromTasks` runs phase 1 — `find({story_id})` → 47 ids returned.
3. Phase 2 — `updateMany({story_id}, {$set: {story_id: null}})` → 47 modifications.
4. `story.deleteOne()`.
5. `updateMany({project_id, position: {$gt: oldPos}}, {$inc: {position: -1}})` — gap closed.
6. Response: `{deleted: true, unset_task_ids: [47 ids]}`.

### Create a top-level task

1. POST `/api/v1/tasks` with `{project_id, title, due_date, …}`.
2. `requireWriter` → `loadProjectForCaller` → `assertValidStatus` → sprint/story/parent/assignee/collaborator/dependency validations → `nextPositionInColumn` → `Task.create({...})`.
3. Audit `TASK_CREATE`, activity `created`.

### Create a subtask

Same as above with `parent_task_id`. `assertParentTaskUsable` enforces same-project and depth ≤ 1. After create, a second activity row `subtask_added` is written on the parent.

### Employee changes own task status

1. Employee PATCHes `/api/v1/tasks/:id` with `{status: 'in_progress'}`.
2. Service: `loadTaskAndProject` → `assertEmployeePatchScope` — caller is creator OR assignee AND the only patch field is in `TASK_EMPLOYEE_PATCH_FIELDS`.
3. `assertValidStatus`; task moves to end of destination column via `nextPositionInColumn`.
4. `task.save()` → audit `TASK_UPDATE` → `emitPatchActivities` writes `status_changed` only.

### Drag a card to a different Kanban column

1. POST `/api/v1/tasks/:id/reorder` with `{position: 3, status: 'in_progress'}`.
2. Service narrows to admin/manager/team_lead OR `primary_assignee_id`.
3. Cross-column move: `assertValidStatus`; save with `position = nextPositionInColumn(...)` in new column; close gap in source column; `shiftNeighboursInColumn(task, 3)`.
4. Audit `TASK_REORDER`; activity `status_changed`.

### Add a dependency that would create a cycle

1. POST `/api/v1/tasks/A/dependencies` with `{depends_on_task_id: B}` where B already (transitively) depends on A.
2. `wouldCreateCycle(A, B)` BFS forward → returns `true`.
3. Throw **422 `TASK_DEPENDENCY_CIRCULAR`**.

### Post a comment that mentions an outside user

1. POST `/api/v1/tasks/:task_id/comments` with `body` and `mentioned_user_ids: [U, X]` where X isn't on the project.
2. `loadTaskAndProject` checks visibility.
3. `sanitiseCommentBody` cleans the body (HTML tags stripped, markdown kept).
4. `assertMentionsBelongToProject` returns **422 `MENTION_NOT_PROJECT_MEMBER`** with `{invalid_user_ids: [X]}`. The comment is NOT created.

### Upload a file (happy path)

1. FE: POST `/tasks/:task_id/attachments/upload-url`. BE validates size + MIME; mints SAS; returns `{upload_url, blob_container, blob_key, ...}`.
2. FE: PUT the file bytes to `upload_url` with the exact `required_headers`. Azure validates the SAS + content-type.
3. FE: POST `/tasks/:task_id/attachments/finalize`. BE re-validates policy, validates blob-key path prefix, HEADs the blob to confirm presence + size match, creates the row.
4. Audit `ATTACHMENT_CREATE`; activity `attachment_added`.

### Recurring task fires today

1. Cron `recurring_task_sweep` runs at 06:00 IST.
2. Service finds all `{recurrence.enabled: true, is_archived: false}` templates (capped per tick).
3. For each: window check → already-today check → schedule fires today → `materialiseTaskFromTemplate({}, system caller)` → `findOneAndUpdate` CAS to stamp `last_generated_at` → `recordSystemAudit(TASK_TEMPLATE_RECURRENCE_RUN)`.
4. The instantiated task goes through `task.service.createTask`, so it gets a `TASK_CREATE` audit + `created` activity row of its own.

### Admin creates a project share link for a client

1. Admin clicks "Create share link" on a project detail page → fills `owner_client_id: <client>`, leaves `expires_at` blank.
2. `POST /projects/:project_id/share-links {owner_client_id, expires_at: null}`.
3. Service: `ensureProjectExists` + `ensureClientExists` (client must be `role: 'client'`, `status: 'active'`).
4. `generateToken()` → 43-char base64url. `sha256Hex(token)` → 64-char hex.
5. `ProjectShareLink.create({token_hash, token: null, owner_client_id, created_by, expires_at: null, ...})`.
6. Audit `share_link.create` with `{project_id, owner_client_id, has_expiry: false}`.
7. **Response** `{...row-without-token-fields, token: '<raw>'}`. Admin's dialog shows the URL and offers a copy button.

### Client visits the shared URL (public, no auth)

1. URL is `${APP_BASE_URL}/share/<token>`. FE viewer calls `GET /share-links/resolve/<token>`.
2. BE: `findOne({token_hash: sha256Hex(token)})` → live link → bump `last_accessed_at`.
3. Project loaded (member_ids/client_ids/created_by stripped). Sprints + Stories + Tasks fetched with `limit+1`.
4. Response `{project, sprints, stories, tasks, last_accessed_at}`. FE renders a read-only project view.

### Client deactivation cascades

1. Admin deactivates client User U. `user.service.deactivateUser` runs.
2. Inside the deactivation flow, `revokeLinksForDeactivatedClient({client_id: U._id, revoked_by: admin._id, audit})` fires.
3. Service finds every open link with `owner_client_id: U._id`. For each, `revokeOne(link, admin._id, 'client_deactivated', audit)`.
4. Aggregate returns `{revoked_count: 3}`.
5. A client trying to access a previously-shared URL → 410 `SHARE_LINK_REVOKED`. The 410 body does NOT echo `revoke_reason`.

### Manager views the Gantt timeline

1. `GET /projects/:id/timeline?from_date=2026-06-01&to_date=2026-08-31`.
2. BE: `loadProjectForCaller(projectId, manager)` → admin/manager scope passes → project loaded.
3. Sprints query: 3 sprints overlap the window.
4. Tasks query: `due_date >= 2026-06-01, status !== DONE` (default). 287 candidates returned.
5. JS-side derivation: each task's `start_date = sprintsById.get(t.sprint_id)?.start_date ?? toIstDate(t.created_at)`. Filter `start_date <= 2026-08-31`. 281 tasks survive.
6. Response: `{project, sprints: [3], tasks: [281], truncated: false}`.

---

# Audit actions produced

| Action | When |
|---|---|
| `PROJECT_CREATE` / `_UPDATE` / `_ARCHIVE` | Project CRUD (`_ARCHIVE` for hard-delete; soft archive is `_UPDATE` with `{is_archived: true}` in diff) |
| `PROJECT_MEMBERS_UPDATE` / `_CLIENTS_UPDATE` | Roster bulk add/remove |
| `PROJECT_CUSTOM_STATUS_CREATE` / `_UPDATE` / `_DELETE` | Custom status CRUD |
| `PROJECT_DEFAULT_STATUS_ORDERS_UPDATE` | Default status reorder |
| `SPRINT_CREATE` / `_UPDATE` / `_DELETE` / `_ARCHIVE` / `_UNARCHIVE` | Sprint lifecycle (carries `metadata: {project_id}`) |
| `STORY_CREATE` / `_UPDATE` / `_DELETE` / `_REORDER` | Story lifecycle (delete writes `unset_task_ids` + `detached_count`) |
| `TASK_CREATE` | Task creation (manual or template-instantiated) |
| `TASK_UPDATE` | PATCH /tasks/:id |
| `TASK_DELETE` | DELETE /tasks/:id |
| `TASK_REORDER` | POST /tasks/:id/reorder |
| `TASK_ASSIGN_STORY` | POST /tasks/:id/assign-story |
| `TASK_MOVE_SPRINT` | POST /tasks/:id/move-sprint |
| `TASK_DEPENDENCY_ADD` / `_REMOVE` | Dependency edges |
| `COMMENT_CREATE` / `_UPDATE` / `_DELETE` | Comment CRUD |
| `ATTACHMENT_CREATE` / `_DELETE` | Attachment finalize + delete (mint upload URL is NOT audited — no DB row yet) |
| `TASK_TEMPLATE_CREATE` / `_UPDATE` / `_DELETE` / `_INSTANTIATE` | Template CRUD + manual instantiate |
| `TASK_TEMPLATE_RECURRENCE_RUN` | Cron-driven instantiation (system audit) |
| `SHARE_LINK_CREATE` | `POST /:project_id/share-links` (token + token_hash stripped) |
| `SHARE_LINK_REVOKE` | Manual revoke OR cascade (metadata `reason: 'manual' \| 'client_deactivated'`) |

Timeline NEVER audits — read-only.

---

# Error codes produced

| Code | HTTP | When |
|---|---|---|
| `PROJECT_NOT_FOUND` | 404 | `findById` miss |
| `PROJECT_CODE_TAKEN` | 409 | `POST /projects` with duplicate code (E11000) |
| `PROJECT_DATE_INVALID` | 422 | PATCH that would make `end_date < start_date` |
| `PROJECT_MEMBER_NOT_FOUND` | 404 | `DELETE /projects/:id/members/:user_id` when not on roster |
| `PROJECT_CLIENT_NOT_FOUND` | 404 | `DELETE /projects/:id/clients/:user_id` when not on roster |
| `INVALID_PROJECT_MEMBER_ROLE` | 422 | Member add candidate isn't an active internal user |
| `INVALID_PROJECT_CLIENT_ROLE` | 422 | Client add candidate isn't an active `role=client` user OR `owner_client_id` on share link references non-client / non-active |
| `CUSTOM_STATUS_NOT_FOUND` | 404 | PATCH / DELETE of a custom-status sub-doc that doesn't exist |
| `CUSTOM_STATUS_KEY_TAKEN` | 409 | Duplicate key within the same project |
| `RESOURCE_HAS_DEPENDENTS` | 409 | Hard-delete project / sprint / custom-status with dependants |
| `FORBIDDEN` | 403 | `assertCallerCanRead` failed |
| `SPRINT_NOT_FOUND` | 404 | `findById` miss |
| `SPRINT_DATE_INVALID` | 422 | `end_date < start_date` OR window outside project window |
| `STORY_NOT_FOUND` | 404 | `findById` miss |
| `STORY_WRITE_FORBIDDEN` | 403 | Service-layer narrowing (story.write or assign-story by non-writer) |
| `STORY_PROJECT_MISMATCH` | 422 | A task tries to attach to a story in a different project |
| `TASK_NOT_FOUND` | 404 | `findById` miss |
| `TASK_INVALID_STATUS` | 422 | Status not in (defaults ∪ project customs) |
| `TASK_INVALID_ASSIGNEE` | 422 | Assignee isn't an active internal user |
| `TASK_INVALID_COLLABORATOR` | 422 | Same for a collaborator id |
| `TASK_SPRINT_PROJECT_MISMATCH` | 422 | Sprint belongs to a different project |
| `TASK_PARENT_NOT_FOUND` | 422 | Parent task missing |
| `TASK_PARENT_PROJECT_MISMATCH` | 422 | Parent is in a different project |
| `TASK_SUBTASK_DEPTH_EXCEEDED` | 422 | Parent is already a subtask (depth > 1) |
| `TASK_DEPENDENCY_SELF` | 422 | Self-dependency |
| `TASK_DEPENDENCY_EXISTS` | 409 | Duplicate dep OR cap reached |
| `TASK_DEPENDENCY_NOT_FOUND` | 404 | Removing a non-existent edge |
| `TASK_DEPENDENCY_PROJECT_MISMATCH` | 422 | Dep is in a different project |
| `TASK_DEPENDENCY_CIRCULAR` | 422 | Would form a cycle |
| `TASK_WRITE_FORBIDDEN` | 403 | Service-layer role narrowing failure |
| `COMMENT_NOT_FOUND` | 404 | Comment missing or soft-deleted |
| `COMMENT_EDIT_FORBIDDEN` | 403 | PATCH by a non-author |
| `COMMENT_DELETE_FORBIDDEN` | 403 | Delete by a non-author and non-moderator |
| `MENTION_NOT_PROJECT_MEMBER` | 422 | Mentioned user is not in the project |
| `ATTACHMENT_NOT_FOUND` | 404 | Attachment missing or soft-deleted |
| `ATTACHMENT_BLOB_KEY_MISMATCH` | 422 | Finalize path doesn't match task / uploader / container |
| `ATTACHMENT_BLOB_MISSING` | 422 | No uploaded blob exists for the supplied key |
| `ATTACHMENT_SIZE_MISMATCH` | 422 | Azure size != claimed size |
| `ATTACHMENT_DELETE_FORBIDDEN` | 403 | Delete by non-uploader, non-moderator |
| `FILE_TOO_LARGE` | 422 | Exceeds `system_settings.uploads.max_file_size_mb` |
| `FILE_TYPE_NOT_ALLOWED` | 422 | MIME not in policy allowlist |
| `STORAGE_NOT_CONFIGURED` | 503 | Azure isn't wired |
| `DUPLICATE_RESOURCE` | 409 | Re-finalize with the same blob_key |
| `TASK_TEMPLATE_NOT_FOUND` | 404 | Template missing OR archived (on instantiate) |
| `SHARE_LINK_NOT_FOUND` | 404 | Unknown id (admin path) OR unknown token (public path) OR project deleted while link existed |
| `SHARE_LINK_REVOKED` | 410 | `revoked_at !== null` on resolve |
| `SHARE_LINK_EXPIRED` | 410 | `expires_at <= now` on resolve |
| `VALIDATION_ERROR` | 400 | `expires_at <= now` on share link create; bad token format on resolve; strict-mode unknown keys |

---

# Gotchas

## Projects

| # | Behaviour | Why |
|---|---|---|
| 1 | A Team Lead creating a project is **auto-added to `member_ids`** even if they didn't include themselves | BUG-007 — their visibility filter is `member_ids ∋ caller.id`, so otherwise they'd lose access to the project they just made |
| 2 | PATCH doesn't accept `member_ids` / `client_ids` / `custom_task_statuses` | Whole-set replacement would silently truncate a large roster if the FE forgot to send it; use the dedicated bulk endpoints |
| 3 | Member/client bulk add/remove is **idempotent** | Re-running the same `{add, remove}` converges; the FE doesn't need to inspect current state |
| 4 | Bulk endpoint validates only **truly new** add candidates | A stale role change on an existing roster member doesn't make the call fail |
| 5 | Bulk endpoint uses two separate `updateOne` calls inside `withTransaction` | F4 — Mongo refuses overlapping path operators in one update, but two sequential atomic updates with `$pull` + `$addToSet` are race-safe at the row level |
| 6 | `DELETE /projects/:id` refuses if any Task / Story / Sprint exists | R3 — admin must archive or reassign dependants first |
| 7 | `DELETE /project-custom-statuses/:id` refuses if any Task references it | R3 — PATCH each affected task onto another status first |
| 8 | Custom status sub-doc has its own `_id`; URL uses the `_id`, not the `key` | Lets `key` be renamed without breaking deep links |
| 9 | Client `role=client` users must be granted access via the **client roster**, not the member roster | `validateClientCandidates` requires `role=client`; `validateMemberCandidates` rejects `role=client` |
| 10 | The four built-in statuses are **implicit**, not stored in `custom_task_statuses[]` | They're in `default_status_orders[]` (order + visibility only); the keys themselves are constants |
| 11 | `default_status_orders[]` is **always exactly four entries** | Model + validator both enforce; replaced atomically on reorder |
| 12 | Project `code` is **uppercased on write** | Both Zod (`transform`) and the model (`uppercase: true`) — case-insensitive de-facto uniqueness |
| 13 | Search `q` requires ≥ 2 chars | R15 — prevents `?q=a` full-collection regex scans |

## Sprints

| # | Behaviour | Why |
|---|---|---|
| 14 | Sprint status transitions are **NOT enforced** (any → any allowed) | Data_Model leaves this open intentionally |
| 15 | Sprint window must fit within project window **only when the project has an `end_date`** | Open-ended projects allow open-ended sprints |
| 16 | Sprint list **defaults to `is_archived: false`** when the param is absent (F1) | Default-active contract |
| 17 | Sprint delete **refuses when not archived AND tasks reference it** (R3) | Archive is the operator's escape hatch |
| 18 | Archived sprint can be deleted even with lingering tasks | The archive flag is the explicit acknowledgement; orphaned tasks keep their `sprint_id` until manually moved |
| 19 | Sprint archive / unarchive are **idempotent** | Re-archiving is a no-op success |

## Stories

| # | Behaviour | Why |
|---|---|---|
| 20 | Stories carry **no `sprint_id`** | Tasks carry the sprint link; story → sprint membership is derived from `sprint_ids[]` in the rollup |
| 21 | Story `derived_status` is **computed every read**, never persisted | Avoids the reconciliation treadmill on every task write |
| 22 | Story derived rule order: **blocked > in_progress > done** | A story with one `blocked` task + all-else-`done` shows as `blocked` |
| 23 | Story custom statuses **don't exist** — only task customs do | Story derived status is a fixed 5-value enum |
| 24 | `$addToSet sprint_ids` filters nulls via `$project` | Backlog tasks (`sprint_id = null`) don't surface as a phantom sprint id |
| 25 | Story positions are **not unique** by design | Equal-position rows tiebreak on `created_at` on the FE |
| 26 | Story reorder **clamps newPos to `[0, maxPos]`** | A caller asking for position 999 in a 5-story project lands at the bottom |
| 27 | Story delete is **two-phase (find → update)** | Keeps the audit accurate even if a concurrent writer touches the same task between phases |
| 28 | Story delete returns **`unset_task_ids[]`** | FE can refresh the now-orphaned task cache without a separate fetch |
| 29 | `GET /stories/:id` task list is **capped at 500** | Story board can't render thousands; for paginated reads use `GET /stories/:id/tasks` |
| 30 | `GET /stories/:id/tasks` uses DB-level pagination (M11) | Pre-M11 it materialised every row into Node for an in-memory slice |
| 31 | List `?status=` filter applies **after** server-side derivation | The client doesn't know which custom task statuses count as "blocked" |
| 32 | `meta.total` on filtered story list reflects **pre-filter** count | Filter-aware pagination would need a second pass; not worth the cost at Phase-1 scale |
| 33 | H2 — service re-checks role via `isProjectAuthor` even though route gates the perm | Pre-H2 the service compared role-string against admin/manager only, 403'ing Team Leads |

## Tasks

| # | Behaviour | Why |
|---|---|---|
| 34 | `status` is a **free string** (no Mongoose enum); validity comes from `(defaults ∪ project.custom_task_statuses)` and is re-derived per write | The valid set is per-project, which Mongoose static enums can't model |
| 35 | `due_date` is a **string `YYYY-MM-DD`**, not a `Date` | Avoids UTC drift on local-calendar comparisons; strings are lexicographically sortable |
| 36 | **Done tasks can't have a future due_date** (BUG-041) | The Zod refine fires when both `status` and `due_date` are present in the payload — patch with only one of them silently skips the check |
| 37 | **Subtask depth = 1** — a subtask cannot itself be a parent | Keeps the activity feed + UI simple; enforced via `TASK_MAX_SUBTASK_DEPTH` |
| 38 | On task delete, subtasks are **detached** (`parent_task_id = null`), not cascade-deleted | Same policy as story → tasks; preserves history |
| 39 | On task delete, the task is **stripped from peers' `depends_on_task_ids`** via `$pull` | Prevents dangling references on the dependency graph |
| 40 | Status changes always move the task to the **END** of the destination column | Avoids collisions with existing rows |
| 41 | Pure intra-column reorders emit **no activity row** | Position carries no semantic meaning the feed should narrate |
| 42 | Title and description changes **don't emit activity rows** | The spec enum has no matching type; "title changed" rows are noisy on the feed |
| 43 | `assign-story` by a non-writer returns `STORY_WRITE_FORBIDDEN`, not `TASK_WRITE_FORBIDDEN` | Per API_Contract §8.2a — story membership is semantically a story-write op |
| 44 | `?story_id=null` and `?parent_task_id=null` are **literal-string sentinels** | Query strings can't carry `null`; the literal lets the FE filter for "no story" / "top-level" |
| 45 | List endpoint scopes to **visible projects** (capped at 1,000) when `project_id` is absent | Resolves project visibility once, then a single `$in` on tasks |
| 46 | **Task save is intentionally NOT wrapped in `withTransaction`** even though it writes audit + activity rows | `recordAudit` + `recordActivity` are both never-throw; wrapping would change "task always saves; trail eventually consistent" to "task fails if the activity collection hiccups" |

## Comments

| # | Behaviour | Why |
|---|---|---|
| 47 | Comment **edit is author-only** (admin/manager cannot rewrite words) | Matches Slack/GitHub authorship model — moderators can delete, not rewrite |
| 48 | Comment delete is **soft** (`deleted_at`); the row stays so the activity feed can render the tombstone | Audit log keeps the original body for the regulatory trail |
| 49 | Comment notification: mentions OR assignees, **never both** | BUG-068 — if the comment has mentions, only mentioned users get notified; otherwise primary assignee + collaborators get a quiet in-app ping |
| 50 | **Re-saved mention lists don't re-notify** on comment edit | Only newly-introduced mentions trigger fan-out (delta vs. previous list) |
| 51 | If sanitisation reduces body to whitespace, throws `VALIDATION_ERROR` | Empty body after `<script>` strip would otherwise persist as `""` |

## Attachments

| # | Behaviour | Why |
|---|---|---|
| 52 | Attachment SAS pins `Content-Type` into the SAS | A `.png` upload can't be served back as `text/html`; the FE MUST send the exact `Content-Type` from `required_headers` |
| 53 | Attachment blob key is `tasks/{task_id}/users/{uploader_id}/{ulid}-{safe_name}` | The uploader segment defends against the "race to finalize someone else's pending upload" attack |
| 54 | Attachment finalize **HEADs the blob** to verify presence + size | Catches metadata-only spoofs and "claimed 1 MiB, uploaded 100 MiB" mismatches |
| 55 | Attachment delete is **best-effort on the blob** but always succeeds at the row level | A transient Azure failure shouldn't flip the user's success signal; row is already soft-deleted |

## Templates

| # | Behaviour | Why |
|---|---|---|
| 56 | Templates **silently drop stale references** at instantiation (with a `warn` log) | A single stale reference shouldn't hard-fail a recurring task; operator can investigate from logs |
| 57 | Recurring sweep uses a **CAS** on `last_generated_at` to stamp idempotently | Defends against concurrent ticks firing the same template twice; the duplicate is logged for cleanup |
| 58 | `recordAudit` and `recordActivity` **never throw** | Primary write always succeeds; trail is best-effort |

## Share Links

| # | Behaviour | Why |
|---|---|---|
| 59 | Resolve endpoint is **public — no `authenticate` middleware**. Token IS the credential | Per-IP rate limiter is the brute-force defence; 256 bits of entropy makes it impractical anyway |
| 60 | C9 — token hashed at rest (`token_hash: sha256Hex(token)`); raw token returned ONCE on create | Pre-C9 a DB exposure leaked live access; post-C9 only the hash is in Mongo |
| 61 | C9 boot migration walks legacy plaintext rows + hashes them in-place | Idempotent (token: null post-migration); never throws |
| 62 | Legacy `token` column kept as nullable transitional field | To be removed once every deployment has booted with the migration once |
| 63 | `toPublic(doc)` strips `token` AND `token_hash` from JSON | Wire-shape never exposes either form |
| 64 | `audit_logs` rows for `share_link.create` carry `toPublic` shape (no token, no hash) | Audit UI can't be used to extract the credential |
| 65 | Revoke is idempotent — re-revoking returns unchanged row | Double-click safe; doesn't shift the "when did it stop" audit boundary |
| 66 | Generic share (no `owner_client_id`) — only admin revoke can disable | Client-deactivation cascade has no subject to match against |
| 67 | 410 GONE on revoked/expired (distinct from 404 unknown) | Caller had a previously-valid reference; deliberate distinction |
| 68 | Public 410 body does NOT echo `revoke_reason` | Literal `client_deactivated` would leak account-state to a token holder |
| 69 | H4 — `active_only` query param uses `booleanish`, not `z.coerce.boolean()` | `Boolean("false")` is truthy; `booleanish` accepts `"true"/"false"/boolean` and fails loud |
| 70 | Token retry loop max 5 attempts (paranoia ceiling) | 256 bits ≈ 1e-65 collision probability against 1M links |
| 71 | H19 — public payload caps: 50 sprints, 100 stories, 1000 tasks | Unbounded `.find` on a large project = multi-MB DOS amplification per anonymous request |
| 72 | H19 — `limit+1` pattern detects truncation without `countDocuments` | Saves a round-trip; `truncated: {sprints?, stories?, tasks?}` surfaces it |
| 73 | Field projections strip `member_ids`/`client_ids`/`created_by`/`updated_by`/`collaborator_ids` from public payload | Enumeration vectors; authed users get them via `/projects/:id` |
| 74 | `primary_assignee_id` KEPT (per-task ObjectId, not a bulk list) | FE renders an avatar tile |
| 75 | `last_accessed_at` is a SINGLE timestamp, NOT an event log | v1; future `share_link_accesses` collection if per-visit auditing is needed |
| 76 | Client-deactivation cascade: each revoke is independently audited (one row per link) | Step-31 audit UI correlates to parent user.deactivate by `revoked_by` + timestamp |
| 77 | `revoked_by` on cascade = the deactivating admin, NOT the client | Audit points at the human who triggered |
| 78 | Cascade NEVER throws | A failure mid-cascade still leaves the user deactivated; failures log under `SHARE_LINK_AUTO_REVOKE_FAILED` |
| 79 | `ensureClientExists` requires `role: 'client' AND status: 'active'` | Can't share with a deactivated or non-client user |

## Timeline

| # | Behaviour | Why |
|---|---|---|
| 80 | Timeline endpoint mounted as nested under `/projects/:project_id/timeline` | Mirrors share-link nested pattern; matches data hierarchy |
| 81 | Timeline derived `start_date` per task: sprint.start_date → task.created_at fallback | v1 — no schema migration for an explicit `start_date` column |
| 82 | Timeline two-stage overlap filter (DB on `due_date`; JS on derived `start_date`) | DB filter index-friendly; JS filter needs the join with sprints |
| 83 | Timeline `include_completed: false` default excludes `status: DONE` | Typical Gantt view; FE flips on for retro view |
| 84 | Timeline `TIMELINE_RANGE_MAX_DAYS = 365` + `TIMELINE_TASK_CAP = 2_000` | Both bound payload size; `truncated: true` flag surfaces the cap hit |
| 85 | Timeline NO pagination | Gantt renders everything in the window; date-range cap is the size limiter |
| 86 | Timeline `loadProjectForCaller` enforces per-caller scoping | Admin/manager: all; employee: member_of; client: client_of; 404 on cross-project |
| 87 | Timeline NEVER audits | Read-only |
| 88 | Timeline sort: `{position: 1, created_at: 1}` | Position is the explicit Kanban order; created_at is the deterministic tiebreaker |

## Cross-cutting

| # | Behaviour | Why |
|---|---|---|
| 89 | Text index exists on `name, code, description` for projects + sprints + stories + tasks but is **unused today** | Step-32 migration target; current list uses regex |
| 90 | Pagination uses `skip + limit`, not a cursor | Acceptable while total project / task counts are bounded |
| 91 | `comments-tab.tsx` exists on the FE but is **dead code** | Live comment UI is inline `CommentComposer` in `task-detail-view.tsx`. See the FE module doc |
