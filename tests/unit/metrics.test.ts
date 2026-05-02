import { buildPrometheusText } from "../../src/utils/metrics";
import { redisClient } from "../../src/db/connection";

// Mock redisClient
jest.mock("../../src/db/connection", () => ({
  redisClient: {
    xlen: jest.fn(),
    get: jest.fn(),
  },
}));

// Mock logger to silence expected errors
jest.mock("../../src/utils/logger", () => ({
  info: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  warn: jest.fn(),
}));

describe("metricsUtil", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("should build correct prometheus format", async () => {
    const mockedRedis = redisClient as jest.Mocked<typeof redisClient>;
    mockedRedis.xlen.mockResolvedValue(100);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedRedis.get.mockImplementation(async (key: any) => {
      if (key === "worker:heartbeat") return new Date().toISOString();
      if (key === "worker:last_processed_at") return new Date().toISOString();
      if (key === "worker:events_processed_total") return "500";
      return null;
    });

    const metrics = await buildPrometheusText();

    expect(metrics).toContain("# HELP event_tracker_uptime_seconds");
    expect(metrics).toContain("event_tracker_redis_stream_length 100");
    expect(metrics).toContain("event_tracker_worker_events_processed_total 500");
    expect(metrics.endsWith("\n")).toBe(true);
  });

  it("should handle redis failures gracefully in metrics", async () => {
    const mockedRedis = redisClient as jest.Mocked<typeof redisClient>;
    mockedRedis.xlen.mockRejectedValue(new Error("Redis down"));
    mockedRedis.get.mockRejectedValue(new Error("Redis down"));

    const metrics = await buildPrometheusText();

    // Should still return other metrics like uptime/memory
    expect(metrics).toContain("event_tracker_uptime_seconds");
    expect(metrics).toContain("event_tracker_redis_stream_length 0"); // Fallback to 0
    expect(metrics).toContain("event_tracker_worker_heartbeat_lag_seconds 999999.000"); // Fallback for lag
  });
});
