import supertest from "supertest";
import { createApp } from "../../src/app";
import { redisClient, connectAll } from "../../src/db/connection";

const { app } = createApp();
const request = supertest(app);

describe("GET /health", () => {
  beforeAll(async () => {
    await connectAll();
  });

  afterAll(async () => {
    // Avoid closing connection here if other integration tests share it
    // Or close it if this is the last one
  });

  it("should return 200 ok when everything is fine", async () => {
    // Ensure worker heartbeat is fresh
    await redisClient.set("worker:heartbeat", new Date().toISOString());
    
    const response = await request.get("/health");
    
    expect(response.status).toBe(200);
    expect(response.body.status).toBe("ok");
    expect(response.body.postgres.status).toBe("ok");
    expect(response.body.redis.status).toBe("ok");
  });

  it("should return 503 degraded when worker heartbeat is stale", async () => {
    // Set heartbeat in the past (> 30s)
    const oldDate = new Date(Date.now() - 60000).toISOString();
    await redisClient.set("worker:heartbeat", oldDate);

    const response = await request.get("/health");
    
    expect(response.status).toBe(503);
    expect(response.body.status).toBe("degraded");
    expect(response.body.worker.status).toBe("offline");
  });

  it("should report Redis stream length", async () => {
    await redisClient.del("events");
    await redisClient.xadd("events", "*", "test", "data");
    
    const response = await request.get("/health");
    expect(response.body.redis.stream_length).toBeGreaterThanOrEqual(1);
  });
});
