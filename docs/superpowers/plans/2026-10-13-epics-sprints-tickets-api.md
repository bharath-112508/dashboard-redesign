# Epics, sprints and tickets from the API (Phase 1b-2, part 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In API mode, the Tickets board, Backlog, List, Overview, Epics & sprints, Timeline, My tickets, the Clients board and the Dashboard ticket widgets show and change real Demo DB epics, sprints and tickets (including subtasks) through the backend.

**Architecture:** Same pattern as companies (`src/api/http/companies.ts`): in API mode `server.get('workspace' | 'tasks')` and `server.send(<task/epic/sprint commands>)` go to a new adapter `src/api/http/board.ts`; every page and the optimistic reducer stay as they are. One loader reads projects, stories (epics), sprints, custom statuses and tasks for the signed-in person and builds both the `Workspace` and the `Task[]`, so the two stay consistent. The backend gains a few additive fields so nothing the screens edit is thrown away. Task ids become strings in the app (as person ids did) because backend ids are ObjectIds.

**Tech Stack:** React 19, TypeScript, TanStack Query 5, Vitest 4. Backend: Express 5, Mongoose 9, Zod, Vitest.

**Spec:** decisions in the conversation and memory (`backend-integration-plan`, `no-ui-changes`, `api-branch-separate`); the user approved on 13 Oct 2026: add priorities Critical and Urgent to the backend; add issue type Story (keep Improvement); subtasks are the backend's linked tasks, shown as the design's checklist lines.

## Global Constraints

- Branch `feat/api-sign-in`; never merge into `feat/webapp-v4`.
- No visual UI change in `app/` unless listed in this plan.
- Mock mode (no `VITE_API_URL`) behaves exactly as before: unit tests green; e2e baseline `308 passed / 2 failed (DO-18, DO-19) / 3 skipped`.
- Shared Demo DB: backend changes are additive (new optional fields, new enum values); never rewrite existing documents.
- Backend with `npm run dev:redesign` (port 3101); app with `npm run dev:api` (port 5200).
- Value mappings (app ↔ backend):
  - priority: `Critical`↔`critical`, `Urgent`↔`urgent`, `High`↔`high`, `Medium`↔`medium`, `Low`↔`low`
  - type: `Bug`↔`bug`, `Task`↔`task`, `Story`↔`story`; backend `improvement` reads as `Story` and is never written back unless the type is changed
  - status: `todo`↔`to_do`, `prog`↔`in_progress`, `review`↔`review`, `done`↔`done`; backend `bug` reads as `todo`; a project's custom status `key` is the app status id
  - sprint state: `planned`↔`planned`, `active`↔`active`, `done`↔`completed`
  - `est` `'6h'`↔`estimated_hours: 6`; `due`/`start` `''`↔`null`
- Tasks keep people by name in this part (`assignee`, `assignees`, `contribs`, `members`): the adapter maps backend user ids to directory names and back. (Ids-not-names is a later change.)
- Ticket keys come from the backend: `subKey = '<PROJECT CODE>-<task_number>'`.

## Decisions taken in this plan (for review)

1. **Employees edit tickets like in the design.** Today the backend lets an employee change only status, description, estimate, assignees and flag on a ticket, and not move it between sprints or epics; the redesign lets developers do that on projects they work on. Part of Task 3 widens the employee rule to: on tasks of a project they are a member of, also `title`, `priority`, `due_date`, `start_date`, `issue_type`, `labels`, `sprint_id`, `story_id`, and the move-sprint / assign-story routes. Clients keep their narrow rule.
2. **A sprint belongs to an epic** through a new optional `story_id`. Sprints created before this have none: the app shows such a sprint under every epic that has tasks in it (same sprint, one entry per epic, id `<sprintId>~<storyId>`); writes go to the real sprint.
3. **Tasks without an epic** are shown in a per-project epic named "No epic" (id `none~<projectId>`). Moving a task there clears its `story_id`.
4. **A new epic** is created in the project open on the Clients page (`?project=`), otherwise the project of the epic currently selected in the epic bar, otherwise the first project the person can see.
5. **Backend `bug` status** (one Demo DB task) reads as To do; it is not written back unless the status changes.
6. **Comments, history and attachments in the ticket drawer** stay empty in this part (part 2 wires them). Sending a comment in API mode is refused with "Comments come with the next update." so nothing is silently lost.
7. **Hours per ticket** (`time`) stay empty until the timesheets slice.

## Review Focus

1. **Dragging a card to another column** (status change) by a developer who is the assignee → saved; by a developer who is not → backend 403 → card snaps back with the refusal message. Test in Task 7.
2. **A legacy sprint shown under two epics** → editing it (dates, goal) from either epic changes the one real sprint, and both entries update. Test in Task 6.
3. **Creating a ticket from the board** → it appears with its real key (e.g. `AFSP-24`) and the drawer opens on the backend id, not a temporary one. Test in Task 7.
4. **A client user** → only sees tickets of their own company's projects; they never call staff-only endpoints. Test in Task 6.
5. **Saved browser data from version 5** (numeric task ids) → upgraded to string ids without losing tickets, time entries or questions. Test in Task 4.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `backend/src/constants/task.ts`, `validators/task.validator.ts`, `models/task.model.ts` (+ tests) | priorities critical/urgent, issue type story, task `start_date` (Task 1) |
| `backend/src/models/sprint.model.ts`, `validators/sprint.validator.ts`, `services/sprint.service.ts`, `services/share-link.service.ts` (+ tests) | sprint `story_id`, `member_ids`, `goals`, `goals_done`, `summary`, `why` (Task 2) |
| `backend/src/models/story.model.ts`, `validators/story.validator.ts`, `services/story.service.ts` (+ tests) | epic document fields on stories (Task 2) |
| `backend/src/services/task.service.ts`, `constants/task.ts` (+ tests) | employee edit rule on member projects (Task 3) |
| `app/src/api/types.ts` and every file `tsc` flags | `TaskId = string` (Task 4) |
| `app/src/api/server.ts`, `app/src/api/seed.ts` | DB_VERSION 6 migration of task ids (Task 4) |
| `app/src/api/http/boardMappers.ts` (+ test) | backend task/story/sprint/status → app, and app → bodies (Task 5) |
| `app/src/api/http/board.ts` (+ tests) | `loadBoard`, `fetchWorkspace`, `fetchTasks`, `sendBoardCommand` (Tasks 6–7) |
| `app/src/api/server.ts`, `app/src/api/queries.ts` | API-mode delegation for workspace/tasks and board commands (Tasks 6–7) |
| `app/src/features/plan/EpicFormModal.tsx`, `app/src/api/commands.ts` | `epic.create` carries `projectId` (Task 7) |
| `app/README.md` | API mode coverage (Task 8) |

---

### Task 1: Backend — priorities, Story type, task start date

**Files:** `backend/src/constants/task.ts`, `backend/src/models/task.model.ts`, `backend/src/validators/task.validator.ts`, `backend/src/validators/project.validator.ts`; tests `backend/src/validators/task.validator.test.ts`, `backend/src/services/task.service.test.ts`.

**Interfaces:** Produces: `TASK_PRIORITIES` = low, medium, high, urgent, critical; `TASK_ISSUE_TYPES` = task, bug, improvement, story; task JSON gains `start_date: string | null`; POST/PATCH `/tasks` accept `start_date`.

- [ ] **Step 1: Failing tests** — create/patch schemas accept `priority: 'critical'`, `'urgent'`, `issue_type: 'story'`, `start_date: '2026-10-01'` and `start_date: null`; reject `start_date: '01/10/2026'`; a patch with `start_date` after the persisted `due_date` is refused by the service with 422 (same rule as sprint dates). The client report schema still refuses `critical` (clients pick low/medium/high).
- [ ] **Step 2: Run** `npm --prefix backend test -- src/validators/task.validator.test.ts` → FAIL.
- [ ] **Step 3: Implement** — extend the two constant objects (keep order low…critical); `TASK_REPORT_IMPACT_LABEL` gains `urgent: 'Urgent'`, `critical: 'Critical'`; update the comment at `constants/task.ts:45-51` (Story is now an issue type, distinct from the Story entity that the app calls an epic); model `start_date: { type: String, match: ISO_DATE, default: null }`; validators accept it; service checks `start_date <= due_date` on the merged document; report schema uses an explicit `['low','medium','high']` enum; raise `project.validator.ts` quick-filter `priorities` max to 10.
- [ ] **Step 4: Run** task validator + service tests and `npm --prefix backend run type-check` → PASS. Fix the existing tests that pin the old sets (`task.validator.test.ts:123`, `project.validator.test.ts`).
- [ ] **Step 5: Commit** `Backend: Critical and Urgent priorities, Story type, task start date`.

### Task 2: Backend — sprint and epic fields the design edits

**Files:** `backend/src/models/sprint.model.ts`, `validators/sprint.validator.ts`, `services/sprint.service.ts`, `services/share-link.service.ts`; `models/story.model.ts`, `validators/story.validator.ts`, `services/story.service.ts`; tests next to each.

**Interfaces:** Produces:
- Sprint JSON gains `story_id: string | null`, `member_ids: string[]`, `goals: string[]`, `goals_done: number[]` (indexes), `summary: string`, `why: string`; create/patch accept them; `story_id` must be a story of the same project (422 otherwise).
- Story JSON gains `goal`, `user_story`, `criteria: string[]`, `criteria_done: number[]`, `target_date: string | null`, `in_scope: string[]`, `out_scope: string[]`, `requirements: string[]`, `risks: string[]`, `open_questions: string[]`; patch/create accept them.
- The public share-link sprint projection excludes `member_ids`.

- [ ] **Step 1: Failing tests** — sprint create with `story_id` of another project → 422; patch `goals_done: [0, 2]` stored; share-link resolve output has no `member_ids`; story patch stores `criteria` and `target_date`, rejects `target_date: 'soon'`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** — schema fields with empty defaults; Zod: arrays of trimmed strings (max 50 items, 500 chars), `goals_done`/`criteria_done` arrays of non-negative ints; `createSprint`/`updateSprint` copy the new fields (they assign explicitly) and validate `story_id` with the same project check as `task.service` (line ~293); share-link sprint `select` adds `-member_ids`; leave the sprint text index on `goal` unchanged.
- [ ] **Step 4: Run** sprint, story, share-link tests + type-check → PASS.
- [ ] **Step 5: Commit** `Backend: epic link, members and goals on sprints; epic document fields on stories`.

### Task 3: Backend — developers edit tickets of their projects

**Files:** `backend/src/services/task.service.ts` (`assertEmployeePatchScope`, move-sprint, assign-story), `backend/src/constants/task.ts`; test `backend/src/services/task.service.test.ts`.

**Interfaces:** Produces: an employee who is a member of the task's project may PATCH `title, priority, due_date, start_date, issue_type, labels, sprint_id, story_id` (plus today's fields) and call move-sprint / assign-story; non-members unchanged; clients unchanged.

- [ ] **Step 1: Failing tests** — employee member (not creator, not assignee) PATCH `{ sprint_id }` → allowed; same employee, project where they are not a member → 403; client PATCH `{ sprint_id }` → still 403; employee member assign-story → allowed.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** with a `TASK_MEMBER_PATCH_FIELDS` constant and a member check via the already-loaded project (`project.member_ids`). **Step 4: Run** task service tests + full backend suite (known failures only). **Step 5: Commit** `Backend: project members may plan and edit their project's tickets`.

### Task 4: App — task ids become strings (DB version 6)

**Files:** `app/src/api/types.ts` (`export type TaskId = string`; `Task.id`, `Task.deps`, `Task.parent`, `Subtask.sid`, `TimeEntry.task`, `Question.task`, `DevopsRequest` task refs), `app/src/domain/tasks.ts` (`nextTaskId` → string, `ticketIdFromParam` → string, `taskKey`), `app/src/api/server.ts` (`stringTaskIds` migration, DB_VERSION 6), every file `npx tsc -b` flags; test `app/src/api/server.migrate.test.ts`.

**Interfaces:** Produces: `TaskId = string`; `nextTaskId(tasks): TaskId` (`String(max numeric + 1)`); `ticketIdFromParam(v: string): TaskId | null` (accepts `'12'`, `'PMT-12'` and any backend id); `stringTaskIds(v: unknown): unknown` (idempotent).

- [ ] **Step 1: Failing test** — `stringTaskIds` turns numeric `tasks[].id`, `deps`, `parent`, `subs[].sid`, `entries[].task`, `questions[].task`, `requests[].task` into strings, leaves strings alone, keeps every other field; a second run changes nothing.
- [ ] **Step 2: Run** → FAIL. **Step 3:** add the migration (chain after `stringPersonIds`), bump `DB_VERSION` to 6, change the types, then fix every `tsc` error at its source: numeric sorts `a.id - b.id` become `a.id.localeCompare(b.id, undefined, { numeric: true })`; `+e.target.value` for task ids becomes the string; the subtask record id `100000 + parent.id*100 + i + 1` becomes `` `${parent.id}.${i + 1}` ``; `'PMT-' + t.id` uses `taskKey(t)`.
- [ ] **Step 4: Run** `npm --prefix app test`, `npx tsc -b`, build, and the full e2e suite in mock mode on port 5174 → same as baseline.
- [ ] **Step 5: Commit** `Use string task ids, as the backend does (DB version 6)`.

### Task 5: App — board mappers

**Files:** create `app/src/api/http/boardMappers.ts`, `app/src/api/http/boardMappers.test.ts`.

**Interfaces:** Consumes `Task`, `Epic`, `Sprint`, `Status`, `Person`, `TaskId`. Produces:
- types `BackendTask`, `BackendStory`, `BackendSprint`, `BackendStatuses` (the `/custom-statuses` body);
- `statusIdFrom(key: string): string`, `statusKeyFrom(id: string): string`, `prioFrom/prioTo`, `typeFrom/typeTo`, `sprintStateFrom/sprintStateTo`;
- `epicFrom(s: BackendStory): Epic`; `noEpicFor(projectId: string): Epic` (id `none~<projectId>`, name "No epic");
- `sprintsFrom(sp: BackendSprint, storyIdsOfItsTasks: string[], names: (id: string) => string): Sprint[]` (one entry, or one per story for a legacy sprint, id `<sprintId>~<storyId>`);
- `taskFrom(t: BackendTask, ctx: { key: string; sprintIdFor: (t) => string | null; epicIdFor: (t) => string; names: (id: string) => string; children: BackendTask[] }): Task`;
- `taskBody(patch: Partial<Task>, ctx: { ids: (name: string) => string | undefined; realSprintId: (appId: string | null) => string | null; storyIdOf: (epicId: string) => string | null }): Record<string, unknown>`;
- `realSprintId(appId: string): string` (strips `~<storyId>`).

- [ ] **Step 1: Failing tests** — every mapping in Global Constraints both ways; `est` `'6h'` ↔ 6 and `''` ↔ 0; a backend task with two children gives `subs` `[{ t, done, sid, due, assignee, note }]` in child order; `clientBug` present (`{ reported: <created date>, chat: [] }`) only for `source: 'client'`; `taskBody` sends only the given fields, maps names to ids (unknown name → left out), `epic: 'none~p1'` → `story_id: null`, sprint `'s1~e2'` → `sprint_id: 's1'`, `sprint: null` → `sprint_id: null`; a legacy sprint with tasks in stories e1 and e2 yields two `Sprint`s `s1~e1`, `s1~e2` with the same name and dates; a sprint with `story_id: 'e1'` yields one `Sprint` with id `s1` and `epic: 'e1'`.
- [ ] **Step 2: Run** `npx vitest run src/api/http/boardMappers.test.ts` → FAIL. **Step 3: Implement** pure functions. Epic palette `p` = `hashOf(id) % 8` (from `mappers.ts`). **Step 4: Run** → PASS, `npx tsc -b` clean. **Step 5: Commit** `Map backend tasks, stories and sprints to the app's board shapes`.

### Task 6: App — read the board through the API

**Files:** create `app/src/api/http/board.ts`, `app/src/api/http/board.test.ts`; modify `app/src/api/server.ts` (`get`).

**Interfaces:** Produces `loadBoard(session: Session | null): Promise<Board>` where `Board = { workspace: Workspace; tasks: Task[]; index: BoardIndex }` and `BoardIndex = { projectOfEpic: Map<string, string>; projectOfTask: Map<TaskId, string>; storyOfEpic: Map<string, string | null> }` (kept in module scope for writes); `fetchWorkspace(session)` and `fetchTasks(session)` both read the same in-flight `loadBoard` promise (one load per refetch round, dropped after it settles).

Reads per visible project (`allPages('/projects')`, non-archived): `/projects/:id/stories`, `/projects/:id/sprints` (non-archived), `/projects/:id/custom-statuses`, `allPages('/tasks?project_id=:id')`; people names from the people directory (`fetchPeople`). Statuses: the default four in app order, then each distinct custom key (label as name, palette by order). `devopsLinks` stays `{}` until the DevOps phase.

- [ ] **Step 1: Failing tests** (mock `api.get`) — workspace epics are the stories plus one "No epic" per project that has tasks without a story; sprints follow decision 2; tasks carry `subKey` `<CODE>-<n>`, their epic and sprint ids as mapped, and subtasks appear both as `parent`-linked tasks and in the parent's `subs`; two parallel calls to `fetchWorkspace` and `fetchTasks` make each backend request once; a client user (`cuser`) gets only what `/projects` returns for them and the loader calls nothing outside `/projects`, `/projects/:id/*` and `/tasks`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement**; in `server.get` add `if (apiMode && resource === 'workspace') return fetchWorkspace(readSession())` and the same for `'tasks'`. **Step 4: Run** app tests, `tsc`, build → PASS. **Step 5: Commit** `Read epics, sprints and tickets through the API in API mode`.

### Task 7: App — write tickets, epics and sprints through the API

**Files:** `app/src/api/http/board.ts` (+ `board.write.test.ts`), `app/src/api/server.ts` (`send`), `app/src/api/queries.ts` (`refuseBeforeSending` skips board commands), `app/src/api/commands.ts` (`epic.create` gains `projectId?: string`), `app/src/features/plan/EpicFormModal.tsx` (passes `projectId`).

**Interfaces:** Produces `isBoardApiCommand(cmd)`, `sendBoardCommand(cmd, today): Promise<{ id?: string }>`.

| Command | Calls |
| --- | --- |
| `task.create` / `tickets.task.createTop` | `POST /tasks` with `project_id` from the task's epic (or "No epic" project), `taskBody(task)`, `status` key; returns `{ id }`; with `top` then `POST /tasks/:id/rank {}` |
| `task.update` | `PATCH /tasks/:id` with `taskBody(patch)` when it has fields; `patch.subs` → diff against the current children: new → `POST /tasks` with `parent_task_id`; changed → `PATCH`; removed → `DELETE` |
| `task.delete` | `DELETE /tasks/:id` |
| `task.comment` | refused: "Comments come with the next update." |
| `sprint.create` | `POST /projects/:projectOfEpic/sprints` with name, dates, goal, `story_id` (unless "No epic"), members, goals; returns `{ id }` |
| `sprint.update` | `PATCH /sprints/:realId`; state changes go through `POST /sprints/:id/start` / `complete {move_unfinished_to: 'backlog'}` |
| `sprint.addMembers` | `PATCH /sprints/:realId { member_ids: union }` |
| `epic.create` | `POST /projects/:projectId/stories` with title, description and the epic document fields; returns `{ id }` |
| `epic.update` | `PATCH /stories/:id` with the mapped fields |
| `batch` | each command in order |

- [ ] **Step 1: Failing tests** — one per row, exact paths and bodies; create returns the backend id; a 403 rejects (server maps it to `RefusedError`); `task.comment` rejects with the message above before any call; sprint `s1~e2` updates `/sprints/s1`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement**; `EpicFormModal` passes `projectId` from `useOpenProject()` (Clients page) or the selected epic's project (`index.projectOfEpic`). **Step 4: Run** app tests, `tsc`, build, e2e mock suite → baseline. **Step 5: Commit** `Write tickets, epics and sprints through the API in API mode`.

### Task 8: Hands-on check and docs

- [ ] **Step 1:** As `admin@viljetech.com` in API mode: the Tickets board shows the real Aurora Foods / Nordmark tickets with real keys; Epics & sprints shows the 7 real epics with their sprints (legacy sprints under each of their epics) and "No epic"; Timeline draws them; My tickets for `rahul@viljetech.com` lists his real tickets.
- [ ] **Step 2:** Create a ticket on the board of the archived-then-restored test company's project ("Redesign Test Portal": restore the company, test, archive again), drag it across columns, give it a Critical priority and a subtask, move it to a new sprint "Redesign test sprint" under a new epic "Redesign test epic"; reload after each step. Read-only DB check: only these test documents were added.
- [ ] **Step 3:** As `lars.bergstrom@aurorafoods.example` (client user): Clients board shows only Aurora Foods tickets; no 403 in the console.
- [ ] **Step 4:** README "API mode" section updated; commit `Document epics, sprints and tickets in API mode`.
