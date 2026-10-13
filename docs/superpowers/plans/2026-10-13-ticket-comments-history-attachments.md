# Ticket comments, history and attachments from the API (Phase 1b-2, part 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** In API mode the ticket drawer shows a ticket's real comments, history (activity) and attachments, posting a comment saves it, and attaching a file uploads it to the backend.

**Architecture:** A new adapter `app/src/api/http/ticketDetails.ts` reads `GET /tasks/:id/comments`, `/activity` and `/attachments` for the open ticket only (not for the whole board) and maps them to the drawer's `Activity[]` and `Attachment[]`. A query hook `useTicketDetails(id)` (API mode only) feeds them into the drawer, which otherwise renders exactly as before. Writes stay in `board.ts`: `task.comment` posts a comment; `task.update` with new attachments uploads each file (upload-url → PUT to the signed URL → finalize). Every write already refetches; the details query is invalidated with the rest.

**Tech Stack:** React 19, TanStack Query 5, Vitest 4. Backend unchanged.

**Spec:** the user's go on 13 Oct 2026 for "Part 2 of tickets: comments, history and attachments in the ticket drawer"; constraints in memory (`no-ui-changes`, `api-branch-separate`, `backend-integration-plan`).

## Global Constraints

- Branch `feat/api-sign-in`; no visual UI change in `app/`; mock mode unchanged (unit tests green; e2e baseline 307 passed / DO-18, DO-19 failing / 3 skipped, SH-01 and TS-08 known flakes).
- Only the open ticket's details are loaded (three requests per opened ticket).
- `when` reads like the mock: `just now`, `5m ago`, `3h ago`, `2d ago`, then `9 Oct 2026`.
- People are named by the backend's hydrated `author` / `actor` display (`full_name`), falling back to the board's names.
- Uploading writes to the real Azure storage configured for the backend: the hands-on upload test needs the user's OK first.

## Decisions taken in this plan

1. Comment mentions (`@name`) are sent as plain text; the backend's mention list is not filled yet.
2. The drawer has no download or remove control for attachments, so neither is wired (no UI changes).
3. A comment appears once the POST returns and the details refetch (no optimistic line).
4. History lines are built from the activity type: e.g. `moved it to In progress`, `renamed it to “X”`, `set priority to High`, `added an attachment`, `commented`. Comment activity rows are dropped from history (the comment itself is shown).

## Review Focus

1. A ticket opened before the board reloads (a draft, or just created) → details are not requested for a temporary id.
2. A failed upload (refused, too big, network) → the refusal reason shows; no half-saved attachment row.
3. A client user opening their bug → reads only; the comment endpoints are allowed for them.
4. Long histories (> 100 rows) → only the first page is shown; no crash.
5. Mock mode → no details requests at all.

---

### Task 1: ticket details adapter

**Files:** create `app/src/api/http/ticketDetails.ts` (+ test). Produces `fetchTicketDetails(taskId: string): Promise<{ acts: Activity[]; atts: Attachment[] }>`, `ago(iso: string, now?: Date): string`, `historyLine(row): string | null`.

- [ ] Failing tests: `ago` buckets; comment → `{ kind:'comment', who, text, when }`; activity rows → history lines (status uses the board's status names), comment_* activity rows skipped; attachments → `{ name, size: '12 KB', date: fmt(created) }`; acts newest first; a temporary id (no backend id) returns empty without calling the API.
- [ ] Implement; run; commit `Read a ticket's comments, history and attachments from the API`.

### Task 2: drawer reads details in API mode

**Files:** `app/src/api/queries.ts` (`useTicketDetails`, invalidated on every settled write), `app/src/features/ticket/TicketDrawer.tsx` (merge `acts`/`atts` when present).

- [ ] Failing test: `useTicketDetails` is disabled in mock mode (no fetch). Implement; app tests, tsc, build; commit `Show real comments, history and attachments in the ticket drawer`.

### Task 3: post comments, upload attachments

**Files:** `app/src/api/http/board.ts` (+ write tests), `app/src/api/types.ts` (`Attachment.fileRef?: string`), `app/src/features/ticket/TicketDrawer.tsx` (API mode: register the picked File and pass its ref).

- [ ] Failing tests: `task.comment` → `POST /tasks/:id/comments { body }`; `task.update` with a new attachment → upload-url, PUT with the required headers, finalize; a 403 on upload-url rejects before any PUT; attachments without a file are ignored.
- [ ] Implement; app tests, tsc, build, e2e mock suite; commit `Post comments and upload attachments through the API`.

### Task 4: hands-on check and README

- [ ] As admin: open AFS-1, see its history; post a comment; reload; it is there. As a client user: open their bug, read only.
- [ ] Attachment upload: only with the user's OK (real storage).
- [ ] README API mode section; commit `Document ticket comments, history and attachments in API mode`.
