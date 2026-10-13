# src/data: types, seed, store, selectors (v5)

Everything the app knows lives in one persisted store (AsyncStorage key `vt.mobile.v5`,
`STATE_VERSION = 2`; the old `vt.mobile.v4` key is removed on start and never migrated).
Screens **read** with selectors and **write** with named commands; they never touch state.

```
clock.ts        TODAY ('2026-10-10', the one place to change it), WEEK_MONDAY, DAY_MIN, WEEK_MIN, DEMO_PASSWORD
format.ts       diff, addD, fmt ("10 Oct"; "30 Aug 2027" outside TODAY's year), fmtY, fmtL ("Sat 10 Oct"), fmtRange, hm (minutes → "1h 30m"),
                ini, monday, dvDate (ISO → "12 Oct 2026, 07:00"), dvShort, plural, csv, hash, hashPw
types.ts        entity types (DELTA §3), web names and ids
constants.ts    ROLES, ROLE_LABEL, ROLE_COLOURS, PAGE_ACCESS (ACC), PERMS, PDEF, TICKET_STATUS (+client labels),
                PRIORITY_DOT, PRIORITY_SOFT, TYPE_TAG, PROJECT_STATE, AREAS, DEVTYPES, COUNTRIES, TIME_ZONES,
                LEAVE_KINDS, FACE_OF, NAME_COLOURS, INFRA, DEVOPS_STATUS_TONE/devopsTone, DEVOPS_PHASES/phaseOf,
                LADDER, OFFS, ILADDER, DEVSTEPS, DEVDAYS, DEVOPS_PEOPLE, DEVOPS_REQUEST_TYPES, DVF,
                DEFAULT_DEVOPS_SETTINGS, REMINDER_TIME
seed/           people, companies (+ PROJECTS, EPICS), sprints, tickets, time (E0 + TEAM_E), leave,
                client (QUESTIONS, BUGS, BUG_CHAT, CLIENT_TEAM), devops (DEVOPS, DEPLOYS, DEVOPS_REQUESTS),
                dashboardDemo (static demo numbers kept by A-1)
media/          FACES (assets/faces m0 m1 m2 m4 m5 m6 w0 w1) and LOGO_XML (company logos)
store/          state.ts, actions.ts, reducer.ts (pure), store.ts (persistence), commands.ts, hooks.ts
selectors/      pure functions of AppState
```

Import from `@/data` (barrel) or the file.

## Model notes (binding: mobile-spec-v5/DECISIONS.md)

- **People** use the web ids and colours (Rahul 1, Vivek 2, Chary 3, Bhavana P 4, Sofia 5, Arjun 6,
  Ingrid 7, Lars 8, Kari 9, Ola 10). Roles: super, admin, pm, dev, devops, cadmin, cuser; a freelancer
  is `dev` + `emp: 'freelancer'` (`isFreelancer`). Teams, assignees, leave, entries and owners refer to
  people by **name** (B-2). `Session = {personId}`.
- **Projects** are one flat list: `kind: 'client'` (with `companyId`) or `'internal'` (with `area`), plus
  `keyPrefix` for new ticket keys (A-13; i1 = INT, never OPS — the seed tickets are INT-3 and INT-5).
  `projAll` hides projects of archived companies; `project(id)` finds any. Epics are separate
  (`epicsOf` returns a pseudo-epic `{id: projectId}` for a project without epics). Sprints are state.
- **Tickets**: `key` is the id; `title`, `projectId`, `epicId`, `sprintId` (null = backlog), `as`
  (names), `blk`, `unread`, `att: FileRef[]`. Logged time is derived (`loggedMin`, includes subtasks).
- **Subtasks** have stable ids `"<KEY>.s<n>"` (A-11). The displayed key stays positional (`PMT-11.2`,
  `subKey`/`subOf`). Links (`href.subtask(id)`) and time entries use the id; `subOf`/`tkOrSub` accept
  either form.
- **Time** is in minutes: `{id, who, date, proj: 'c:<id>'|'i:<id>'|'x:admin', key, task, min, bill, note}`.
  Seed `E0` entries have `who: '*'` (they belong to whoever is signed in, as v5's `mine`); generated
  `TEAM_E` entries have `team: true` and are hidden for the signed-in person. Always read through
  `entriesAll` / `myEntries` / `entriesBetween` / `weekBars`.
- **Leave** kinds are the web values `Annual | Sick | Holiday | Personal` (DECISIONS 2 / B-3; labels in
  `LEAVE_KINDS`). v5 comp-off records map to Holiday / Personal. There is no comp-off balance any more.
- **DevOps** is project-specific (DECISIONS 3): every `DevopsProject` has `projectId`; name, tile and
  company come from the project (`devopsAll`, `devopsByKey`, `devopsFor(projectId)` return a
  `DevopsView` with `name`, `company`, `project`, `openRequests`). The seed adds the DevOps clients
  (Inoff, Weland, Alnarp ×2, ARC, Fa tech, OSBY, Redare, SST, Tryggrätt) as companies with projects (A-5).
  Dates are ISO (A-14): days `2026-11-30`, reminders `2026-10-12T07:00`; format with `dvDate`.
  Requests store the DevOps `key`; the project name is derived (`requestProjectName`).
- **Bugs** carry `projectId` (A-16) and ISO `when`; the conversation is `bugChat[bugId]`.
- **Questions** carry `projectId` and a ticket key in `task`.
- **Dashboard** numbers are computed where data exists (A-1); `seed/dashboardDemo.ts` has the rest
  (hours sold, capacity, uptime, SLA, incidents, support history, upkeep tasks, `demoCheckIn`).

## Reading

```tsx
import { useAppState } from '@/data/store';
import { myTickets, projVis, devopsFor, myPerm } from '@/data/selectors';

const tickets = useAppState(myTickets);
const canCreate = useAppState((s) => myPerm(s, 'tickets.create'));
const dv = useAppState((s) => devopsFor(s, projectId));
```

`useAppState(selector)` re-renders on every store change and runs the selector during render.
Keep selectors pure and cheap; `useMemo` in the screen for heavy derivations.

## Access (`selectors/access.ts`, re-exported by `@/nav/access`)

| Function | Meaning |
|---|---|
| `can(role, page)` | page access, the web `ACC` map (`'My Tickets'` = Tickets) |
| `perm(role, key, matrix = PDEF)` | action permission; super always true; clients none |
| `myCan(s, page)`, `myPerm(s, key)` | the same for the signed-in person (matrix from the store) |
| `canSetProjectStatus(role)` | super, admin, pm (status badge, support terms) |
| `canEditDevopsSettings(role)` | super, admin, devops |
| `canDv(s)` | `devops.edit` or role devops (every DevOps edit) |
| `canEditPermissions(role)` | super, admin (Users → Permissions) |
| `isClient(s)`, `isClientRole(role)`, `isFreelancer(person)`, `seesPhotos(role)` | role helpers |

`time.others` is in the matrix and gates nothing (DECISIONS 6 / A-6).

## Selectors

| Area | Selectors |
|---|---|
| session | `me`, `myRole`, `myName`, `personById`, `personByName`, `personByEmail`, `roleLabel`, `orgName`, `sampleAccounts`, `activeStaff`, `avatarOf` |
| projects | `projAll`, `project`, `company`, `projectTitle`, `projVis`, `canSeeProject`, `projectsOfCompany`, `epicsOf`, `epicName`, `projectOfEpic`, `sprint`, `sprintsOf`, `activeSprintOf`, `ticketsOf`, `projOpts`, `projLabel`, `projValue`, `viewerIsClient` |
| tickets | `ticket`, `subKey`, `subOf`, `tkOrSub`, `loggedMin`, `dueInfo`, `isLate`, `myTickets`, `unreadTotal`, `subProgress`, `nextTicketKey` |
| time | `entriesAll`, `myEntries`, `entriesBetween`, `weekBars`, `sumMin` |
| client | `isOpenQuestion`, `openQuestions`, `questionsOf`, `visibleQuestions`, `visibleBugs`, `bugsOfCompany`, `bug`, `question`, `clientTeamOf` |
| devops | `devopsAll`, `devopsByKey`, `devopsFor`, `devopsPickerProjects`, `isDevopsOverdue`, `requestsFor`, `openRequests`, `request`, `requestProjectName`, `nextDevopsKey` |

`morePages(role)` and the tab sets live in `src/nav`.

## Writing

```tsx
import { useActions } from '@/data/store';
import { showToast, toastResult } from '@/components';

const { createTicket } = useActions();
const r = createTicket({ projectId: 'dacop', title });
if (!r.ok) setError(r.field, r.error);   // "Required" on title
else { showToast(r.toast); closeSheet(); }   // "PMT-32 created"; r.key = 'PMT-32'
```

Every command returns `Result`: `{ok: true, toast, ...extra}` or `{ok: false, error, field?}`. It
resolves ids, keys, dates and the acting person, validates impossible input (with the SPEC copy),
dispatches one named action (`store/actions.ts`) to the pure reducer and returns the toast text
(`''` when the flow has no toast). Form-level "Required" checks are also done by the commands (the
`field` tells the sheet where to show it).

| Flow | Command | Action |
|---|---|---|
| V-01 | `signIn(email, password)` → `{personId}`; errors "Enter your email.", "We don't recognise that email.", "That password is not right.", deactivated | `session/signIn` |
| V-03 | `signOut()` | `session/signOut` |
| V-04 | `saveProfile({name, phone, tz, notif, password, repeat})` → "Profile saved"; "Add your name", "Password needs at least 8 characters", "Passwords do not match" | `profile/save` |
| V-10/11/12 | `saveTimeEntry({id?, date, proj, mode, key, text, h, m, bill, note})` → "1h 30m logged" (errors in SPEC order); `deleteTimeEntry(id)` → "Entry deleted" | `time/save`, `time/delete` |
| V-31 | `createTicket({projectId, title, type, epicId, sprintId, prio, as, due, est, desc})` → `{key}`, "PMT-32 created" | `tickets/create` |
| V-21/22/48 | `patchTicket(key, patch)` (status → "Moved to Review"; `as` needs tickets.assign) | `tickets/patch` |
| V-20 | `markTicketRead(key)` (staff) | `tickets/markRead` |
| V-29 | `addTicketComment(key, text)` | `tickets/addComment` |
| V-28 | `attachToTicket(key, {n, size})` → "Attachment added" | `tickets/attach` |
| V-27 | `linkBlocker(key, blockerKey)`, `clearBlockers(key)` | `tickets/patch` |
| V-23 | `addSubtask(key, title)` → `{id}`, "Subtask added" | `subtasks/add` |
| V-24 | `toggleSubtask(key, subId, {short?})` → "Completed PMT-11.2" / "Reopened …" ("Marked done" with short) | `subtasks/patch` |
| V-25 | `patchSubtask(key, subId, patch)`, `commentOnSubtask(key, subId, text)` | `subtasks/patch`, `subtasks/comment` |
| V-26 | `deleteSubtask(key, subId)` → "Subtask deleted" | `subtasks/delete` |
| V-41 | `createProject({kind, companyId, area, name, desc, start, due, team})` → `{id}`, "Project started" | `projects/create` |
| V-42 | `setProjectStatus(id, state)` → "Status set to Maintenance" (maint creates `sup`; done → 100%) | `projects/patch` |
| V-54 | `saveSupportTerms(id, until, quota)` → "Support terms saved" | `projects/patch` |
| V-51 | `saveProjectTeam(id, team)` → "Team updated" | `projects/patch` |
| V-50 | `addProjectFile(id, {n, size})` → "File added" | `projects/addFile` |
| V-49 | `createEpic(projectId, name, req)` → "Epic created" | `epics/create` |
| V-46 | `createSprint(epicId, {start, weeks})` → "Sprint added" | `sprints/create` |
| V-47 | `startSprint(id)` → "Sprint 3 started" or "Complete Sprint 2 first" (A-12); `completeSprint(id)` → "Sprint 2 completed" (unfinished → backlog) | `sprints/start`, `sprints/complete` |
| V-48 | `moveTicketToSprint(key, sprintId \| null)` → "Moved" | `tickets/patch` |
| V-55 | `createSupportRequest({projectId, kind, title, desc, prio})` → "Sent to the support team" | `tickets/create` |
| V-53 | `createQuestion({projectId, title, text, task})` → "Question sent to Daco" | `questions/create` |
| V-60 | `answerQuestion(id, answer)` → "Answer sent to the team" | `questions/answer` |
| V-61 | `reportBug({projectId, epicId, title, desc, file})` → "Bug reported. Thank you." | `bugs/create` |
| V-62/63 | `replyOnBug(id, text)`, `setBugStatus(id, st)` (staff) | `bugs/reply`, `bugs/setStatus` |
| V-64 | `saveClientMember({id?, name, title, email})` → "Invite sent" / "Saved" / "Check the email address"; `removeClientMember(id)` → "Member removed" (the sheet confirms first) | `clientTeam/*` |
| V-71 | `saveUser({id?, name, email, role, devType, emp, projects, active, org})` → "Invite sent to x" / "User saved" / "Someone already uses that email" | `users/add`, `users/update` |
| V-72 | `setUserActive(id, active)` → "User activated"/"User deactivated"; `removeUser(id)` → "User removed" | `users/setActive`, `users/remove` |
| V-73 | `addLeave({who, kind, from, to, reason})` → "Leave added" (approver) / "Request sent for approval"; "End date is before start date" | `leave/add` |
| V-74 | `decideLeave(id, 'approved' \| 'rejected')` → "Approved"/"Rejected" | `leave/decide` |
| V-75 | `togglePermission(role, key)` (super/admin) | `perms/toggle` |
| V-80 | `createCompany({name, logo, industry, country, web, contact, contactEmail})` → `{id}`, "Company created" | `companies/create` |
| V-81 | `updateCompany(id, patch)` → "Saved" | `companies/update` |
| V-82 | `saveContact(companyId, index \| null, contact)` → "Contact saved"; `removeContact(companyId, index)` | `contacts/*` |
| V-83 | `setCompanyArchived(id, archived)` → "Company archived"/"Company restored" | `companies/setArchived` |
| V-91 | `createDevopsProject({projectId, infra, owner, initDue, note})` → `{key}`, "OPS-112 created" | `devops/create` |
| V-92 | `setDevopsStatus(key, infra)` → "Status updated" (Client onboarding starts the ladder; Deployment Completed sets deploy) | `devops/patch` |
| V-93 | `setDevopsField(key, field, value, reason?)` (options; ISO dates; reminder → 07:00 + overdue; latestDue → reason + moved; initDue locked) | `devops/patch` |
| V-94 | `setDevopsText(key, text, 'next' \| 'phase')` | `devops/patch` |
| V-95 | `logFollowUp(key, {type, note, reminder, advance, nextName})` → "Follow-up logged" (rules decide required fields) | `devops/patch` |
| V-96/97/98 | `setDevPhase(key, phase)`, `toggleCicd(key)`, `addDevopsNote(key, text)` | `devops/patch`, `devops/addNote` |
| V-52 | `createDevopsRequest({key, type, prio, to, text})` → "Request sent to DevOps" (REQ-n + log line) | `requests/create` |
| V-99 | `setRequestStatus(id, 'Open' \| 'Done')`, `commentOnRequest(id, text)` | `requests/*` |
| V-100 | `saveDevopsSettingsItem(list, index \| null, name, days?)` (rename propagates), `removeDevopsSettingsItem(list, index)` (projects move to the first status), `toggleDevopsRule(rule)` | `devopsSettings/*` |
| — | `resetDemo()` | `demo/reset` |
