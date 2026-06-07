// Contract pins for src/admin/auth.ts.
//
// `tests/admin/auth.test.ts` covers happy/sad paths but doesn't pin
// wire-format invariants: the exact error body shapes, the case-sensitive
// header lookup, the 503-over-401 precedence, the don't-touch-the-reply
// pass-through behaviour, and closure semantics. Each test below sits at a
// seam where a plausible refactor would pass the existing behavioural
// suite while silently breaking admin clients or — worse — silently
// granting access.

import { describe, it, expect } from "vitest";
import type { FastifyReply, FastifyRequest } from "fastify";
import { makeAdminAuth } from "../../src/admin/auth.js";

// ─── Reply trap ────────────────────────────────────────────────────────────
//
// Records every call to reply.code() / reply.send() (and a counter so we can
// detect the pass-through "did not touch the reply" case). Chains both
// methods so `reply.code(503).send(...)` works exactly like Fastify's.

interface Trap {
  codeCalls: number[];
  sendCalls: unknown[];
  code: number | undefined;
  body: unknown;
}

function mkReplyTrap(): { reply: FastifyReply; trap: Trap } {
  const trap: Trap = {
    codeCalls: [],
    sendCalls: [],
    code: undefined,
    body: undefined,
  };
  const reply = {
    code(c: number) {
      trap.codeCalls.push(c);
      trap.code = c;
      return reply;
    },
    async send(body: unknown) {
      trap.sendCalls.push(body);
      trap.body = body;
      return reply;
    },
  };
  return { reply: reply as unknown as FastifyReply, trap };
}

function mkReq(headers: Record<string, string | string[]> = {}): FastifyRequest {
  return { headers } as unknown as FastifyRequest;
}

// ─── 1. Exact error body shapes ────────────────────────────────────────────

describe("admin/auth contract — error body shapes are exact", () => {
  // Admin clients (and our own /admin UI, if we ever build one) branch on
  // these bodies. Renaming `error` → `message`, adding a `code` field, or
  // changing the strings would silently break consumers without tripping
  // the existing behavioural tests (which only assert the status code).

  it("admin-disabled response body is exactly { error: 'admin disabled' } — no extra keys", async () => {
    const guard = makeAdminAuth({ expected: "" });
    const { reply, trap } = mkReplyTrap();
    await guard(mkReq({ "x-admin-token": "whatever" }), reply);
    expect(trap.body).toEqual({ error: "admin disabled" });
    expect(Object.keys(trap.body as object)).toEqual(["error"]);
  });

  it("unauthorized response body is exactly { error: 'unauthorized' } — no extra keys", async () => {
    const guard = makeAdminAuth({ expected: "sekret" });
    const { reply, trap } = mkReplyTrap();
    await guard(mkReq({ "x-admin-token": "wrong" }), reply);
    expect(trap.body).toEqual({ error: "unauthorized" });
    expect(Object.keys(trap.body as object)).toEqual(["error"]);
  });

  it("missing-header response body is also { error: 'unauthorized' } (same path)", async () => {
    // No "missing token" vs "wrong token" distinction — both are auth
    // failures and must not leak which case occurred. Pin the unification.
    const guard = makeAdminAuth({ expected: "sekret" });
    const { reply, trap } = mkReplyTrap();
    await guard(mkReq({}), reply);
    expect(trap.body).toEqual({ error: "unauthorized" });
  });

  it("admin-disabled and unauthorized bodies are strictly distinct", async () => {
    const disabled = makeAdminAuth({ expected: "" });
    const unauth = makeAdminAuth({ expected: "sekret" });
    const a = mkReplyTrap();
    const b = mkReplyTrap();
    await disabled(mkReq({}), a.reply);
    await unauth(mkReq({}), b.reply);
    expect(a.trap.body).not.toEqual(b.trap.body);
  });
});

// ─── 2. Status-code precedence: 503 takes priority over 401 ────────────────

describe("admin/auth contract — 503 short-circuits before 401", () => {
  // When the env token is empty AND the request supplies a (necessarily
  // wrong) header, the guard must return 503 (admin disabled), NOT 401.
  // A refactor that checked the header first would flip the meaning and
  // leak the fact that admin is configured (or not) depending on response
  // shape. Pin the precedence.

  it("empty expected + non-empty supplied → 503, not 401", async () => {
    const guard = makeAdminAuth({ expected: "" });
    const { reply, trap } = mkReplyTrap();
    await guard(mkReq({ "x-admin-token": "anything" }), reply);
    expect(trap.code).toBe(503);
  });

  it("empty expected + empty supplied → 503 (NOT a 401 'unauthorized', NOT pass-through)", async () => {
    // The dangerous case: if a refactor made secureEqual return true on
    // ('', ''), and the disabled-check was removed or reordered, an empty
    // ADMIN_TOKEN deploy would silently grant every request. Pin that the
    // disabled-check fires first and unconditionally.
    const guard = makeAdminAuth({ expected: "" });
    const { reply, trap } = mkReplyTrap();
    await guard(mkReq({ "x-admin-token": "" }), reply);
    expect(trap.code).toBe(503);
    expect(trap.body).toEqual({ error: "admin disabled" });
  });

  it("empty expected + missing header → 503 (still not 401)", async () => {
    const guard = makeAdminAuth({ expected: "" });
    const { reply, trap } = mkReplyTrap();
    await guard(mkReq({}), reply);
    expect(trap.code).toBe(503);
  });
});

// ─── 3. Header name is exactly `x-admin-token` (lowercase) ─────────────────

describe("admin/auth contract — header lookup is exactly 'x-admin-token'", () => {
  // Fastify normalises incoming header names to lowercase, so the guard
  // MUST look up the lowercase key. A refactor that read "X-Admin-Token"
  // (mixed case) would always miss in production. Pin the exact key.

  it("looks up the lowercase header name", async () => {
    const guard = makeAdminAuth({ expected: "sekret" });
    const { reply, trap } = mkReplyTrap();
    await guard(mkReq({ "x-admin-token": "sekret" }), reply);
    expect(trap.code).toBeUndefined();
    expect(trap.body).toBeUndefined();
  });

  it("does NOT also accept Authorization header (rules out bearer-style refactor leak)", async () => {
    // If a refactor adds Authorization-header support, this test forces
    // an explicit decision (delete this test, add a new contract pin).
    const guard = makeAdminAuth({ expected: "sekret" });
    const { reply, trap } = mkReplyTrap();
    await guard(mkReq({ authorization: "Bearer sekret" }), reply);
    expect(trap.code).toBe(401);
  });

  it("does NOT accept x-admin-key, x-api-key, or other near-miss header names", async () => {
    const guard = makeAdminAuth({ expected: "sekret" });
    for (const wrongKey of ["x-admin-key", "x-api-key", "x-token", "admin-token"]) {
      const { reply, trap } = mkReplyTrap();
      await guard(mkReq({ [wrongKey]: "sekret" }), reply);
      expect(trap.code, `header ${wrongKey} must not authorise`).toBe(401);
    }
  });
});

// ─── 4. Case-sensitive comparison ──────────────────────────────────────────

describe("admin/auth contract — token comparison is case-sensitive", () => {
  // ADMIN_TOKEN is opaque entropy; case-folding it would shrink the
  // keyspace and silently change which strings authorise. Pin both
  // directions (supplied uppercased and expected uppercased).

  it("supplied token in different case is rejected", async () => {
    const guard = makeAdminAuth({ expected: "AbCdEf" });
    const { reply, trap } = mkReplyTrap();
    await guard(mkReq({ "x-admin-token": "abcdef" }), reply);
    expect(trap.code).toBe(401);
  });

  it("supplied token in upper case is rejected when expected is lower", async () => {
    const guard = makeAdminAuth({ expected: "abcdef" });
    const { reply, trap } = mkReplyTrap();
    await guard(mkReq({ "x-admin-token": "ABCDEF" }), reply);
    expect(trap.code).toBe(401);
  });
});

// ─── 5. Whitespace and trailing characters are NOT tolerated ───────────────

describe("admin/auth contract — comparison is exact, no trim", () => {
  // The header value is taken verbatim. A reverse proxy that appends a
  // stray newline or a client that includes a trailing space must NOT
  // accidentally authenticate, but equally must NOT mysteriously fail
  // either — the contract is "exact bytes". Pin no-trim behaviour.

  it("trailing whitespace on supplied token rejects", async () => {
    const guard = makeAdminAuth({ expected: "sekret" });
    const { reply, trap } = mkReplyTrap();
    await guard(mkReq({ "x-admin-token": "sekret " }), reply);
    expect(trap.code).toBe(401);
  });

  it("leading whitespace on supplied token rejects", async () => {
    const guard = makeAdminAuth({ expected: "sekret" });
    const { reply, trap } = mkReplyTrap();
    await guard(mkReq({ "x-admin-token": " sekret" }), reply);
    expect(trap.code).toBe(401);
  });

  it("trailing newline on supplied token rejects", async () => {
    const guard = makeAdminAuth({ expected: "sekret" });
    const { reply, trap } = mkReplyTrap();
    await guard(mkReq({ "x-admin-token": "sekret\n" }), reply);
    expect(trap.code).toBe(401);
  });
});

// ─── 6. Pass-through path leaves reply untouched ───────────────────────────

describe("admin/auth contract — successful auth sends NO response", () => {
  // Fastify pre-handlers indicate "proceed to the route" by NOT touching
  // the reply. A refactor that called `reply.send()` on the happy path
  // would consume the reply and the actual route handler would never run
  // (or worse, throw "reply already sent"). Pin: zero calls to code() and
  // zero calls to send() on the success path.

  it("happy path makes ZERO calls to reply.code() and reply.send()", async () => {
    const guard = makeAdminAuth({ expected: "sekret" });
    const { reply, trap } = mkReplyTrap();
    const ret = await guard(mkReq({ "x-admin-token": "sekret" }), reply);
    expect(trap.codeCalls).toEqual([]);
    expect(trap.sendCalls).toEqual([]);
    expect(trap.code).toBeUndefined();
    expect(trap.body).toBeUndefined();
    expect(ret).toBeUndefined();
  });

  it("503 disabled path makes exactly one code() call and one send() call", async () => {
    const guard = makeAdminAuth({ expected: "" });
    const { reply, trap } = mkReplyTrap();
    await guard(mkReq({ "x-admin-token": "x" }), reply);
    expect(trap.codeCalls).toEqual([503]);
    expect(trap.sendCalls.length).toBe(1);
  });

  it("401 unauthorized path makes exactly one code() call and one send() call", async () => {
    const guard = makeAdminAuth({ expected: "sekret" });
    const { reply, trap } = mkReplyTrap();
    await guard(mkReq({ "x-admin-token": "wrong" }), reply);
    expect(trap.codeCalls).toEqual([401]);
    expect(trap.sendCalls.length).toBe(1);
  });
});

// ─── 7. Closure captures `expected` at construction time ───────────────────

describe("admin/auth contract — `expected` is captured at construction", () => {
  // The guard reads `opts.expected` once when built and closes over the
  // resulting string. Mutating the opts object after construction MUST NOT
  // change behaviour — otherwise an env-reload helper that mutated the
  // existing opts (instead of rebuilding the guard) would create a
  // confusing per-request divergence. Pin closure semantics.

  it("mutating opts.expected after construction does not affect the guard", async () => {
    const opts = { expected: "original" };
    const guard = makeAdminAuth(opts);

    opts.expected = "changed"; // attempt to mutate

    // 'original' must still authorise; 'changed' must NOT.
    const a = mkReplyTrap();
    await guard(mkReq({ "x-admin-token": "original" }), a.reply);
    expect(a.trap.code).toBeUndefined();

    const b = mkReplyTrap();
    await guard(mkReq({ "x-admin-token": "changed" }), b.reply);
    expect(b.trap.code).toBe(401);
  });

  it("two guards built with different tokens have independent state", async () => {
    // Pins against a "static expected" refactor that hoisted `expected`
    // out of the closure — would cause the second makeAdminAuth call to
    // overwrite the first guard's token.
    const g1 = makeAdminAuth({ expected: "alpha" });
    const g2 = makeAdminAuth({ expected: "beta" });

    const a1 = mkReplyTrap();
    await g1(mkReq({ "x-admin-token": "alpha" }), a1.reply);
    expect(a1.trap.code).toBeUndefined();

    const a2 = mkReplyTrap();
    await g1(mkReq({ "x-admin-token": "beta" }), a2.reply);
    expect(a2.trap.code).toBe(401);

    const b1 = mkReplyTrap();
    await g2(mkReq({ "x-admin-token": "beta" }), b1.reply);
    expect(b1.trap.code).toBeUndefined();

    const b2 = mkReplyTrap();
    await g2(mkReq({ "x-admin-token": "alpha" }), b2.reply);
    expect(b2.trap.code).toBe(401);
  });
});

// ─── 8. Length-mismatch returns 401, does NOT throw ────────────────────────

describe("admin/auth contract — length-mismatched tokens return 401 (no throw)", () => {
  // Node's crypto.timingSafeEqual throws when the two buffers have
  // different lengths. The auth module pads to equal length before
  // calling it (the wasted-work pattern in secureEqual). A refactor that
  // dropped the padding would crash the request with an uncaught
  // RangeError instead of a clean 401. Pin both extremes.

  it("supplied shorter than expected → 401 (no throw)", async () => {
    const guard = makeAdminAuth({ expected: "abcdefghij" });
    const { reply, trap } = mkReplyTrap();
    await expect(
      guard(mkReq({ "x-admin-token": "ab" }), reply),
    ).resolves.toBeUndefined();
    expect(trap.code).toBe(401);
  });

  it("supplied longer than expected → 401 (no throw)", async () => {
    const guard = makeAdminAuth({ expected: "ab" });
    const { reply, trap } = mkReplyTrap();
    await expect(
      guard(mkReq({ "x-admin-token": "abcdefghij" }), reply),
    ).resolves.toBeUndefined();
    expect(trap.code).toBe(401);
  });

  it("empty supplied vs non-empty expected → 401 (no throw)", async () => {
    const guard = makeAdminAuth({ expected: "sekret" });
    const { reply, trap } = mkReplyTrap();
    await expect(
      guard(mkReq({ "x-admin-token": "" }), reply),
    ).resolves.toBeUndefined();
    expect(trap.code).toBe(401);
  });
});

// ─── 9. makeAdminAuth always returns an async function ─────────────────────

describe("admin/auth contract — makeAdminAuth return shape", () => {
  // Fastify pre-handlers can be sync or async. We chose async — pinning
  // the shape so a refactor to sync (which would still work for happy
  // path but break the await semantics on the error branches that call
  // `await reply.code(...).send(...)`) is caught.

  it("returns an async function (Promise-returning)", () => {
    const guard = makeAdminAuth({ expected: "x" });
    expect(typeof guard).toBe("function");
    const result = guard(mkReq({ "x-admin-token": "x" }), mkReplyTrap().reply);
    expect(result).toBeInstanceOf(Promise);
  });

  it("the same guard instance is reusable across requests with independent traps", async () => {
    // Pins against any stateful refactor (e.g. memoising the last reply)
    // that would couple concurrent requests.
    const guard = makeAdminAuth({ expected: "sekret" });
    const a = mkReplyTrap();
    const b = mkReplyTrap();
    await Promise.all([
      guard(mkReq({ "x-admin-token": "wrong1" }), a.reply),
      guard(mkReq({ "x-admin-token": "wrong2" }), b.reply),
    ]);
    expect(a.trap.code).toBe(401);
    expect(b.trap.code).toBe(401);
    // Each trap recorded exactly one code() and one send() call.
    expect(a.trap.codeCalls.length).toBe(1);
    expect(b.trap.codeCalls.length).toBe(1);
  });
});
