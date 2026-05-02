# Observability — Event Tracker

> **Reader:** Engineer monitoring the system.
> This document covers the built-in health and metrics endpoints — what they report, how failure states are detected, and how thresholds are configured.
>
> **Related docs:** [ARCHITECTURE.md](./ARCHITECTURE.md) · [MODULES.md](./MODULES.md) · [CONFIGURATION.md](./CONFIGURATION.md) · [TESTING.md](./TESTING.md)

---

## Table of Contents

1. [Advanced `/health` Endpoint](#1-advanced-health-endpoint)
2. [`/metrics` Endpoint (Prometheus)](#2-metrics-endpoint-prometheus)

---

## 1. Advanced `/health` Endpoint

Located at `GET /health`, this endpoint provides a deep inspection of the system state:

- **Postgres Check**: Actively pings the database and reports latency in `ms`.
- **Redis Check**: Pings the Redis instance and reports the current stream length.
- **Worker Check**: Provides both **Liveness** (is it alive?) and **Throughput** (is it keeping up?) metrics.
- **Resource Usage**: Reports system uptime and memory (RSS and Heap) in MB.

### Threshold-Based Failure

The endpoint returns **HTTP 503 (Service Unavailable)** instead of 200 if:

1. Postgres is unreachable.
2. Redis is unreachable.
3. **Worker Offline**: The heartbeat is older than `HEALTH_WORKER_HEARTBEAT_THRESHOLD_SECONDS` (default: 30s).
4. **Worker Lagging**: The worker lag exceeds `HEALTH_WORKER_LAG_THRESHOLD_SECONDS` (default: 40s) **AND** there are actual pending events in the Redis stream.

This prevents the system from reporting "OK" when the background processing is silently stalled or dead.

### Configurable Thresholds

Both thresholds are tunable via environment variables — see [CONFIGURATION.md — Environment Variables](./CONFIGURATION.md#1-environment-variables) for the full reference.

| Variable | Default | Effect |
|---|---|---|
| `HEALTH_WORKER_HEARTBEAT_THRESHOLD_SECONDS` | `30` | Seconds before a silent worker is marked offline |
| `HEALTH_WORKER_LAG_THRESHOLD_SECONDS` | `40` | Seconds of processing lag before the worker is marked degraded |

### Example Response — Healthy (200)

```json
{
  "status": "ok",
  "postgres": { "status": "ok", "latency_ms": 12 },
  "redis": { "status": "ok", "stream_length": 0 },
  "worker": { "status": "ok", "heartbeat_lag_seconds": 3 }
}
```

### Example Response — Degraded (503)

```json
{
  "status": "degraded",
  "postgres": { "status": "ok", "latency_ms": 14 },
  "redis": { "status": "ok", "stream_length": 850 },
  "worker": { "status": "offline", "heartbeat_lag_seconds": 62 }
}
```

---

## 2. `/metrics` Endpoint (Prometheus)

Exposes real-time telemetry at `GET /metrics` in the **Prometheus text exposition format (v0.0.4)**.

### Metric Reference

| Metric | Type | Description |
|---|---|---|
| `event_tracker_uptime_seconds` | Gauge | How long the API process has been running. |
| `event_tracker_memory_heap_used_bytes` | Gauge | Current heap memory consumption. |
| `event_tracker_redis_stream_length` | Gauge | Total event log size in Redis. |
| `event_tracker_worker_heartbeat_lag_seconds` | Gauge | Seconds since the worker last signaled liveness. |
| `event_tracker_worker_lag_seconds` | Gauge | Seconds since the worker last processed a batch. |
| `event_tracker_worker_events_processed_total` | Counter | Cumulative total of events consumed from the stream. |

### Implementation Notes

**Zero-dependency implementation**: To keep the production image small and fast, these metrics are constructed manually in `src/utils/metrics.ts` rather than using a heavy client library like `prom-client`.

**Failure behaviour**: If Redis is unreachable when `/metrics` is called, stream length falls back to `0` and worker heartbeat lag falls back to `999999` seconds. The endpoint always returns `200` — use `/health` for alerting on degraded state.

### Example Output

```
# HELP event_tracker_uptime_seconds Total uptime of the API process in seconds
# TYPE event_tracker_uptime_seconds gauge
event_tracker_uptime_seconds 3821.45

# HELP event_tracker_memory_heap_used_bytes Heap memory used by the Node.js process
# TYPE event_tracker_memory_heap_used_bytes gauge
event_tracker_memory_heap_used_bytes 47382528

# HELP event_tracker_redis_stream_length Number of entries in the Redis event stream
# TYPE event_tracker_redis_stream_length gauge
event_tracker_redis_stream_length 142

# HELP event_tracker_worker_heartbeat_lag_seconds Seconds since the worker last sent a heartbeat
# TYPE event_tracker_worker_heartbeat_lag_seconds gauge
event_tracker_worker_heartbeat_lag_seconds 2.103

# HELP event_tracker_worker_lag_seconds Seconds since the worker last processed a batch
# TYPE event_tracker_worker_lag_seconds gauge
event_tracker_worker_lag_seconds 1.887

# HELP event_tracker_worker_events_processed_total Total events processed by the worker
# TYPE event_tracker_worker_events_processed_total counter
event_tracker_worker_events_processed_total 8420
```
