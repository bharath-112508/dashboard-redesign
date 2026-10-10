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
| `src/features/` | Ticket drawer, bug and question window, report-a-bug form, DevOps request, epic and sprint windows |

To start over with fresh mock data, run `localStorage.removeItem('vt.clients.db')` in the browser console and reload.

## Differences from the prototype

- **Epics & sprints and Timeline are built.** In the exported prototype both tabs render blank, because of broken markup. They're built here from the prototype's own markup and code.
- **Test data left out.** Leftover test items in the prototype's saved data ("Verifier test question", "Verifier DNS access", "VerifyBug crash on open", "Client ping from verifier") aren't in the seed.
- **New sprint people are saved.** In the prototype, the "Person 1 / Person 2" choices in "New sprint" were ignored when saving. Here they become the sprint's members.
- **Escape closes every window.** In the prototype it only closed the ticket drawer.
- **The DevOps board is built (see below); Tickets may still be a placeholder.** Data the prototype shares between pages (client bugs, questions, DevOps requests) lives in the mock backend.
- **The DevOps status in the epic bar is live.** It reads the linked project (`workspace.devopsLinks`: Mobile app → OPS-101, Web app → OPS-107) from the DevOps board's data, so a status change on the board shows here. The label keeps the Clients page's own colours.
- **Today is fixed at 10 Oct 2026**, as in the design, so overdue and "days left" labels match the mock data.

# DevOps board

Front-end build of `project/DevOps Board v6.dc.html`, at `/devops/board` and `/devops/list`. It's where the DevOps team tracks each client project's status, follow-ups with the client and the dev team, phases, and the requests and questions that link it to the other pages.

## What's on the page

- **Header:** the project count with overdue, client and dev team totals, a List / Board switch and "New project". The search box, the due-now bell (it selects "Due now") and Settings sit in the shared top bar.
- **Filters:** All, Due now, Client, Dev team, Escalated and Rescheduled tabs with counts, plus the All / Client / Internal "Sequence" switch.
- **Board:** one column per status, each with its default description. Dragging a card to another column opens the status change window.
- **List:** one line per project, with a sort arrow on every column. Status and priority sort in workflow order, dates by date, and empty values always go last. Hovering a status shows its description, which you can edit and log. Hovering a project name shows its current phase.
- **Critical projects** pulse light red, with a red edge, in both views. The pulse stops when reduced motion is on.
- **Project panel** (`?project=OPS-101&tab=…`):
  - **Follow-ups:**
    - The status card, where you change the status or edit its description.
    - The Client / Internal switch.
    - The client sequence, with planned dates, per-step notes, "Move to …" (what happened, next reminder and estimated deployment), "Edit dates" with "Shift later steps", and "+ Add step" for this project only.
    - The internal sequence, where you set a date at each step.
    - Project notes.
  - **Phases:**
    - The dev phase owner, with "Next step → Set date and owner".
    - The dev phase stepper: click a date to set it, "Edit steps for this project" (reset to the defaults is available), and "Move to …" with a due date.
    - The DevOps phase timeline: edit the current phase, or use "Make current phase" for the confirm window.
  - **Activity:** every change, logged with the old value, and free-form posts.
  - **Tickets:** DevOps requests raised from Tickets for this project. Clicking one opens the request window (`?request=`). There you can change the status, priority, type and assignee, edit the description in the markdown editor, reply (`side: 'devops'`), set the start, due date and estimate (the due date and estimate lock once set), and log time. Its activity tab shows the request's history.
  - **Client chat:** raise a question to the client (`question.create` with `fromDevops` and the project key). It shows on `/clients` under "Questions to client" with a DevOps tag. The question window (`?question=`) has the chat and "Mark as solved".
  - **Sidebar:** Details pill dropdowns. Each has "+ New …", and a new status asks for a description that goes into Settings. The CI/CD switch sits under Deployment type. Below are the Dates: the estimated deployment card and editable dates, with the initial due date and dev phase due date locked when the rules say so.
- **Status change window:** opens for every status change. It shows old → new, and a description pre-filled from Settings with a "Use default" link. Moving to Client onboarding also requires the initial due date and the first reminder, and starts the client sequence.
- **Settings** (`?settings=infra|seq|dates|dev`):
  - Statuses, with their default descriptions.
  - The client sequence (hours after the previous step) and the internal sequence.
  - The step a project counts as escalated from.
  - Date rules and the default reminder time.
  - Dev phases with their typical durations, and their rules.
  - Renaming moves projects along with the new name. Projects on a removed item move as the prototype describes.
- **New project** (`?new=1`): react-hook-form + Zod. It checks that there's a name, an initial due date, a phase due date (when a current phase is set and the rule is on) and that the name is unique. It creates the next OPS key and opens the project.

## Code map

| Path | What it holds |
| --- | --- |
| `src/api/devops/types.ts` | `DevopsDb`: projects (ISO dates), settings (sequences, statuses, dev phases, rules, added options, people) |
| `src/api/devops/seed.ts` | The prototype's 11 sample projects |
| `src/api/devops/commands.ts` | `devops.project.create`, `devops.project.update` (patch, plus an optional Activity entry), `devops.option.add`, `devops.settings.save` (with rename maps) |
| `src/features/devops/model.ts` | Colours, date helpers, the sequence and phase maths, filters and field options |
| `src/features/devops/ctx.tsx` | Board context: data, `update` / `setField`, URL windows, the open menu, the status change window, and layered Escape |
| `src/features/devops/*` | Project panel and its tabs, sidebar, windows, settings, new project, hover cards |
| `src/pages/devops/` | Routes, page shell, list and board |
| `src/components/HeaderSlot.tsx` | Lets a page add controls to the shared top bar (empty on Clients) |

## Differences from the prototype

- **Top bar:** the shared app bar (DevOps board / Tickets / Clients) replaces the prototype's "Viljetech / DevOps / All projects" breadcrumb. Search, the bell and Settings sit in that bar.
- **Today is 10 Oct 2026, the app-wide date.** The prototype used 9 Oct, so relative labels ("in 3 days", "1 day ago") read one day later. The sample dates are the same.
- **Data persists** in the mock backend; the prototype lost every change on reload. Dates are stored as ISO strings and shown in the prototype's format.
- **Seed fix:** Inoff's initial due date was stored as "Due30 Nov 2026" (a typo) and showed that way in the panel. It's 30 Nov 2026 here.
- **Dead branches left out:** the inline request detail in the Tickets tab and the inline client-ticket detail in Client chat can never show in the prototype (`inlineNever`, `isDetail: false`). Only the full request and question windows are built. The request editor's "Improve description" (`window.claude`) wasn't in the template, so it isn't here.
- **The Client / Internal switch** in Follow-ups resets when the panel reopens; the prototype remembered it for the session.
- **Extra client steps survive a Settings change:** a project on a step it added keeps that step. The prototype clamped it to the default sequence.
- **Request estimate** locks as soon as it's set (on blur), using the stored estimate. The prototype kept a separate `estLock` flag that the shared request type doesn't have.
- **New project** doesn't reset the page's filter and search after creating, but it opens the new project straight away.
- **"Export a backup"** in the footer downloads the board's data as JSON; in the prototype it was a dead link.
- **Escape** closes the status window, then an open menu, then the top window. The prototype did the same, but for the project panel only.
