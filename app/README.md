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
  - **DevOps** (with an unread badge): a Status tab, which is read-only and covers project status, deployment, CI/CD, client follow-up and, for a project with releases, a **Deployments** timeline (version, name, rolled back, day), and a Tickets tab where the team raises requests with a type, priority and tag. Opening a request marks its DevOps replies as read.
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

- **The DevOps board is built (see below); Tickets may still be a placeholder.** Data the prototype shares between pages (client bugs, questions, DevOps requests) lives in the mock backend.
- **The DevOps status in the epic bar is live.** It reads the linked project (`workspace.devopsLinks`: Mobile app → OPS-101, Web app → OPS-106) from the DevOps board's data, so a status change on the board shows here. The label keeps the Clients page's own colours. On Tickets, a project with releases (`DvProject.releases`) shows "Live <version>" in green instead of its status, plus the client's name next to the project name when the project has one.
- **Release notices (v4).** When a project linked to an epic has a release the signed-in person hasn't seen, the DevOps button shows **NEW** and a "<client> · <project> <version> is live" toast appears once (9 s, View deployment / Dismiss). View deployment switches to that epic and opens the Status tab. Opening the panel marks the release as seen. Seen releases are kept per person in `localStorage` (`vt.deploySeen`). The prototype fakes the 2.6.2 release arriving six seconds after load; here 2.6.2 is in the release seed (`api/devops/releases.ts`), so the notice shows on first visit.
- **Today is fixed at 10 Oct 2026**, as in the design, so overdue and "days left" labels match the mock data.

# DevOps board

Front-end build of `project/DevOps Board v6.dc.html`, at `/devops/board` and `/devops/list`. It's where the DevOps team tracks each client project's status, follow-ups with the client and the dev team, phases, and the requests and questions that link it to the other pages.

## What's on the page

- **Header:** the project count with overdue, client and dev team totals, a List / Board switch and "New project". The search box, the due-now bell (it selects "Due now") and Settings sit in the shared top bar.
- **Filters:** All, Due now, Client, Dev team, Escalated and Rescheduled tabs with counts, plus the All / Client / Internal "Sequence" switch.
- **Board:** one column per status, each with its default description. Dragging a card to another column opens the status change window.
- **List:** one line per project, with a sort arrow on every column. Status and priority sort in workflow order, dates by date, and empty values always go last. Hovering a status shows its description, which you can edit and log. Hovering a project name shows its current phase.
- **Client under the name:** each project has a client company (`client`). The list row, the board card and the panel header show it under the project name, and the initials tile uses the client's initials. A new project takes the client from the company that has a project of that name (Companies), or none.
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
  - **Sidebar:** Details pill dropdowns. Each has "+ New …", and a new status asks for a description that goes into Settings. The CI/CD switch sits under Deployment type. Projects with a release history (`deploys`, sample data on OPS-106) then show **Deployments**: each release with its version, name, "rolled back" in red when it was, and its day. Below are the Dates: the estimated deployment card and editable dates, with the initial due date and dev phase due date locked when the rules say so.
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
- **Escape** closes the status window, then an open menu, then the top window.
- **v4 design (client and project name):** the sample projects are renamed (DACO → Daco platform for Daco, and so on). A store saved before keeps its data; sample projects still under their old name get the new name, client and sample releases on load, and requests on them the new project name (`upgradeDevopsNames`, run from `migrate3`). The release the prototype dates "Today" is stored on the app's today (10 Oct).
- **Left out of the v4 Deployments design:** the second Deployments block in the New project window ("Live on Production", feed, "Notify me when live on" switches, `vt.deployNotify`) reads values the prototype never computes (`dep.prod`, `dep.feed`, `dep.envs`, `dep.auto`) and has no project to show in a new-project form, so it isn't built. The unused release strip and picker (`dep.strip`, `dep.pick`) and the disabled "2.6.2 Just now" release are dead code too. Search still matches the project name, not the client, as in the prototype. The prototype did the same, but for the project panel only.

# App shell, sign-in and roles

The shell wraps every page: sign-in, the role guard, the sidebar, the top bar with search, profile settings and the Back button. Built from the uploaded prototype's `template.html`, `764bb322` (session and role map) and `a5dbe222` (Login).

## Routes

Paths replace the prototype's `#PageName` hash. A hash link (`/#Dashboard?x=1`) still opens its page.

| Prototype page | Route | Sidebar item | Roles that can open it |
| --- | --- | --- | --- |
| Login | `/login` | none (no shell) | everyone |
| Dashboard | `/dashboard` | Dashboard | all seven |
| Companies | `/companies` | Companies | super, admin, pm, dev |
| Projects | `/projects` | Projects | super, admin, pm, dev |
| DevOps Board v6 | `/devops/board`, `/devops/list` | DevOps board | super, admin, devops |
| Tickets | `/tickets/<tab>` | none (search and links) | super, admin, pm, dev |
| My Tickets | `/my-tickets` | My tickets | super, admin, pm, dev (Tickets rule) |
| Clients | `/clients/board`, `/clients/plan`, `/clients/timeline`; `/clients` is the portal home | Clients ("Project portal" for client users) | super, admin, pm, cadmin, cuser |
| Timesheet | `/timesheet` | Timesheet | super, admin, pm, dev, devops |
| Employee Timesheets | `/employee-timesheets` | Employee timesheets | super, admin, pm |
| Users | `/users` | Users | super, admin, cadmin |

Pages not built yet (Dashboard, Companies, Projects, My tickets, Timesheet, Employee timesheets, Users, Clients portal home) render `pages/shell/ComingSoon.tsx` inside the shell. Each package replaces its route element.

## Code map

| Path | What it holds |
| --- | --- |
| `src/pages/shell/Shell.tsx` | The guard (`Shell`) and the frame: sidebar, top bar, Back stack, profile modal |
| `src/pages/shell/Sidebar.tsx`, `nav.ts` | Nine nav items, role filter, collapse (`vt.sideCol`), profile row, sign out, client brand |
| `src/pages/shell/GlobalSearch.tsx` | Search flyout: Pages, Tickets, Projects, Companies, People |
| `src/pages/shell/ProfileModal.tsx` | Profile settings (name, phone, time zone, notifications, password) |
| `src/pages/shell/toast.tsx` | The access-denied message |
| `src/pages/login/LoginPage.tsx` | Sign-in (LG-01..LG-06) |
| `src/api/session/` | `pages.ts` (page names and paths), `access.ts` (role map, `canAccess`), `store.ts` (`vt.session`, `useSession`), `signIn.ts` (checks) |
| `src/api/people/` | The people directory: `usePeople`, `findPerson`, `avatarOf`, the seed |
| `src/api/companies/seed.ts` | Company seed (companies collection) |
| `src/lib/media.ts` | Avatar faces (JPEG data URLs), company logos, generated logo tiles, `initials` |
| `src/components/HeaderSlot.tsx` | Renders page controls into the top bar (`#app-header-slot`). DevOps uses it for its search and epic controls |

## Sign-in and roles

- Sign-in checks the email against the directory (case and spaces ignored) and the password against the demo password `demo`. A password set from the profile replaces it for that person (stored as a SHA-256 hash; needs https or localhost).
- Deactivated people cannot sign in. Only `active` people can, and Ola Nilsen is seeded inactive.
- The role map (`access.ts`) is the prototype's `ACC`. It is enforced in the client only. A backend has to repeat it.
- No session goes to `/login`. A page the role cannot open shows "Your role (…) does not have access to …" and goes to `/dashboard`.
- Client users see the company brand and "Project portal". Their avatars show initials only.

## Data model (shared)

`src/api/types.ts` adds `Person`, `Session`, `Company` (with `CompanyContact`, `ClientProject`, `EpicSummary`), `InternalProject` and the shared `TimeEntry` (`userId` and nullable `task`). The `Db` gains `people`, `companies` and `internalProjects`. `DB_VERSION` is 3. A version 2 store is upgraded on read (`migrate` in `api/server.ts`), keeping its tickets and entries. Commands: `profile.update` (`api/commands.ts`).

Session writes are not part of the Db reducer: `vt.session` is per browser, so the profile modal writes it next to the `profile.update` command.

## Decisions beyond DECISIONS.md

- Search sits in the top bar (as the spec asks), so the collapsed sidebar has no search icon.
- Bharath Reddy Panyala is added to the directory as a developer (he appears on Tickets and in the time seed, but not in the prototype's Users list).
- Wrong password: "That password is not right." Blank password: "Enter your password." Deactivated: "This account is deactivated. Ask an admin to reactivate it."
- The sign-in hint names the demo password instead of "any password works" (the prototype's text is no longer true).
- The Tickets page highlights the Projects item in the sidebar, as the prototype does.
- Client brand: "{Company} admin panel" for client admins and "{Company} project portal" for client users (the prototype used the admin wording for both).
- Team colours in `lib/theme.ts` are unchanged, and they match the directory's colours for the four Tickets members.
