import { describe, it, expect, afterAll } from "vitest";
import { buildApp } from "../src/app.js";

describe("health routes", () => {
  // Pass a stub pingDb so /readyz works without a real Postgres.
  const appPromise = buildApp({ health: { pingDb: async () => undefined } });

  afterAll(async () => {
    const app = await appPromise;
    await app.close();
  });

  it("GET /health returns ok", async () => {
    const app = await appPromise;
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("ok");
    expect(typeof body.uptime).toBe("number");
    expect(typeof body.timestamp).toBe("string");
  });

  it("GET /readyz returns ready when DB ping succeeds", async () => {
    const app = await appPromise;
    const res = await app.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("ready");
  });

  it("GET /readyz returns 503 when DB ping fails", async () => {
    const failing = await buildApp({
      health: {
        pingDb: async () => {
          throw new Error("db down");
        },
      },
    });
    const res = await failing.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ status: "not_ready", reason: "db_unreachable" });
    await failing.close();
  });

  it("GET / returns app metadata", async () => {
    const app = await appPromise;
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.name).toBe("boba");
  });
});
