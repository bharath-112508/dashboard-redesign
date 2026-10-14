# Client team and InvoiceMatch in API mode (Phase 1g) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans.

**Goal:**
- In API mode, a client admin's **Add member** creates a real client login.
- The InvoiceMatch live-app demo shows under Aurora Foods, with its approve/hold/reject decisions saved on the backend.

**Spec:** the user's answers on 14 Oct 2026:
- client team → "Real login"
- InvoiceMatch → "Yes, under Aurora Foods"

Constraints in memory: `no-ui-changes`, `api-branch-separate`, `backend-integration-plan`.

## Global Constraints

- Branch `feat/api-sign-in`.
- No visual UI change.
- Mock mode unchanged; e2e baseline is 310 passed / 3 skipped.
- Backend changes are additive on the shared Demo DB.

## Decisions

1. **Add member** calls the existing `createContact`: a client user on the member's company (`POST /companies/:id/representatives`), invited by email and rostered on all the company's live projects.
   - In API mode the separate member list is empty, because members are real people and show as company contacts.
   - Removing someone is done in Users, as for any contact.
2. **The InvoiceMatch project** is a real Demo DB project named `InvoiceMatch` under Aurora Foods AB, with two epics: "Matching engine" and "Review & reports". It is created once through the app as admin.
   - The app finds it by name in API mode (`isImProject`).
   - Its epics come from that project (`imEpicIds`).
   - Feedback bugs go to its "Review & reports" epic (`imBugEpic`).
   - In mock mode the same helpers return today's fixed ids.
3. **The 10 invoices** stay the app's fixed sample. Only decisions are stored, in a new collection `invoicematch_decisions` with fields `project_id`, `no`, `st`, `note`, `by` and `by_id`, unique on (`project_id`, `no`).
   - Endpoints: `GET /invoicematch/:projectId/decisions`, `PUT` and `DELETE` on `/invoicematch/:projectId/decisions/:no`.
   - Anyone on the team may use them, and so may clients who can see the project. The project must be named InvoiceMatch.
   - `by` comes from the backend.
4. **Live updates:** the topic `invoicematch` maps to the key `invoiceMatch`.

## Tasks

1. **App:** `clientTeam.*` in API mode (read empty; add → `createContact`), with tests.
2. **Backend:** InvoiceMatch decisions (model, service, routes, topic), with tests.
3. **App:**
   - InvoiceMatch resolved by name.
   - Invoices read with their saved decisions.
   - `invoiceMatch.decide` sent to the backend.
   - Tests.
4. **Finish:**
   - Create the project and epics on the Demo DB.
   - Hands-on as Emma: the card, the live app, a decision kept after reload, feedback becomes a bug, add member.
   - README; unit, tsc, build and e2e runs.
   - Fresh reviewer, then fixes.
