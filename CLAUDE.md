# Viljetech platform redesign — CLAUDE.md

The redesigned Viljetech web app, wired to a copy of the Viljetech backend. It will
**replace the current viljetech-platform frontend** once it is ready.

Repo: `viljetech-core/viljetech-platform-redesign` (`main`). It was moved here on
2026-10-14 from `bharath-112508/dashboard-redesign`, branch `feat/api-sign-in`, with full history.
Other branches of the old repo (`feat/mobile-app`, `feat/webapp-v4`, `feat/clients-page`) were not moved.

## Layout

| Folder | What it is | Read first |
| --- | --- | --- |
| `app/` | The web app: React 19 + Vite + React Query + Tailwind | `app/README.md` (per-phase notes, decisions, code map) |
| `backend/` | The API: Express + Mongoose, copied from viljetech-platform with its history | `backend/CLAUDE.md`, `backend/docs/modules/` |
| `e2e/` | Playwright tests of the app in mock mode | — |
| `docs/` | Plans and specs from development | — |
| `design/` | The original Claude Design handoff: HTML prototypes in `design/project/`, chats in `design/chats/` | `README.md` |

## Two modes

- **Mock mode** (`npm run dev` in `app/`): no backend; built-in demo data; "today" is fixed at 2026-10-10.
  The e2e suite runs against this. **Mock mode must keep behaving exactly as designed.**
- **API mode** (`VITE_API_URL` set): real data from the backend. Adapters live in `app/src/api/http/*`;
  `app/src/api/server.ts` routes each read and write to them. `VITE_DEMO_ACCOUNTS=true` shows the
  Demo DB account list on the sign-in page.

## Running it

```bash
# backend (needs backend/.env, which is never committed; get it privately)
cd backend && npm install && npm run dev:redesign   # port 3101, Demo DB; email stubbed, jobs, Slack and push off

# app against the backend
cd app && npm install && npm run dev:api            # http://localhost:5200

# app with mock data
cd app && npm run dev                                # http://localhost:5173
```

The test accounts' password is not stored anywhere in the repo. Ask the user.

## Tests (and the expected baseline)

| Where | Command | Expected |
| --- | --- | --- |
| app | `npx vitest run`, `npx tsc --noEmit -p .`, `npx tsc -b` | all pass; type checks clean |
| backend | `npx vitest run`, `npx tsc --noEmit -p .` | **8 known failures** in `src/constants/mirror-coverage.test.ts`: they compare against the old frontend, which is not in this repo. `src/utils/mfa.test.ts` can time out under load; it passes on its own. |
| e2e | in `e2e/`: `E2E_BASE_URL=http://localhost:5174 npx playwright test --reporter=line` against a mock-mode app (`npx vite --port 5174` in `app/`) | 309–310 passed, 3 skipped. TS-08 is occasionally flaky under load. |

## Rules (from the user)

- **Never touch the live or production database.** Development uses the shared **Demo DB**.
  Other branches write to the Demo DB too, so every schema change must be **additive**:
  never rewrite or delete existing documents. The old frontend still uses this backend.
- **Keep Slack, email, push and cron jobs off in development.** `npm run dev:redesign` does this.
  The Demo DB has Slack switched on in its settings, so `SLACK_OUTBOUND_ENABLED=false` is mandatory.
- **Never print, copy or commit secrets** (`.env`, tokens, passwords).
- **No UI changes** unless the user asks for them. Wire data and behaviour; keep screens as designed;
  if something seems to need a visible change, ask first.
  In API mode the user has approved these: the Roles & permissions grid is read-only with a note, and
  "All projects" is offered only where the server really shows every project.
- **Web app only.** Mobile is a separate, later piece of work.
- **Push only when the user asks.** Merging is the user's decision.
- **Working style:** test first (watch the test fail, then pass); keep changes small; have a fresh
  reviewer check each finished phase and fix what it finds, minor issues included.
  Explain things to the user in plain, short language.

## Where things stand (2026-10-14)

Done and verified against the Demo DB:
- **Sign-in and accounts:** sign-in with the MFA code step, sign-out, password reset and invitations.
- **Work items:** tickets, epics, sprints, timeline, My tickets and the Clients board.
  The board is one request: `GET /board`.
- **Companies:** companies, contacts and the client team.
  The page's epics and contacts are one request: `GET /board/companies`.
- **People and time:** users, roles and photos; timesheets, week submit and reopen; leave; the dashboard.
- **DevOps:** the board, questions to clients (chat) and DevOps requests.
  Writes are atomic; activity, chats and hours are capped.
- **Client view:** clients see status only.
  Their own bug reports are in the "No epic" group, and the bug chat runs on ticket comments.
- **Uploads:** attachments and photos go to Azure Blob.
- **Security:** stored links only open if they are web, mail, blob or file links, and the built app
  carries a Content-Security-Policy.

Known limits, each marked with a `ponytail:` comment in the code:
- Every write reloads the whole board.
- Team timesheets are read for two months; a person's own time for a year.
- Leave is read from a year back to two years ahead.
- Question and request lists return the newest 2000.

## Next steps (suggested to the user, in this order)

1. **Deploy a test copy.** Host the built app pointed at the Demo DB and add its address to the
   backend's `CORS_ORIGIN` and to Azure Blob's CORS. The host must send `frame-ancestors`
   (a page's own meta tag cannot set it). Check sign-in, live updates (SSE) and uploads there.
2. **Test with production-sized data.**
3. **Plan the switch from the old frontend.** Decide the cut-over and how long both run, and remove
   or repoint the 8 mirror-coverage tests.
4. **Optional:** make the permissions grid real. That needs backend permission changes.

Related: the old frontend's crash on Urgent and Critical priorities is fixed on
`viljetech-core/viljetech-platform`, branch `fix/new-priorities-fallback`. It still needs a pull request and a merge.
