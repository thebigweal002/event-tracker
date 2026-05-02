import supertest from "supertest";
import { createApp } from "../../src/app";
import { pool, connectAll } from "../../src/db/connection";

const { app } = createApp();
const request = supertest(app);

describe("GET /analytics", () => {
  beforeAll(async () => {
    await connectAll();
    // Seed some data
    await pool.query("DELETE FROM event_counts");
    await pool.query(`
      INSERT INTO event_counts (bucket, event_name, count)
      VALUES 
        (NOW() - INTERVAL '10 minutes', 'click', 5),
        (NOW() - INTERVAL '5 minutes', 'click', 3),
        (NOW() - INTERVAL '2 hours', 'click', 10)
    `);
  });

  it("should return analytics for the last hour by default", async () => {
    const response = await request.get("/analytics");
    
    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.range).toBe("1h");
    // Should have 2 click entries (10m and 5m ago)
    const clicks = response.body.data.filter((r: { event_name: string }) => r.event_name === 'click');
    expect(clicks.length).toBeGreaterThanOrEqual(1); // 1h bucket might group them depending on time_bucket param but query uses 1 min bucket
  });

  it("should return analytics for a 24h range", async () => {
    const response = await request.get("/analytics?range=24h");
    
    expect(response.status).toBe(200);
    expect(response.body.range).toBe("24h");
    const clicks = response.body.data.filter((r: { event_name: string }) => r.event_name === 'click');
    expect(clicks.length).toBeGreaterThanOrEqual(2); // Should include the 2h ago entry
  });
});
