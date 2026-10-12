# Viljetech mobile

React Native app (Expo SDK 57, TypeScript strict, expo-router) built to the **v5** mobile design.
Specs: `mobile-spec-v5/` — `DECISIONS.md` (binding), `SPEC.md`, `DELTA.md`, `BUILD-PLAN.md`,
`screenshots/`. All data is a local mock store (no network). Today is fixed at
`TODAY = '2026-10-10'` (`src/data/clock.ts`).

v5 is built in packages: **F0** (foundation: data, store, roles and permissions, guards, block
components, shell — this layer) and **W1–W4** (features), which replace the placeholder route
bodies listed in the route map below.

## Run

```bash
cd mobile
npm install

npx expo start            # then press i (iOS simulator), a (Android emulator), w (web)
npx expo start --web --port 8091   # web at http://localhost:8091
```

Expo Go works for everything (all native modules are in the SDK). Sign in with a sample-user row
(it fills the email and the demo password `demo`) or type an email and `demo`.

Checks:

```bash
npx tsc --noEmit                    # typecheck
npm test                            # Jest (jest-expo): pure selectors, commands, reducer, seed integrity
npx expo export --platform web      # production web build in dist/
```

Jest tests live in `src/**/__tests__/*.test.ts` (import `describe/it/expect` from `@jest/globals`);
`src/data/__tests__/helpers.ts` has a store-less `harness(personId)` with state + commands.

Dev gallery of every block: `/dev/kitchen-sink`.

## E2E (Playwright, web at 390×844)

```bash
cd mobile/e2e && npm install
cd mobile && npx expo export --platform web && node e2e/serve-dist.mjs 8091 &
cd mobile/e2e && MOBILE_BASE_URL=http://localhost:8091 npx playwright test --output=/tmp/my-run
```

Always pass a private `--output` folder. Without `MOBILE_BASE_URL` Playwright starts
`expo start --web` on 8091. One spec per package in `e2e/tests/`: `f0-shell.spec.ts` (F0), then
`w1-…`, `w2-…`, `w3-…`, `w4-…`. Helpers in `e2e/helpers/session.ts`: `ACCOUNTS`, `ACCOUNT_KEYS`
(`super admin pm dev freelancer devops cadmin cuser`), `TAB_LABELS`, `TAB_KEYS`, `signInAs(page, key)`
(sample row + Sign in), `signInWithEmail`, `openSignIn`, `screen`, `expectScreen`, `byTestId` (visible
only; tab roots stay mounted), `headerTitle`, `goTab`, `tabLabels`, `selectedTab`, `signOut`,
`openRoute` (deep link; the session persists), `toast`, `ACCESS_DENIED`.

## Folder layout

```
src/app/            routes only (expo-router); thin files that render a screen
  _layout.tsx       Inter, store hydration (drops vt.mobile.v4), safe area, ToastHost, auth guard
  index.tsx         "/" → /home or /sign-in
  sign-in.tsx       S5-LOGIN
  (app)/_layout.tsx signed-in stack + floating TabBar + RouteGuard; URL sheets are transparent modals
  (app)/(tabs)/     tab roots: home projects tickets time devops questions bugs more
  (app)/…           pushed screens and sheet/* routes (route map below)
  dev/kitchen-sink  block gallery
src/theme/          colors (v5 tokens, tones), typography (Inter + mono), layout (space, radii, shadows), motion
src/components/     the v5 block system + shell (README.md lists each)
src/data/           types, seed, store, commands, selectors (README.md: model, commands, selectors)
src/nav/            tabs per role, access (can/perm, route guards), morePages, routes (href, sheets, tab2), titles
src/features/<area>/ feature screens (W1–W4) and the F0 embed placeholders
assets/faces        staff photos (m0 m1 m2 m4 m5 m6 w0 w1)
e2e/                Playwright package
```

Path alias: `@/…` → `src/…`.

## Roles, tabs and access

| Account | Role | Tabs |
|---|---|---|
| Rahul | super | Home · Projects · Tickets · Time · More |
| Vivek | admin | same |
| Bhavana P | pm | same |
| Chary | dev | same |
| Sofia | dev + freelancer | same |
| Arjun | devops | Home · DevOps · Time · More |
| Ingrid Solberg | cadmin | Home · Projects (portal) · Questions · Bugs · More |
| Lars Moen | cuser | same |

Page access is the web `ACC` map: `can(role, page)`. Action permissions are the editable matrix:
`perm(role, key, matrix)` / `myPerm(s, key)` (super always true). Both live in `src/data/selectors/access.ts`
and are re-exported from `src/nav/access.ts`, which also holds `ROUTE_ACCESS` (one rule per route).
**Every route is guarded** (DECISIONS 6): the `(app)` RouteGuard sends a role without access to Home with
the toast "You don't have access to this page", and `Screen` / `BottomSheet` render an access-denied
state meanwhile. Permission checks inside a screen (e.g. the "+" on Projects) stay with the owner.

## Store and actions

One persisted store (`src/data/store`, AsyncStorage key `vt.mobile.v5`, `STATE_VERSION = 2`). Screens
read with `useAppState(selector)` and write with commands from `useActions()`; each command dispatches
one named action to a pure reducer and returns a `Result` with the SPEC toast text:

```tsx
const t = useAppState((s) => ticket(s, key));
const { patchTicket } = useActions();
const r = patchTicket(key, { st: 'review' });   // { ok: true, toast: 'Moved to Review' }
toastResult(r);
```

The full command list (every V-xx flow), the selectors and the data model are in `src/data/README.md`.
Feature packages never add actions; a missing one is added under the feature and flagged for F0.

## Navigation

One stack per session (SPEC §1.2): a tab is the root, pushed screens go on top, the tab bar shows on
every signed-in screen and highlights the tab that owns the stack. Tapping a tab resets the stack. In-screen
state (tab, filters, segments) is component state.

Use `src/nav/routes.ts`, not hard-coded paths:

```ts
push(href.ticket('PMT-11'));            // openTicket(key) also clears unread (V-20)
push(href.subtask('PMT-11.s2'));        // stable subtask id (A-11)
push(href.project('dacop', 'board'));
push(href.dvp('OPS-103', 'requests'));
goTab('time');
tab2('emp', role);                      // tab if the role has it, else push (dashboard links, More, search)
openSheet('new-ticket', { pid: 'dacop' });
closeSheet();                            // inside a URL sheet
openLog({ proj: 'c:dacop', key: 'PMT-11' })  // src/features/time/openLog.ts (W3)
```

`href`: `tab, ticket, subtask, project(id, tab?), company, companyTime(co, pf?), user, question, bug,
dvp(key, tab?), request, portal, search, emp, clients, companies, users, dvset, me, leave, devopsStack`.
URL sheet params (`SheetParams`, read with `useLocalSearchParams<SheetQuery<'name'>>()`):

| Sheet | Params |
|---|---|
| `log-time` | `{date?, proj?, key?, text?, id?}` |
| `new-ticket` | `{pid}` |
| `new-project` | `{co?}` |
| `project-status` | `{id}` |
| `support-terms` | `{id}` |
| `support-request` | `{pid, kind: problem\|change}` |
| `devops-request` | `{key}` |
| `new-question` | `{pid, title?}` |
| `report-bug` | `{pid?}` |
| `leave` | `{who?}` |
| `user` | `{id?}` |
| `company` | `{id?}` |
| `contact` | `{co, i?}` |
| `client-member` | `{email?}` |

Inline sheets (field pickers, confirm, …) use `<BottomSheet visible onClose>` in the owning feature.

## Route map and owners

F0 created every route. Each W package replaces only the bodies of the files it owns (keep the
`testID="screen-<id>"` / `sheet-<name>` ids so the shell spec keeps working).

| Route file (`src/app/…`) | Screen / sheet | testID | Owner |
|---|---|---|---|
| `sign-in.tsx` | S5-LOGIN (working F0 version) | `screen-sign-in` | W3 |
| `(app)/(tabs)/home.tsx` | S5-DASH (7 roles) | `screen-home` | W1 |
| `(app)/(tabs)/tickets.tsx` | S5-MYTICKETS | `screen-tickets` | W1 |
| `(app)/search.tsx` | S5-SEARCH | `screen-search` | W1 |
| `(app)/ticket/[key].tsx` | S5-TICKET | `screen-ticket` | W1 |
| `(app)/subtask/[key].tsx` | S5-SUB (key = stable subtask id) | `screen-subtask` | W1 |
| `(app)/sheet/new-ticket.tsx` | SH-NEWTICKET | `sheet-new-ticket` | W1 |
| `(app)/(tabs)/projects.tsx` | S5-PROJECTS (staff branch); clients → `PortalScreen` (W4) | `screen-projects` | W2 |
| `(app)/project/[id].tsx` | S5-PROJECT (`?tab=`) | `screen-project` | W2 |
| `(app)/sheet/new-project.tsx` | SH-NEWPROJECT | `sheet-new-project` | W2 |
| `(app)/sheet/project-status.tsx` | SH-PROJSTATUS | `sheet-project-status` | W2 |
| `(app)/sheet/support-terms.tsx` | SH-SUPTERMS | `sheet-support-terms` | W2 |
| `(app)/sheet/support-request.tsx` | SH-SUPREQ | `sheet-support-request` | W2 |
| `(app)/(tabs)/time.tsx` | S5-TIME | `screen-time` | W3 |
| `(app)/(tabs)/more.tsx` | S5-MORE (working F0 version) | `screen-more` | W3 |
| `(app)/me.tsx` | S5-PROFILE | `screen-me` | W3 |
| `(app)/leave.tsx` | My leave (A-2) | `screen-leave` | W3 |
| `(app)/emp.tsx` | S5-EMP | `screen-emp` | W3 |
| `(app)/company-time/[id].tsx` | S5-COTS (`?pf=`) | `screen-company-time` | W3 |
| `(app)/users.tsx` | S5-USERS (staff); cadmin → `ClientTeamScreen` (W4) | `screen-users` | W3 |
| `(app)/user/[id].tsx` | S5-USER | `screen-user` | W3 |
| `(app)/companies.tsx`, `(app)/company/[id].tsx` | S5-COMPANIES, S5-COMPANY | `screen-companies`, `screen-company` | W3 |
| `(app)/sheet/log-time.tsx`, `leave.tsx`, `user.tsx`, `company.tsx`, `contact.tsx` | SH-LOG, SH-LEAVE, SH-USER, SH-COMPANY, SH-CONTACT | `sheet-<name>` | W3 |
| `(app)/(tabs)/devops.tsx`, `(app)/stack/devops.tsx` | S5-DEVOPS (tab for devops; pushed for super/admin) | `screen-devops` | W4 |
| `(app)/dvp/[key].tsx` | S5-DVP (`?tab=`) | `screen-dvp` | W4 |
| `(app)/request/[id].tsx` | S5-REQ | `screen-request` | W4 |
| `(app)/dvset.tsx` | S5-DVSET | `screen-dvset` | W4 |
| `(app)/clients.tsx`, `(app)/portal/[co].tsx` | S5-CLIENTS, S5-PORTAL staff view | `screen-clients`, `screen-portal` | W4 |
| `(app)/(tabs)/questions.tsx`, `(app)/question/[id].tsx` | S5-QUESTIONS, S5-QUESTION | `screen-questions`, `screen-question` | W4 |
| `(app)/(tabs)/bugs.tsx`, `(app)/bug/[id].tsx` | S5-BUGS, S5-BUG | `screen-bugs`, `screen-bug` | W4 |
| `(app)/sheet/devops-request.tsx`, `new-question.tsx`, `report-bug.tsx`, `client-member.tsx` | SH-NEWREQ, SH-NEWQ, SH-NEWBUG, SH-CMEMBER | `sheet-<name>` | W4 |
| `dev/kitchen-sink.tsx` | block gallery | `kitchen-sink` | F0 |

**Embed placeholders** (cross-package; the owner fills them, the host mounts them):

| File | Filled by | Mounted by |
|---|---|---|
| `src/features/devops/ProjectDevopsTab.tsx` `({projectId})` | W4 | W2 (project DevOps tab) |
| `src/features/client/ProjectQuestionsTab.tsx` `({projectId})` | W4 | W2 |
| `src/features/client/ProjectBugsTab.tsx` `({projectId})` | W4 | W2 (client Bugs tab) |
| `src/features/client/PortalScreen.tsx` | W4 | `(tabs)/projects.tsx` for clients |
| `src/features/client/ClientTeamScreen.tsx` | W4 | `users.tsx` for cadmin |
| `src/features/time/openLog.ts` `openLog(preset?)` | W3 | everyone (opens `log-time`; clients get "Your role does not log time") |

Removed in v5 (DECISIONS 4): notifications/inbox, switch account, push toggle, team hours, time history,
ticket board, the v4 leave screen, the v4 maintenance plan/report/upkeep, v4 DevOps cards and settings,
`stack/projects`, `stack/tickets`.

### Building a screen (W1–W4)

1. Build it in `src/features/<area>/MyScreen.tsx` with `<Screen title sub actions testID="screen-…">` and
   the blocks from `@/components`; tab roots pass `useRootActions()` (Search / Profile) after their own.
2. Make the route file render it: `export default function Route() { return <MyScreen />; }`.
3. URL sheets: render `<BottomSheet title sub testID="sheet-<name>">` as the whole route body; read params
   with `useLocalSearchParams<SheetQuery<'name'>>()`; close with `closeSheet()`; `toastResult(r)`.
4. Need a new action, selector, block or route? Add it under your feature folder and flag it for F0.
   Only F0 edits `src/data`, `src/theme`, `src/components`, `src/nav`.
