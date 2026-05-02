# Architecture — Event Tracker

> **Reader:** Engineer joining the project.
> This document covers how the system is designed, how data moves through it, and the Redis primitives that make it work.
>
> **Related docs:** [MODULES.md](./MODULES.md) · [CONFIGURATION.md](./CONFIGURATION.md) · [OBSERVABILITY.md](./OBSERVABILITY.md) · [TESTING.md](./TESTING.md)

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [System Architecture](#2-system-architecture)
3. [Directory Structure](#3-directory-structure)
4. [End-to-End Data Flow](#4-end-to-end-data-flow)
5. [Key Redis Concepts Used](#5-key-redis-concepts-used)
6. [Dependency Map](#6-dependency-map)

---

## 1. Project Overview

**Event Tracker** is a distributed, real-time analytics backend. Its core job is:

1. **Accept** arbitrary user/browser events over an HTTP API (`POST /track`).
2. **Buffer** those events in a **Redis Stream** — a durable, ordered log.
3. **Process** the stream in a background **Worker** that aggregates counts and persists them to **TimescaleDB** (PostgreSQL with time-series extensions).
4. **Broadcast** live updates to connected browsers via **Socket.IO** using Redis Pub/Sub.
5. **Display** the live aggregated counts on a client-side rendered **dashboard** (`GET /dashboard`).

The system is split into two independent processes:

| Process | Start command | Purpose |
|---|---|---|
| **API Server** | `npm run dev` | HTTP server + Socket.IO gateway |
| **Worker** | `npm run dev:worker` | Streams consumer + DB writer |

Both processes talk to the same **Redis** instance and **PostgreSQL** database, but they run independently and can be scaled or restarted separately.

---

## 2. System Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           CLIENT / BROWSER                              │
│                                                                         │
│  POST /track ──────────────────────────────────────────► API Server     │
│  GET  /dashboard ──────────────────────────────────────► API Server     │
│  WebSocket (socket.io) ◄───────────────────────────────── API Server    │
└──────────────────────────────────┬──────────────────────────────────────┘
                                   │
                   ┌───────────────▼───────────────┐
                   │        API SERVER             │
                   │  (src/index.ts + router)      │
                   │                               │
                   │  ┌─────────────────────────┐  │
                   │  │  Express HTTP Server    │  │
                   │  │  + Socket.IO            │  │
                   │  └──────────┬──────────────┘  │
                   │             │  xadd            │
                   └─────────────┼──────────────────┘
                                 │
              ┌──────────────────▼──────────────────────┐
              │              REDIS                       │
              │                                         │
              │  Stream key: "events"                   │
              │  Hash key:   "analytics:event_counts"   │
              │  String key: "analytics_worker:last_id" │
              │  Channel:    "analytics-update" (PubSub)│
              └──────┬───────────────────────┬──────────┘
                     │ xread (blocking)      │ subscribe
                     │                       │
       ┌─────────────▼──────────┐   ┌────────▼──────────────────┐
       │    WORKER PROCESS      │   │  API Server (subscriber)   │
       │  (src/workers/index.ts)│   │  (src/sockets/index.ts)    │
       │                        │   │                            │
       │  - Reads stream        │   │  - Receives publish msg    │
       │  - Aggregates counts   │   │  - Emits via Socket.IO to  │
       │  - Publishes to PubSub │   │    all connected browsers  │
       │  - Writes to Postgres  │   └────────────────────────────┘
       └─────────┬──────────────┘
                 │ INSERT / UPSERT
       ┌─────────▼──────────────┐
       │  PostgreSQL / TimescaleDB  │
       │  Table: event_counts   │
       └────────────────────────┘
```

---

## 3. Directory Structure

```
event-tracker/
│
├── docker/                       # Docker build definitions
│   ├── api.Dockerfile            # API service Dockerfile
│   └── worker.Dockerfile         # Worker service Dockerfile
│
├── src/                          # All TypeScript source code
│   ├── index.ts                  # Thin boot file — calls createApp(), connectAll(), listen()
│   ├── app.ts                    # App factory: Express setup, middleware, routes, graceful shutdown
│   │
│   ├── config/
│   │   └── loadEnv.ts            # .env loader (skipped in production)
│   │
│   ├── db/
│   │   └── connection.ts         # PostgreSQL pool + Redis client (shared)
│   │
│   ├── router/
│   │   └── eventTracker.ts       # Express routes: POST /track, GET /dashboard, GET /analytics
│   │
│   ├── schema/
│   │   └── eventSchema.ts        # Zod schema for incoming event payloads
│   │
│   ├── middleware/
│   │   ├── validation.middleware.ts   # Generic Zod validation middleware factory
│   │   ├── rateLimiter.middleware.ts  # globalLimiter + writeLimiter (express-rate-limit)
│   │   └── apiKey.middleware.ts       # x-api-key header authentication
│   │
│   ├── workers/
│   │   └── index.ts              # Background worker: stream consumer + DB writer
│   │
│   ├── sockets/
│   │   └── index.ts              # Socket.IO init + Redis Pub/Sub subscriber
│   │
│   ├── utils/
│   │   ├── logger.ts             # Winston logger (structured, PII-redacting)
│   │   └── metrics.ts            # Prometheus metrics builder (zero-dependency)
│   │
│   └── public/
│       ├── index.html            # Static HTML dashboard UI
│       ├── style.css             # Dashboard CSS (dark/glassmorphism theme)
│       └── js/
│           └── dashboard.js      # Client-side render + Socket.IO logic
│
├── tests/                        # Automated test suite (Jest + Docker)
│   ├── globalSetup.ts            # Spins up docker-compose.test.yml before all tests
│   ├── globalTeardown.ts         # Tears down test containers after all tests
│   ├── setup.ts                  # Per-file setup (env config)
│   ├── unit/                     # Pure logic tests — no DB required
│   │   ├── schema.test.ts
│   │   ├── validation.middleware.test.ts
│   │   ├── apiKey.middleware.test.ts
│   │   ├── rateLimiter.middleware.test.ts
│   │   └── metrics.test.ts
│   ├── integration/              # Real Docker containers (Postgres + Redis)
│   │   ├── track.test.ts
│   │   ├── stats.test.ts
│   │   ├── analytics.test.ts
│   │   ├── health.test.ts
│   │   ├── metrics-endpoint.test.ts
│   │   └── rateLimiter.test.ts
│   └── e2e/                      # Full-stack: event → stream → socket
│       └── track-to-socket.test.ts
│
├── sql/
│   └── init.sql                  # TimescaleDB table creation + hypertable setup
│
├── .github/
│   └── workflows/
│       ├── ci.yml                # GitHub Actions CI (build, test, lint)
│       └── test.yml              # GitHub Actions test pipeline (coverage gate)
│
├── logs/                         # Winston log output (error.log, combined.log)
├── dist/                         # Compiled JavaScript output (from tsc)
│
├── .env                          # Local secrets (not committed to git)
├── .example.env                  # Template for env variables
├── .env.test                     # Environment variables for the test suite
├── docker-compose.yml            # Orchestrates API + Worker containers
├── docker-compose.test.yml       # Isolated test infrastructure (Postgres:5433, Redis:6380)
├── jest.config.ts                # Jest configuration (ts-jest, 80% coverage threshold)
├── tsconfig.json                 # TypeScript compiler configuration
├── package.json                  # NPM scripts and dependencies
├── eslint.config.mjs             # ESLint rules
├── .prettierrc                   # Prettier formatting rules
└── test_track.sh                 # Shell script for manual event testing
```

---

## 4. End-to-End Data Flow

### Step 1 — Client sends an event

A client (browser, curl, test script) sends an HTTP `POST` request:

```http
POST /track HTTP/1.1
Content-Type: application/json

{
  "eventName": "page_view",
  "url": "/home",
  "userId": "u-123",
  "metadata": { "browser": "Chrome" }
}
```

### Step 2 — Validation Middleware runs

`validate(trackEventSchema)` in `validation.middleware.ts` calls `schema.safeParse(req.body)`.

- **If invalid** → responds `400` with field-level error details (from Zod's `flatten()`).
- **If valid** → replaces `req.body` with the sanitized+typed data and calls `next()`.

### Step 3 — Event written to Redis Stream

The route handler in `router/eventTracker.ts` calls:

```ts
    const maxLen = Number(process.env.REDIS_STREAM_MAX_LENGTH) || 50000;
    
    await redisClient.xadd(
      "events", // Redis stream key
      "MAXLEN",
      "~",
      maxLen,
      "*", // Auto-generate ID
      "userId",
      eventPayload.userId ?? "",
      "eventName",
      eventPayload.eventName ?? "",
      "url",
      eventPayload.url ?? "",
      "metadata",
      JSON.stringify(eventPayload.metadata ?? {})
    );
```

Redis Streams work like an append-only log. Each entry gets a unique monotonic ID (`<timestamp>-<seq>`). The stream acts as a durable buffer between the API and the Worker.

### Step 4 — Worker reads the stream (blocking poll)

The Worker process (`workers/index.ts`) runs a controlled `while(!isShuttingDown)` loop. On each iteration it calls:

```ts
redisClient.xread("BLOCK", 5000, "STREAMS", "events", lastReadId)
```

- `BLOCK 5000` — waits up to 5 seconds for new entries before returning `null`. This avoids busy-waiting.
- `lastReadId` — only entries **after** this ID are returned. This is a "bookmark" that starts at `0-0` (all entries) or the last saved bookmark from Redis.

### Step 5 — Worker aggregates in Redis

For each batch of entries received, the worker builds a Redis **pipeline** (transaction):

```ts
const multi = redisClient.multi();
for (const entry of entries) {
  multi.hincrby("analytics:event_counts", eventName, 1);
}
await multi.exec();
```

`HINCRBY` atomically increments the count field for a given event name inside the hash `analytics:event_counts`. This is the running total across all time.

### Step 6 — Bookmark is saved

After processing a batch, the worker saves the **ID of the last processed entry** to Redis:

```ts
await redisClient.set("analytics_worker:last_id", lastEntryId);
```

On worker restart, it reads this key to resume exactly where it left off — **no events are lost or re-processed**.

> [!TIP]
> **Graceful Shutdown Integration:** By using a shutdown handler, we ensure the worker *never* stops halfway through Step 6. It always finishes the current batch and saves the bookmark before exiting, preventing duplicate processing on restart.

### Step 7 — Worker publishes updated totals via Pub/Sub

```ts
const grandTotals = await redisClient.hgetall("analytics:event_counts");
redisClient.publish("analytics-update", JSON.stringify(grandTotals));
```

This broadcasts the entire current aggregation snapshot to any subscriber on the `analytics-update` channel.

### Step 8 — API Server receives the Pub/Sub message

In `sockets/index.ts`, a **duplicate** Redis client (required because a client in subscribe mode can only receive, not send commands) listens:

```ts
subscriber.on("message", (channel, message) => {
  const parsed = JSON.parse(message);
  io.emit("analytics-update", parsed); // Push to all WebSocket clients
});
await subscriber.subscribe("analytics-update");
```

### Step 9 — Browser receives real-time update via Socket.IO

The dashboard page loads `socket.io.js` and listens:

```js
socket.on('analytics-update', updateDashboard);
```

`updateDashboard()` rebuilds the stat cards and event list in the DOM without a page reload.

### Step 10 — Worker writes to TimescaleDB

After publishing, the worker also persists aggregated totals to PostgreSQL, snapping them to **1-minute intervals**:

```sql
INSERT INTO event_counts (bucket, event_name, count)
VALUES (time_bucket('1 minute', NOW()), $1, $2), ...
ON CONFLICT (bucket, event_name) DO UPDATE
SET count = event_counts.count + EXCLUDED.count;
```

This creates a time-series record. By using `time_bucket`, multiple worker batches within the same minute are automatically aggregated into a single row, optimizing storage and query performance.

### Step 11 — Dashboard initial render

When someone navigates to `GET /dashboard`, the server responds with a static `index.html` file.

The client-side JavaScript (`dashboard.js`) then:
1. Calls `GET /api/stats` to fetch the current aggregation from Redis as JSON.
2. Renders the UI immediately based on that initial data.
3. Allows Socket.IO to receive live updates from there.

---

## 5. Key Redis Concepts Used

| Concept | Redis Command | Where Used | Why |
|---|---|---|---|
| **Streams** | `XADD`, `XREAD BLOCK` | Router → Worker | Durable, ordered event log; decouples producers from consumers |
| **Hash** | `HINCRBY`, `HGETALL` | Worker, Router | Efficient in-memory aggregation store per event name |
| **String** | `SET`, `GET` | Worker, API | Persistent bookmark (`analytics_worker:last_id`) and Worker Liveness Heartbeat (`worker:heartbeat`) |
| **Pub/Sub** | `PUBLISH`, `SUBSCRIBE` | Worker → Sockets | Push-based real-time notifications without polling |
| **Pipeline/Multi** | `MULTI`, `EXEC` | Worker | Atomic batch writes — all `HINCRBY` calls succeed or fail together |
| **Duplicate client** | `redisClient.duplicate()` | Sockets | A subscribed client can't run normal commands; duplicate is the pattern |

---

## 6. Dependency Map

```
src/index.ts
  ├── src/app.ts                             → express, http.createServer
  │     ├── src/middleware/rateLimiter.middleware.ts  → express-rate-limit
  │     ├── src/router/eventTracker.ts
  │     │     ├── src/middleware/apiKey.middleware.ts
  │     │     ├── src/middleware/rateLimiter.middleware.ts
  │     │     ├── src/middleware/validation.middleware.ts  → zod
  │     │     ├── src/schema/eventSchema.ts               → zod
  │     │     └── src/db/connection.ts
  │     ├── src/sockets/index.ts
  │     │     └── src/db/connection.ts
  │     ├── src/utils/logger.ts                    → winston
  │     └── src/utils/metrics.ts                   → (zero-dependency)
  └── src/db/connection.ts                     → ioredis, pg

src/workers/index.ts
  ├── src/db/connection.ts
  └── src/utils/logger.ts
```
