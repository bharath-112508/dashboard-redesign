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
- **DevOps board and Tickets are placeholders.** The top-bar links go to a "not part of this build" page. Data the prototype shares with those pages (client bugs, questions, DevOps requests) lives in the mock backend.
- **Today is fixed at 10 Oct 2026**, as in the design, so overdue and "days left" labels match the mock data.
