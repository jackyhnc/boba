import { describe, it, expect, beforeEach } from "vitest";
import { loadEnv, _resetEnvCacheForTests } from "../src/config/env.js";

describe("env config", () => {
  beforeEach(() => {
    _resetEnvCacheForTests();
  });

  it("loads defaults when env is sparse", () => {
    const before = { ...process.env };
    delete process.env.PORT;
    delete process.env.NODE_ENV;
    delete process.env.LOG_LEVEL;
    delete process.env.PUBLIC_WEBHOOK_BASE_URL;
    delete process.env.DATABASE_URL;
    delete process.env.AI_SEEDING_ENABLED;
    try {
      const env = loadEnv();
      expect(env.PORT).toBe(3000);
      expect(env.NODE_ENV).toBe("development");
      expect(env.AI_SEEDING_ENABLED).toBe(false);
    } finally {
      process.env = before;
      _resetEnvCacheForTests();
    }
  });

  it("parses AI_SEEDING_ENABLED string truthy values", () => {
    const before = { ...process.env };
    process.env.AI_SEEDING_ENABLED = "true";
    try {
      const env = loadEnv();
      expect(env.AI_SEEDING_ENABLED).toBe(true);
    } finally {
      process.env = before;
      _resetEnvCacheForTests();
    }
  });
});
