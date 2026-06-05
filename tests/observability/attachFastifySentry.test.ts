// Contract pin for `attachFastifySentry`.
//
// `attachFastifySentry` is the production wiring between Fastify's
// `onError` hook and Sentry's `captureException`. It runs in `buildApp`
// before any route is registered (src/app.ts:74), so a quiet refactor
// here can break error reporting in prod without any test failing.
//
// The existing `sentry.test.ts` covers `initSentry` only. This file pins
// the hook itself — specifically the invariants whose loss would be
// invisible in unit-isolation:
//
//   1. NO-OP WHEN NOT INITIALIZED. `initialized === false` (or empty DSN)
//      must skip hook registration entirely. Otherwise we'd ship errors
//      to a Sentry client that was never `init`ed.
//   2. PATH TAG PREFERS `routeOptions.url` OVER `req.url`. Sentry's
//      issue grouping aggregates by tag values — using the resolved URL
//      (`/users/42`) instead of the route pattern (`/users/:id`) would
//      shatter one bug into N issues per distinct id. The `??` fallback
//      to `req.url` is only meant for cases where Fastify hasn't resolved
//      a route (404s etc).
//   3. `method` IS A SCOPE EXTRA, NOT A TAG. Sentry tags are an indexed,
//      cardinality-bounded surface. Method belongs in extras so it shows
//      up in the issue UI without polluting the tag index.
//   4. `withScope` ISOLATES PER-ERROR STATE. Calling `setTag` outside a
//      scope (or sharing a scope across captures) would leak the first
//      error's path tag into every subsequent error in the same process.
//   5. ORIGINAL ERROR REFERENCE IS PASSED THROUGH. No wrapping, no
//      message rewriting — the captured exception is referentially the
//      same object the handler threw, so Sentry's fingerprinting (stack,
//      cause chain) is honest.
//   6. FASTIFY'S REPLY PATH IS UNCHANGED. `onError` returning void means
//      Fastify still ships its own 500 response; we observe, we don't
//      intercept.
//
// We mock `@sentry/node` so we can observe scope state at the moment
// `captureException` is called. The shape of the mock matches the real
// module's surface used by the source (`init`, `captureException`,
// `withScope`).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify from "fastify";
import {
  _resetSentryForTests,
  attachFastifySentry,
  initSentry,
} from "../../src/observability/sentry.js";

type ScopeSnapshot = {
  err: unknown;
  tags: Record<string, unknown>;
  extras: Record<string, unknown>;
};

vi.mock("@sentry/node", () => {
  const captured: ScopeSnapshot[] = [];
  let current: { tags: Record<string, unknown>; extras: Record<string, unknown> } | null = null;

  const init = vi.fn();
  const captureException = vi.fn((err: unknown) => {
    captured.push({
      err,
      tags: current ? { ...current.tags } : {},
      extras: current ? { ...current.extras } : {},
    });
  });
  const withScope = (
    fn: (s: {
      setTag: (k: string, v: unknown) => void;
      setExtra: (k: string, v: unknown) => void;
    }) => void,
  ): void => {
    const prev = current;
    current = { tags: {}, extras: {} };
    try {
      fn({
        setTag: (k, v) => {
          current!.tags[k] = v;
        },
        setExtra: (k, v) => {
          current!.extras[k] = v;
        },
      });
    } finally {
      current = prev;
    }
  };
  return {
    init,
    captureException,
    withScope,
    __captured: captured,
    __reset: () => {
      captured.length = 0;
      init.mockClear();
      captureException.mockClear();
    },
  };
});

import * as SentryMock from "@sentry/node";

const captured = (SentryMock as unknown as { __captured: ScopeSnapshot[] }).__captured;
const resetMock = (SentryMock as unknown as { __reset: () => void }).__reset;
const initFn = (SentryMock as unknown as { init: { mock: { calls: unknown[] } } }).init;

const ENABLED_ENV = {
  SENTRY_DSN: "https://abc@sentry.io/1",
  SENTRY_TRACES_SAMPLE_RATE: 0,
  NODE_ENV: "test" as const,
};

const DISABLED_ENV = {
  SENTRY_DSN: "",
  SENTRY_TRACES_SAMPLE_RATE: 0,
  NODE_ENV: "test" as const,
};

beforeEach(() => {
  _resetSentryForTests();
  resetMock();
});

afterEach(() => {
  _resetSentryForTests();
});

describe("attachFastifySentry — initialization gating", () => {
  it("does not register an onError hook when initSentry was never called", async () => {
    // No initSentry call.
    const app = Fastify({ logger: false });
    attachFastifySentry(app);
    app.get("/boom", async () => {
      throw new Error("boom");
    });
    const res = await app.inject({ method: "GET", url: "/boom" });
    // Fastify still ships its 500 (no error reporter, but the request
    // pipeline is unchanged).
    expect(res.statusCode).toBe(500);
    // And Sentry NEVER sees it.
    expect(captured).toHaveLength(0);
    expect(
      (SentryMock as unknown as { captureException: { mock: { calls: unknown[] } } })
        .captureException.mock.calls,
    ).toHaveLength(0);
    await app.close();
  });

  it("does not register an onError hook when DSN is empty (initSentry returns false)", async () => {
    expect(initSentry({ env: DISABLED_ENV })).toBe(false);
    // initSentry returning false must mean attachFastifySentry is a no-op
    // — otherwise we'd ship captures to a never-init'd Sentry client.
    const app = Fastify({ logger: false });
    attachFastifySentry(app);
    app.get("/boom", async () => {
      throw new Error("boom");
    });
    const res = await app.inject({ method: "GET", url: "/boom" });
    expect(res.statusCode).toBe(500);
    expect(captured).toHaveLength(0);
    // initSentry with empty DSN must not have called Sentry.init either.
    expect(initFn.mock.calls).toHaveLength(0);
    await app.close();
  });

  it("registers the hook only after successful initSentry (DSN present)", async () => {
    expect(initSentry({ env: ENABLED_ENV })).toBe(true);
    const app = Fastify({ logger: false });
    attachFastifySentry(app);
    app.get("/boom", async () => {
      throw new Error("boom");
    });
    const res = await app.inject({ method: "GET", url: "/boom" });
    expect(res.statusCode).toBe(500);
    expect(captured).toHaveLength(1);
    await app.close();
  });
});

describe("attachFastifySentry — capture semantics", () => {
  async function buildApp() {
    initSentry({ env: ENABLED_ENV });
    const app = Fastify({ logger: false });
    attachFastifySentry(app);
    app.get("/boom", async () => {
      throw new Error("boom-static");
    });
    app.get("/users/:id", async (req) => {
      throw new Error(`boom-user-${(req.params as { id: string }).id}`);
    });
    app.post("/users/:id/edit", async (req) => {
      throw new Error(`edit-${(req.params as { id: string }).id}`);
    });
    return app;
  }

  it("captures exactly once per handler error", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/boom" });
    expect(res.statusCode).toBe(500);
    expect(captured).toHaveLength(1);
    await app.close();
  });

  it("tags path with the ROUTE PATTERN, not the resolved URL", async () => {
    // This is the key Sentry-grouping pin. If a refactor swapped to
    // `req.url`, every distinct :id would shatter into a separate issue
    // in Sentry's UI.
    const app = await buildApp();
    await app.inject({ method: "GET", url: "/users/42" });
    expect(captured).toHaveLength(1);
    expect(captured[0]!.tags.path).toBe("/users/:id");
    // Negative pin: the resolved id must NOT have ended up in the tag.
    expect(captured[0]!.tags.path).not.toBe("/users/42");
    expect(String(captured[0]!.tags.path)).not.toContain("42");
    await app.close();
  });

  it("tags path = routeOptions.url even when req.url carries a querystring", async () => {
    // For static routes, routeOptions.url is the path "/boom" while
    // req.url is "/boom?x=1". The current preference returns "/boom".
    const app = await buildApp();
    await app.inject({ method: "GET", url: "/boom?x=1&y=2" });
    expect(captured).toHaveLength(1);
    expect(captured[0]!.tags.path).toBe("/boom");
    // Negative pin: a refactor that dropped the routeOptions preference
    // would leak querystrings into Sentry tag values.
    expect(String(captured[0]!.tags.path)).not.toContain("?");
    await app.close();
  });

  it("method goes to setExtra, NOT setTag (Sentry cardinality discipline)", async () => {
    const app = await buildApp();
    await app.inject({ method: "GET", url: "/boom" });
    expect(captured).toHaveLength(1);
    expect(captured[0]!.extras.method).toBe("GET");
    // Negative pin: a refactor flipping setExtra↔setTag for method would
    // bloat Sentry's tag index with one tag value per HTTP verb.
    expect(captured[0]!.tags.method).toBeUndefined();
    await app.close();
  });

  it("path goes to setTag, NOT setExtra (so Sentry can filter/group by it)", async () => {
    const app = await buildApp();
    await app.inject({ method: "GET", url: "/boom" });
    expect(captured).toHaveLength(1);
    expect(captured[0]!.tags.path).toBe("/boom");
    expect(captured[0]!.extras.path).toBeUndefined();
    await app.close();
  });

  it("captures only `path` and `method` — no extra scope keys leak in", async () => {
    // Pins the exact scope-touch surface. A refactor that started adding
    // `requestId`, `ip`, or a body excerpt would hit this assertion. If
    // we WANT to add a field, this test is the place to update it.
    const app = await buildApp();
    await app.inject({ method: "GET", url: "/boom" });
    expect(captured).toHaveLength(1);
    expect(Object.keys(captured[0]!.tags).sort()).toEqual(["path"]);
    expect(Object.keys(captured[0]!.extras).sort()).toEqual(["method"]);
    await app.close();
  });

  it("passes the ORIGINAL error reference through (no wrapping, no message rewrite)", async () => {
    initSentry({ env: ENABLED_ENV });
    const app = Fastify({ logger: false });
    attachFastifySentry(app);
    const sentinel = new Error("sentinel-message");
    (sentinel as Error & { code?: string }).code = "SENTINEL_CODE";
    app.get("/sentinel", async () => {
      throw sentinel;
    });
    await app.inject({ method: "GET", url: "/sentinel" });
    expect(captured).toHaveLength(1);
    // Pin referential identity — a refactor that did
    // `captureException(new Error(err.message))` to "normalize" errors
    // would lose `code` and break stack-based fingerprinting.
    expect(captured[0]!.err).toBe(sentinel);
    expect((captured[0]!.err as Error & { code?: string }).code).toBe("SENTINEL_CODE");
    expect((captured[0]!.err as Error).message).toBe("sentinel-message");
    await app.close();
  });
});

describe("attachFastifySentry — scope isolation across errors", () => {
  it("each capture sees only its OWN tags/extras (withScope isolates)", async () => {
    // The hook uses Sentry.withScope so per-error tags don't leak into
    // siblings in the same process. If a refactor dropped withScope and
    // used the global scope, the first error's `path` tag would still
    // be attached when the second error's setTag overwrote it — but more
    // importantly, any tag that the FIRST error set and the second
    // didn't would survive into the second capture. We model that by
    // recording the scope state at capture time and asserting both
    // snapshots show their own (and only their own) path.
    initSentry({ env: ENABLED_ENV });
    const app = Fastify({ logger: false });
    attachFastifySentry(app);
    app.get("/alpha", async () => {
      throw new Error("alpha");
    });
    app.get("/beta", async () => {
      throw new Error("beta");
    });

    await app.inject({ method: "GET", url: "/alpha" });
    await app.inject({ method: "GET", url: "/beta" });

    expect(captured).toHaveLength(2);
    expect(captured[0]!.tags.path).toBe("/alpha");
    expect(captured[1]!.tags.path).toBe("/beta");

    // Symmetric pin: ONLY `path` is set on each snapshot. (Catches a
    // refactor that started mutating the global scope and forgot to
    // clear between requests.)
    expect(Object.keys(captured[0]!.tags)).toEqual(["path"]);
    expect(Object.keys(captured[1]!.tags)).toEqual(["path"]);

    await app.close();
  });

  it("captureException is invoked INSIDE withScope (so tags reach the scope)", async () => {
    // The mock's scope snapshot is empty when `captureException` runs
    // outside withScope. A refactor that moved the captureException call
    // out of the withScope callback would silently send untagged events
    // to Sentry — this pins the wiring.
    initSentry({ env: ENABLED_ENV });
    const app = Fastify({ logger: false });
    attachFastifySentry(app);
    app.get("/inside", async () => {
      throw new Error("inside");
    });
    await app.inject({ method: "GET", url: "/inside" });
    expect(captured).toHaveLength(1);
    // If captureException had been outside the scope, both maps would
    // be empty here.
    expect(captured[0]!.tags.path).toBe("/inside");
    expect(captured[0]!.extras.method).toBe("GET");
    await app.close();
  });

  it("only handler errors capture — successful responses produce no capture", async () => {
    initSentry({ env: ENABLED_ENV });
    const app = Fastify({ logger: false });
    attachFastifySentry(app);
    app.get("/ok", async () => ({ ok: true }));
    app.get("/boom", async () => {
      throw new Error("boom");
    });
    await app.inject({ method: "GET", url: "/ok" });
    await app.inject({ method: "GET", url: "/ok" });
    expect(captured).toHaveLength(0);
    await app.inject({ method: "GET", url: "/boom" });
    expect(captured).toHaveLength(1);
    await app.close();
  });
});

describe("attachFastifySentry — Fastify reply contract", () => {
  it("does not change the response: Fastify still ships its own 500", async () => {
    initSentry({ env: ENABLED_ENV });
    const app = Fastify({ logger: false });
    attachFastifySentry(app);
    app.get("/boom", async () => {
      throw new Error("user-visible-message");
    });
    const res = await app.inject({ method: "GET", url: "/boom" });
    expect(res.statusCode).toBe(500);
    // Body shape is Fastify's default error JSON.
    const body = res.json() as { statusCode: number; error: string; message: string };
    expect(body.statusCode).toBe(500);
    expect(body.error).toBe("Internal Server Error");
    // And the hook fired: we did capture.
    expect(captured).toHaveLength(1);
    expect((captured[0]!.err as Error).message).toBe("user-visible-message");
    await app.close();
  });

  it("captures across multiple HTTP methods on the same route pattern", async () => {
    initSentry({ env: ENABLED_ENV });
    const app = Fastify({ logger: false });
    attachFastifySentry(app);
    app.get("/users/:id", async () => {
      throw new Error("get-err");
    });
    app.post("/users/:id", async () => {
      throw new Error("post-err");
    });
    await app.inject({ method: "GET", url: "/users/1" });
    await app.inject({ method: "POST", url: "/users/2" });
    expect(captured).toHaveLength(2);
    // Both go to the same `path` tag (the route pattern), distinguished
    // only by the `method` extra. That's exactly how Sentry groups.
    expect(captured[0]!.tags.path).toBe("/users/:id");
    expect(captured[1]!.tags.path).toBe("/users/:id");
    expect(captured[0]!.extras.method).toBe("GET");
    expect(captured[1]!.extras.method).toBe("POST");
    await app.close();
  });
});
