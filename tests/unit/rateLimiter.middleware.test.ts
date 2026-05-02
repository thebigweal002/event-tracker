import { writeLimiter, globalLimiter } from "../../src/middleware/rateLimiter.middleware";

describe("Rate Limiter Middleware Configuration", () => {
  it("should export writeLimiter as a middleware function", () => {
    expect(typeof writeLimiter).toBe("function");
  });

  it("should export globalLimiter as a middleware function", () => {
    expect(typeof globalLimiter).toBe("function");
  });
});
