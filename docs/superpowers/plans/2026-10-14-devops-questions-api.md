# DevOps board, client questions and DevOps requests from the API (Phase 1f) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** In API mode the DevOps board (items and settings), the questions to clients and the DevOps requests come from the backend and are saved there, so everyone sees the same board, questions and requests.

**Architecture:** Three new backend collections (`devops_items`, `client_questions`, `devops_requests`) plus `devops_settings` in system settings, each behind a small route file in the style of `app-access.routes.ts`. The app reads them in a new adapter `app/src/api/http/devops.ts` and maps them to the existing `DevopsDb`, `Question[]` and `DevopsRequest[]` shapes, so no screen changes. Writes go through `sendDevopsCommand`. Settings saves reuse the app's own `reduceDevops` (the one place that knows how renames move items) and send the result.

**Tech Stack:** React 19, TanStack Query 5, Vitest 4. Backend: Express 5, Mongoose 9, Zod, Vitest (models mocked).

**Spec:** the user's answers on 14 Oct 2026:
- storage → "Board's fields as-is": one item document per project, with the board's detail fields kept as one block
- start data → "Start empty"
- scope → "Board + questions + requests" (client team and InvoiceMatch come later)

Constraints in memory: `no-ui-changes`, `api-branch-separate`, `backend-integration-plan`.

## Global Constraints

- Branch `feat/api-sign-in`.
- No visual UI change.
- Mock mode unchanged.
- e2e baseline is 310 passed / 3 skipped; DO-18 and DO-19 are fixed in 9a6a574.
- Backend changes are additive on the shared Demo DB: new collections only, plus one new settings field.
- Safe dev mode: no Slack, push or email.
- Hands-on test data is removed afterwards.

## Decisions

1. **Ids.**
   - Questions and requests keep their numeric ids, stored as `number` (unique).
   - DevOps items keep their `key` (`OPS-<n>`, unique).
   - The app proposes the next id, as it does today. Team roles see every record, so the proposal is right except when two people create at once.
   - A clash returns 409, which the app shows as a refusal ("Someone else just added one. Try again."). No DB version bump.
2. **Who may do what.**
   - Staff (any non-client role):
     - read everything
     - create and update questions, requests and their messages
   - DevOps items and DevOps settings may be written only by admins (`isAdminLike`) and people with the `devops` role key.
   - Clients (role `client` or `representative`):
     - read DevOps items, questions and requests that belong to their company's projects (via `project_id`)
     - post client messages on their questions
     - edit their own messages
     - set `solved` on their questions
     - nothing else
3. **Each record stores `project_id`**, resolved at create time, so client scoping is one query:
   - an item stores it from `project.id`
   - a question from its task's project, or from its DevOps item's project
   - a request from its DevOps item's project
4. **Authors and times come from the backend:**
   - `by` / `who` is the caller's full name
   - `when` is ISO, and the app shows it with `ago()`
   - a message's `side` is `client` for clients and `team` for staff
   - a request comment's `side` is taken from the body (`tickets` | `devops`), because staff may write from either page
5. **Locks.** The backend repeats `applyLocks` (initial due date and dev phase due dates) with the saved rules. A locked date can't be changed through the API either.
6. **Settings.**
   - `GET /devops/settings` returns the saved settings or `null`.
   - On `null` the app uses the design's default settings. Their `people` become the names of active people with the DevOps role.
   - Option adds and settings saves run `reduceDevops` on the current data, `PUT` the settings, then `PATCH` each item whose fields changed. This is not atomic (a ponytail note); it is fine at this size.
7. **Files** (question photos, message files) stay inline data URLs, capped at 5 files of up to 2 MB each per write. Moving them to blob storage waits for the Azure upload OK.
8. **The question answer fields** (`answer`, `answerBy`, `answerIdx`, `answeredWhen`) are not stored. The app derives them from the first client message, the way the mock reducer sets them.
9. **Request time logs** (`logs`, hours DevOps logs on a request from the Timesheet page) stay on the request, as in the design. They are not timesheet entries.
10. **`devopsLinks`** (epic → item key) are worked out in the app: each epic's project, then the item on that project.

## Review Focus

- A client reading `/questions` gets only questions on their company's projects.
- A client sending `side: 'team'` or editing someone else's message is refused (403).
- Locked dates survive a PATCH that tries to change them.
- A clash on a new id gives a refusal, not a silent overwrite.
- Live updates: a change on one tab refetches devops, questions and requests elsewhere.

## Tasks

1. **Backend: DevOps items + settings**
   - Model `devops-item.model.ts` (`key`, `project_id`, `data` Mixed, `created_by`, `updated_by`).
   - Service `devops.service.ts`:
     - list, scoped
     - create: 409 on a duplicate key
     - update: locks, plus a log written with the caller's name and an ISO time
     - get and set settings
   - Routes `devops.routes.ts`: `GET/POST /devops/items`, `PATCH /devops/items/:key`, `GET/PUT /devops/settings`.
   - Topic `devops`, plus tests.
   - Commit `Backend: DevOps board items and settings`.
2. **Backend: questions + requests**
   - Models `client-question.model.ts` and `devops-request.model.ts`.
   - Service `client-question.service.ts`:
     - questions: create, update, message, edit message
     - requests: create, update, comment
   - Routes `/questions` and `/devops-requests`.
   - Topics `questions` and `devops-requests`, plus tests.
   - Commit `Backend: questions to clients and DevOps requests`.
3. **App: read**
   - `http/devops.ts`: `fetchDevops`, `fetchQuestions`, `fetchRequests`, and `devopsLinks` on the workspace.
   - Live keys: `devops` → devops, workspace; `questions` → questions; `devops-requests` → requests.
   - Tests.
   - Commit `DevOps board, questions and requests read from the API`.
4. **App: write**
   - `sendDevopsCommand` covers `devops.*`, `question.*`, `request.*` and batches of them.
   - Wire it into `server.send` (with 409 refusals) and `refuseBeforeSending`.
   - Tests.
   - Commit `DevOps board, questions and requests saved through the API`.
5. **Finish**
   - Hands-on check in API mode: create an item on a Demo project, raise a question, the client answers, raise a request, comment. Then remove the test data.
   - README.
   - Unit, tsc, build and e2e.
   - Fresh reviewer, then fixes.
