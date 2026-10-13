# Viljetech Platform — Backend

Backend API for the **Viljetech Company Management Platform** (User, Leave, Attendance, Project, Timesheet modules).

Built with **Node.js 20+**, **Express 5**, **TypeScript**, **MongoDB (Mongoose)** and **Pino** for structured logging.

> This repository follows the design specified in the companion planning docs:
> `Company_Management_Plan.md`, `Data_Model.md`, `API_Contract.md`, `Screens_and_Wireframes.md`, `Roadmap_and_Milestones.md`, `Build_Decisions.md`.

---

## Prerequisites

- Node.js `>= 20`
- npm `>= 10`
- A MongoDB instance (Atlas or local)

## Getting started

```bash
npm install
cp .env.example .env     # then fill in real values
npm run dev              # starts the API with hot reload
```

The server listens on `PORT` (default `3001`). Health probe: `GET /health`.

## Environment variables

See `.env.example` for the full list. Key ones:

| Variable | Purpose |
|---|---|
| `NODE_ENV` | `development` \| `production` \| `test` |
| `PORT` | HTTP port (default `3001`) |
| `LOG_LEVEL` | Pino level: `trace` \| `debug` \| `info` \| `warn` \| `error` \| `fatal` |
| `CORS_ORIGIN` | Comma-separated allowed origins, e.g. `http://localhost:5173,https://app.example.com` |
| `MONGO_URI` | MongoDB connection string |
| `JWT_SECRET` / `JWT_EXPIRES_IN` | Access token secret + TTL (plan default `8h`) |
| `JWT_REFRESH_SECRET` / `JWT_REFRESH_EXPIRES_IN` | Refresh token secret + TTL (plan default `5d`) |

> **Never commit `.env`.** Real secrets belong in Azure Key Vault in production.

## Available scripts

| Script | Description |
|---|---|
| `npm run dev` | Start with `tsx` watch mode |
| `npm run build` | Type-check and emit JS to `dist/` |
| `npm run build:prod` | Clean + build |
| `npm start` | Run compiled build (`dist/index.js`) |
| `npm run type-check` | TypeScript type-check only (no emit) |
| `npm run lint` / `lint:fix` | ESLint |
| `npm run format` | Prettier |
| `npm test` / `test:watch` | Vitest unit tests |
| `npm run coverage` | Vitest with v8 coverage report (text + html → `coverage/`) |
| `npm run smoke` | Phase-1 black-box smoke runner (curl + bash). Requires a dev server at `:3001`. |
| `npm run smoke:no-reset` | Same as above without re-seeding the users collection. |

## Project structure

```
src/
  config/          # env, db, and other runtime config
  constants/       # enums, role names, collection names
  controllers/     # thin Express handlers (per module)
  services/        # business logic (per module)
  models/          # Mongoose schemas
  validators/      # request schema validation (Zod)
  middlewares/     # auth, error handler, request validation
  jobs/            # scheduled / background jobs
  routes/          # route registration
  types/           # shared TS types
  utils/           # logger, jwt, app-error, helpers
  index.ts         # app bootstrap
tests/             # vitest + supertest
```

> Zod schemas live under `src/validators/`. Controllers call `validate({ body|query|params })` from `middlewares/validate.middleware.ts`, which delegates to those schemas.

## Logging

Uses **Pino** (high-perf structured JSON logs) with `pino-http` for request logging.
- Development: pretty-printed via `pino-pretty`.
- Production: line-delimited JSON to `stdout` (picked up by Azure Log Stream / Application Insights).
- Every request is auto-tagged with an `x-request-id` (generated with ULID unless provided by the client).
- Sensitive paths (`authorization`, `password`, `refresh_token`, …) are redacted.

## Security baseline

- `helmet`, strict CORS whitelist via `CORS_ORIGIN`
- Global rate-limit on `/api` (120 req/min/IP, tuneable)
- JSON body limit `1mb`
- Global error handler with standardized response shape
- Graceful shutdown on `SIGINT` / `SIGTERM`
- Handlers for `unhandledRejection` / `uncaughtException`

## Conventions

- **Field naming:** `snake_case` across DB, request/response bodies, and query params (per `Data_Model.md`).
- **Dates:** UTC timestamps on the wire; user-facing dates are `YYYY-MM-DD` with per-user timezone (default `Asia/Kolkata`).
- **API versioning:** all routes mount under `/api/v1/...` (see `API_Contract.md`).

## Phase-1 smoke runner

The `scripts/smoke-*.sh` files are black-box `bash + curl` suites that hit a
running dev server on `:3001` and assert end-to-end behaviour for each Phase-1
domain (auth, MFA, password reset, users, settings, office locations,
attendance, holidays, leaves, notifications). The umbrella runner
`scripts/smoke-all.sh` orchestrates them in dependency order:

```bash
# in one terminal
npm run dev

# in another, with the dev server's stdout captured for the forgot-password smoke
SERVER_LOG=/tmp/vjt-dev.log npm run smoke
# or skip the user-table reset (faster on subsequent runs)
SERVER_LOG=/tmp/vjt-dev.log npm run smoke:no-reset
# or pin to a single smoke
bash scripts/smoke-all.sh smoke-leaves.sh
```

Exit code is the cumulative count of assertion failures across smokes
(0 = all green). Each smoke is `set -u` clean and bash-3.2 compatible
(works on stock macOS).

## Slack interactive setup (Phase 0–2)

The backend exposes two webhook surfaces Slack hits with signed
payloads:

- `POST /api/v1/slack/interactive` — Block Kit button clicks (Approve / Reject leave).
- `POST /api/v1/slack/commands/:command` — slash commands: `/checkin`, `/checkout`, `/status`.

Both verify `X-Slack-Signature` (HMAC-SHA256 of `v0:<ts>:<rawBody>`)
with `SLACK_SIGNING_SECRET` and reject anything older than 5 min.
Unsigned / mis-signed requests get a 401 before the controller runs.

### Dev wiring

The backend has to be reachable over HTTPS for Slack to deliver
webhooks. Use a stable tunnel (ngrok / cloudflared / smee) and point
your Slack app at it:

1. Slack app → **Basic Information** → copy the **Signing Secret** →
   set `SLACK_SIGNING_SECRET=<value>` in `viljetech-platform-backend/.env`.
2. Slack app → **Interactivity & Shortcuts** → enable → Request URL =
   `https://<your-tunnel>/api/v1/slack/interactive`.
3. Slack app → **Slash Commands** → create each of `/checkin`,
   `/checkout`, `/status`. Request URL for each =
   `https://<your-tunnel>/api/v1/slack/commands/<command>`.
4. Reinstall the app to the workspace (Slack re-issues the bot token).
   In Viljetech, paste the new token at **Admin → Settings → Slack**
   (it's stored AES-encrypted at rest).
5. Restart the backend.

Quick smoke (the 401 confirms the signature middleware is wired):

```bash
curl -X POST http://localhost:3001/api/v1/slack/interactive \
    -H 'Content-Type: application/json' \
    --data '{}'
# → 401 Unauthorized
```

To verify a real signed call from Slack: click any Approve/Reject
button on a leave message in `#leaves`, or run `/checkin` in any
channel. The backend logs `SLACK_INTERACTIVE_REJECTED` (warn) for
sig-fail / unknown-action / permission-denied so grepping the logs
shows rejected webhooks at a glance.

## Status

Early scaffold — wiring and guardrails only. Feature modules are implemented per the `Roadmap_and_Milestones.md`.
