# Viljetech mobile

React Native app (Expo SDK 57, TypeScript strict, expo-router) built from the v4 mobile
prototype. Specs: `SPEC.md`, `DATA.md`, `BUILD-PLAN.md`, `DECISIONS.md` (mobile-spec).
All data is a local mock store (no network). Today is fixed at `TODAY = '2026-10-10'`.

## Run

```bash
cd mobile
npm install

npx expo start            # then press i (iOS simulator), a (Android emulator), w (web)
npx expo start --ios      # iOS simulator
npx expo start --android  # Android emulator
npx expo start --web --port 8091   # web at http://localhost:8091
```

Expo Go works for everything in this app (all native modules are in the SDK). Sign in with a
sample account row, or with an email from the list and the demo password `demo`.

Time history "Download CSV" downloads the file on web; on iOS / Android it writes a real
`.csv` to the cache directory (expo-file-system) and opens the share sheet (expo-sharing).

Checks:

```bash
npx tsc --noEmit                    # typecheck
npx expo export --platform web      # production web build in dist/
```

Dev gallery of the shared components: open `/dev/kitchen-sink`.

## E2E (Playwright, web at 390×844)

```bash
cd mobile/e2e && npm install
npx playwright test --output=/tmp/my-run      # starts `expo start --web` on 8091 if nothing is running
# faster: test the export build
cd mobile && npx expo export --platform web && node e2e/serve-dist.mjs 8093 &
MOBILE_BASE_URL=http://localhost:8093 npx playwright test --output=/tmp/my-run   # from mobile/e2e
```

Always pass a private `--output` folder. Specs live in `e2e/tests/` (one per package:
`p0-foundation.spec.ts`, `p1-….spec.ts`, …). Helpers in `e2e/helpers/session.ts`:
`signInAs(page, role)`, `signInWithEmail`, `expectScreen(page, id)`, `screen`, `byTestId`
(visible elements only; tab roots stay mounted), `goTab`, `tabLabels`, `selectedTab`,
`signOut`, `ACCOUNTS`, `TAB_LABELS`.

## Folder layout

```
src/app/            routes only (expo-router); thin files that render a screen
  _layout.tsx       fonts, store hydration, safe area, gestures, ToastHost, auth guard
  index.tsx         "/" → /home or /sign-in
  sign-in.tsx       S-LOGIN (P0)
  (app)/_layout.tsx signed-in stack + the floating TabBar; sheets are transparent modals
  (app)/(tabs)/     tab roots: home tickets time projects devops questions bugs more
  (app)/…           pushed screens and sheet/* routes (see the route map below)
  dev/kitchen-sink  component gallery
src/theme/          colors, typography (Schibsted Grotesk), layout (space, radii, shadows), motion
src/components/     shared UI (README.md lists each)
src/data/           types, seed, store, commands, selectors (README.md explains the pattern)
src/nav/            tabs per role, More tiles, titles, route helpers, useShellRoute
src/features/<area>/ feature screens and their components (auth is P0's sign-in)
assets/faces        staff photos exported from the prototype media.js
e2e/                Playwright package
```

Path alias: `@/…` → `src/…`.

## Store and actions

One persisted store (`src/data/store`, AsyncStorage key `vt.mobile.v4`). Screens read
with `useAppState(selector)` and write with commands from `useActions()`; each command
dispatches one named action to a pure reducer. Commands that end in a toast return its text:

```tsx
const ticket = useAppState((s) => ticketById(s, id));
const { setTicketStatus } = useActions();
const msg = setTicketStatus(id, 'done');
if (msg) showToast(msg);
```

The full command list, selectors and demo rules are in `src/data/README.md`.

## Navigation

One stack per session, as in the prototype (SPEC §1.2): a tab is the root of the `(app)`
stack and pushed screens go on top. The TabBar stays visible on pushed screens and
highlights the tab that owns the stack; it hides on `ticket` and `question` (composer) and
while a sheet is open. Tapping a tab resets the stack to that tab.

Use the helpers in `src/nav/routes.ts`, not hard-coded paths:

```ts
push(href.ticket(12));               // or toTicket(12)
push(href.project('Daco platform'));
goTab('time');
openSheet('log-time', { ticketId: 1 });
openSheet('report', { project: 'Daco website', kind: 'Change' });
closeSheet();                         // inside a sheet
router.push(hrefForKey('devops', role))  // tab for devops, pushed copy for pm/admin/super
```

Sheet params (strings in the URL, read with `useLocalSearchParams`):
`log-time {ticketId?, day?, project?, text?}`, `report {project?, kind?}`, `leave {}`,
`project-status {project}`, `support-plan {project}`.

Tabs per role, Home layout (`homeVariant(role)`: `ic`, `staffAll`, `devops`, `client`) and
More tiles (`moreTiles(state)`) are in `src/nav`.

## Route map and owners

Each route file renders a screen from `src/features/<area>/` (P1–P4). Keep the `testID="screen-<name>"` on the screen root
(`<Screen testID=…>`) so the shell tests keep working.

| Route file (src/app/…) | Screen | Owner |
|---|---|---|
| `(app)/(tabs)/home.tsx` | S-HOME (4 variants) | P1 |
| `(app)/(tabs)/tickets.tsx`, `(app)/stack/tickets.tsx` | S-TICKETS | P1 |
| `(app)/ticket/[id].tsx` | S-TICKET | P1 |
| `(app)/board.tsx` | S-BOARD | P1 |
| `(app)/inbox.tsx` | S-INBOX | P1 |
| `sign-in.tsx` | S-LOGIN | P0 (done) |
| `(app)/(tabs)/time.tsx` | S-TIME | P2 |
| `(app)/(tabs)/more.tsx` | S-MORE (working version from P0) | P2 |
| `(app)/history.tsx`, `leave.tsx`, `team.tsx`, `me.tsx` | S-HISTORY, S-LEAVE, S-TEAM, S-ME | P2 |
| `(app)/sheet/log-time.tsx`, `(app)/sheet/leave.tsx` | S-LOG, S-LEAVESHEET | P2 |
| `(app)/(tabs)/projects.tsx`, `(app)/stack/projects.tsx` | S-PROJECTS | P3 |
| `(app)/project/[name].tsx` | S-PROJECT | P3 |
| `(app)/sheet/project-status.tsx`, `(app)/sheet/support-plan.tsx` | S-PSS, S-PLAN | P3 |
| `(app)/(tabs)/questions.tsx`, `bugs.tsx`, `devops.tsx`, `(app)/stack/devops.tsx` | S-QUESTIONS, S-BUGS, S-DEVOPS | P4 |
| `(app)/question/[id].tsx`, `dvset.tsx`, `companies.tsx`, `company/[name].tsx`, `users.tsx`, `user/[name].tsx` | S-QUESTION, S-DVSET, S-COMPANIES, S-COMPANY, S-USERS, S-USER | P4 |
| `(app)/sheet/report.tsx` | S-BUG | P4 |

### Adding a screen (P1–P4)

1. Build it in `src/features/<area>/MyScreen.tsx` with `<Screen title=… header=… testID="screen-…">`
   (large header on tab roots, small on pushed screens; `noTabBar` + `footer={<Composer/>}`
   on ticket/question).
2. Make the route file render it: `export default function Route() { return <MyScreen />; }`.
3. Sheets: render `<BottomSheet title icon subtitle footer>` as the whole route body; read
   params with `useLocalSearchParams`; close with `closeSheet()`; toast after saving.
4. Need a new store action, shared component or route? Ask P0 (or add it under your
   feature folder and flag it for promotion). Only P0 edits `src/data/store`, `types.ts`,
   `constants.ts`, `src/theme`, `src/components`, `src/nav`.
