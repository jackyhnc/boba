// Admin authorization.
//
// All `/admin/*` routes share a single bearer-style guard: the request
// MUST include `X-Admin-Token: <ADMIN_TOKEN env>`. Comparisons run in
// constant time to avoid timing leaks. When the env value is empty, the
// guard short-circuits to 503 (Service Unavailable) — admin is disabled.

import { timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";

export interface AdminAuthOptions {
  /** Server-side ADMIN_TOKEN (from env). Empty string disables admin. */
  expected: string;
}

/**
 * Pre-handler that enforces the X-Admin-Token header. Returns
 *   - 503 when admin is disabled (no token configured)
 *   - 401 when the header is missing or mismatched
 *   - falls through (returns void) when the token matches.
 */
export function makeAdminAuth(opts: AdminAuthOptions) {
  const expected = opts.expected;
  return async function adminAuth(
    req: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    if (!expected) {
      await reply.code(503).send({ error: "admin disabled" });
      return;
    }
    const supplied = (req.headers["x-admin-token"] ?? "").toString();
    if (!secureEqual(supplied, expected)) {
      await reply.code(401).send({ error: "unauthorized" });
      return;
    }
  };
}

function secureEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) {
    // timingSafeEqual requires equal lengths; pad the shorter to avoid early
    // return based on length differences alone. We still report mismatch.
    const pad = Buffer.alloc(Math.max(aBuf.length, bBuf.length));
    aBuf.copy(pad);
    const bPad = Buffer.alloc(pad.length);
    bBuf.copy(bPad);
    timingSafeEqual(pad, bPad); // wasted work, intentional
    return false;
  }
  return timingSafeEqual(aBuf, bBuf);
}
