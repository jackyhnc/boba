import { describe, it, expect, beforeEach } from "vitest";
import { loadEnv, _resetEnvCacheForTests } from "../src/config/env.js";

// Helpers to mutate process.env in tests without leaking across cases.
// `loadEnv()` is memoised, so each case must reset both the env snapshot
// and the cache.

function withEnv(overrides: Record<string, string | undefined>, fn: () => void): void {
  const before = { ...process.env };
  try {
    for (const [k, v] of Object.entries(overrides)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    _resetEnvCacheForTests();
    fn();
  } finally {
    process.env = before;
    _resetEnvCacheForTests();
  }
}

const ALL_BOOL_FLAGS = [
  "TWILIO_DRY_RUN",
  "TWILIO_REQUIRE_SIGNATURE",
  "AI_SEEDING_ENABLED",
  "INVITES_REQUIRED",
  "SCHEDULER_ENABLED",
] as const;

describe("env config", () => {
  beforeEach(() => {
    _resetEnvCacheForTests();
  });

  describe("defaults", () => {
    it("loads defaults when env is sparse", () => {
      withEnv(
        {
          PORT: undefined,
          NODE_ENV: undefined,
          LOG_LEVEL: undefined,
          PUBLIC_WEBHOOK_BASE_URL: undefined,
          DATABASE_URL: undefined,
          AI_SEEDING_ENABLED: undefined,
        },
        () => {
          const env = loadEnv();
          expect(env.PORT).toBe(3000);
          expect(env.NODE_ENV).toBe("development");
          expect(env.AI_SEEDING_ENABLED).toBe(false);
        },
      );
    });

    it("PORT defaults to 3000 as a number, not a string", () => {
      withEnv({ PORT: undefined }, () => {
        const env = loadEnv();
        expect(env.PORT).toBe(3000);
        expect(typeof env.PORT).toBe("number");
      });
    });

    it("DATABASE_URL falls back to the local dev Postgres URL", () => {
      withEnv({ DATABASE_URL: undefined }, () => {
        const env = loadEnv();
        // Pin the exact dev fallback so a refactor doesn't silently
        // point dev at a different DB.
        expect(env.DATABASE_URL).toBe(
          "postgresql://boba:boba@localhost:5432/boba?schema=public",
        );
      });
    });

    it("PUBLIC_WEBHOOK_BASE_URL defaults to localhost:3000", () => {
      withEnv({ PUBLIC_WEBHOOK_BASE_URL: undefined }, () => {
        const env = loadEnv();
        expect(env.PUBLIC_WEBHOOK_BASE_URL).toBe("http://localhost:3000");
      });
    });

    it("SCHEDULER_CRON defaults to 9pm UTC (5pm ET)", () => {
      withEnv({ SCHEDULER_CRON: undefined }, () => {
        const env = loadEnv();
        // Pinning this default protects the daily-match SLA: a refactor
        // that changes the schedule (e.g. "0 0 * * *" midnight UTC) would
        // silently move when users get their match.
        expect(env.SCHEDULER_CRON).toBe("0 21 * * *");
      });
    });

    it("SENTRY_TRACES_SAMPLE_RATE defaults to 0 (off)", () => {
      withEnv({ SENTRY_TRACES_SAMPLE_RATE: undefined }, () => {
        const env = loadEnv();
        expect(env.SENTRY_TRACES_SAMPLE_RATE).toBe(0);
      });
    });

    it("LOG_LEVEL defaults to info", () => {
      withEnv({ LOG_LEVEL: undefined }, () => {
        expect(loadEnv().LOG_LEVEL).toBe("info");
      });
    });

    it("Twilio credential fields default to empty strings (never undefined)", () => {
      withEnv(
        {
          TWILIO_ACCOUNT_SID: undefined,
          TWILIO_AUTH_TOKEN: undefined,
          TWILIO_PHONE_NUMBER: undefined,
          TWILIO_MESSAGING_SERVICE_SID: undefined,
          ANTHROPIC_API_KEY: undefined,
          ADMIN_TOKEN: undefined,
          SENTRY_DSN: undefined,
        },
        () => {
          const env = loadEnv();
          // Several call sites do `env.TWILIO_ACCOUNT_SID.length` or
          // truthy checks; defaulting to "" (not undefined) is the
          // contract that keeps those safe.
          expect(env.TWILIO_ACCOUNT_SID).toBe("");
          expect(env.TWILIO_AUTH_TOKEN).toBe("");
          expect(env.TWILIO_PHONE_NUMBER).toBe("");
          expect(env.TWILIO_MESSAGING_SERVICE_SID).toBe("");
          expect(env.ANTHROPIC_API_KEY).toBe("");
          expect(env.ADMIN_TOKEN).toBe("");
          expect(env.SENTRY_DSN).toBe("");
        },
      );
    });
  });

  describe("boolean flag default-orientation (asymmetric on purpose)", () => {
    // TWILIO_DRY_RUN and INVITES_REQUIRED are SAFE-BY-DEFAULT and use
    // `v.toLowerCase() !== "false"` (anything-but-false → true).
    // The other three are OFF-BY-DEFAULT and use `=== "true"`. A refactor
    // that "standardises" these to a single helper would silently flip
    // TWILIO_DRY_RUN to false-by-default — sending real SMS in dev.

    it("TWILIO_DRY_RUN defaults to TRUE (safe: no real SMS without explicit opt-in)", () => {
      withEnv({ TWILIO_DRY_RUN: undefined }, () => {
        expect(loadEnv().TWILIO_DRY_RUN).toBe(true);
      });
    });

    it("INVITES_REQUIRED defaults to TRUE (safe: closed beta unless explicitly opened)", () => {
      withEnv({ INVITES_REQUIRED: undefined }, () => {
        expect(loadEnv().INVITES_REQUIRED).toBe(true);
      });
    });

    it("TWILIO_REQUIRE_SIGNATURE defaults to FALSE (dev/ngrok unblocked)", () => {
      withEnv({ TWILIO_REQUIRE_SIGNATURE: undefined }, () => {
        expect(loadEnv().TWILIO_REQUIRE_SIGNATURE).toBe(false);
      });
    });

    it("AI_SEEDING_ENABLED defaults to FALSE (per PRD: hooks built, off by default)", () => {
      withEnv({ AI_SEEDING_ENABLED: undefined }, () => {
        expect(loadEnv().AI_SEEDING_ENABLED).toBe(false);
      });
    });

    it("SCHEDULER_ENABLED defaults to FALSE (dev/CI never auto-schedule)", () => {
      withEnv({ SCHEDULER_ENABLED: undefined }, () => {
        expect(loadEnv().SCHEDULER_ENABLED).toBe(false);
      });
    });
  });

  describe("boolean flag parsing semantics", () => {
    // Two distinct semantics by design:
    //   "default-true" flags coerce TRUE for ANYTHING except the literal
    //     (case-insensitive) string "false".
    //   "default-false" flags coerce TRUE only for the literal
    //     (case-insensitive) string "true".

    it("default-true flags treat the literal 'false' (any case) as false", () => {
      for (const v of ["false", "FALSE", "False", "fAlSe"]) {
        withEnv({ TWILIO_DRY_RUN: v, INVITES_REQUIRED: v }, () => {
          expect(loadEnv().TWILIO_DRY_RUN).toBe(false);
          expect(loadEnv().INVITES_REQUIRED).toBe(false);
        });
      }
    });

    it("default-true flags treat any other value as true (incl. typos)", () => {
      // This is the deliberate safe-by-default behaviour: a typo like
      // "fasle" leaves DRY_RUN on, not off.
      for (const v of ["true", "yes", "1", "0", "no", "fasle", "", "   "]) {
        withEnv({ TWILIO_DRY_RUN: v, INVITES_REQUIRED: v }, () => {
          expect(loadEnv().TWILIO_DRY_RUN).toBe(true);
          expect(loadEnv().INVITES_REQUIRED).toBe(true);
        });
      }
    });

    it("default-false flags treat the literal 'true' (any case) as true", () => {
      for (const v of ["true", "TRUE", "True", "tRuE"]) {
        withEnv(
          {
            TWILIO_REQUIRE_SIGNATURE: v,
            AI_SEEDING_ENABLED: v,
            SCHEDULER_ENABLED: v,
          },
          () => {
            const env = loadEnv();
            expect(env.TWILIO_REQUIRE_SIGNATURE).toBe(true);
            expect(env.AI_SEEDING_ENABLED).toBe(true);
            expect(env.SCHEDULER_ENABLED).toBe(true);
          },
        );
      }
    });

    it("default-false flags treat any other value as false (incl. typos)", () => {
      for (const v of ["false", "yes", "1", "0", "no", "ture", "", "   "]) {
        withEnv(
          {
            TWILIO_REQUIRE_SIGNATURE: v,
            AI_SEEDING_ENABLED: v,
            SCHEDULER_ENABLED: v,
          },
          () => {
            const env = loadEnv();
            expect(env.TWILIO_REQUIRE_SIGNATURE).toBe(false);
            expect(env.AI_SEEDING_ENABLED).toBe(false);
            expect(env.SCHEDULER_ENABLED).toBe(false);
          },
        );
      }
    });

    it("every boolean flag resolves to a boolean (no leaking string types)", () => {
      // Guards against a refactor that returns `string | undefined`
      // for one of the flags — downstream `if (env.FLAG)` would then
      // treat the literal string "false" as truthy.
      withEnv({}, () => {
        const env = loadEnv();
        for (const flag of ALL_BOOL_FLAGS) {
          expect(typeof env[flag]).toBe("boolean");
        }
      });
    });
  });

  describe("validation + coercion", () => {
    it("PORT='8080' coerces to the number 8080", () => {
      withEnv({ PORT: "8080" }, () => {
        const env = loadEnv();
        expect(env.PORT).toBe(8080);
        expect(typeof env.PORT).toBe("number");
      });
    });

    it("rejects non-positive PORT", () => {
      withEnv({ PORT: "0" }, () => {
        expect(() => loadEnv()).toThrow(/Invalid environment configuration/);
      });
      withEnv({ PORT: "-1" }, () => {
        expect(() => loadEnv()).toThrow(/Invalid environment configuration/);
      });
    });

    it("rejects non-integer PORT", () => {
      withEnv({ PORT: "3.14" }, () => {
        expect(() => loadEnv()).toThrow(/Invalid environment configuration/);
      });
    });

    it("rejects unknown NODE_ENV", () => {
      withEnv({ NODE_ENV: "staging" }, () => {
        expect(() => loadEnv()).toThrow(/Invalid environment configuration/);
      });
    });

    it("accepts all three known NODE_ENV values", () => {
      for (const v of ["development", "test", "production"] as const) {
        withEnv({ NODE_ENV: v }, () => {
          expect(loadEnv().NODE_ENV).toBe(v);
        });
      }
    });

    it("rejects unknown LOG_LEVEL", () => {
      withEnv({ LOG_LEVEL: "verbose" }, () => {
        expect(() => loadEnv()).toThrow(/Invalid environment configuration/);
      });
    });

    it("rejects malformed PUBLIC_WEBHOOK_BASE_URL", () => {
      withEnv({ PUBLIC_WEBHOOK_BASE_URL: "not a url" }, () => {
        expect(() => loadEnv()).toThrow(/Invalid environment configuration/);
      });
    });

    it("rejects empty-string DATABASE_URL when explicitly set", () => {
      // The schema is `z.string().min(1).default(...)`. Setting it to "" via
      // env should fail validation, not silently fall back to the default.
      withEnv({ DATABASE_URL: "" }, () => {
        expect(() => loadEnv()).toThrow(/Invalid environment configuration/);
      });
    });

    it("clamps SENTRY_TRACES_SAMPLE_RATE to [0, 1]", () => {
      withEnv({ SENTRY_TRACES_SAMPLE_RATE: "0.5" }, () => {
        expect(loadEnv().SENTRY_TRACES_SAMPLE_RATE).toBe(0.5);
      });
      withEnv({ SENTRY_TRACES_SAMPLE_RATE: "-0.1" }, () => {
        expect(() => loadEnv()).toThrow(/Invalid environment configuration/);
      });
      withEnv({ SENTRY_TRACES_SAMPLE_RATE: "1.5" }, () => {
        expect(() => loadEnv()).toThrow(/Invalid environment configuration/);
      });
    });
  });

  describe("error reporting", () => {
    it("error message names the offending field and lists each issue indented", () => {
      withEnv({ PORT: "abc", NODE_ENV: "staging" }, () => {
        try {
          loadEnv();
          throw new Error("expected loadEnv to throw");
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          expect(msg.startsWith("Invalid environment configuration:")).toBe(true);
          // Each issue is prefixed by two spaces and "<path>: <message>".
          expect(msg).toMatch(/\n {2}PORT: /);
          expect(msg).toMatch(/\n {2}NODE_ENV: /);
        }
      });
    });
  });

  describe("singleton caching", () => {
    it("loadEnv() returns the exact same object on repeat calls", () => {
      withEnv({}, () => {
        const a = loadEnv();
        const b = loadEnv();
        expect(b).toBe(a);
      });
    });

    it("subsequent loadEnv() calls do NOT pick up process.env mutations until reset", () => {
      withEnv({ PORT: "4000" }, () => {
        const first = loadEnv();
        expect(first.PORT).toBe(4000);
        process.env.PORT = "5000";
        const second = loadEnv();
        // No reset → cache wins.
        expect(second.PORT).toBe(4000);
        expect(second).toBe(first);
      });
    });

    it("_resetEnvCacheForTests() clears the cache so the next load re-parses", () => {
      withEnv({ PORT: "4000" }, () => {
        expect(loadEnv().PORT).toBe(4000);
        process.env.PORT = "5000";
        _resetEnvCacheForTests();
        const reloaded = loadEnv();
        expect(reloaded.PORT).toBe(5000);
      });
    });
  });

  // Preserved from the original suite — keeps the explicit truthy-AI case
  // alongside the broader semantics pinned above.
  it("parses AI_SEEDING_ENABLED string truthy values", () => {
    withEnv({ AI_SEEDING_ENABLED: "true" }, () => {
      expect(loadEnv().AI_SEEDING_ENABLED).toBe(true);
    });
  });
});
