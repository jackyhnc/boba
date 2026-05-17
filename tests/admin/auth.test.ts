import { describe, it, expect } from "vitest";
import { makeAdminAuth } from "../../src/admin/auth.js";

function mkReplyTrap() {
  const out: { code?: number; body?: unknown } = {};
  const reply = {
    code(c: number) {
      out.code = c;
      return reply;
    },
    async send(body: unknown) {
      out.body = body;
      return reply;
    },
  };
  return { reply: reply as unknown as Parameters<ReturnType<typeof makeAdminAuth>>[1], out };
}

function mkReq(token?: string) {
  return {
    headers: token ? { "x-admin-token": token } : {},
  } as unknown as Parameters<ReturnType<typeof makeAdminAuth>>[0];
}

describe("makeAdminAuth", () => {
  it("returns 503 when ADMIN_TOKEN is empty", async () => {
    const guard = makeAdminAuth({ expected: "" });
    const { reply, out } = mkReplyTrap();
    await guard(mkReq("anything"), reply);
    expect(out.code).toBe(503);
    expect(out.body).toMatchObject({ error: "admin disabled" });
  });

  it("returns 401 on missing header", async () => {
    const guard = makeAdminAuth({ expected: "sekret" });
    const { reply, out } = mkReplyTrap();
    await guard(mkReq(undefined), reply);
    expect(out.code).toBe(401);
  });

  it("returns 401 on wrong token", async () => {
    const guard = makeAdminAuth({ expected: "sekret" });
    const { reply, out } = mkReplyTrap();
    await guard(mkReq("nope"), reply);
    expect(out.code).toBe(401);
  });

  it("passes through on correct token", async () => {
    const guard = makeAdminAuth({ expected: "sekret" });
    const { reply, out } = mkReplyTrap();
    await guard(mkReq("sekret"), reply);
    expect(out.code).toBeUndefined();
    expect(out.body).toBeUndefined();
  });

  it("constant-time compare handles different-length tokens", async () => {
    const guard = makeAdminAuth({ expected: "abcdef" });
    const { reply, out } = mkReplyTrap();
    await guard(mkReq("ab"), reply);
    expect(out.code).toBe(401);
  });
});
