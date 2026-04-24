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
| `npm test` / `test:watch` | Vitest |

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

## Status

Early scaffold — wiring and guardrails only. Feature modules are implemented per the `Roadmap_and_Milestones.md`.
