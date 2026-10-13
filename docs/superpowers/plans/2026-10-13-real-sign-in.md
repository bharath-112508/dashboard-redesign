# Real sign-in and people directory (Phase 1a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sign in to the web app (`app/`) with a real Demo DB account through the backend (`backend/`), and load the people directory from the API, while every other screen keeps its mock data until Phase 1b.

**Architecture:** A build-time switch picks the data source: with `VITE_API_URL` set the app runs in *API mode*, without it the app runs exactly as today (mock mode, sample users), so the e2e suite and untouched screens keep working. A small HTTP client (bearer token, one shared refresh on 401, `{data}` envelope unwrap) talks to `/api/v1`. Pure mapper functions turn backend users into the app's `Person` and `Session`. Person ids become strings everywhere, because backend ids are ObjectId strings.

**Tech Stack:** React 19, TypeScript, Vite 6, TanStack Query 5, React Router 7, Vitest 4 (new, dev only). Backend: Express 5, Mongoose, Vitest.

**Spec:** the decisions recorded in this conversation and in `README.md` (repo layout) and `backend/CLAUDE.md` (auth module). Key facts are copied into Global Constraints below.

## Global Constraints

- Development data is the shared Demo DB (`vilje-platform-demo`). Backend changes are additive only: never rewrite or delete existing documents.
- Run the backend with `npm run dev:redesign` (port 3101, email stubbed, jobs, Slack and push off). Never plain `npm run dev` for this work.
- API mode runs the app on port 5200 (`CORS_ORIGIN` allows `http://localhost:5200`); mock mode stays on 5173.
- Mock mode must behave exactly as before: sample users, demo password `demo`, all e2e specs green.
- Role mapping: `admin`→`super`, `manager`→`pm`, `team_lead`→`pm`, `employee`→`dev`, `client`→`cadmin`, `representative`→`cuser`; a `devops` entry in `role_keys` wins over `employee`/`team_lead`/`manager` → `devops`.
- Backend envelope: success `{ data }`; error `{ error: { code, message, details? } }`. Auth is `Authorization: Bearer <access_token>`; refresh is `POST /auth/refresh` with body `{ refresh_token }`, and it rotates the refresh token.
- Tokens live in `localStorage` under `vt.tokens`; the session stays under `vt.session`.
- Copy rules (user-facing text): plain sentences, no jargon, end with a full stop.

## Review Focus

1. **Wrong password / unknown email** → one message on the password field: "That email or password is not right." (backend returns 401 `INVALID_CREDENTIALS` for both; never reveal which). Test in Task 5.
2. **Account with two-step sign-in (MFA)** → login returns `mfa_required: true`; the app must not hang or crash: show "This account uses two-step sign-in, which the new app does not support yet." Test in Task 5.
3. **Access token expires mid-session** → the next request gets 401, the client refreshes once (even if five requests fail at the same moment) and retries; the user notices nothing. Test in Task 4.
4. **Refresh token expired or revoked** (signed out elsewhere) → tokens and session are cleared and the guard sends the user to `/login`, not an error screen. Test in Task 4.
5. **Client user** (`client`/`representative`, no `user.read`) → `GET /users` would 403; the people directory must fall back to just the signed-in person instead of failing the whole page. Test in Task 6.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `app/package.json`, `app/vitest.config.ts` | Vitest dev dependency and `test` script (Task 1) |
| `app/src/api/types.ts` and the 36 files that use person ids | `PersonId = string` everywhere (Task 2) |
| `app/src/api/server.ts`, `app/src/api/seed.ts` | DB_VERSION 5 + migration of stored numeric ids to strings (Task 2) |
| `backend/src/services/auth.service.ts` | `/auth/me` gains `company_id`, `company_name`, `phone` (Task 3) |
| `app/src/api/http/config.ts` | `API_URL`, `apiMode` (Task 4) |
| `app/src/api/http/tokens.ts` | read/write/clear `vt.tokens` (Task 4) |
| `app/src/api/http/client.ts` | `api.get/post`, `ApiError`, refresh-once logic (Task 4) |
| `app/src/api/http/mappers.ts` | `roleFromBackend`, `personFromUser`, `sessionFromMe` (Task 5) |
| `app/src/api/http/auth.ts` | `apiSignIn`, `apiSignOut` (Task 5) |
| `app/src/api/people/directory.ts` | `usePeople` reads the API in API mode (Task 6) |
| `app/src/pages/login/LoginPage.tsx`, `app/src/pages/shell/Shell.tsx` | real sign-in / sign-out wiring (Task 6) |
| `app/README.md` | how to run API mode (Task 7) |

---

### Task 1: Unit test harness for the app

**Files:**
- Modify: `app/package.json`
- Create: `app/vitest.config.ts`, `app/src/lib/dates.test.ts`

**Interfaces:**
- Produces: `npm test` in `app/` runs Vitest once (node environment).

- [ ] **Step 1: Install Vitest (same major as the backend)**

Run: `cd app && npm install -D vitest@^4.1.5`

- [ ] **Step 2: Add the script and config**

In `app/package.json` `scripts`, add `"test": "vitest run"`.

`app/vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
})
```

- [ ] **Step 3: Write a first test against existing code**

`app/src/lib/dates.test.ts` (check the exact exports of `lib/dates.ts` first and use one of them; `fmt` formats ISO dates as "09 Oct 2026"):
```ts
import { describe, expect, it } from 'vitest'
import { fmt } from './dates'

describe('fmt', () => {
  it('formats an ISO date with a zero-padded day', () => {
    expect(fmt('2026-10-09')).toBe('09 Oct 2026')
  })
})
```

- [ ] **Step 4: Run it**

Run: `cd app && npm test`
Expected: 1 passed. Also `npm run build` still passes (tsconfig must not pick up `vitest.config.ts` errors; if it does, add it to `tsconfig.node.json` or exclude it).

- [ ] **Step 5: Commit**

```bash
git add app/package.json app/package-lock.json app/vitest.config.ts app/src/lib/dates.test.ts
git commit -m "Add Vitest to the app for unit tests"
```

---

### Task 2: Person ids become strings

Backend user ids are ObjectId strings, so `Person.id`, `Session.personId`, `TimeEntry.userId` and the `team` arrays become `string`. Mock data keeps its numbers as strings (`'1'`, `'2'`, …) so mock mode behaves the same.

**Files:**
- Modify: `app/src/api/types.ts` (fields at lines ~133, 153, 178, 205, 258, 293, 395, 409)
- Modify: `app/src/api/seed.ts` (`personIdByName`, `DB_VERSION`), `app/src/api/people/seed.ts`, `app/src/api/users/seed.ts`, `app/src/api/companies/seed.ts`
- Modify: `app/src/api/server.ts` (`migrate`)
- Modify: every file `tsc -b` reports after the type change (36 files reference `personId`, `userId`, `findPerson(` or `.team`; list: `grep -rln "personId\|findPerson(\|userId\|\.team\b" app/src`)
- Test: `app/src/api/server.migrate.test.ts`

**Interfaces:**
- Produces: `export type PersonId = string` in `types.ts`; `findPerson(people, id: PersonId)`; `personIdByName(name): PersonId` (returns `''` when unknown, was `0`).

- [ ] **Step 1: Write the failing migration test**

Export `migrate` from `server.ts` for the test (named export `migrateForTest = migrate` is fine). `app/src/api/server.migrate.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { migrateForTest } from './server'

describe('migrate to version 5', () => {
  it('turns stored numeric person ids into strings and keeps the data', () => {
    const v4 = {
      version: 4,
      people: [{ id: 3, name: 'Chary' }],
      entries: [{ id: 1, userId: 3, date: '2026-10-06', bill: 2, non: 0 }],
      companies: [{ id: 'daco', projects: [{ id: 'dacop', team: [3, 4] }] }],
    }
    const v5 = migrateForTest(v4) as typeof v4 & { version: number }
    expect(v5.version).toBe(5)
    expect(v5.people[0].id).toBe('3')
    expect(v5.entries[0].userId).toBe('3')
    expect(v5.companies[0].projects[0].team).toEqual(['3', '4'])
    expect(v5.entries[0].bill).toBe(2)
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd app && npx vitest run src/api/server.migrate.test.ts`
Expected: FAIL (`migrateForTest` is not exported).

- [ ] **Step 3: Change the types**

In `types.ts` add `export type PersonId = string` and use it for `Person.id`, `Session.personId`, every `userId`, and both `team: number[]` → `team: PersonId[]`. Run `cd app && npx tsc -b` and fix each error at its source:
- seeds: write ids as strings (`id: '1'`), or wrap with `String(n)` where generated;
- comparisons like `p.id === Number(x)` become `p.id === x`;
- form values that were parsed with `Number(...)` for a person become plain strings;
- `personIdByName` returns `PEOPLE_SEED.find(p => p.name === name)?.id ?? ''`.
Do not change task, entry or question ids (those stay numbers in this phase).
Repeat until `npx tsc -b` is clean.

- [ ] **Step 4: Add the version 5 migration**

In `seed.ts` set `DB_VERSION = 5`. In `server.ts`, after the existing upgrades, add a step that runs for version 4 and sets `version: 5`:
```ts
/** Version 5: person ids are strings, as the backend's are. */
const toStringIds = (v: Record<string, unknown>): Record<string, unknown> => {
  const s = (x: unknown) => (typeof x === 'number' ? String(x) : x)
  const people = Array.isArray(v.people) ? v.people.map(p => (isObj(p) ? { ...p, id: s(p.id) } : p)) : v.people
  const entries = Array.isArray(v.entries) ? v.entries.map(e => (isObj(e) ? { ...e, userId: s(e.userId) } : e)) : v.entries
  const companies = Array.isArray(v.companies)
    ? v.companies.map(c =>
        isObj(c) && Array.isArray(c.projects)
          ? { ...c, projects: c.projects.map(p => (isObj(p) && Array.isArray(p.team) ? { ...p, team: p.team.map(s) } : p)) }
          : c,
      )
    : v.companies
  return { ...v, people, entries, companies, version: 5 }
}
```
Wire it so `migrate` sends a version 2, 3 or 4 store through the existing steps and then `toStringIds`, and returns a version 5 store unchanged. Check every other collection in `types.ts` that holds a `userId` (lines ~395, 409: leave and notifications) and convert those arrays the same way. Export `export const migrateForTest = migrate`.

- [ ] **Step 5: Run the unit test, type check, build**

Run: `cd app && npm test && npm run build`
Expected: all pass.

- [ ] **Step 6: Run the e2e suite in mock mode**

Run (two terminals): `cd app && npx vite --port 5200` then `cd e2e && npx playwright test` (set `E2E_CHROMIUM` to a local Chromium if `/opt/pw-browsers/chromium` does not exist, e.g. the path from `npx playwright install chromium`).
Expected: same pass count as before the change (record the baseline first by running the suite on the parent commit).

- [ ] **Step 7: Commit**

```bash
git add -A app/src
git commit -m "Use string person ids, as the backend does (DB version 5)"
```

---

### Task 3: `/auth/me` returns company and phone

Client users need their company name for the brand ("Daco project portal") and `/auth/me` is the only user read a client role may make.

**Files:**
- Modify: `backend/src/services/auth.service.ts` (`getMe`, ~line 533)
- Test: `backend/src/services/auth.service.test.ts` (extend the existing `getMe` tests; find them with `grep -n "getMe" backend/src/services/*.test.ts`)

**Interfaces:**
- Produces: `/auth/me` adds `company_id: string | null`, `company_name: string | null`, `phone: string | null`. Existing fields unchanged.

- [ ] **Step 1: Write the failing test**

Follow the existing `getMe` test's mocking style (it mocks `User.findById`). Add a case with `client_profile: { company_id: <ObjectId>, phone: '+47 1' }` and a mocked `Company.findById(...).select('name').lean()` returning `{ name: 'Daco' }`; expect `company_id` (string), `company_name: 'Daco'`, `phone: '+47 1'`. Add a staff case with `internal_profile: { phone: '+91 2' }` expecting `company_id: null`, `company_name: null`, `phone: '+91 2'`.

- [ ] **Step 2: Run it to see it fail**

Run: `cd backend && npx vitest run src/services/auth.service.test.ts -t getMe`
Expected: FAIL on the new fields.

- [ ] **Step 3: Implement**

In `getMe`, after loading `user`:
```ts
const companyId = user.client_profile?.company_id ?? null;
const company = companyId ? await Company.findById(companyId).select('name').lean() : null;
```
and add to the returned object:
```ts
company_id: companyId ? companyId.toString() : null,
company_name: company?.name ?? null,
phone: user.client_profile?.phone ?? user.internal_profile?.phone ?? null,
```
Import `Company` from `../models/company.model.js` (note the `.js` extension, required by NodeNext).

- [ ] **Step 4: Run backend tests and type check**

Run: `cd backend && npx vitest run src/services/auth.service.test.ts && npm run type-check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/auth.service.ts backend/src/services/auth.service.test.ts
git commit -m "Return company and phone from /auth/me"
```

---

### Task 4: HTTP client with token refresh

**Files:**
- Create: `app/src/api/http/config.ts`, `app/src/api/http/tokens.ts`, `app/src/api/http/client.ts`
- Test: `app/src/api/http/client.test.ts`

**Interfaces:**
- Produces:
  - `config.ts`: `export const API_URL: string` (`import.meta.env.VITE_API_URL ?? ''`), `export const apiMode: boolean` (`API_URL !== ''`).
  - `tokens.ts`: `type Tokens = { access: string; refresh: string }`; `readTokens(): Tokens | null`; `writeTokens(t: Tokens): void`; `clearTokens(): void`.
  - `client.ts`: `class ApiError extends Error { status: number; code: string }`; `api.get<T>(path): Promise<T>`; `api.post<T>(path, body?): Promise<T>`; `api.patch<T>(path, body?): Promise<T>`; `onSignedOut(cb: () => void): void` (called when refresh fails); `createClient(baseUrl, fetchImpl)` for tests.

- [ ] **Step 1: Write the failing tests**

`app/src/api/http/client.test.ts`:
```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, createClient } from './client'
import { readTokens, writeTokens } from './tokens'

const store = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
})

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

describe('api client', () => {
  beforeEach(() => {
    store.clear()
    writeTokens({ access: 'a1', refresh: 'r1' })
  })

  it('sends the bearer token and unwraps { data }', async () => {
    const f = vi.fn(async () => json(200, { data: { id: 'u1' } }))
    const api = createClient('http://x/api/v1', f)
    expect(await api.get('/auth/me')).toEqual({ id: 'u1' })
    expect(f.mock.calls[0][1].headers.Authorization).toBe('Bearer a1')
  })

  it('throws ApiError with the backend code', async () => {
    const f = vi.fn(async () => json(401, { error: { code: 'INVALID_CREDENTIALS', message: 'no' } }))
    const api = createClient('http://x/api/v1', f)
    await expect(api.post('/auth/login', {})).rejects.toMatchObject({ status: 401, code: 'INVALID_CREDENTIALS' })
    expect(ApiError).toBeDefined()
  })

  it('refreshes once for parallel 401s, then retries with the new token', async () => {
    let refreshes = 0
    const f = vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith('/auth/refresh')) {
        refreshes++
        return json(200, { data: { access_token: 'a2', refresh_token: 'r2' } })
      }
      const auth = (init.headers as Record<string, string>).Authorization
      return auth === 'Bearer a2' ? json(200, { data: 'ok' }) : json(401, { error: { code: 'TOKEN_EXPIRED', message: '' } })
    })
    const api = createClient('http://x/api/v1', f)
    const results = await Promise.all([api.get('/a'), api.get('/b'), api.get('/c')])
    expect(results).toEqual(['ok', 'ok', 'ok'])
    expect(refreshes).toBe(1)
    expect(readTokens()).toEqual({ access: 'a2', refresh: 'r2' })
  })

  it('clears tokens and signals sign-out when refresh fails', async () => {
    const signedOut = vi.fn()
    const f = vi.fn(async (url: string) =>
      url.endsWith('/auth/refresh') ? json(401, { error: { code: 'INVALID_TOKEN', message: '' } }) : json(401, { error: { code: 'TOKEN_EXPIRED', message: '' } }),
    )
    const api = createClient('http://x/api/v1', f, signedOut)
    await expect(api.get('/a')).rejects.toMatchObject({ status: 401 })
    expect(readTokens()).toBeNull()
    expect(signedOut).toHaveBeenCalledOnce()
  })
})
```

- [ ] **Step 2: Run to see them fail**

Run: `cd app && npx vitest run src/api/http/client.test.ts`
Expected: FAIL (modules missing).

- [ ] **Step 3: Implement `config.ts` and `tokens.ts`**

`config.ts`:
```ts
/** Base URL of the backend API, e.g. http://localhost:3101/api/v1. Empty means mock mode. */
export const API_URL: string = import.meta.env.VITE_API_URL ?? ''
/** True when the app talks to the real backend instead of the browser mock. */
export const apiMode = API_URL !== ''
```
Add `interface ImportMetaEnv { readonly VITE_API_URL?: string }` to `app/src/vite-env.d.ts` (create it with `/// <reference types="vite/client" />` if it does not exist).

`tokens.ts`:
```ts
export type Tokens = { access: string; refresh: string }
const KEY = 'vt.tokens'

export const readTokens = (): Tokens | null => {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(KEY) ?? 'null')
    return v && typeof v === 'object' && typeof (v as Tokens).access === 'string' && typeof (v as Tokens).refresh === 'string' ? (v as Tokens) : null
  } catch {
    return null
  }
}
export const writeTokens = (t: Tokens) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(t))
  } catch {
    // Storage blocked: the user will have to sign in again after a reload.
  }
}
export const clearTokens = () => {
  try {
    localStorage.removeItem(KEY)
  } catch {
    // Nothing to clear.
  }
}
```

- [ ] **Step 4: Implement `client.ts`**

```ts
import { API_URL } from './config'
import { clearTokens, readTokens, writeTokens } from './tokens'

/** A failed API call: HTTP status plus the backend's stable error code. */
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message)
  }
}

type Fetch = (url: string, init: RequestInit) => Promise<Response>

export const createClient = (base: string, fetchImpl: Fetch = fetch, signedOut: () => void = () => undefined) => {
  // One refresh at a time: parallel 401s all wait for the same call.
  let refreshing: Promise<boolean> | null = null

  const refresh = (): Promise<boolean> =>
    (refreshing ??= (async () => {
      const t = readTokens()
      if (!t) return false
      const res = await fetchImpl(`${base}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: t.refresh }),
      }).catch(() => null)
      if (!res?.ok) {
        clearTokens()
        signedOut()
        return false
      }
      const { data } = (await res.json()) as { data: { access_token: string; refresh_token: string } }
      writeTokens({ access: data.access_token, refresh: data.refresh_token })
      return true
    })().finally(() => (refreshing = null)))

  const call = async <T>(method: string, path: string, body?: unknown, retried = false): Promise<T> => {
    const t = readTokens()
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (t) headers.Authorization = `Bearer ${t.access}`
    const res = await fetchImpl(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
    if (res.status === 401 && t && !retried && !path.startsWith('/auth/login')) {
      if (await refresh()) return call<T>(method, path, body, true)
    }
    if (res.status === 204) return undefined as T
    const payload = (await res.json().catch(() => ({}))) as { data?: T; error?: { code?: string; message?: string } }
    if (!res.ok) throw new ApiError(res.status, payload.error?.code ?? 'UNKNOWN', payload.error?.message ?? res.statusText)
    return payload.data as T
  }

  return {
    get: <T>(path: string) => call<T>('GET', path),
    post: <T>(path: string, body?: unknown) => call<T>('POST', path, body),
    patch: <T>(path: string, body?: unknown) => call<T>('PATCH', path, body),
  }
}

const listeners = new Set<() => void>()
/** Runs when the session cannot be refreshed any more (signed out elsewhere, or expired). */
export const onSignedOut = (cb: () => void) => void listeners.add(cb)

export const api = createClient(API_URL, (u, i) => fetch(u, i), () => listeners.forEach(cb => cb()))
```

- [ ] **Step 5: Run the tests**

Run: `cd app && npx vitest run src/api/http/client.test.ts && npx tsc -b`
Expected: 4 passed, type check clean.

- [ ] **Step 6: Commit**

```bash
git add app/src/api/http app/src/vite-env.d.ts
git commit -m "Add an API client with bearer tokens and one shared refresh"
```

---

### Task 5: Mappers and API sign-in

**Files:**
- Create: `app/src/api/http/mappers.ts`, `app/src/api/http/auth.ts`
- Test: `app/src/api/http/mappers.test.ts`, `app/src/api/http/auth.test.ts`

**Interfaces:**
- Consumes: `api`, `ApiError` (Task 4); `PersonId` (Task 2); `Person`, `Session`, `Role` from `types.ts`.
- Produces:
  - `roleFromBackend(role: string, roleKeys: readonly string[]): Role`
  - `type BackendUser` (the `GET /users` item) and `personFromUser(u: BackendUser): Person`
  - `type BackendMe` (the `/auth/me` body) and `sessionFromMe(me: BackendMe): Session`
  - `apiSignIn(email, password): Promise<SignInResult>` (same `SignInResult` type as `session/signIn.ts`)
  - `apiSignOut(): Promise<void>`

- [ ] **Step 1: Write the failing mapper tests**

`app/src/api/http/mappers.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { personFromUser, roleFromBackend, sessionFromMe } from './mappers'

describe('roleFromBackend', () => {
  it.each([
    ['admin', [], 'super'],
    ['manager', [], 'pm'],
    ['team_lead', [], 'pm'],
    ['employee', [], 'dev'],
    ['client', [], 'cadmin'],
    ['representative', [], 'cuser'],
    ['employee', ['employee', 'devops'], 'devops'],
    ['unknown', [], 'dev'],
  ])('%s %j → %s', (role, keys, expected) => {
    expect(roleFromBackend(role, keys)).toBe(expected)
  })
})

describe('personFromUser', () => {
  it('maps a staff member', () => {
    const p = personFromUser({
      id: 'u1', full_name: 'Asha Rao', email: 'asha@viljetech.com', role: 'employee', status: 'active',
      timezone: 'Asia/Kolkata', internal_profile: { employment_type: 'freelancer', phone: '+91 1' }, last_login_at: null,
    })
    expect(p).toMatchObject({ id: 'u1', name: 'Asha Rao', org: 'vt', role: 'dev', emp: 'freelancer', active: true, phone: '+91 1', tz: 'Asia/Kolkata', projects: 'all' })
    expect(p.colour).toMatch(/^#[0-9A-Fa-f]{6}$/)
  })

  it('maps a client representative to their company and marks deactivated people inactive', () => {
    const p = personFromUser({
      id: 'u2', full_name: 'Lars', email: 'l@daco.no', role: 'representative', status: 'deactivated',
      timezone: 'Europe/Oslo', client_profile: { company_id: 'c1' }, last_login_at: '2026-10-01T10:00:00Z',
    })
    expect(p).toMatchObject({ org: 'c1', role: 'cuser', active: false })
  })

  it('gives the same person the same colour every time', () => {
    const u = { id: 'u9', full_name: 'X', email: 'x@y', role: 'employee', status: 'active', timezone: 'UTC', last_login_at: null }
    expect(personFromUser(u).colour).toBe(personFromUser(u).colour)
  })
})

describe('sessionFromMe', () => {
  it('builds a client session with the company name as org', () => {
    const s = sessionFromMe({
      id: 'u2', email: 'l@daco.no', full_name: 'Lars', role: 'representative', role_keys: ['representative'],
      timezone: 'Europe/Oslo', employment_type: null, company_id: 'c1', company_name: 'Daco', phone: null,
    })
    expect(s).toEqual({ personId: 'u2', name: 'Lars', email: 'l@daco.no', role: 'cuser', org: 'Daco', orgId: 'c1', tz: 'Europe/Oslo' })
  })

  it('builds a staff session', () => {
    const s = sessionFromMe({
      id: 'u1', email: 'a@viljetech.com', full_name: 'Asha', role: 'admin', role_keys: ['admin'],
      timezone: 'Asia/Kolkata', employment_type: 'staff', company_id: null, company_name: null, phone: '+91 1',
    })
    expect(s).toEqual({ personId: 'u1', name: 'Asha', email: 'a@viljetech.com', role: 'super', org: 'Viljetech', emp: 'employee', phone: '+91 1', tz: 'Asia/Kolkata' })
  })
})
```

- [ ] **Step 2: Run to see them fail**

Run: `cd app && npx vitest run src/api/http/mappers.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement `mappers.ts`**

```ts
import type { Person, Role, Session } from '../types'

const ROLE_MAP: Record<string, Role> = {
  admin: 'super',
  manager: 'pm',
  team_lead: 'pm',
  employee: 'dev',
  client: 'cadmin',
  representative: 'cuser',
}

/** The app's role for a backend user. A custom "devops" role wins over the staff roles. */
export const roleFromBackend = (role: string, roleKeys: readonly string[]): Role => {
  if (roleKeys.includes('devops') && !['admin', 'client', 'representative'].includes(role)) return 'devops'
  return ROLE_MAP[role] ?? 'dev'
}

export interface BackendUser {
  id: string
  full_name: string
  email: string
  role: string
  role_keys?: string[]
  status: string
  timezone: string
  internal_profile?: { employment_type?: 'staff' | 'freelancer' | null; phone?: string }
  client_profile?: { company_id?: string; phone?: string }
  last_login_at: string | null
}

const PALETTE = ['#4870E8', '#3F9079', '#C0392B', '#8E44AD', '#D68910', '#2E86C1', '#30B0C7', '#E67E22']
/** A stable avatar colour from the person's id. */
const colourOf = (id: string) => PALETTE[[...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % PALETTE.length]

const emp = (t: 'staff' | 'freelancer' | null | undefined) => (t === 'freelancer' ? 'freelancer' : t === 'staff' ? 'employee' : undefined)

export const personFromUser = (u: BackendUser): Person => {
  const phone = u.client_profile?.phone ?? u.internal_profile?.phone
  const e = emp(u.internal_profile?.employment_type)
  return {
    id: u.id,
    name: u.full_name,
    email: u.email,
    org: u.client_profile?.company_id ?? 'vt',
    role: roleFromBackend(u.role, u.role_keys ?? []),
    // ponytail: every person sees every project here; the backend scopes the real data. Fill from project members in Phase 1b.
    projects: 'all',
    colour: colourOf(u.id),
    active: u.status === 'active',
    last: u.last_login_at ? new Date(u.last_login_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }) : 'Never',
    tz: u.timezone,
    ...(e ? { emp: e } : {}),
    ...(phone ? { phone } : {}),
  }
}

export interface BackendMe {
  id: string
  email: string
  full_name: string
  role: string
  role_keys: string[]
  timezone: string
  employment_type: 'staff' | 'freelancer' | null
  company_id: string | null
  company_name: string | null
  phone: string | null
}

export const sessionFromMe = (me: BackendMe): Session => {
  const e = emp(me.employment_type)
  return {
    personId: me.id,
    name: me.full_name,
    email: me.email,
    role: roleFromBackend(me.role, me.role_keys),
    org: me.company_id ? me.company_name ?? 'Client' : 'Viljetech',
    ...(me.company_id ? { orgId: me.company_id } : {}),
    ...(e ? { emp: e } : {}),
    ...(me.phone ? { phone: me.phone } : {}),
    tz: me.timezone,
  }
}
```
If `Person` has other required fields that `tsc` flags, fill them with the neutral value the mock uses for a new person (see `users/commands.ts` `user.create`).

- [ ] **Step 4: Run the mapper tests**

Run: `cd app && npx vitest run src/api/http/mappers.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing sign-in tests**

`app/src/api/http/auth.test.ts` (mock the client module):
```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'

const post = vi.fn()
const get = vi.fn()
vi.mock('./client', () => ({
  api: { post: (...a: unknown[]) => post(...a), get: (...a: unknown[]) => get(...a) },
  ApiError: class extends Error { constructor(public status: number, public code: string, m: string) { super(m) } },
}))
vi.mock('./tokens', () => ({ writeTokens: vi.fn(), clearTokens: vi.fn(), readTokens: () => ({ access: 'a', refresh: 'r' }) }))

const { apiSignIn } = await import('./auth')
const { ApiError } = await import('./client')

const me = { id: 'u1', email: 'a@viljetech.com', full_name: 'Asha', role: 'admin', role_keys: ['admin'], timezone: 'UTC', employment_type: null, company_id: null, company_name: null, phone: null }

describe('apiSignIn', () => {
  beforeEach(() => { post.mockReset(); get.mockReset() })

  it('asks for an email first', async () => {
    expect(await apiSignIn(' ', 'x')).toEqual({ ok: false, field: 'email', message: 'Enter your email.' })
  })

  it('signs in and builds the session from /auth/me', async () => {
    post.mockResolvedValue({ access_token: 'a', refresh_token: 'r', user: { id: 'u1' } })
    get.mockResolvedValue(me)
    const r = await apiSignIn('a@viljetech.com', 'pw')
    expect(r).toMatchObject({ ok: true, session: { personId: 'u1', role: 'super' } })
  })

  it('gives one message for a wrong email or password', async () => {
    post.mockRejectedValue(new ApiError(401, 'INVALID_CREDENTIALS', 'Invalid'))
    expect(await apiSignIn('a@viljetech.com', 'bad')).toEqual({ ok: false, field: 'password', message: 'That email or password is not right.' })
  })

  it('refuses accounts with two-step sign-in for now', async () => {
    post.mockResolvedValue({ mfa_required: true, mfa_session_token: 't' })
    expect(await apiSignIn('a@viljetech.com', 'pw')).toEqual({
      ok: false, field: 'password', message: 'This account uses two-step sign-in, which the new app does not support yet.',
    })
  })

  it('explains deactivated and locked accounts', async () => {
    post.mockRejectedValueOnce(new ApiError(403, 'ACCOUNT_DEACTIVATED', ''))
    expect((await apiSignIn('a@b.c', 'pw')) as { message: string }).toMatchObject({ message: 'This account is deactivated. Ask an admin to reactivate it.' })
    post.mockRejectedValueOnce(new ApiError(423, 'ACCOUNT_LOCKED', ''))
    expect((await apiSignIn('a@b.c', 'pw')) as { message: string }).toMatchObject({ message: 'Too many attempts. This account is locked for a while; try again later.' })
  })
})
```

- [ ] **Step 6: Implement `auth.ts`**

```ts
import { ApiError, api } from './client'
import { sessionFromMe, type BackendMe } from './mappers'
import { clearTokens, readTokens, writeTokens } from './tokens'
import type { SignInResult } from '../session/signIn'

type LoginBody =
  | { access_token: string; refresh_token: string }
  | { mfa_required: true; mfa_session_token: string }

const MESSAGES: Record<string, { field: 'email' | 'password'; message: string }> = {
  INVALID_CREDENTIALS: { field: 'password', message: 'That email or password is not right.' },
  ACCOUNT_DEACTIVATED: { field: 'email', message: 'This account is deactivated. Ask an admin to reactivate it.' },
  ACCOUNT_LOCKED: { field: 'email', message: 'Too many attempts. This account is locked for a while; try again later.' },
}

/** Signs in against the backend and returns the session the app keeps. */
export const apiSignIn = async (email: string, password: string): Promise<SignInResult> => {
  if (!email.trim()) return { ok: false, field: 'email', message: 'Enter your email.' }
  if (!password) return { ok: false, field: 'password', message: 'Enter your password.' }
  try {
    const body = await api.post<LoginBody>('/auth/login', { email: email.trim(), password })
    if ('mfa_required' in body) {
      return { ok: false, field: 'password', message: 'This account uses two-step sign-in, which the new app does not support yet.' }
    }
    writeTokens({ access: body.access_token, refresh: body.refresh_token })
    return { ok: true, session: sessionFromMe(await api.get<BackendMe>('/auth/me')) }
  } catch (err) {
    if (err instanceof ApiError && MESSAGES[err.code]) return { ok: false, ...MESSAGES[err.code] }
    return { ok: false, field: 'password', message: 'Could not reach the server. Check your connection and try again.' }
  }
}

/** Ends the session on the server too, so the refresh token cannot be reused. */
export const apiSignOut = async () => {
  const t = readTokens()
  clearTokens()
  if (t) await api.post('/auth/logout', { refresh_token: t.refresh }).catch(() => undefined)
}
```
Check the backend's actual login validator and lockout status code (`grep -n "ACCOUNT_LOCKED" backend/src/services/auth.service.ts`) and adjust the test's status if it is not 423; the mapping is by `code`, so the status does not matter to the app.

- [ ] **Step 7: Run all app tests and type check**

Run: `cd app && npm test && npx tsc -b`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add app/src/api/http
git commit -m "Map backend users to people and sessions; sign in through the API"
```

---

### Task 6: Wire API mode into sign-in, sign-out and the people directory

**Files:**
- Modify: `app/src/api/people/directory.ts`
- Modify: `app/src/pages/login/LoginPage.tsx` (~lines 49–71 and the sample-users panel ~140–160)
- Modify: `app/src/pages/shell/Shell.tsx` (~line 121) and wherever else `clearSession()` is called for sign-out (`grep -rn "clearSession()" app/src`)
- Modify: `app/src/main.tsx` (register `onSignedOut`)
- Modify: `app/package.json` (script `dev:api`)
- Test: `app/src/api/people/directory.test.ts`

**Interfaces:**
- Consumes: `apiMode`, `api`, `onSignedOut`, `apiSignIn`, `apiSignOut`, `personFromUser`, `BackendUser`.
- Produces: `fetchPeople(session: Session | null): Promise<Person[]>` used by `usePeople`.

- [ ] **Step 1: Write the failing directory test**

`app/src/api/people/directory.test.ts`:
```ts
import { describe, expect, it, vi } from 'vitest'

const get = vi.fn()
vi.mock('../http/config', () => ({ apiMode: true, API_URL: 'http://x' }))
vi.mock('../http/client', () => ({ api: { get: (...a: unknown[]) => get(...a) } }))
const { fetchPeople } = await import('./directory')

const user = (id: string, role = 'employee') => ({ id, full_name: id, email: `${id}@x`, role, status: 'active', timezone: 'UTC', last_login_at: null })

describe('fetchPeople in API mode', () => {
  it('reads every page of /users', async () => {
    get.mockReset()
    get.mockResolvedValueOnce(Array.from({ length: 100 }, (_, i) => user(`a${i}`)))
    get.mockResolvedValueOnce([user('b1')])
    const people = await fetchPeople({ personId: 'a0', name: 'a0', email: 'a0@x', role: 'super', org: 'Viljetech' })
    expect(people).toHaveLength(101)
    expect(get).toHaveBeenNthCalledWith(1, '/users?limit=100&page=1')
    expect(get).toHaveBeenNthCalledWith(2, '/users?limit=100&page=2')
  })

  it('gives a client user just themselves instead of calling /users', async () => {
    get.mockReset()
    const people = await fetchPeople({ personId: 'c1', name: 'Lars', email: 'l@daco.no', role: 'cuser', org: 'Daco', orgId: 'co1' })
    expect(get).not.toHaveBeenCalled()
    expect(people).toEqual([expect.objectContaining({ id: 'c1', name: 'Lars', role: 'cuser', org: 'co1' })])
  })
})
```
`GET /users` returns `{ data, meta }`; the client unwraps `data`, so a page is an array. Stop when a page has fewer than 100 items.

- [ ] **Step 2: Run to see it fail**

Run: `cd app && npx vitest run src/api/people/directory.test.ts`
Expected: FAIL (`fetchPeople` missing).

- [ ] **Step 3: Implement `fetchPeople` and use it in `usePeople`**

In `directory.ts`:
```ts
import { apiMode } from '../http/config'
import { api } from '../http/client'
import { personFromUser, type BackendUser } from '../http/mappers'
import { isClientRole } from '../session/access'
import { readSession } from '../session/store'
import type { Person, Session } from '../types'

const PAGE = 100

/** The people directory: the mock's in mock mode, the backend's users in API mode. */
export const fetchPeople = async (session: Session | null): Promise<Person[]> => {
  if (!apiMode) return server.get('people')
  if (!session) return []
  // Client roles may not list users; they see themselves until the team feed exists.
  if (isClientRole(session.role)) {
    return [{ id: session.personId, name: session.name, email: session.email, org: session.orgId ?? 'vt', role: session.role, projects: 'all', colour: '#4870E8', active: true, last: 'Now' }]
  }
  const people: Person[] = []
  for (let page = 1; ; page++) {
    const batch = await api.get<BackendUser[]>(`/users?limit=${PAGE}&page=${page}`)
    people.push(...batch.map(personFromUser))
    if (batch.length < PAGE) return people
  }
}

export const usePeople = () => useQuery({ queryKey: qk.people, queryFn: () => fetchPeople(readSession()) })
```
Keep the existing imports of `useQuery`, `qk`, `server` and the `findPerson*` helpers.

- [ ] **Step 4: Run the directory test**

Run: `cd app && npx vitest run src/api/people/directory.test.ts`
Expected: PASS.

- [ ] **Step 5: Sign-in page in API mode**

In `LoginPage.tsx`:
- In the submit handler, call `apiMode ? apiSignIn(v.email, v.password) : signIn(v.email, v.password, dir, orgs)`; on success call `startSession(result.session)`, then `queryClient.invalidateQueries({ queryKey: qk.people })`, then navigate as today.
- When `apiMode` is true, do not render the "Sample users" panel or the demo-password hint (render the form alone, centred as the page already does without the panel).
- In API mode, skip `findPersonByEmail` pre-checks; the backend decides.

- [ ] **Step 6: Sign-out and expired sessions**

Where sign-out calls `clearSession()`, call `if (apiMode) void apiSignOut()` first. In `main.tsx`, register once: `onSignedOut(() => clearSession())`, so a failed refresh clears the session and `Shell` redirects to `/login`.

- [ ] **Step 7: Add the run script**

In `app/package.json` scripts: `"dev:api": "VITE_API_URL=http://localhost:3101/api/v1 vite --port 5200 --strictPort"`.

- [ ] **Step 8: Check mock mode is unchanged**

Run: `cd app && npm test && npm run build`, then the e2e suite as in Task 2 Step 6.
Expected: all pass, same count as the baseline.

- [ ] **Step 9: Commit**

```bash
git add app/src app/package.json
git commit -m "Sign in, sign out and load people through the API in API mode"
```

---

### Task 7: End-to-end check with a real Demo DB account, and docs

**Files:**
- Modify: `app/README.md` (new section "API mode")

- [ ] **Step 1: Start both sides**

Terminal 1: `cd backend && npm run dev:redesign` (wait for "Server is running").
Terminal 2: `cd app && npm run dev:api`, open http://localhost:5200.

- [ ] **Step 2: Walk the Review Focus list by hand**

With a Demo DB staff account (ask the user for one; never store it in the repo):
1. Wrong password → "That email or password is not right." under the password field.
2. Right password → Dashboard opens; the sidebar shows the real name and role label; the Users page lists the 30 active Demo DB people.
3. In DevTools, edit `vt.tokens` so `access` is garbage, then reload → still signed in (refresh worked), `vt.tokens` has new values.
4. Edit `vt.tokens` so both are garbage, then click any page → back on `/login`.
5. Sign out → `/login`; `POST /auth/logout` returned 204 in the Network tab.
6. If the user can provide a client (representative) account: sign in → Dashboard shows the company brand ("<Company> project portal"); no 403 errors in the console.
Expected: every point behaves as written. Note any failure and fix it in the owning task before continuing.

- [ ] **Step 3: Document API mode**

Add to `app/README.md`, after the run commands:
```md
## API mode (real backend)

Start the backend in safe mode, then the app against it:

    cd backend && npm run dev:redesign   # http://localhost:3101, Demo DB, no email/Slack/jobs
    cd app && npm run dev:api            # http://localhost:5200

Sign in with a real Demo DB account. In this phase only sign-in, sign-out and the people
directory come from the backend; every other screen still shows the mock data. Accounts
with two-step sign-in (MFA) cannot sign in yet.
```

- [ ] **Step 4: Commit**

```bash
git add app/README.md
git commit -m "Document API mode"
```
