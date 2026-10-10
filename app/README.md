# Clients page

Front-end build of `project/Clients.dc.html` from the Claude Design handoff: the page clients use to follow their project, report bugs and answer the team's questions.

React 19 + TypeScript, Vite, React Router, TanStack Query, Tailwind CSS 4, react-hook-form + Zod. Mock data only; there is no backend.

```bash
cd app
npm install
npm run dev        # http://localhost:5173
npm run build      # typecheck + production build
```

## What's on the page

- **Board**: three kinds of column.
  - **Bugs:** only bugs the client reported. This is the only place clients add tickets.
  - **Questions to client:** shows whether each question needs an answer, has new replies, is waiting for the team, or is solved.
  - **Status columns:** To do, In progress, Review and Done. Cards can be dragged between them. DevOps requests for the epic's linked project show here too.
- **Epics & sprints**: the epic → sprint → task tree, with the epic requirement doc, sprint overview, "New sprint", "New epic" and "+ Create ticket".
- **Timeline**: a Gantt of the epic's tasks grouped by sprint, in a days or weeks scale.
- **Windows**: each window is opened by a URL parameter, so the browser's back button closes it and links can point straight at it.
  - **Ticket drawer** (`?ticket=`): includes subtask pages.
  - **Bug window** (`?bug=`): the client's own bug, with progress, a priority they can change, a description they can edit, attachments and a chat.
  - **Question window** (`?question=`).
  - **DevOps request** (`?request=`): only comments can be added.
  - **Report a bug** (`?report=1`).
- **Epic bar**: the epic and sprint pickers, "Report a bug", and the DevOps status, which is a label only.

## Code map

| Path | What it holds |
| --- | --- |
| `src/api/types.ts` | Data model |
| `src/api/seed.ts` | Mock data, taken from the prototype |
| `src/api/server.ts` | Mock backend. Data is stored in `localStorage` (`vt.clients.db`), every call waits ~180 ms, and changes sync across open tabs. Swap this file for real HTTP calls. |
| `src/api/commands.ts` | Every write is a command. One reducer runs both in the mock server and as the optimistic React Query update. |
| `src/api/queries.ts` | Query and mutation hooks (`useTasks`, `useSend`, …) |
| `src/state/ui.tsx` | Board filters, epic and sprint selection, and the URL-driven windows |
| `src/pages/clients/` | The page shell and its three views |
| `src/pages/tickets/` | The Tickets page (team side): shell, epic bar and its eight views |
| `src/features/tickets/` | The DevOps panel and the "Questions to client" panel |
| `src/api/tickets/commands.ts` | Commands only the Tickets page sends |
| `src/state/page.tsx` | Which side a page is (client or team): shared windows read it for behaviour and avatar colours |
| `src/features/` | Ticket drawer, bug and question window, report-a-bug form, DevOps request, epic and sprint windows |

To start over with fresh mock data, run `localStorage.removeItem('vt.clients.db')` in the browser console and reload.

## Differences from the prototype

- **Epics & sprints and Timeline are built.** In the exported prototype both tabs render blank, because of broken markup. They're built here from the prototype's own markup and code.
- **Test data left out.** Leftover test items in the prototype's saved data ("Verifier test question", "Verifier DNS access", "VerifyBug crash on open", "Client ping from verifier") aren't in the seed.
- **New sprint people are saved.** In the prototype, the "Person 1 / Person 2" choices in "New sprint" were ignored when saving. Here they become the sprint's members.
- **Escape closes every window.** In the prototype it only closed the ticket drawer.
- **The DevOps board is built separately.** Data the Clients page shares with the Tickets page and the DevOps board (client bugs, questions, DevOps requests) lives in the mock backend.
- **Today is fixed at 10 Oct 2026**, as in the design, so overdue and "days left" labels match the mock data.

# Tickets page

The team's page, at `/tickets`, built from `project/Tickets.dc.html`. It works on the same tasks, epics, sprints, time entries, questions and DevOps requests as the Clients page, so anything the client does shows up here and the other way round.

## What's on the page

- **Tabs** (`/tickets/<tab>`, with the same Back button as the Clients page):
  - **Overview:** KPI cards (hours logged, needs attention, overdue, critical open, over estimate), then Needs attention, Over estimate, Missed timelines, Time spent by person, Most hours logged and Recent activity.
  - **Board:** To do, In progress, Review, **Bugs** (bugs still to do, placed before Done) and Done. Each column has a "+" at the top and at the bottom that creates a ticket (a Bug in the Bugs column) and opens it to type the title. Cards drag between columns. DevOps requests for the epic's linked project show as cards.
  - **Tasks:** every ticket matching the filters, as a table.
  - **Backlog:** the epic's open sprints and its backlog, a "move to sprint" menu on every row and an input to create backlog items.
  - **Epics & sprints** and **Timeline:** the same views as the Clients page.
  - **Timesheet:** totals, entries filtered by person and range, notes that expand, delete, and a "+ Log time" form. Time can be logged on a ticket, a subtask or a DevOps request.
  - **Files:** every attachment on every ticket, search and filters, Upload and drag and drop.
- **Epic bar:** the epic and sprint pickers and:
  - **DevOps** (with an unread badge): a Status tab, which is read-only and covers project status, deployment, CI/CD and client follow-up, and a Tickets tab where the team raises requests with a type, priority and tag. Opening a request marks its DevOps replies as read.
  - **Questions to client** (with a "new reply" badge): raise a question with a title, details, photos, an optional type (Blocker, Information, Requirement or custom), an optional priority and a linked sprint, and see every question with its status. The question then opens in the question window, where the team chats with the client, adds photos and marks it solved. The client sees it in their "Questions to client" column.
- **Ticket drawer:** the same drawer as on the Clients page, with subtasks, the locked due date and estimate, the hours and minutes log, contributors and assignees. Bugs the client reported also have a **Client chat** tab, which is the conversation the client sees in their bug window.
- **Avatars** use the team's personal colours (`TEAM_COLORS` in `lib/theme.ts`). The Clients page keeps grey initials. The page sets this through `PageContext` (`state/page.tsx`).

## Differences from the prototype

- **Quick-add is the ticket drawer.** In the prototype, a column's "+" creates a blank ticket and opens it (`_openCt`). It works the same here. The prototype's older inline "What needs doing?" input and its unused create-ticket form (`_openCtOld`) aren't built.
- **The sprint picker filters the Timesheet.** In the prototype, the Timesheet ignores the multi-select sprint picker even though it's shown. Here it applies.
- **"Seen" state for questions is saved.** Which client replies the team has seen on a question is stored (`seenT`, like the DevOps requests already were), so the "New reply" badge stays cleared after a reload. In the prototype it was kept in memory only.
- **Form controls use normal letter spacing.** In the prototype, buttons and inputs reset to the browser's normal letter spacing. A rule scoped to `[data-page="tickets"]` in `index.css` does the same, so the tabs and buttons line up with the prototype to the pixel. The Clients page is unchanged.
- **One small gap is left as it is.** The shared ticket drawer's "Move to In progress" button has a slightly wider gap before the status name in the prototype, an artifact of how bindings render. That button is shared with the Clients page, so it's left as built.
- **Unreachable views are left out.** The panels' in-place detail views (`cqt.isDetail`, `dv.hasSel`) can't be reached in the prototype, because clicking an item opens the full window, so they aren't built. The same goes for the old Epics and Sprints views (`isEpics`, `isSprints`), which have no tab.
- **DevOps project details are seed data.** Deployment, the estimated deployment date, CI/CD, the follow-up step and the owner shown in the DevOps panel are optional fields on `workspace.devops`. The DevOps board will own them.
- **Questions and requests use their ids.** A new question gets the next free id. A new request gets the next free id and `REQ-<count>`, rather than `Date.now()`.
