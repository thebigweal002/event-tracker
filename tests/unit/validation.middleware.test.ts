import { validate } from "../../src/middleware/validation.middleware";
import { z } from "zod";
import { Request, Response, NextFunction } from "express";

describe("validationMiddleware", () => {
  const schema = z.object({
    name: z.string().min(3),
    age: z.number().int().optional(),
  });

  let mockReq: Partial<Request>;
  let mockRes: Partial<Response>;
  const nextFunction: NextFunction = jest.fn();

  beforeEach(() => {
    mockReq = {};
    mockRes = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
    (nextFunction as jest.Mock).mockClear();
  });

  it("should call next() and update req.body if data is valid", () => {
    mockReq.body = { name: "Alice", age: 30 };
    const middleware = validate(schema);

    middleware(mockReq as Request, mockRes as Response, nextFunction);

    expect(nextFunction).toHaveBeenCalled();
    expect(mockReq.body).toEqual({ name: "Alice", age: 30 });
    expect(mockRes.status).not.toHaveBeenCalled();
  });

  it("should return 400 if data is invalid", () => {
    mockReq.body = { name: "Al" }; // Too short
    const middleware = validate(schema);

    middleware(mockReq as Request, mockRes as Response, nextFunction);

    expect(nextFunction).not.toHaveBeenCalled();
    expect(mockRes.status).toHaveBeenCalledWith(400);
    expect(mockRes.json).toHaveBeenCalledWith({
      errors: expect.objectContaining({ name: expect.any(Array) }),
    });
  });

  it("should strip extra fields during validation", () => {
    mockReq.body = { name: "Bob", extra: "hack" };
    const middleware = validate(schema);

    middleware(mockReq as Request, mockRes as Response, nextFunction);

    expect(nextFunction).toHaveBeenCalled();
    expect(mockReq.body).toEqual({ name: "Bob" });
    expect(mockReq.body).not.toHaveProperty("extra");
  });
});
