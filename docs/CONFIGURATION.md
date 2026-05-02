# Configuration — Event Tracker

> **Reader:** DevOps engineer or anyone deploying the system.
> This document covers everything needed to get the system running: environment variables, Docker setup, CI/CD workflows, NPM scripts, and production dependencies.
>
> **Related docs:** [ARCHITECTURE.md](./ARCHITECTURE.md) · [MODULES.md](./MODULES.md) · [OBSERVABILITY.md](./OBSERVABILITY.md) · [TESTING.md](./TESTING.md)

---

## Table of Contents

1. [Environment Variables](#1-environment-variables)
2. [Docker & Containerization](#2-docker--containerization)
3. [CI/CD — GitHub Actions](#3-cicd--github-actions)
4. [NPM Scripts Reference](#4-npm-scripts-reference)
5. [Dependencies](#5-dependencies)

---

## 1. Environment Variables

| Variable | Example | Required | Description |
|---|---|---|---|
| `NODE_ENV` | `production` | Yes | Affects SSL, logging, .env loading |
| `PORT` | `5000` | No (default: 5000) | HTTP server port |
| `REDIS_URL` | `redis://...` or `rediss://...` | Yes | Redis connection string |
| `DB_HOST` | `*.render.com` | Yes | PostgreSQL host |
| `DB_PORT` | `5432` | No | PostgreSQL port |
| `DB_NAME` | `event_tracker_36h0` | Yes | PostgreSQL database name |
| `DB_USER` | `event_tracker_...` | Yes | PostgreSQL user |
| `DB_PASSWORD` | `...` | Yes | PostgreSQL password |
| `API_KEYS` | `key-1,key-2` | Yes (for `/track`) | Comma-separated valid API keys for `POST /track` |
| `REDIS_STREAM_MAX_LENGTH` | `50000` | No (default: `50000`) | Maximum number of events to retain in the Redis stream |
| `LOG_LEVEL` | `info` | No (default: `info`) | Winston log verbosity (`error`,`warn`,`info`,`http`,`debug`) |
| `RATE_LIMIT_GLOBAL_WINDOW_MS` | `600000` | No (default: 600000) | Global rate limit window in ms |
| `RATE_LIMIT_GLOBAL_MAX` | `30` | No (default: 30) | Max requests per IP in global window |
| `RATE_LIMIT_WRITE_WINDOW_MS` | `60000` | No (default: 60000) | Write endpoint rate limit window in ms |
| `RATE_LIMIT_WRITE_MAX` | `30` | No (default: 30) | Max write requests per IP per window |
| `ALLOWED_ORIGINS` | `http://localhost:3000,http://localhost:5000` | No (default: `*`) | Comma-separated list of allowed CORS origins for Socket.IO |
| `HEALTH_WORKER_HEARTBEAT_THRESHOLD_SECONDS` | `30` | No (default: 30) | Heartbeat lag threshold for worker health check |
| `HEALTH_WORKER_LAG_THRESHOLD_SECONDS` | `40` | No (default: 40) | Processing lag threshold for worker health check |

- **Development:** Set in `.env` (loaded by `config/loadEnv.ts`). Copy `.example.env` to get started.
- **Production (Docker):** Set via `docker-compose.yml` `environment:` block or the `.env` file referenced under `env_file:`.

---

## 2. Docker & Containerization

### Services in `docker-compose.yml`

| Service | Container | Dockerfile | Port | Command |
|---|---|---|---|---|
| `api` | `event-tracker-api` | `docker/api.Dockerfile` | `5000:5000` | `node dist/index.js` |
| `worker` | `event-tracker-worker` | `docker/worker.Dockerfile` | none | `node dist/workers/index.js` |

Both services are on the shared bridge network `event-tracker-network`.

### Production Safety & Log Rotation

To prevent the production server from crashing due to disk exhaustion, both services are configured with a strict log rotation policy:

```yaml
    logging:
      driver: "json-file"
      options:
        max-size: "10m"
        max-file: "3"
```

- **Safety**: Logs are capped at **30MB** total (3 files x 10MB) per service.
- **Persistence**: Logs are maintained even if the container restarts.
- **Visibility**: You can watch live logs in production using `docker-compose logs -f`.

> [!IMPORTANT]
> Redis and PostgreSQL are **not** defined in `docker-compose.yml`. The project uses **external cloud-hosted** services (Render for Postgres, RedisCloud for Redis), with connection details provided via environment variables.

### Multi-Stage Dockerfiles

Both `docker/api.Dockerfile` and `docker/worker.Dockerfile` follow the same 2-stage pattern:

**Stage 1 — `builder`:**
```
node:20-alpine
  → npm ci (all deps including devDeps)
  → COPY source
  → npm run build (tsc → dist/)
```

**Stage 2 — `production`:**
```
node:20-alpine
  → npm ci --only=production (no devDeps)
  → COPY dist/ from builder
  → (API only) COPY src/public → dist/public
  → Run as non-root user nodejs:1001
  → EXPOSE 5000 (API only)
  → HEALTHCHECK (API only) — Configured with a 10-second timeout to accommodate network latency when checking remote database health.
```

> [!NOTE]
> TypeScript compiler (`tsc`) **does not** copy non-`.ts` files. That's why the `.html`, `.js`, and `.css` static assets are explicitly copied from the builder stage in the API Dockerfile.

---

## 3. CI/CD — GitHub Actions

Two workflows live in `.github/workflows/`.

### `ci.yml` — Build & Lint

**Triggers:** Push or Pull Request to `main`.

**Steps:**
1. `actions/checkout@v4` — clone the repo.
2. `actions/setup-node@v4` with Node.js 20 + npm cache.
3. `npm ci` — install exact dependencies from `package-lock.json`.
4. `npm test` — runs the full Jest suite.
5. `npx eslint` — lint the source code.

### `test.yml` — Coverage Gate

**Triggers:** Push or Pull Request to `main` / `master`.

**Steps:**
1. `actions/checkout@v4` + `actions/setup-node@v4` (Node 20).
2. `npm ci` — install dependencies.
3. Verify Docker and Docker Compose are available on the runner.
4. `npm run test:coverage` with `NODE_ENV=test` — spins up isolated containers via `docker-compose.test.yml`, runs all tests, and enforces the **80% coverage threshold** configured in `jest.config.ts`.

> [!NOTE]
> `test.yml` relies on the `globalSetup`/`globalTeardown` hooks in `jest.config.ts` to manage the test database lifecycle — no GitHub Services block is needed.

---

## 4. NPM Scripts Reference

| Script | Command | Use case |
|---|---|---|
| `dev` | `nodemon src/index.ts` | Start the API server in dev (auto-restarts on changes) |
| `dev:worker` | `ts-node src/workers/index.ts` | Start the worker in dev (manual restart) |
| `build` | `tsc` | Compile TypeScript → `dist/` for production |
| `test` | `cross-env NODE_ENV=test jest --runInBand` | Run all tests sequentially (requires Docker) |
| `test:coverage` | `cross-env NODE_ENV=test jest --runInBand --coverage` | Run tests with 80% coverage threshold |
| `lint` | `eslint src/` | Check for code style issues |
| `format` | `prettier --write ...` | Auto-format all source files |
| `format:check` | `prettier --check ...` | Verify formatting (used in CI) |
| `typecheck` | `tsc --noEmit` | Type-check without emitting files |
| `prepare` | `husky` | Sets up Git pre-commit hooks via Husky |

---

## 5. Dependencies

### Production Dependencies

| Package | Version | Role |
|---|---|---|
| `express` | ^5.1.0 | HTTP server + routing |
| `socket.io` | ^4.8.1 | WebSocket server |
| `ioredis` | ^5.7.0 | Redis client (streams, pub/sub, hashes) |
| `pg` | ^8.16.3 | PostgreSQL client (TimescaleDB) |
| `zod` | ^4.1.9 | Schema validation + TypeScript inference |
| `dotenv` | ^17.2.3 | `.env` file loader |
| `winston` | ^3.11.0 | Structured logging |
| `express-rate-limit` | ^8.3.2 | Rate limiting middleware |

### Development Dependencies

| Package | Role |
|---|---|
| `typescript` | Language compiler |
| `ts-node` | Run TypeScript directly (dev worker) |
| `nodemon` | Auto-restart on file save (dev server) |
| `jest` + `ts-jest` | Test runner + TypeScript support |
| `supertest` | HTTP integration test client |
| `socket.io-client` | WebSocket client for E2E tests |
| `cross-env` | Cross-platform env variable injection for test scripts |
| `@types/*` | TypeScript type declarations |
| `eslint` + `typescript-eslint` | Linting |
| `prettier` | Code formatting |
| `husky` | Git pre-commit hooks |
