# Companies and projects from the API (Phase 1b-1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In API mode, the Companies page, company details, the Projects page and their dialogs read and write real Demo DB companies, client contacts, Viljetech staff on a company, client projects and internal projects through the backend.

**Architecture:** The app's data layer stays as it is: pages call `useCompanies` / `useInternalProjects` and send commands; the shared reducer still applies each command optimistically to the cache. In API mode `server.get` and `server.send` hand the company and project resources and commands to a new adapter (`src/api/http/companies.ts`), which builds the app's `Company` / `InternalProject` shapes from `GET /companies`, `GET /projects`, `GET /companies/:id/representatives` and `GET /projects/:id/stories`, and turns each command into the matching backend calls. Every other resource and command keeps using the mock. The backend gains a few additive fields so nothing the screens show has to be thrown away.

**Tech Stack:** React 19, TypeScript, TanStack Query 5, Vitest 4. Backend: Express 5, Mongoose 9, Zod, Vitest.

**Spec:** decisions recorded in the conversation and in memory (`backend-integration-plan`, `no-ui-changes`, `api-branch-separate`); Phase 1a plan `docs/superpowers/plans/2026-10-13-real-sign-in.md` for the API-mode conventions.

## Global Constraints

- Work on branch `feat/api-sign-in`; never merge into `feat/webapp-v4`.
- No visual UI change in `app/` (layout, text, styles). Data and behaviour only.
- Mock mode (no `VITE_API_URL`) must behave exactly as before: unit tests green, e2e `308 passed / 2 failed (DO-18, DO-19) / 3 skipped`.
- Shared Demo DB: backend changes are additive; never rewrite or delete existing documents; new fields default to empty.
- Backend runs with `npm run dev:redesign` (port 3101); app in API mode with `npm run dev:api` (port 5200).
- Backend relative imports end in `.js`; every new env var goes through `config/server.config.ts` (none expected here).
- Project state mapping (app ↔ backend `status`): `active`↔`active`, `done`↔`completed`, `hold`↔`on_hold`, `planned`↔`planned` (new), `maint`↔`maintenance` (new).
- Company role mapping (app `CompanyRole` ↔ backend `responsibles[].role`): `Super admin`↔`super_admin`, `Admin`↔`admin`, `Developer`↔`developer`, `Viewer`↔`viewer`.

## Decisions taken in this plan (for review)

1. **A client contact is a backend client user.** Adding a contact creates a `representative` user on that company with a random starting password nobody sees; the person sets their own with "Forgot password". The contact's "admin" flag maps to the backend `client` role (changed with `POST /users/:id/change-role`, admin only). The contact's free-text role ("CTO") is stored in a new optional `client_profile.title` field.
2. **Company profile fields move to the backend:** `industry`, `country`, `website`, `notes`, `logo` (a data URL, at most 200 KB for now), and `archived_at`.
3. **Viljetech staff on a company** (`ourRoles`) become a new `responsibles: [{ user_id, role }]` array on the company.
4. **Projects** gain the statuses `planned` and `maintenance`, an `area` (internal projects), and `support_plan: { until, quota_hours }`. The support plan's "hours used this month" stays 0 until the timesheets slice computes it.
5. **Epic summaries on a project** come from the project's stories (`GET /projects/:id/stories`): name, state from the story's progress, percent done, and sprint count 0 until the tickets slice.
6. Until the tickets slice, the Clients portal and the epic pickers still use the sample epics, so in API mode a real project shows no epics there.

## Review Focus

1. **Creating a company, then opening it** → the page must open the backend's id, not the app's temporary one; no "company not found". Test in Task 6.
2. **A failed write** (validation 400, 403 for a role that may not write, duplicate company name 409) → the optimistic change is rolled back and the command's promise rejects; the page does not keep showing data the backend refused. Test in Task 6.
3. **A client user** (`cadmin`/`cuser`) → `GET /companies` returns only their own company and `GET /projects` only their projects; the adapter must not call staff-only endpoints that would 403 (e.g. listing another company's representatives). Test in Task 5.
4. **Company or project without the new fields** (every existing Demo DB document) → read as empty strings / defaults, never `undefined` in places the UI calls string methods on. Test in Task 4.
5. **Archived companies** → shown as archived (the Companies page has an archived filter), not dropped from the list. Test in Task 5.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `backend/src/models/company.model.ts`, `validators/company.validator.ts`, `services/company.service.ts` (+ test) | company profile fields, `responsibles`, `archived_at` (Task 1) |
| `backend/src/models/user.model.ts`, `validators/company.validator.ts` | `client_profile.title` for contacts (Task 1) |
| `backend/src/constants/project.ts`, `models/project.model.ts`, `validators/project.validator.ts` (+ test) | statuses `planned`/`maintenance`, `area`, `support_plan` (Task 2) |
| `app/src/api/http/companyMappers.ts` (+ test) | backend company / project / story / representative → app `Company`, `ClientProject`, `InternalProject`, `EpicSummary`, `CompanyContact`; and back for writes (Tasks 3–4) |
| `app/src/api/http/companies.ts` (+ test) | `fetchCompanies`, `fetchInternalProjects`, `sendCompanyCommand` (Tasks 5–6) |
| `app/src/api/server.ts` | API-mode delegation for `companies` / `internalProjects` and the company + project commands (Task 5–6) |
| `app/src/pages/companies/CompanyFormModal.tsx`, `app/src/pages/projects/NewProjectDialog.tsx` | use the id the server returns after create (Task 6) |
| `app/README.md` | what API mode now covers (Task 7) |

---

### Task 1: Backend — company profile, staff on a company, contact title

**Files:**
- Modify: `backend/src/models/company.model.ts`, `backend/src/validators/company.validator.ts`, `backend/src/services/company.service.ts`, `backend/src/models/user.model.ts`
- Test: `backend/src/services/company.service.test.ts`, `backend/src/validators/company.validator.test.ts` (create if missing)

**Interfaces:**
- Produces: company JSON gains `industry: string`, `country: string`, `website: string`, `notes: string`, `logo: string` (data URL or ''), `archived_at: string | null` (ISO), `responsibles: { user_id: string; role: 'super_admin' | 'admin' | 'developer' | 'viewer' }[]`. `POST /companies` and `PATCH /companies/:id` accept `industry`, `country`, `website`, `notes`, `logo` (≤ 200 KB string), `responsibles`. `POST /companies/:id/representatives` accepts optional `title` (≤ 100 chars). Users JSON gains `client_profile.title`.

- [ ] **Step 1: Failing validator tests** — `patchCompanyBodySchema` accepts `{ industry: 'Retail', responsibles: [{ user_id: <24-hex>, role: 'developer' }] }`; rejects `role: 'owner'`, a `logo` longer than 200 KB, and an unknown key. `createRepresentativeBodySchema` accepts `title: 'CTO'`.
- [ ] **Step 2: Run** `cd backend && npx vitest run src/validators/company.validator.test.ts` → FAIL.
- [ ] **Step 3: Implement** — in `company.model.ts` add to the schema (all optional with defaults so existing documents read cleanly):
```ts
industry: { type: String, trim: true, default: '' },
country: { type: String, trim: true, default: '' },
website: { type: String, trim: true, default: '' },
notes: { type: String, default: '' },
logo: { type: String, default: '' },
archived_at: { type: Date, default: null },
responsibles: {
    type: [{ _id: false, user_id: { type: Schema.Types.ObjectId, ref: COLLECTIONS.USERS, required: true }, role: { type: String, enum: COMPANY_RESPONSIBLE_ROLES, required: true } }],
    default: [],
},
```
with `export const COMPANY_RESPONSIBLE_ROLES = ['super_admin', 'admin', 'developer', 'viewer'] as const` and matching fields on `CompanyDocument`. In the validator add the same fields to `createCompanyBodySchema` (optional) and `patchCompanyBodySchema`, `logo: z.string().max(200 * 1024)`, `responsibles: z.array(z.object({ user_id: objectIdSchema, role: z.enum(COMPANY_RESPONSIBLE_ROLES) })).max(100)`. In `user.model.ts` add `title: { type: String, trim: true, maxlength: 100 }` to the client profile sub-schema and the `ClientProfile` type; in `createRepresentativeBodySchema` add `title: z.string().trim().max(100).optional()` and pass it into `client_profile.title` in `createRepresentative`.
- [ ] **Step 4: Failing service tests** — `patchCompany` with `{ responsibles: [...] }` stores them; `archiveCompany` sets `archived_at` to now; `toPublic` returns `responsibles[].user_id` as strings and `archived_at` as ISO or null.
- [ ] **Step 5: Implement** — `patchCompany` copies the new fields when present (same pattern as `name`); `archiveCompany` sets `archived_at = new Date()` with `status: 'archived'`, and the un-archive path (`PATCH status: 'active'`) clears it.
- [ ] **Step 6: Run** `npm test -- src/services/company.service.test.ts src/validators/company.validator.test.ts && npm run type-check` (from `backend/`) → PASS.
- [ ] **Step 7: Commit** `Backend: company profile fields, staff on a company, contact title`.

### Task 2: Backend — project statuses, area, support plan

**Files:**
- Modify: `backend/src/constants/project.ts`, `backend/src/models/project.model.ts`, `backend/src/validators/project.validator.ts`
- Test: `backend/src/validators/project.validator.test.ts` (extend or create)

**Interfaces:**
- Produces: `status` may also be `planned` or `maintenance`; project JSON gains `area: string` and `support_plan: { until: string; quota_hours: number } | null`; both accepted on create and patch.

- [ ] **Step 1: Failing tests** — `createProjectBodySchema` accepts `status: 'planned'`, `status: 'maintenance'`, `area: 'Infra'`, `support_plan: { until: '2027-06-30', quota_hours: 20 }`; rejects `support_plan.quota_hours: -1` and `until: '30/06/2027'`. Same for the patch schema.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** — `PROJECT_STATUSES` gains `PLANNED: 'planned'`, `MAINTENANCE: 'maintenance'`; model adds `area: { type: String, trim: true, default: '' }` and `support_plan: { type: new Schema({ until: { type: String, match: ISO_DATE_REGEX, required: true }, quota_hours: { type: Number, min: 0, required: true } }, { _id: false }), default: null }`; validators add the fields. Then run `npm run type-check` and fix every exhaustive `switch`/`Record<ProjectStatus, …>` the compiler flags: treat `planned` like `active` for "not finished" rules and `maintenance` like `completed` for "delivered" rules (overdue filters, dashboards). List each place in the commit message.
- [ ] **Step 4: Run** the project tests and the full backend suite → only the known pre-existing failures (8 mirror-coverage, occasional mfa timing).
- [ ] **Step 5: Commit** `Backend: planned and maintenance project states, area, support plan`.

### Task 3: Mappers — backend → app shapes

**Files:**
- Create: `app/src/api/http/companyMappers.ts`, `app/src/api/http/companyMappers.test.ts`

**Interfaces:**
- Consumes: `PersonId`, `Company`, `ClientProject`, `InternalProject`, `EpicSummary`, `CompanyContact`, `CompanyRole`, `ProjectState` from `api/types`.
- Produces: `type BackendCompany`, `type BackendProject`, `type BackendStory`, `type BackendRepresentative`; `stateFromStatus(status: string): ProjectState`; `statusFromState(state: ProjectState): string`; `epicFromStory(s: BackendStory): EpicSummary`; `clientProjectFrom(p: BackendProject, epics: EpicSummary[]): ClientProject`; `internalProjectFrom(p: BackendProject): InternalProject`; `contactFrom(r: BackendRepresentative): CompanyContact`; `companyFrom(c: BackendCompany, projects: ClientProject[], contacts: CompanyContact[]): Company`; `companyRoleFrom(role)` / `companyRoleTo(role)`.

- [ ] **Step 1: Failing tests** covering: every state mapping both ways; percent = round(done / total × 100), 0 when total is 0; `start_date`/`end_date` → `start`/`due` (`end_date: null` → `due: ''`); `member_ids` → `team`; `support_plan` → `sup: { until, quota, used: 0 }` and absent → no `sup`; story with `progress_percent`/`derived_status` → `EpicSummary` (`derived_status` `done`→`done`, `empty`→`planned`, otherwise `active`); company with none of the new fields (an existing Demo DB document) → `industry/country/web/notes: ''`, `archived: false`, `archivedAt: null`, `ourRoles: {}`; `status: 'archived'` → `archived: true`; `responsibles` → `ourRoles` keyed by user id with app labels; representative with `role: 'client'` → `admin: true`, `client_profile.title` → `role`, project ids from its `projects`.
- [ ] **Step 2: Run** `cd app && npx vitest run src/api/http/companyMappers.test.ts` → FAIL (module missing).
- [ ] **Step 3: Implement** the mappers as pure functions. The company colour `p` is derived from the id (same hash as `mappers.ts` `colourOf`, modulo the palette length used by `lib/media.ts`), not stored.
- [ ] **Step 4: Run** → PASS; `npx tsc -b` clean.
- [ ] **Step 5: Commit** `Map backend companies, projects, stories and contacts to the app's shapes`.

### Task 4: Mappers — app commands → backend bodies

**Files:**
- Modify: `app/src/api/http/companyMappers.ts`, its test

**Interfaces:**
- Produces: `companyBody(fields: Partial<CompanyFields>): Record<string, unknown>` (`web`→`website`, the rest by name); `projectBody(p: ClientProject | InternalProject, companyId: string | null): Record<string, unknown>` (`desc`→`description`, `start`→`start_date` (today when empty), `due`→`end_date` (null when empty), `state`→`status`, `team`→`member_ids`, `sup`→`support_plan`, `area`); `responsiblesBody(ourRoles: Record<PersonId, CompanyRole>)`.

- [ ] **Step 1: Failing tests** for each body, including empty `due` → `end_date: null`, no `sup` → no `support_plan` key, and a sample `ClientProject` from `api/companies/seed.ts` round-tripping through `projectBody` then `clientProjectFrom` to the same name/desc/state/start/due/team.
- [ ] **Step 2–4:** run (FAIL) → implement → run (PASS).
- [ ] **Step 5: Commit** `Map company and project commands to backend request bodies`.

### Task 5: Read companies and internal projects through the API

**Files:**
- Create: `app/src/api/http/companies.ts`, `app/src/api/http/companies.test.ts`
- Modify: `app/src/api/server.ts` (`get`)

**Interfaces:**
- Produces: `fetchCompanies(session: Session | null): Promise<Company[]>`, `fetchInternalProjects(session: Session | null): Promise<InternalProject[]>`; `server.get('companies' | 'internalProjects')` returns them in API mode.

- [ ] **Step 1: Failing tests** (mock `api.get`):
  - staff: reads all pages of `/companies?limit=100&page=N` (both `status=active` and `status=archived`), all pages of `/projects?limit=…`, `/projects/:id/stories` per client project, `/companies/:id/representatives?limit=100&page=N` per company; builds companies with their projects (by `company_id`) and contacts; internal projects are the projects with `company_id: null`.
  - archived company is returned with `archived: true`.
  - client user (`cadmin`/`cuser`): reads `/companies` (the backend narrows it to their own) and `/projects`, and does **not** call `/companies/:id/representatives` for a company other than `session.orgId`.
  - `fetchInternalProjects` for a client user returns `[]` without calling the API.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** with a shared `allPages<T>(path)` helper in `companies.ts` (moved out of `people/directory.ts`, which then imports it). Cache one `/projects` read per `fetchCompanies` call; `fetchInternalProjects` does its own read.
- [ ] **Step 4:** In `server.get`, at the top: `if (apiMode && resource === 'companies') return fetchCompanies(readSession()) as Promise<Db[K]>` and the same for `internalProjects`. Keep the mock path untouched.
- [ ] **Step 5: Run** unit tests, `npx tsc -b`, `npm run build` → PASS.
- [ ] **Step 6: Commit** `Read companies and projects through the API in API mode`.

### Task 6: Write company and project commands through the API

**Files:**
- Modify: `app/src/api/http/companies.ts` (+ test), `app/src/api/server.ts` (`send`), `app/src/api/server.ts` `SendResult` (`id?: number | string`), `app/src/pages/companies/CompanyFormModal.tsx`, `app/src/pages/projects/NewProjectDialog.tsx`

**Interfaces:**
- Produces: `sendCompanyCommand(cmd: CompaniesCommand | ProjectsCommand): Promise<SendResult>`; `server.send` routes these command types to it in API mode.

Command → backend calls:

| Command | Calls |
| --- | --- |
| `company.create` | `POST /companies` (name + profile + responsibles) → returns `{ id }` |
| `company.update` | `PATCH /companies/:id` (profile fields); `main` → update or create the first contact as below |
| `company.archive` | `archived: true` → `POST /companies/:id/archive`; `false` → `PATCH /companies/:id { status: 'active' }` |
| `company.contact.save` (new) | `POST /companies/:id/representatives` `{ email, full_name, title, initial_password: <random 24 chars> }`; if `admin` → `POST /users/:newId/change-role { role: 'client' }`; then `POST /projects/:pid/representatives` for each project id |
| `company.contact.save` (edit) | `PATCH /users/:personId { full_name, client_profile.title }` (check the self/admin PATCH whitelist; if `title` is not patchable, add it there in this task), role change if `admin` flipped, project roster add/remove diff |
| `company.contact.remove` | `DELETE /companies/:id/representatives/:personId` |
| `company.responsible.save` | `PATCH /companies/:id { responsibles }` with the person's role set; project team diff via `POST /projects/:pid/members` |
| `company.responsible.remove` | `PATCH /companies/:id { responsibles }` without the person; remove from every company project's members |
| `company.project.create` | `POST /projects` with `projectBody(project, companyId)` → `{ id }` |
| `project.client.setState`, `project.internal.setState` | `PATCH /projects/:id { status }` |
| `project.internal.create` | `POST /projects` with `projectBody(project, null)` → `{ id }` |

- [ ] **Step 1: Failing tests** — one per row above (mock `api.post/patch/delete`; add `delete` to the client in this task with its own test in `client.test.ts`), asserting the exact paths and bodies, and that create commands resolve `{ id: <backend id> }`. Plus: a 409 from `POST /companies` rejects with the `ApiError`; the random password is 24 chars and differs between two calls.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** `sendCompanyCommand`; in `server.send`, before the mock path: `if (apiMode && isCompanyOrProjectCommand(cmd)) return sendCompanyCommand(cmd)`. `RefusedError` mapping: a 403 from the backend becomes `RefusedError(message)` so the existing UI handling shows it.
- [ ] **Step 4: Use the returned id** — `CompanyFormModal` navigates to `` `/companies/${result.id ?? id}` ``; `NewProjectDialog` passes `result.id ?? project.id` to `onCreated`. Both use `useSendAsync` (check which send hook each already uses; switch to the async one only if needed). No visual change.
- [ ] **Step 5: Run** unit tests, `npx tsc -b`, build, and the full e2e suite in mock mode → same as baseline.
- [ ] **Step 6: Commit** `Write company and project changes through the API in API mode`.

### Task 7: Hands-on check and docs

- [ ] **Step 1:** Backend `npm run dev:redesign`, app `npm run dev:api`; sign in as `admin@viljetech.com`.
- [ ] **Step 2:** Companies page lists the 2 Demo DB companies (Aurora Foods AB and the other one) with their real projects and contacts; Projects page lists the 3 real projects (2 client, 1 internal) with progress from their tasks.
- [ ] **Step 3:** Create a company "Redesign Test AB", open it (correct page, no "not found"), edit its industry and notes, add a contact, add a responsible, create a client project, move it to Planned, then archive the company. Reload after each step: the change is still there. Confirm in the Demo DB (read-only script) that the documents exist with the new fields, and nothing else changed.
- [ ] **Step 4:** Sign in as `emma@viljetech.com` (client admin): sees only Aurora Foods AB; no 403 in the console.
- [ ] **Step 5:** Leave the test company archived (never hard-delete; the Demo DB is shared) and note its name in the README so others recognise it.
- [ ] **Step 6:** Update `app/README.md` "API mode" with what now comes from the backend, the contact-account rule, and the remaining sample-data screens. Commit `Document companies and projects in API mode`.
