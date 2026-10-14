# Clients page

Front-end build of `design/project/Clients.dc.html` from the Claude Design handoff: the page clients use to follow their project, report bugs and answer the team's questions.

React 19 + TypeScript, Vite, React Router, TanStack Query, Tailwind CSS 4, react-hook-form + Zod. By default it runs on mock data in the browser (mock mode); it can also run against the real backend in `../backend` (API mode).

```bash
cd app
npm install
npm run dev        # http://localhost:5173, mock mode
npm run build      # typecheck + production build
npm test           # unit tests (Vitest)
```

## API mode (real backend)

Start the backend in safe mode, then the app against it:

```bash
cd backend && npm run dev:redesign   # http://localhost:3101, Demo DB; no email, Slack, push or cron jobs
cd app && npm run dev:api            # http://localhost:5200
```

Sign in with a real Demo DB account. The `VITE_API_URL` variable switches the app into API mode (`src/api/http/config.ts`).

What comes from the backend so far:

- **Phase 1a:** sign-in, sign-out, the session (name, role, company) and the people directory.
- **Phase 1b-1:** companies (profile, client contacts, Viljetech staff on the company, archive) and projects (client and internal: create, progress from their tasks, epics from the project's stories, team, state including Planned and Maintenance). The adapter is `src/api/http/companies.ts`.

- **Phase 1b-2 (part 1):** epics, sprints and tickets on the Tickets and Clients pages (board, backlog, list, overview, epics & sprints, timeline), My tickets and the dashboard ticket widgets. The adapter is `src/api/http/board.ts` (mappings in `boardMappers.ts`).

- **Phase 1b-2 (part 2):** the ticket drawer's comments, history and attachments (`src/api/http/ticketDetails.ts`), read for the open ticket only.

- **Phase 1c:** timesheets — My timesheet, the dashboard quick log, the Tickets timesheet, Employee timesheets, profile week cards, hours on tickets and the support plan's hours used (`src/api/http/timesheet.ts`, mappings in `timesheetMappers.ts`).

- **Phase 1d:** users and people — the people directory everywhere, the Users page (add, edit, deactivate, roles, developer types, project access, photo), the Roles & permissions grid and the profile window (`src/api/http/users.ts`).

- **Phase 1e:** leave on the profile page — requests, balance, notices; adding, approving and rejecting (`src/api/http/leave.ts`, `src/api/users/leaveBook.ts`).

- **Live updates:** while signed in, the app keeps the backend's change stream open (`GET /events/stream`, `src/api/http/live.ts`). When anyone changes tickets, comments, epics, sprints, time, leave, people, roles, companies or the permission grid, the pages showing that data refetch it within about a second — no reload. Events carry only the kind of data that changed; what is shown is always refetched with your own rights. The stream reconnects on its own and renews the token when it expires.

DevOps and questions still show the mock data.

Leave in API mode:

- **Types are the backend's** (e.g. Casual Leave, Sick/Personal Leave, Work From Home, Compensatory Off), with its rules (pro-rata, monthly caps, holidays and weekends not counted). The three boxes show the main type's balance (Casual Leave): days left, used and pending.
- **Add leave** applies for the person whose profile is open: an admin for anyone, a manager or team lead for a direct report (new on the backend). The backend needs a reason; an empty one sends the type's name. Overlapping leave or too little balance is refused with the backend's reason.
- **Approve / Reject:** admins may approve their own leave (the backend allows it for admins only); managers decide for their direct reports. Rejecting sends the remarks "Rejected by <name>", which the backend requires.
- **Notifications** on the profile are built from the person's decided requests (the backend lets only the owner read their own notifications). Cancelled requests are not shown.
- Approving or rejecting changes real balances and writes in-app notifications on the backend; in safe mode no email, Slack or push is sent.

Users and people in API mode:

- **Adding a user** creates the backend account with a random password and emails them a link to set their own (in safe mode the email is written to the backend log). Employee ID, job title, department, joining date and reporting manager are optional on the backend now; someone without a reporting manager shows on team screens (leave approvals, team timesheets) for admins only until one is set. A client person is added to their company like a contact.
- **Removing a user deactivates them** (the backend keeps people, since their time and tickets point at them). Deactivated people show as Deactivated; admins see them in the list.
- **Roles:** Super admin = backend admin, Project manager = manager (or team lead), Developer = employee, Client admin = client, Client user = representative. **DevOps engineer** = a staff member who also holds the backend's custom `devops` role (created when the backend starts). The app's separate **Admin** role has no backend equivalent and is refused. Moving someone between staff and client is refused (deactivate and add them again).
- **Developer type** is stored on the user; the list of types and the **Roles & permissions grid** are stored on the backend (`/app-access`). The grid is display only: real access is decided by the backend's own role permissions.
- **Project access** is project membership: picking projects adds or removes the person from those projects. "All projects" changes nothing, so a developer with "All projects" still only sees the projects they are a member of.
- **Photos** come from the backend (initials when there is none, never a sample face). Uploading uses the backend's signed upload to Azure storage, like ticket attachments, and has not been tried against the real storage yet.
- **Profile window:** name, phone and time zone save to the backend. A new password is set from an emailed link (the backend needs the current password to change it directly, which this window does not ask for). The four notification toggles are kept until you sign out (no backend field yet).
- Forms now show the backend's reason when a change is refused (e.g. the last admin cannot be deactivated).
- The test user **Redesign Test Dev** (deactivated) was made by the API checks on 13 Oct 2026.

Timesheets in API mode:

- A developer reads their own time; a project manager or admin also reads their team's (the backend decides who that is). Time is read from the first day of the previous month. Clients read none.
- **Submit week** locks the week on the backend (new `timesheet_weeks` collection): logging, editing or deleting time in it is refused until it is reopened. A manager or admin can reopen anyone's week. The backend's 7-day self-edit window still applies too.
- The work type (General, Meeting, Review, DevOps) is stored with each entry (new optional backend field `work_type`). A text entry's task is stored as its category. The backend needs a description: an empty note sends the task, ticket title or work type instead, and reads back as an empty note.
- You can only log your own time: picking someone else in the Tickets timesheet is refused.
- A ticket's **Log time** adds a billable entry on that ticket for you.
- A support plan's hours used this month are the project's billable hours from the timesheets.
- DevOps request time logs are still the mock (DevOps phase).
- My timesheet's "today" is the design's fixed date (10 Oct 2026), while the dashboard uses the real date; both are as in mock mode.

Epics, sprints and tickets in API mode:

- An epic is a project's story. Tickets with no story show under that project's **No epic**, which cannot be edited; moving a ticket there clears its story.
- A sprint made before sprints had an epic shows under every epic its tickets are in (and under No epic when it has none). It is still one sprint: editing it from any epic changes it everywhere.
- A new epic goes into the project open on the Clients page (`?project=`), else the project of the selected epic, else the first project.
- Ticket keys are the backend's (`<project code>-<number>`, e.g. `AFS-7`). Subtasks are linked child tasks, shown as the checklist lines.
- **"+ Create ticket"** opens an empty ticket that is only created on the backend once it has a title; left empty it is discarded, as in mock mode.
- Priorities include **Critical** and **Urgent**, and the type **Story** (new backend values; a backend `improvement` shows as Story).
- Developers may plan tickets of projects they are members of (title, priority, dates, type, labels, sprint, epic) as well as their work fields. A change the backend refuses snaps back with its reason.
- People on tickets are matched by name to the project's members; someone who is not a member shows without a name.
- The drawer's Activity tab shows the ticket's real comments and history (the first 100 of each). Posting a comment saves it; @mentions are kept as plain text and do not notify anyone yet.
- Attaching a file uploads it to the backend's file storage (a signed upload link, then the file goes straight to storage). The storage must allow uploads from the app's address (CORS); otherwise the drawer says "The file could not be uploaded. Try again." The drawer has no download or remove button for attachments yet.
- Hours per ticket stay empty until the timesheets slice.
- Every write reloads the whole board (five requests per project). Fine at Demo DB size; a single board endpoint is the upgrade.
- The **Redesign test epic**, its sprint and the ticket RTP-2 (with one subtask) on the Redesign Test Portal project were made by the API checks on 13 Oct 2026.

Companies and projects in API mode:

- Adding a client contact creates a client user on that company and emails them a **"Set your Viljetech password"** link (valid 7 days). They choose their own password on `/reset-password?token=…&welcome=1` and then sign in with it. Nobody else ever sees a password. The contact's admin switch makes them a client admin (admins only). A contact needs an email, and the company form asks for one when a main contact is filled in.
- **Forgot password:** the login page links to `/forgot-password`, which emails a reset link to `/reset-password?token=…`. In safe mode (`npm run dev:redesign`) emails are not sent: the backend writes each one, with its link, to its log. In an environment with a real email transport they arrive in the inbox.
- **Archiving a company switches off sign-in for all its client contacts** (and ends their sessions). Restoring the company to active lets them sign in again with their own passwords. A contact removed on purpose stays removed after a restore. While a company is archived its contacts are not listed.
- Viljetech staff on a company are added and removed one at a time on the backend, and only active staff qualify. Changing the main contact's email on the company form updates that contact.
- Making a client admin a regular contact again is refused by the backend for now.
- Company logos are stored in the company as an image of at most 200 KB.
- The support plan's hours used this month show 0 until timesheets come from the backend.
- Projects can now be **Planned** or **Maintenance** (new backend statuses). An older backend running against the same Demo DB would refuse to save a project in one of these states, so only the test project below uses them for now.
- **Redesign Test AB** (archived), its project and its contacts (Kari and Nina Testsson, switched off by the archive) in the Demo DB were made by the API checks on 13 Oct 2026; they are safe to ignore.

Also:

- In API mode the login page lists **Demo DB accounts**, one per user type (`src/api/http/sampleAccounts.ts`). Picking one fills in its email; type its password. Two types have no backend account yet and are shown greyed out with the reason: **Admin** (the backend's admins sign in as Super admin) and **DevOps engineer** (no DevOps role in the backend yet). Mock mode keeps the sample users and the `demo` password.
- Backend roles map to the app's roles in `src/api/http/mappers.ts`: admin → Super admin, manager and team lead → Project manager, employee → Developer, client → Client admin, representative → Client user, and a custom `devops` role → DevOps engineer.
- Client users see only themselves in the people directory: the backend does not let client roles list users.
- Accounts with two-step sign-in (MFA) cannot sign in yet. This must be added before go-live.
- The access token is renewed in the background. If that fails (expired, or signed out elsewhere), the app signs out and shows the login page.

## What's on the page

- **Board**: three kinds of column.
  - **Bugs:** only bugs the client reported. This is the only place clients add tickets.
  - **Questions to client:** shows whether each question needs an answer, has new replies, is waiting for the team, or is solved. A client's first reply is also stored as the question's `answer`, linked to its chat message (`answerIdx`), so the chat shows it once and editing it updates the answer that lists, the Tickets questions panel and the dashboard read.
  - **Status columns:** To do, In progress, Review and Done. Cards can be dragged between them. DevOps requests for the epic's linked project show here too.
- **Epics & sprints**: the epic → sprint → task tree, with the epic requirement doc, sprint overview, "New sprint", "New epic" and "+ Create ticket".
- **Timeline**: a Gantt of the epic's tasks grouped by sprint, in a days or weeks scale.
- **Windows**: each window is opened by a URL parameter, so the browser's back button closes it and links can point straight at it.
  - **Ticket drawer** (`?ticket=`): includes subtask pages.
  - **Bug window** (`?bug=`): the client's own bug, with progress, a priority they can change, a description they can edit, attachments and a chat.

### What a client can do

Product decision: **a client only raises bugs and answers the questions sent to them.** Client roles (cadmin, cuser) may report bugs (Report a bug, InvoiceMatch Send feedback); work on their own bugs (chat, priority, description, attachments); reply to their questions, edit their own messages and mark a question solved or reopen it; view their projects, board, Epics & sprints, Timeline and the live app; and a client admin manages their own team (portal team and Colleagues). They may not create or quick-add tasks, edit team tasks, add subtasks, log time, move tasks, comment on team tasks (or DevOps requests, which they see read-only), raise DevOps requests or start questions.

- **UI:** no quick add on the status columns, no dragging, a team ticket opens as **View only** with no comment box, the request window has no comment box, and the Tickets and DevOps pages are closed to them.
- **Command layer:** `api/session/permissions.ts` (`refusal`) is checked by the mock server on every command against the signed-in session (`vt.session`), never against what the command says about its author, so a command forged in the browser is refused (`RefusedError`, "Clients cannot …") and nothing is saved. The optimistic cache update runs the same check, so a refused command never shows. Team roles are not limited by it. A real backend has to repeat this check.
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

## InvoiceMatch (v5)

Daco's accounts-payable app, a project Viljetech delivered, built from `Invoice Match.dc.html` and the v5 `Clients.dc.html`. Code in `src/features/invoice-match/`.

- **A Daco project in the Companies data:** `imp` in Daco's projects (`IM_PROJECT` in `data.ts`, added to the companies seed): Maintenance, 100%, due (delivered) 28 Sep, team Rahul, Chary and Vivek, its two epics (Matching engine, Review & reports) and a support agreement of 10h a month with 4h used. It shows on Companies and Projects like any client project.
- **Portal card:** Daco's "Your projects" lists it with the other projects in the company's data, on its own card: Completed <due date>, live at invoicematch.daco.no, uptime, version, support hours left (quota minus used), "Live · last deployed 9 Oct" with a Live chip, and a green "Open project ›". A company without the project has no such card.
- **Project board:** opening it picks its two epics (Matching engine, Review & reports), so the board, Epics & sprints and Timeline show its four done sprints and eleven delivered tickets. The header shows the IM tile, **Completed** and **Live app ↗**; the DevOps label reads **Live**; there are no DevOps requests or questions. Other projects no longer list the InvoiceMatch epics.
- **Live app** (`/clients/live/invoicematch/inbox | review | invoices/<no> | reports`): "Back to InvoiceMatch project", "Daco · Completed project · Live", the uptime chip, and the app in a browser frame whose address bar follows the page.
  - **Inbox:** KPIs, filters (All, Needs attention, Awaiting approval, Matched, On hold) with counts, search, "Review next exception".
  - **Review:** invoice, purchase order and goods receipt cards, line-by-line comparison (±2% on price, exact on quantity), Approve for payment / Put on hold / Reject with a note, Undo decision, Previous / Next.
  - **Reports:** KPIs, auto-match rate by month (October follows the approvals), exceptions by supplier, Export CSV.
- **Send feedback** (Feedback button, or ⌘⇧5 / Ctrl+Shift+5 for a snippet): title (required), description, how bad it is, and an optional **Snippet** (drag over part of the app), **Screenshot** (the whole app), **Record** (screen recording, up to two minutes) or **Upload**. Sending creates a client bug (`task.create` with `clientBug`) in Review & reports, so it shows in the Bugs column, in the bug window and in Tickets. The capture is its attachment and goes to IndexedDB like every other attachment.
- **Data:** the project's epics, sprints and tickets are in the shared workspace and tasks; the project itself is in Daco's company; the invoices are the `invoiceMatch` collection, and decisions are the `invoiceMatch.decide` command. `migrate3` adds them to stores saved before v5 (`withInvoiceMatch`). The company project is added once (`invoiceMatch.projectAdded`), so a project removed later stays removed.

### Differences from the prototype

- **Captures without html2canvas.** The prototype loads html2canvas from a CDN. Here the app's DOM is copied with its computed styles into an SVG `foreignObject` and drawn on a canvas (`capture.ts`); web fonts fall back to system fonts in the image. Browsers that refuse to draw it (Safari) show the prototype's "could not be captured, try upload" message.
- **Real ticket keys.** The thank-you card shows the bug's ticket key (PMT-…) rather than the prototype's FB-001 counter, and the project's delivered tickets are numbered after the existing tickets instead of 9000+, so new tickets keep short keys.
- **Feedback is stored like any bug.** The prototype kept reports in `vt.imBugs` and the decisions in `im.state`; here both are in the shared db, so they survive a reload and reach the team side.
- **Only the bug kind.** The prototype's code has Idea and Question kinds, but its form never shows the picker, so every report is a bug.
- **The open project is in the URL.** "Open project ›" opens `/clients/board?project=<id>` (`imp` for InvoiceMatch, `dacop` for Daco platform); the tabs and the live app's "Back to InvoiceMatch project" keep it, so a reload or a shared link reopens the project (`useProjectParam` in `state/ui.tsx`, `useOpenProject` in `pages/clients/useClientScope.ts`). Picking epics outside the project in the epic picker leaves it and drops the parameter.
- **Left out:** the "Live projects" section of the portal is switched off in the prototype (`hasLive: false`) and is not built.
- **Who can open it:** Daco's people and the Viljetech team. Other clients are sent back to the portal.

# Tickets page

The team's page, at `/tickets`, built from `design/project/Tickets.dc.html`. It works on the same tasks, epics, sprints, time entries, questions and DevOps requests as the Clients page, so anything the client does shows up here and the other way round.

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
- **The DevOps status in the epic bar is live.** It reads the linked project (`workspace.devopsLinks`: Mobile app and Web app → OPS-101, Daco platform; DevOps is project specific, so both Daco epics link to Daco's own item. Stores saved with Web app on ARC's OPS-106 are moved to OPS-101 by `migrate3`, only while the link is still OPS-106) from the DevOps board's data, so a status change on the board shows here. The label keeps the Clients page's own colours. On Tickets, a project with releases (`DvProject.releases`) shows "Live <version>" in green instead of its status, plus the company of the linked project (v5: `DvProject.project`) next to the project name when it is a client project.
- **Release notices (v4).** When a project linked to an epic has a release the signed-in person hasn't seen, the DevOps button shows **NEW** and a "<client> · <project> <version> is live" toast appears once (9 s, View deployment / Dismiss). View deployment switches to that epic and opens the Status tab. Opening the panel marks the release as seen. Seen releases are kept per person in `localStorage` (`vt.deploySeen`). The prototype fakes the 2.6.2 release arriving six seconds after load; here 2.6.2 is in the release seed (on OPS-106, ARC's Fast). Since the Web app epic links to Daco's OPS-101, which has no releases, no seeded epic links to a project with releases: the toast, the NEW badge and the Deployments timeline do not show on Tickets with the sample data (the timeline still shows on the DevOps board's OPS-106 panel).
- **Today is fixed at 10 Oct 2026**, as in the design, so overdue and "days left" labels match the mock data.

# DevOps board

Front-end build of `design/project/DevOps Board v6.dc.html`, at `/devops/board` and `/devops/list`. It's where the DevOps team tracks each client project's status, follow-ups with the client and the dev team, phases, and the requests and questions that link it to the other pages.

## What's on the page

- **Search** matches the project name (the linked project's) and the DevOps key, plus the phase, next step and owner.
- **Header:** the project count with overdue, client and dev team totals, a List / Board switch and "New project". The search box, the due-now bell (it selects "Due now") and Settings sit in the shared top bar.
- **Filters:** All, Due now, Client, Dev team, Escalated and Rescheduled tabs with counts, plus the All / Client / Internal "Sequence" switch.
- **Board:** one column per status, each with its default description. Dragging a card to another column opens the status change window.
- **List:** one line per project, with a sort arrow on every column. Status and priority sort in workflow order, dates by date, and empty values always go last. Hovering a status shows its description, which you can edit and log. Hovering a project name shows its current phase.
- **Each item is a project (v5):** DevOps is project specific, not client specific. Every DevOps item links to a real project (`project: ProjectRef`): a client project inside its company (Companies) or an internal project (Projects). The name and the initials tile come from that project, and its kind sets the item's Client / Internal kind. The board card, list row and panel header show only the name; the panel sidebar starts with a **Project** card: the project's name (a link to `/projects?q=<name>` for roles that can open Projects; plain text for the others, such as DevOps engineers, who would only get "access denied") and its meta ("Client project · <company>" or "Internal project · <area>"). Every sample item links to a project in the companies seed (the DevOps clients Inoff, Weland, Alnarp, ARC, Fa tech, OSBY, Redare, SST and Tryggrätt are seeded as companies for this).
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
- **New project** (`?new=1`): react-hook-form + Zod. The name field is a searchable select over the Projects list (client projects with their company, then internal projects; arrow keys and Enter work). Projects already on the board show "On the board · OPS-…" and can't be picked. It checks that a project is picked, that there's an initial due date and a phase due date (when a current phase is set and the rule is on). It creates the next OPS key and opens the project.

## Code map

| Path | What it holds |
| --- | --- |
| `src/api/devops/types.ts` | `DevopsDb`: projects (ISO dates), settings (sequences, statuses, dev phases, rules, added options, people) |
| `src/api/devops/seed.ts` | The prototype's 11 sample projects, their project links (`DEVOPS_PROJECT_LINKS`) and the store upgrades |
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
- **v4 design (client and project name):** the sample projects are renamed (DACO → Daco platform for Daco, and so on). A store saved before keeps its data; sample projects still under their old name get the new name and sample releases on load, and requests on them the new project name (`upgradeDevopsNames`, run from `migrate3`). The release the prototype dates "Today" is stored on the app's today (10 Oct).
- **v5: items saved before they were projects** get their link on load (`linkDevopsProjects` in `api/devops/seed.ts`, run from `migrate3` after `upgradeDevopsNames`). A sample item still under its sample name links to its sample project; if the store has no such project (or company) yet, it is added from the companies seed. Any other item links to the client project of the same name (its old client's first), or else the internal project of that name. An item with no match keeps all its data (and its old `client`) with `project: null`, and its panel says it is not linked. Requests, `workspace.devopsLinks` and the deployments stay on the DevOps item by key.
- **Left out of the v4 Deployments design:** the second Deployments block in the New project window ("Live on Production", feed, "Notify me when live on" switches, `vt.deployNotify`) reads values the prototype never computes (`dep.prod`, `dep.feed`, `dep.envs`, `dep.auto`) and has no project to show in a new-project form, so it isn't built. The unused release strip and picker (`dep.strip`, `dep.pick`) and the disabled "2.6.2 Just now" release are dead code too.  The prototype did the same, but for the project panel only.

# Timesheet, Companies and Projects (v5)

- **Timesheet links on project cards.** Each project card on Projects and each project row on a company page has a **Timesheet** button. It opens `/timesheet?project=<id>&name=<name>`.
- **Scoped timesheet pages.** A project link (`?project=`) or the company's "Timesheets" link (`?company=`) opens the history as the page itself, with no week view or tabs: "Timesheets · <name>", the period, project and group-by filters, and the download menu. A project page is grouped by day and its project filter is the project alone; a company page is grouped by project and starts on "All <company> projects". "Show all my time" goes back to the plain My timesheet. Without `name`, a client project is titled "<company> · <project>" and an internal one by its name. A link that matches nothing says so and shows no time.
- **Projects search from the URL.** `/projects?q=<text>` pre-fills the search (the DevOps panel's project link uses it).

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

- Sign-in removes the legacy `vt.dashRole` key (the prototype's role switch, spec 01 data effect) before it stores the session (`startSession` in `api/session/store.ts`).
- Sign-in checks the email against the directory (case and spaces ignored) and the password against the demo password `demo`. A password set from the profile replaces it for that person (stored as a SHA-256 hash; needs https or localhost).
- Deactivated people cannot sign in. Only `active` people can, and Ola Nilsen is seeded inactive.
- The role map (`access.ts`) is the prototype's `ACC`. It is enforced in the client only. A backend has to repeat it. What clients may write is checked in the command layer as well (see "What a client can do").
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
