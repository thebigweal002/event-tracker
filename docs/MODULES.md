# Modules — Event Tracker

> **Reader:** Engineer debugging a specific file.
> This document provides a deep-dive into every source file in the codebase — what it does, how it fits into the system, and the key design decisions behind it.
>
> **Related docs:** [ARCHITECTURE.md](./ARCHITECTURE.md) · [CONFIGURATION.md](./CONFIGURATION.md) · [OBSERVABILITY.md](./OBSERVABILITY.md) · [TESTING.md](./TESTING.md)

---

## Table of Contents

- [5.1 Boot — `src/index.ts`](#51-boot--srcindexts)
- [5.2 App Factory — `src/app.ts`](#52-app-factory--srcappts)
- [5.3 Config — `src/config/loadEnv.ts`](#53-config--srcconfigloadenvts)
- [5.4 Database — `src/db/connection.ts`](#54-database--srcdbconnectionts)
- [5.5 Router — `src/router/eventTracker.ts`](#55-router--srcroutereventtrackersts)
- [5.6 Schema — `src/schema/eventSchema.ts`](#56-schema--srcschemaeventschematts)
- [5.7 Middleware — `src/middleware/validation.middleware.ts`](#57-middleware--srcmiddlewarevalidationmiddlewarets)
- [5.8 Rate Limiter — `src/middleware/rateLimiter.middleware.ts`](#58-rate-limiter--srcmiddlewareratelimitermiddlewarets)
- [5.9 API Key Auth — `src/middleware/apiKey.middleware.ts`](#59-api-key-auth--srcmiddlewareapikeymiddlewarets)
- [5.10 Worker — `src/workers/index.ts`](#510-worker--srcworkersindexts)
- [5.11 Sockets — `src/sockets/index.ts`](#511-sockets--srcsocketsindexts)
- [5.12 Logger — `src/utils/logger.ts`](#512-logger--srcutilsloggerts)
- [5.13 Metrics — `src/utils/metrics.ts`](#513-metrics--srcutilsmetricsts)
- [5.14 Dashboard UI — `src/public/index.html`](#514-dashboard-ui--srcpublicindexhtml)
- [5.15 Dashboard Logic — `src/public/js/dashboard.js`](#515-dashboard-logic--srcpublicjsdashboardjs)
- [5.16 Styles — `src/public/style.css`](#516-styles--srcpublicstylecss)
- [6. Database Schema — `sql/init.sql`](#6-database-schema--sqlinitsql)

---

## 5. Module Deep Dives

### 5.1 Boot — `src/index.ts`

**What it does:** A thin 22-line process entry point. Its only responsibilities are:

1. Call `createApp()` from `src/app.ts` to get the configured HTTP server.
2. Call `connectAll()` to establish Postgres and Redis connections.
3. Call `httpServer.listen()` to start accepting traffic.

If `connectAll()` rejects, the process exits with code `1` rather than serving traffic against broken connections.

---

### 5.2 App Factory — `src/app.ts`

**What it does:** Exports `createApp()`, a factory function that builds and returns the fully configured Express application and HTTP server.

**Middleware stack (in order):**
```
express.json()          → Parse JSON request bodies
express.static()        → Serve /public assets
globalLimiter           → Baseline rate limit (30 req/10min per IP)
```

**Routes wired:**
```
GET  /health    → Deep 503-aware health check
GET  /metrics   → Prometheus exposition text
use  /          → trackRouter (POST /track, GET /dashboard, GET /api/stats, GET /analytics)
```

**Global error handler:** Catches `ZodError` → `400` with field-level details, all others → `500`.

**Graceful Shutdown** is registered inside `createApp()`:
1. `httpServer.close()` — stops accepting new requests, drains in-flight ones.
2. `closeSocket()` — shuts down Socket.IO and its Redis subscriber.
3. `redisClient.quit()` + `pool.end()` — closes shared DB connections.
4. A 10-second failsafe `setTimeout` forces exit if cleanup hangs.

---

### 5.3 Config — `src/config/loadEnv.ts`

**What it does:** Loads the `.env` file in development; skips gracefully in production.

- In **production** (`NODE_ENV=production`), environment variables are expected to be injected by Docker/the hosting platform. The `.env` file is not needed.
- In **development**, it resolves the `.env` path relative to the compiled output and uses `dotenv.config()`.
- If `dotenv` is missing or the `.env` file doesn't exist, it logs warnings instead of crashing.

This module is side-effect: it runs `loadEnvironmentVariables()` immediately on `import`.

---

### 5.4 Database — `src/db/connection.ts`

**What it does:** Creates and exports the two shared database clients used across the entire app.

| Export | Type | Description |
|---|---|---|
| `pool` | `pg.Pool` | PostgreSQL connection pool |
| `redisClient` | `ioredis.Redis` | Redis client (used for commands + Pub/Sub publisher) |
| `connectAll()` | `async function` | Runs both connection checks at startup |
| `disconnectAll()` | `async function` | Closes all connections and resets the state (critical for tests) |

**SSL handling:**
```ts
const sslConfig = process.env.NODE_ENV === "production"
  ? { rejectUnauthorized: false }  // Cloud-hosted Postgres (Render, Railway)
  : false;                          // Local dev — no SSL
```

**Redis TLS:**
```ts
tls: redisUrl.startsWith("rediss://") ? { rejectUnauthorized: false } : undefined
```
`rediss://` (double-s) is the TLS-enabled Redis URL scheme used by RedisCloud.

**Pool Performance Tuning:**
To minimize latency when using remote cloud databases, the pool is configured to keep connections "warm":
- `max: 10`: Limits concurrent connections to prevent exhausting DB resources.
- `min: 2`: Ensures at least 2 connections stay open, avoiding the multi-second SSL handshake penalty on every health check.
- `idleTimeoutMillis: 60000`: Connections stay alive for 1 minute before closing.
- `connectionTimeoutMillis: 5000`: Fails early if the DB is unreachable.

**`connectAll()` resiliency:** The function uses a state machine (`disconnected`, `connecting`, `connected`, `failed`) and a shared `connectionPromise` to ensure that simultaneous calls don't trigger redundant attempts and that failures can be recovered from cleanly.

---

### 5.5 Router — `src/router/eventTracker.ts`

**What it does:** Defines all HTTP API routes.

#### `GET /dashboard`

Serves the static `index.html` file containing the analytics UI.

#### `GET /api/stats`

1. Reads the `analytics:event_counts` hash from Redis (`hgetall`).
2. Returns a JSON object with the current aggregate counts. This handles the client-side's initial state fetch.

#### `POST /track`

1. The `validate(trackEventSchema)` middleware runs first (validation gate).
2. Writes the event to the `"events"` Redis Stream using `xadd`.
3. Returns `200 { success: true, event: {...} }`.

#### `GET /analytics`

1.  Accepts a `range` query parameter (e.g., `1h`, `6h`, `24h`, `7d`). Defaults to `1h`.
2.  Maps the shorthand to a PostgreSQL `INTERVAL`.
3.  Queries TimescaleDB using `time_bucket('1 minute', bucket)` to return historical trends.
4.  Returns JSON data for charts or historical analysis.

**Redis Stream entry format:**
```
ID          | Field    | Value
------------|----------|---------------------------
<auto-id>   | userId   | "u-123"
            | eventName| "page_view"
            | url      | "/home"
            | metadata | '{"browser":"Chrome"}'
```

**`POST /track` middleware chain:**
```
apiKey          → x-api-key header validation (401/403 on failure)
writeLimiter    → 30 req/min per IP (429 on breach)
validate(...)   → Zod schema check (400 on invalid body)
→ xadd to Redis Stream
```

---

### 5.6 Schema — `src/schema/eventSchema.ts`

**What it does:** Defines the shape and validation rules for incoming event payloads using **Zod**.

```ts
const trackEventSchema = z.object({
  eventName: z.string().min(1),           // Required, non-empty
  url:       z.string(),                  // Required
  userId:    z.string().optional(),       // Optional
  metadata:  z.record(z.string(), z.any()).optional(), // Optional free-form object
});

type TrackEventInput = z.infer<typeof trackEventSchema>; // TypeScript type
```

This schema is the **single source of truth** for what a valid event looks like. It's used in both the middleware (validation) and the route handler (typed `req.body`).

---

### 5.7 Middleware — `src/middleware/validation.middleware.ts`

**What it does:** Generic, reusable Express middleware factory that takes a Zod schema and returns a middleware function.

```ts
validate(schema) → (req, res, next) => void
```

- On success: replaces `req.body` with the **typed, sanitized** Zod output and calls `next()`.
- On failure: immediately responds `400` with `{ errors: { fieldName: ["message"] } }`.

This is a **higher-order function** pattern — `validate` is called at route-registration time (not at request time), and it returns the actual middleware closure.

---

### 5.8 Rate Limiter — `src/middleware/rateLimiter.middleware.ts`

**What it does:** Exports two `express-rate-limit` instances that protect the API from abuse.

| Export | Applied on | Window | Max Requests | On Breach |
|---|---|---|---|---|
| `globalLimiter` | All routes (in `app.ts`) | 10 minutes | 30 per IP | `429` |
| `writeLimiter` | `POST /track` only | 1 minute | 30 per IP | `429` |

Both limiters return `RateLimit-*` standard headers (RFC draft) and a JSON body:
```json
{ "success": false, "message": "Too many requests. Please slow down and try again later." }
```

Limits are configurable via environment variables, making them easy to tighten for tests:

| Variable | Default | Controls |
|---|---|---|
| `RATE_LIMIT_GLOBAL_WINDOW_MS` | `600000` (10 min) | Global window |
| `RATE_LIMIT_GLOBAL_MAX` | `30` | Global max requests |
| `RATE_LIMIT_WRITE_WINDOW_MS` | `60000` (1 min) | Write window |
| `RATE_LIMIT_WRITE_MAX` | `30` | Write max requests |

> [!NOTE]
> During integration tests, `.env.test` sets these limits very low (e.g., 2–5 requests) so the `429` response can be triggered quickly without flooding the test infrastructure.

---

### 5.9 API Key Auth — `src/middleware/apiKey.middleware.ts`

**What it does:** Protects `POST /track` by validating the `x-api-key` request header against a comma-separated list of valid keys stored in the `API_KEYS` environment variable.

**Flow:**
```
req.headers['x-api-key']
        ↓
  missing? → 401 { success: false, message: "API key is required." }
        ↓
  not in API_KEYS list? → 403 { success: false, message: "Invalid API key." }
        ↓
  valid → next()
```

**Multi-key support:** `API_KEYS` accepts a comma-separated string (e.g., `"key-1, key-2, key-3"`). Each key is trimmed before comparison, so whitespace around commas is safely ignored.

Invalid attempts are logged as `warn` with the requester's IP for audit trail purposes.

---

### 5.10 Worker — `src/workers/index.ts`

**What it does:** The background process that consumes the Redis Stream, aggregates counts, publishes updates, and writes to PostgreSQL.

**Three Redis keys used:**

| Key | Type | Purpose |
|---|---|---|
| `events` | Stream | The event log produced by the API |
| `analytics:event_counts` | Hash | Running total per event name |
| `analytics_worker:last_id` | String | Bookmark — last processed stream entry ID |
| `worker:last_processed_at` | String | ISO Timestamp of last successful batch |
| `worker:events_processed_total`| String | Global counter of events handled by worker |

**The main loop:**

```
startWorker()
  └── connectAll()                   → ensures DB connections exist
  └── GET analytics_worker:last_id  → resume from last position (or "0-0")
  └── while(!isShuttingDown):       → controlled loop (SIGTERM/SIGINT)
        processEvents(lastReadId)
          └── XREAD BLOCK 5000 ...  → wait up to 5s for new events
          └── MULTI / HINCRBY ...   → atomic batch aggregation in Redis
          └── EXEC
          └── SET analytics_worker:last_id <newId>
          └── HGETALL analytics:event_counts
          └── PUBLISH analytics-update <json>
          └── INSERT INTO event_counts ... (Postgres upsert)
  └── Close Redis & Postgres connections
  └── process.exit(0)
```

**Fault tolerance:**
- The `BLOCK 5000` call prevents CPU spin loops when the stream is empty.
- The bookmark ensures **at-least-once processing** — a worker crash leaves the bookmark at the last successfully persisted ID, so on restart only unprocessed entries are re-read.
- Postgres write errors are caught and logged but do **not** crash the loop — the Redis aggregation is still valid.

**Graceful Shutdown:**
The worker uses an `isShuttingDown` flag and `SIGTERM`/`SIGINT` listeners. Because the flag is checked at the start of the `while` loop, the worker will always finish its **current batch** (including saving the bookmark to Redis and writing to Postgres) before exiting. This prevents duplicate processing of events that would otherwise occur if the process were killed mid-batch.

---

### 5.11 Sockets — `src/sockets/index.ts`

**What it does:** Manages the Socket.IO server and the Redis Pub/Sub subscriber.

**Two Redis clients for one connection:**
```ts
const subscriber = redisClient.duplicate();
```
A Redis client in `subscribe` mode can **only** receive messages — it cannot execute regular commands. So the worker uses the main `redisClient` to `publish`, and the sockets module creates a dedicated `subscriber` clone for receiving.

**Message flow:**
```
Worker               redisClient.publish("analytics-update", json)
                                    ↓
Redis Pub/Sub channel: "analytics-update"
                                    ↓
Sockets module       subscriber.on("message", ...)
                                    ↓
                     io.emit("analytics-update", parsed)
                                    ↓
Browser              socket.on("analytics-update", updateDashboard)
```

CORS is configurable via the `ALLOWED_ORIGINS` environment variable. If multiple origins are needed, they can be provided as a comma-separated list. If the variable is not set, it defaults to `*` for convenience in development.

**Cleanup Handler:**
 Exports a `closeSocket()` async function that:
1.  Calls `io.close()` to disconnect clients and stop the server.
2.  Calls `subscriber.quit()` to cleanly close the dedicated Redis subscription client.

---

### 5.12 Logger — `src/utils/logger.ts`

**What it does:** Provides a structured, production-ready **Winston** logger that balances visibility with security.

- **Unified Stream**: All logs are directed to **stdout/stderr**, allowing Docker to capture and manage the stream.
- **Environment-Specific Formatting**:
  - **Production**: Uses **JSON** format, which is easier for cloud log managers (like AWS CloudWatch or Loki) to parse and index.
  - **Development**: Uses a **Colorized**, human-readable format for better local debugging.
- **Security & Redaction**:
  - **PII Redaction**: A custom formatter automatically masks sensitive keys (e.g., `password`, `token`, `authorization`) with `[REDACTED]`.
  - **URL Redaction**: Automatically detects and masks passwords within connection strings (e.g., `redis://user:[REDACTED]@host`).
  - **Always On**: Redaction is active in **both** Development and Production to prevent accidental leaks.
- **Dynamic Level**: Verbosity can be controlled via the `LOG_LEVEL` environment variable (defaults to `info`).

**Log levels (custom priority order):**
```
error (0) → warn (1) → info (2) → http (3) → debug (4)
```

---

### 5.13 Metrics — `src/utils/metrics.ts`

See [OBSERVABILITY.md — `/metrics` Endpoint](./OBSERVABILITY.md#2-metrics-endpoint-prometheus) for the full exposition.

---

### 5.14 Dashboard UI — `src/public/index.html`

**What it does:** The static HTML page for the analytics dashboard.

**UI sections:**
- **Header** — Title, subtitle, animated "Live Monitoring" pill with pulsing dot.
- **Stats Grid** — 4 cards: Total Aggregation, Event Types, Top Event, Avg Count.
- **Event Distribution** — A responsive grid of event cards (sorted by count descending).
- **Empty State** — Shown when no events exist yet.

### 5.15 Dashboard Logic — `src/public/js/dashboard.js`

**What it does:** Provides the Client-Side Rendering (CSR) and Socket.IO real-time binding.

**Data Flow:**
1. **Initial load:** Fetches JSON data from `/api/stats` and runs an initial `updateDashboard()` to construct the UI.
2. **Real-time updates:** Listens to `socket.on('analytics-update', updateDashboard)` to refresh the numbers and list live.

**`updateDashboard(eventCounts)`**:
Receives the raw Redis hash (either from HTTP or Socket), processes it into an array to determine the top event and averages, and directly updates the DOM using Vanilla JavaScript. Handles swapping the Empty State view to the Grid View.

---

### 5.16 Styles — `src/public/style.css`

**What it does:** Styles the dashboard with a modern Web3/dark-mode aesthetic.

**Design system (CSS custom properties):**
```css
--bg-dark:        #08080c           /* near-black background */
--bg-card:        rgba(16,16,24,.4) /* frosted glass cards */
--glass-border:   rgba(255,255,255,.08)
--accent-cyan:    #00f2ff           /* data values, live indicator, hover borders */
--accent-purple:  #7d40ff           /* event icons, top event */
--accent-blue:    #2d5bff           /* gradients */
--font-main:      Space Grotesque   /* headers + body */
--font-mono:      Space Mono        /* numbers — stat values, counts */
```

**Key visual features:**
- Glassmorphism cards with `backdrop-filter: blur(12px)`.
- Radial gradient background (purple top-left + blue bottom-right).
- `pulse` keyframe animation on the live indicator dot.
- `translateY(-8px)` lift on stat card hover.
- `translateY(-4px) scale(1.01)` + cyan border on event item hover.

**Responsive breakpoints:**
| Breakpoint | Stats Grid | Event List |
|---|---|---|
| `> 1024px` | 4 columns | auto-fill 320px columns |
| `≤ 1024px` | 2 columns | 1 column |
| `≤ 768px` | 2 columns, smaller gaps | 1 column |
| `≤ 480px` | 1 column | 1 column |

---

## 6. Database Schema — `sql/init.sql`

```sql
CREATE EXTENSION IF NOT EXISTS timescaledb;

CREATE TABLE event_counts (
    bucket      TIMESTAMPTZ NOT NULL,
    event_name  TEXT        NOT NULL,
    count       INT         NOT NULL,
    PRIMARY KEY (bucket, event_name)
);

SELECT create_hypertable('event_counts', 'bucket');
```

- **`bucket`** — timestamp of when the worker wrote the batch. Snapped to **1-minute intervals** using `time_bucket`.
- **`event_name`** — the event type string (e.g. `"page_view"`, `"click"`).
- **`count`** — the running total at that point in time.
- **TimescaleDB hypertable** — automatically partitions the table into time-based chunks for efficient time-range queries and data retention policies.
- **`ON CONFLICT ... DO UPDATE`** — if the same `(bucket, event_name)` pair is written twice, counts are **added** not replaced.

> [!IMPORTANT]
> **Storage Strategy:** The worker uses `time_bucket('1 minute', NOW())` on every batch write. This means all activity within a single clock minute for a specific event type is rolled up into one row. This significantly reduces row count (from ~thousands/day to 1,440/day per event type) and makes historical trend analysis much faster.
