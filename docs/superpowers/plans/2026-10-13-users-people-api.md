# Users and people from the API (Phase 1d) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** In API mode the people directory, the Users page (add, edit, deactivate, roles, developer types, project access, photo), the Roles & permissions grid and the profile window read and write the real backend, so names, roles and avatars are the same everywhere.

**Architecture:** `server.get('people' | 'access')` and the `user.*`, `access.*` and `profile.update` commands go to a new adapter `app/src/api/http/users.ts` (mapping in `mappers.ts`). The backend gains, additively: optional staff fields on create, a developer type on users, a `devops` custom role (and role keys on the user list), and a stored copy of the app's permission grid and developer types.

**Tech Stack:** React 19, TanStack Query 5, Vitest 4. Backend: Express 5, Mongoose 9, Zod, Vitest.

**Spec:** the user's answers on 13 Oct 2026: add user → "Make them optional"; permission grid → "Save it, display only"; developer types and DevOps role → "Add both"; leave → "Separate phase". Constraints in memory: `no-ui-changes`, `api-branch-separate`, `backend-integration-plan`.

## Global Constraints

- Branch `feat/api-sign-in`; no visual UI change in `app/`; mock mode unchanged (unit tests green; e2e baseline 308 passed / DO-18, DO-19 failing / 3 skipped; known flakes SH-01, TS-08, CL-08, CO-19).
- Shared Demo DB: backend changes are additive. Hands-on writes only touch a new test user made for the check (deactivated afterwards); never change a real person's role, status or password.
- Safe dev mode stays on (stub email, no Slack/push/jobs), so invitations and reset links go to the backend log.
- Role mapping unchanged (admin→Super admin, manager/team lead→Project manager, employee→Developer, client→Client admin, representative→Client user) plus a user holding the `devops` role key → DevOps engineer. The app's separate "Admin" role has no backend role; choosing it in API mode is refused with a clear message.

## Decisions taken in this plan (for review)

1. **Adding a user** creates a backend account with a random password and sends the backend's set-a-new-password email (the same invite as company contacts). Staff fields the design's form does not have (employee ID, job title, department, joining date, reporting manager) are optional on the backend from now on. Client admins and client users are added to their company the same way contacts are.
2. **Removing a user** deactivates them (the backend never hard-deletes people). Deactivated people show as inactive.
3. **Changing a role** uses the backend's change-role. Moving someone between staff and client is refused, as the backend does ("deactivate and add them again").
4. **DevOps engineer** = a staff user (employee) who also holds a new custom backend role `devops`, created at backend start if missing.
5. **Developer type** is stored on the user (`internal_profile.dev_type`); the list of types and the permission grid are stored in system settings (`app_access`), readable by every signed-in person, writable by admins. The grid stays display-only.
6. **Project access** ("all projects" or picked ones) maps to project membership: picking projects adds or removes the person from those projects' members. "All projects" leaves membership as it is.
7. **Profile window:** name, phone and time zone save to the backend. The four notification toggles are kept in the browser (no backend equivalent yet). A new password cannot be set without the current one, so in API mode the window emails a set-a-new-password link instead and says so.
8. **Photos** are read from the backend (`/users/photos`) and uploaded with its signed upload; like ticket attachments, the upload is not tried hands-on until the Azure question is answered.

## Review Focus

1. A developer (no `USER_READ` beyond the list) and a client user open pages that list people → no refused calls; clients see themselves and their company's contacts only.
2. Editing your own role or active flag stays impossible (as in the design).
3. An admin deactivates the last admin → backend refuses; the refusal shows.
4. A person in two pages at once: the list after any write shows the backend's state, not the optimistic one.
5. Saved browser data from earlier versions: no migration needed (people ids are already strings).

---

### Task 1: Backend — optional staff fields on create

**Files:** `backend/src/validators/user.validator.ts` (+ test).
- [ ] Failing test: creating an employee without employee_id, job_title, department, date_of_joining and reporting_manager_id passes validation; the other create rules (client_profile for clients, no internal_profile for clients) still hold. Implement; commit `Backend: staff profile fields are optional when adding a user`.

### Task 2: Backend — developer type, devops role, role keys on the user list, app access settings

**Files:** `models/user.model.ts`, `validators/user.validator.ts` (`internal_profile.dev_type`, ≤40), `services/user.service.ts` (list rows carry `role_keys`), `services/role.service.ts` (`ensureDevopsRole` at start: custom role key `devops`, employee permissions), `index.ts` (call it after `seedSystemRoles`), `models/system-settings.model.ts` (`app_access: { perms: Mixed, dev_types: [String] }`), new `routes/app-access.routes.ts` (`GET /app-access` any signed-in caller, `PUT /app-access` `ROLE_WRITE`) (+ tests).
- [ ] Failing tests for each; implement; backend tests + type-check; commit `Backend: developer type, DevOps role, role keys on users, stored permission grid`.

### Task 3: App — read people and access through the API

**Files:** `app/src/api/http/users.ts` (+ test), `api/http/mappers.ts` (`personFromUser`: devType, devops via role_keys, active from status, photo URL), `api/server.ts` (`get('people')`, `get('access')`), `api/people/directory.ts` (reuse).
- [ ] Failing tests: staff list incl. deactivated for admins; `role_keys: ['devops']` → devops; `dev_type` → devType; photos from `/users/photos`; client → self + company contacts; access defaults when nothing stored. Implement; commit `Read people and the permission grid through the API`.

### Task 4: App — write users, access and profile through the API

**Files:** `app/src/api/http/users.ts` (`isUserApiCommand`, `sendUserCommand`), `api/server.ts`, `api/queries.ts` (+ tests).
- [ ] Failing tests: `user.create` staff → `POST /users` (random password, role, internal_profile.dev_type/employment_type) then `POST /users/:id/reset-password`; client roles → company representatives route; `user.update` → `PATCH /users/:id` for name/email/phone, `change-role` for role, `PATCH /users/:id/roles` for devops on/off, deactivate/reactivate for active, membership diff for projects, photo upload; `user.remove` → deactivate; app role `admin` → refused; `access.setPerm` / `access.addDevType` → `PUT /app-access`; `profile.update` → `PATCH /users/:id` (self fields), password → `POST /auth/forgot-password` with a refusal-style notice.
- [ ] Implement; app tests, tsc, build, e2e; commit `Write users, the permission grid and profiles through the API`.

### Task 5: Hands-on check and README

- [ ] As admin: Users list shows real people with roles and developer types; add a test user (Developer, Backend) → invite link in the backend log; edit it (developer type, DevOps role on/off, project access to the Redesign Test Portal); deactivate it. Roles grid tick persists across reload. As Rahul: profile name/phone/tz save; the people pages show no refused calls. As a client user: no refused calls.
- [ ] README; commit `Document users and people in API mode`.
