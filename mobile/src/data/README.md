# src/data: types, seed, store, selectors

Everything the app knows lives in one persisted store. Screens **read** with selectors and
**write** with named commands; they never touch state directly (DECISIONS.md 4).

```
clock.ts        TODAY ('2026-10-10'), WEEK_MONDAY, WEEK_TARGET_HOURS, greetingFor(date)
format.ts       hm, sh, shY, dow, ini, diff, addD, dateRange, dayCount, plural
types.ts        entity types (DATA.md §1)
constants.ts    lookup tables: TICKET_STATUS, TICKET_TYPE, PRIORITY, SUPPORT_STATUS,
                SUPPORT_PRIO, PROJECT_STATUS(_OPTIONS), SPRINT_STATE, LEAVE_STATUS,
                PHASE_TONE, KPI_ICON, STAFF_ROLES, ROLE_ACCESS, PLAN_*, LOG_MINUTES, INTERNAL_*
seed/           the DATA.md seed: people, tickets, projects (+ SPRINTS, PLANS, CLIENT_COMPANY),
                maintenance (+ REPORTS, EMPTY_MAINTENANCE), work (questions, leave, entries,
                TEAM_WEEK_BASE), devops, notifications (static feeds)
media/          FACES (assets/faces/*.jpg) and LOGO_XML (company logos as SVG strings)
store/          state.ts, actions.ts, reducer.ts, store.ts (persistence), commands.ts, hooks.ts
selectors/      pure functions of AppState
```

Import from `@/data` (barrel) or from the file directly.

## Reading

```tsx
import { useAppState } from '@/data/store';
import { myTickets, unreadCount, weekData } from '@/data/selectors';

const tickets = useAppState(myTickets);
const unread = useAppState(unreadCount);
const week = useAppState((s) => weekData(s, offset));
```

`useAppState(selector)` re-renders on every store change and runs the selector during
render. Keep selectors pure and cheap; derive in the component with `useMemo` if needed.

## Writing

```tsx
import { useActions } from '@/data/store';
import { showToast } from '@/components/Toast';

const { setTicketStatus } = useActions();
const msg = setTicketStatus(ticket.id, 'prog');   // "PMT-22 moved to In progress"
if (msg) showToast(msg);
```

Each command resolves ids, keys, the acting person and dates from the current state, then
dispatches one named action (`store/actions.ts`) to the pure reducer (`store/reducer.ts`).
Commands that end in a toast return its text. Form validation (exact copy in SPEC.md)
stays in the sheet; commands only guard against impossible input.

| Flow | Command | Action type |
|---|---|---|
| M-01 | `signIn(email, password)` → `{ok}` or `{ok:false, field, message}` | `session/signIn` |
| M-02 | `signInAs(name)` | `session/signIn` |
| M-03 | `switchAccount()` (keeps the email draft) | `session/switchAccount` |
| M-04 | `signOut()` (clears the email) | `session/signOut` |
| — | `setEmailDraft(email)` | `session/setEmailDraft` |
| M-06 | `markRead(id)` | `notifications/markRead` |
| M-07 | `markAllRead()` | `notifications/markAllRead` |
| M-09 | `setPush(on)` | `profile/setPush` |
| M-12 | `setTicketStatus(id, st)` → toast | `tickets/setStatus` |
| M-13 | `addTicketComment(id, text, att)` → sent? | `tickets/addComment` |
| M-20 | `setTicketDesc(id, desc)` | `tickets/setDesc` |
| M-21/22 | `createClientTicket({project, kind, title, desc, att})` → Ticket (key for the toast) | `tickets/create` |
| M-14/15/16/34 | `addTimeEntry({day, ticketId, project, text, hours, bill, note})` → toast; adds hours to the ticket | `time/addEntry` |
| M-23 | `addQuestionMessage(id, text, att)` (side from the role) | `questions/addMessage` |
| M-35 | `addLeave({type, from, to, reason})` | `leave/add` |
| M-36 | `decideLeave(id, 'Approved' \| 'Rejected')` → toast; writes decidedBy/When | `leave/decide` |
| M-28 | `setProjectStatus(project, status)` → toast | `projects/setStatus` |
| M-29 | `savePlan(project, plan)` → toast; sets maint and view 'sup' | `projects/savePlan` |
| M-30 | `toggleRequestBilling(project, reqId)` | `maintenance/toggleBilling` |
| M-31 | `assignRequest(project, reqId)` → toast; assigns the signed-in person | `maintenance/assign` |
| M-32 | `toggleUpkeepTask(project, taskId)` | `maintenance/toggleTask` |
| M-37 | `advanceDevopsPhase(project)` → toast or null at the last phase | `devops/advancePhase` |
| M-38 | `adjustReminder(i, ±1)`, `addReminder()`, `toggleRule(key, label)`, `movePhaseUp(i)`, `addPhase(name)` | `devops/*` (each writes the change log) |
| M-40 | `setPortalPerm(company, contact, perm, on)`, `toggleCompanyArchived(company)` → toast | `companies/*` |
| M-41 | `setUserRole(name, role)` → toast, `toggleUserActive(name)` → toast | `users/*` |
| UI | `setUi(patch)`, `setProjectView(project, view)` | `ui/set` |
| Demo | `resetDemoData()` (keeps the session) | `demo/reset` |

UI preferences that the prototype persisted (ticket filter, week offset, open day, project
filter, view per project, report month, tree open state, DevOps expanded cards, board
filters, history filters, team offset, archived tab) live in `state.ui` (`UiPrefs` in
`store/state.ts`). Drafts (composer text, sheet forms, errors) are component state and are
not persisted.

## Selectors

| File | Selectors |
|---|---|
| session | `me`, `myRole`, `personByName`, `findPersonByEmail`, `sampleAccounts`, `staffPeople`, `capabilities(role)`, `avatarOf` |
| tickets | `myTickets`, `isOpen`, `ticketById`, `ticketByKey`, `dueInfo`, `byDue`, `ticketCardVM`, `myTicketCounts` |
| time | `weekRange(off)`, `myEntries`, `weekData(s, off)`, `weekTotals(days)`, `teamWeek(s, off)` |
| notifications | `notificationsFor(role)`, `notifications`, `unreadCount` |
| questions | `questionStatus(q)`, `questionsNeedingClient`, `questionById` |
| projects | `projectByName`, `companyOf`, `companyByName`, `projectsOfCompany`, `maintenanceOf`, `visibleProjects`, `isActiveOrPlanned`, `groupByCompany`, `activeProjectStats`, `sprintsOf`, `epicsOf`, `activeSprint` |
| misc | `pendingApprovals`, `myLeaves`, `remindersDue`, `nextPhase` |

`capabilities(role)` gives: `staffAll`, `isIC`, `isClient`, `isFree`, `isDevops`,
`canApprove`, `canSetProjectStatus`, `hasLeave`, `showIdle`, `maintMode`
('client' | 'staff' | 'ic'), `seesPhotos`, `seesCritical`.

Navigation-related derived data lives in `src/nav` (`moreTiles(s)`, `tabsFor(role)`,
`homeVariant(role)`).

## Rules and demo shortcuts

- **TODAY** is fixed; never use `new Date()` for data. Only `greetingFor()` reads the clock.
- Time entries with `who: '*'` (`ANY_USER`) are the demo week: every account sees them as
  its own. New entries store the person's name.
- Team hours (`teamWeek`) = the seeded weekly base per person (earlier weeks scaled by the
  prototype's demo factor) + hours that person logged in the app. Home and the Team hours
  screen both use it (DECISIONS.md 8).
- Past timesheet weeks are generated by `weekData` (6h on PMT-08 + 1.5h standup per weekday).
- `setUserRole` changes the Users & roles label (`person.staffRole`), not the sample
  account's sign-in role. Deactivated accounts cannot sign in with email.
- Static, never-mutated seed (sprints, monthly reports, notification feeds, team base)
  is imported from `seed/` by selectors and is not in the state.
- Persistence: AsyncStorage key `vt.mobile.v4`, the whole `AppState` (`STATE_VERSION`).
  Bump `STATE_VERSION` in `store/state.ts` when the shape changes; older saves are dropped.

## Adding state (P0 follow-up)

Only P0 edits `store/*`, `types.ts` and `constants.ts`. To add a mutation: add the action to
`actions.ts`, handle it in `reducer.ts`, add a command in `commands.ts`, list it above.
