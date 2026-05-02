# Testing Documentation

This project uses a multi-layered testing strategy (Unit, Integration, and End-to-End) powered by **Jest** and **Docker**.

> **Related docs:** [ARCHITECTURE.md](./ARCHITECTURE.md) · [MODULES.md](./MODULES.md) · [CONFIGURATION.md](./CONFIGURATION.md) · [OBSERVABILITY.md](./OBSERVABILITY.md)

---

## 🚀 Quick Start

Ensure **Docker Desktop** is running, then use the following commands:

```bash
# Run all tests sequentially
npm test

# Run tests with coverage reporting
npm run test:coverage

# Run a specific test file
npx jest tests/unit/schema.test.ts
```

---

## ️ Architecture

We use a **distributed testing strategy** with real infrastructure to ensure high reliability.

```mermaid
graph TD
    Client[Test Client] --> API[Express API]
    API --> RedisStream[(Redis Stream)]
    RedisStream --> Worker[Event Worker]
    Worker --> Timescale[(TimescaleDB)]
    Worker --> Socket[Socket.IO Client]
```

### 1. Unit Tests (`tests/unit/`)

- **Focus**: Pure logic and helper functions.
- **Dependencies**: Fully mocked. No database required.
- **Goal**: Instant feedback on core validation and formatting.

### 2. Integration Tests (`tests/integration/`)

- **Focus**: API endpoints, database communication, and middleware enforcement.
- **Dependencies**: Real Docker containers (Postgres/Redis).
- **Goal**: Verify that your SQL and Redis queries work correctly and that security/policy middleware like rate limiting is properly enforced.

#### Rate Limiting Tests
We use low limits (e.g., 2-5 requests) during integration testing to verify that the `429 Too Many Requests` response is correctly triggered without generating excessive traffic or causing long delays in the test suite. These limits are configured via environment variables in `.env.test`.

### 3. E2E Tests (`tests/e2e/`)

- **Focus**: The "Track-to-Socket" distributed flow.
- **Dependencies**: Full stack (API + Worker + DB + Sockets).
- **Goal**: Verify that an event travels safely from ingestion to live dashboard update.
- **Stability**: Uses a 15-second timeout and `disconnectAll()` to prevent flakiness and resource leaks in CI.

---

## 🔄 Infrastructure Lifecycle

The testing suite manages its own Docker containers automatically using Jest global hooks:

1.  **Start**: `tests/globalSetup.ts` spins up `docker-compose.test.yml`.
2.  **Ready**: It waits until Postgres and Redis are fully healthy.
3.  **Run**: Tests execute sequentially (`--runInBand`) using configurations from `.env.test`. Each test file must call `disconnectAll()` in its `afterAll` hook to ensure clean transitions between files.
4.  **Stop**: `tests/globalTeardown.ts` removes the containers and cleans up data.

---

## 🔒 Configuration

- **`jest.config.ts`**: Main test runner configuration.
- **`docker-compose.test.yml`**: Isolated infrastructure (Postgres: 5433, Redis: 6380).
- **`.env.test`**: Test-specific environment variables.

---

## 📈 Coverage Requirements

The CI pipeline requires **80% statement, branch, function, and line coverage** before a build passes. Ensure your tests meet these thresholds before pushing to production.
