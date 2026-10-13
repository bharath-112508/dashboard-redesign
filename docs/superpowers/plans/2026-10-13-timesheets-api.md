# Timesheets from the API (Phase 1c) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** In API mode, My timesheet, the dashboard quick log, the Tickets timesheet, Employee timesheets, profile week cards, ticket hours and the support plan's "hours used" read and write real Demo DB time entries, and a person can submit and reopen a week.

**Architecture:** Same pattern as the board: `app/src/api/http/timesheet.ts` loads entries and week submissions for the signed-in person (`server.get('entries' | 'weekSubmissions')`) and sends time commands (`server.send`). Mapping lives in `timesheetMappers.ts`. The backend gains week submissions (a new collection, with a lock on entries in a submitted week) and an optional `work_type` on entries, both additive.

**Tech Stack:** React 19, TanStack Query 5, Vitest 4. Backend: Express 5, Mongoose 9, Zod, Vitest.

**Spec:** the user's go on 13 Oct 2026 for "Timesheets from the backend, including hours per ticket and support-plan hours used", with the earlier rule "build every missing backend feature". Constraints in memory: `no-ui-changes`, `api-branch-separate`, `backend-integration-plan`.

## Global Constraints

- Branch `feat/api-sign-in`; no visual UI change in `app/`; mock mode unchanged (unit tests green; e2e baseline 307 passed / DO-18, DO-19 failing / 3 skipped; SH-01, TS-08, CL-08, CO-19 are known timing flakes).
- Shared Demo DB: backend changes are additive (a new collection, a new optional field, a new rule that only applies to weeks submitted through the new endpoint).
- Mappings: `bill`/`non` decimal hours ↔ `billable_hours`+`billable_minutes` / `non_billable_hours`+`non_billable_minutes`; `task` ↔ `task_id` (entry_type `task_linked`), else `general` with `general_category` = `area`; `project` `c:<id>` / `i:<id>` ↔ `project_id`; `type` ↔ `work_type`; `notes` ↔ `description` (an empty note sends the area, the ticket title or the type, since the backend requires one); `date` ↔ `local_date`.
- Entry ids become strings in the app (DB version 7), as task ids did.

## Decisions taken in this plan (for review)

1. **Week submit and reopen are built on the backend.** `GET /timesheets/weeks`, `PUT /timesheets/weeks/:week` (submit your own week), `DELETE /timesheets/weeks/:week?user_id=` (reopen: yourself, or a manager/admin for anyone). While a week is submitted, creating, editing or deleting an entry in it is refused (409 `TIMESHEET_WEEK_SUBMITTED`). The backend's existing 7-day self-edit window still applies on top.
2. **Work type** (General, Meeting, Review, DevOps) is stored in a new optional `work_type` on entries.
3. **Logging for someone else** (the Tickets timesheet's person picker) is refused in API mode with "You can only log your own time." The backend always logs as the caller.
4. **A ticket's "Log time"** in the drawer becomes a real billable time entry on that ticket, for the signed-in person.
5. **Which entries load:** a developer loads their own (`/timesheets/me`); a manager, team lead or admin also loads their team's (`GET /timesheets`), from the start of the previous month; clients load none.
6. **Support plan hours used** come from `GET /timesheets/summary?project_id=…` for the current month (billable minutes).
7. DevOps request time logs stay in the mock (DevOps phase).

## Review Focus

1. Logging in a submitted week → refused with the backend's reason, and the row snaps back.
2. Editing an entry older than 7 days → backend 403 `TIMESHEET_EDIT_WINDOW_EXPIRED`, shown as a refusal.
3. A developer never calls the team list (`GET /timesheets` without `project_id` is staff-only).
4. Saved browser data from version 6 (numeric entry ids) upgrades to strings without losing entries.
5. A decimal entry such as 1.75 h round-trips as 1 h 45 m.

---

### Task 1: Backend — week submissions and the lock

**Files:** create `backend/src/models/timesheet-week.model.ts`, `backend/src/services/timesheet-week.service.ts` (+ test); modify `validators/timesheet.validator.ts`, `routes/timesheet.routes.ts`, `controllers/timesheet.controller.ts`, `services/timesheet.service.ts` (`assertWeekOpen` in create/patch/delete), `constants/error-codes.ts` (`TIMESHEET_WEEK_SUBMITTED`).

- [ ] Failing tests: submit stores `{user_id, week_start (Monday), submitted_at}` once (re-submit keeps one row); a week that is not a Monday → 422; list returns the caller's weeks, or a team member's for a manager; reopen by the owner or a manager deletes the row, by another employee → 403; create/patch/delete an entry dated inside a submitted week → 409 `TIMESHEET_WEEK_SUBMITTED`.
- [ ] Implement; backend tests and type-check; commit `Backend: submit and reopen a timesheet week; a submitted week is locked`.

### Task 2: Backend — work type on entries

**Files:** `models/timesheet-entry.model.ts` (`work_type: String, default null`), `validators/timesheet.validator.ts` (create and patch, trimmed, max 40, nullable), `services/timesheet.service.ts` (stored on create, patched).

- [ ] Failing test, implement, commit `Backend: time entries carry a work type`.

### Task 3: App — entry ids are strings (DB version 7)

**Files:** `app/src/api/types.ts` (`TimeEntry.id: string`), `api/timesheet/commands.ts` (`assignTimeIds` → string), `api/server.ts` (`stringEntryIds` migration), every file `tsc` flags; test `server.migrate.test.ts`.

- [ ] Failing migration test; implement; app tests, tsc, build, e2e; commit `Use string time entry ids (DB version 7)`.

### Task 4: App — timesheet mappers

**Files:** create `app/src/api/http/timesheetMappers.ts` (+ test). Produces `entryFrom(e, ctx): TimeEntry`, `entryBody(t: TimeEntry, ctx): Record<string, unknown>`, `minutesSplit(h: number)`.

- [ ] Failing tests for every mapping in Global Constraints; 1.75 → 1 h 45 m; description fallback; implement; commit `Map backend time entries to the app's`.

### Task 5: App — read entries and weeks through the API

**Files:** create `app/src/api/http/timesheet.ts` (+ test); `api/server.ts` (`get` for `entries`, `weekSubmissions`).

- [ ] Failing tests: developer → `/timesheets/me` only; manager → `/me` and `GET /timesheets`, merged without duplicates; client → none; weeks map to `{userId, week, when}`.
- [ ] Implement; commit `Read time entries and submitted weeks through the API`.

### Task 6: App — write time through the API

**Files:** `app/src/api/http/timesheet.ts` (`isTimeApiCommand`, `sendTimeCommand`), `api/server.ts`, `api/queries.ts`, `api/http/board.ts` (ticket "Log time" → entry).

- [ ] Failing tests: `time.log` → `POST /timesheets`; for someone else → refused; `time.remove` → `DELETE`; `week.submit` → `PUT /timesheets/weeks/:week`; `week.reopen` → `DELETE …?user_id=`; a ticket's `time` patch adds a `task_linked` entry for the added hours; 409 → refusal.
- [ ] Implement; app tests, tsc, build, e2e; commit `Write time entries and weeks through the API`.

### Task 7: App — support plan hours used

**Files:** `app/src/api/http/companies.ts` (+ test).

- [ ] Failing test: a project with a support plan reads this month's summary and shows its billable hours as `used`; implement; commit `Support plan hours used come from the timesheets`.

### Task 8: Hands-on check and README

- [ ] As a developer: log time (ticket and text), see it in My timesheet and on the dashboard, submit the week, try to log in it (refused), reopen. As admin: Employee timesheets shows the team's entries. A ticket's Log time shows on the ticket.
- [ ] README; commit `Document timesheets in API mode`.
