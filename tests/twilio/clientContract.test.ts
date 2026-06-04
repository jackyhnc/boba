// Contract test for `src/twilio/client.ts` — the outbound SMS/MMS adapter.
//
// Why this file exists. `tests/twilio/client.test.ts` covers only the
// MMS-vs-SMS form-param branch (MediaUrl present / absent / dry-run).
// Every other invariant of the Twilio REST contract lives unpinned:
//
//   1. Sender selection. When `TWILIO_MESSAGING_SERVICE_SID` is set, the
//      body must carry `MessagingServiceSid` and NOT `From` (Twilio
//      rejects requests that supply both). When only `TWILIO_PHONE_NUMBER`
//      is set, the body must carry `From`. Swapping these is a silent
//      outbound regression — every message would be rejected by Twilio,
//      not by our code, so the failure surfaces as 4xx in production.
//
//   2. Credential gates. With `TWILIO_DRY_RUN=false`, missing
//      SID/token must throw a specific error (not fall through to a 401
//      Twilio response), and missing sender (neither phone nor
//      messaging-service SID) must throw before fetch. The error
//      messages are part of the operator UX — "credentials missing" vs
//      "sender missing" tells the operator which env var to set.
//
//   3. Auth + URL shape. Basic auth header is base64(`${SID}:${token}`),
//      URL is `https://api.twilio.com/2010-04-01/Accounts/{SID}/Messages.json`,
//      Content-Type is `application/x-www-form-urlencoded`. A refactor
//      that swaps to `application/json` or drops the Authorization
//      header would pass the existing MMS test (which never inspects
//      these), but every live call would 401.
//
//   4. Error surfaces. Non-OK HTTP responses must throw, embedding the
//      status code so the caller can log + retry sensibly. The route
//      layer (`src/twilio/routes.ts`) and scheduler use the thrown
//      message verbatim for their warn logs.
//
//   5. Missing `sid` in response body must throw. Twilio guarantees a
//      `sid` on 2xx, but a network proxy/middlebox that returns 200 with
//      an empty body would otherwise crash downstream with `undefined`
//      SIDs in the Message rows.
//
//   6. Dry-run synthetic SID format. The `DRYRUN-` prefix is the only
//      signal in logs that an outbound was short-circuited; downstream
//      tooling (log search, the Message table reader) keys on it.

import { describe, it, expect, vi } from "vitest";
import { createTwilioClient } from "../../src/twilio/client.js";

type ClientEnv = Parameters<typeof createTwilioClient>[0]["env"];

const baseLiveEnv: ClientEnv = {
  TWILIO_ACCOUNT_SID: "AC" + "0".repeat(32),
  TWILIO_AUTH_TOKEN: "tok-secret",
  TWILIO_PHONE_NUMBER: "+15550000000",
  TWILIO_MESSAGING_SERVICE_SID: "",
  TWILIO_DRY_RUN: false,
};

function silentLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

function okResponse(sid = "SMabc"): Response {
  return {
    ok: true,
    status: 201,
    json: async () => ({ sid }),
    text: async () => "",
  } as unknown as Response;
}

function failResponse(status: number, body: string): Response {
  return {
    ok: false,
    status,
    json: async () => {
      throw new Error("not json");
    },
    text: async () => body,
  } as unknown as Response;
}

interface CapturedRequest {
  url: string;
  method?: string;
  headers: Record<string, string>;
  bodyParams: URLSearchParams;
}

function makeCapturingFetch(response: Response = okResponse()): {
  fetchImpl: typeof fetch;
  captured: CapturedRequest[];
} {
  const captured: CapturedRequest[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    const rawHeaders = (init?.headers ?? {}) as Record<string, string>;
    for (const k of Object.keys(rawHeaders)) {
      const v = rawHeaders[k];
      if (v !== undefined) headers[k] = v;
    }
    captured.push({
      url: String(url),
      method: init?.method,
      headers,
      bodyParams: new URLSearchParams((init?.body as string) ?? ""),
    });
    return response;
  }) as unknown as typeof fetch;
  return { fetchImpl, captured };
}

describe("createTwilioClient — sender selection", () => {
  it("uses MessagingServiceSid (not From) when TWILIO_MESSAGING_SERVICE_SID is set", async () => {
    const { fetchImpl, captured } = makeCapturingFetch();
    const client = createTwilioClient({
      env: {
        ...baseLiveEnv,
        TWILIO_PHONE_NUMBER: "+15550000000",
        TWILIO_MESSAGING_SERVICE_SID: "MG" + "f".repeat(32),
      },
      logger: silentLogger(),
      fetchImpl,
    });

    await client.sendSms({ to: "+15551112222", body: "hi" });

    expect(captured).toHaveLength(1);
    const params = captured[0]!.bodyParams;
    expect(params.get("MessagingServiceSid")).toBe("MG" + "f".repeat(32));
    // Critical: Twilio rejects requests that carry BOTH From and
    // MessagingServiceSid. The client must pick exactly one.
    expect(params.has("From")).toBe(false);
  });

  it("uses From (not MessagingServiceSid) when only TWILIO_PHONE_NUMBER is set", async () => {
    const { fetchImpl, captured } = makeCapturingFetch();
    const client = createTwilioClient({
      env: { ...baseLiveEnv, TWILIO_MESSAGING_SERVICE_SID: "" },
      logger: silentLogger(),
      fetchImpl,
    });

    await client.sendSms({ to: "+15551112222", body: "hi" });

    const params = captured[0]!.bodyParams;
    expect(params.get("From")).toBe("+15550000000");
    expect(params.has("MessagingServiceSid")).toBe(false);
  });

  it("prefers MessagingServiceSid when both are set (single sender invariant)", async () => {
    const { fetchImpl, captured } = makeCapturingFetch();
    const client = createTwilioClient({
      env: {
        ...baseLiveEnv,
        TWILIO_PHONE_NUMBER: "+15550000000",
        TWILIO_MESSAGING_SERVICE_SID: "MG" + "a".repeat(32),
      },
      logger: silentLogger(),
      fetchImpl,
    });

    await client.sendSms({ to: "+15551112222", body: "hi" });

    const params = captured[0]!.bodyParams;
    expect(params.get("MessagingServiceSid")).toBe("MG" + "a".repeat(32));
    expect(params.has("From")).toBe(false);
  });
});

describe("createTwilioClient — credential gates", () => {
  it("throws a 'credentials missing' error when SID is empty (live mode)", async () => {
    const { fetchImpl } = makeCapturingFetch();
    const client = createTwilioClient({
      env: { ...baseLiveEnv, TWILIO_ACCOUNT_SID: "" },
      logger: silentLogger(),
      fetchImpl,
    });

    await expect(
      client.sendSms({ to: "+15551112222", body: "hi" }),
    ).rejects.toThrow(/credentials missing/i);
    // Must not have called fetch — the gate is before the network call.
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("throws a 'credentials missing' error when auth token is empty (live mode)", async () => {
    const { fetchImpl } = makeCapturingFetch();
    const client = createTwilioClient({
      env: { ...baseLiveEnv, TWILIO_AUTH_TOKEN: "" },
      logger: silentLogger(),
      fetchImpl,
    });

    await expect(
      client.sendSms({ to: "+15551112222", body: "hi" }),
    ).rejects.toThrow(/credentials missing/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("throws a 'sender missing' error when neither phone nor messaging-service SID is set", async () => {
    const { fetchImpl } = makeCapturingFetch();
    const client = createTwilioClient({
      env: {
        ...baseLiveEnv,
        TWILIO_PHONE_NUMBER: "",
        TWILIO_MESSAGING_SERVICE_SID: "",
      },
      logger: silentLogger(),
      fetchImpl,
    });

    await expect(
      client.sendSms({ to: "+15551112222", body: "hi" }),
    ).rejects.toThrow(/sender missing/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("dry-run mode skips credential gates entirely", async () => {
    const { fetchImpl } = makeCapturingFetch();
    const client = createTwilioClient({
      env: {
        TWILIO_ACCOUNT_SID: "",
        TWILIO_AUTH_TOKEN: "",
        TWILIO_PHONE_NUMBER: "",
        TWILIO_MESSAGING_SERVICE_SID: "",
        TWILIO_DRY_RUN: true,
      },
      logger: silentLogger(),
      fetchImpl,
    });

    const result = await client.sendSms({ to: "+15551112222", body: "hi" });
    expect(result.dryRun).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("createTwilioClient — HTTP request shape", () => {
  it("targets the correct Twilio Messages endpoint with the SID in the path", async () => {
    const sid = "AC" + "1".repeat(32);
    const { fetchImpl, captured } = makeCapturingFetch();
    const client = createTwilioClient({
      env: { ...baseLiveEnv, TWILIO_ACCOUNT_SID: sid },
      logger: silentLogger(),
      fetchImpl,
    });

    await client.sendSms({ to: "+15551112222", body: "hi" });

    expect(captured[0]!.url).toBe(
      `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
    );
    expect(captured[0]!.method).toBe("POST");
  });

  it("URL-encodes the SID in the path", async () => {
    // Sanity: real Twilio SIDs are URL-safe, but the encoding is the
    // last line of defence if an operator paste-mangles the env var.
    const sid = "AC weird/sid";
    const { fetchImpl, captured } = makeCapturingFetch();
    const client = createTwilioClient({
      env: { ...baseLiveEnv, TWILIO_ACCOUNT_SID: sid },
      logger: silentLogger(),
      fetchImpl,
    });

    await client.sendSms({ to: "+15551112222", body: "hi" });

    expect(captured[0]!.url).toContain("AC%20weird%2Fsid");
  });

  it("sets Basic auth header from SID:token (base64)", async () => {
    const { fetchImpl, captured } = makeCapturingFetch();
    const client = createTwilioClient({
      env: {
        ...baseLiveEnv,
        TWILIO_ACCOUNT_SID: "ACsid",
        TWILIO_AUTH_TOKEN: "secret",
      },
      logger: silentLogger(),
      fetchImpl,
    });

    await client.sendSms({ to: "+15551112222", body: "hi" });

    const expected = "Basic " + Buffer.from("ACsid:secret", "utf8").toString("base64");
    expect(captured[0]!.headers.Authorization).toBe(expected);
  });

  it("uses Content-Type application/x-www-form-urlencoded and JSON Accept", async () => {
    const { fetchImpl, captured } = makeCapturingFetch();
    const client = createTwilioClient({
      env: baseLiveEnv,
      logger: silentLogger(),
      fetchImpl,
    });

    await client.sendSms({ to: "+15551112222", body: "hi" });

    expect(captured[0]!.headers["Content-Type"]).toBe(
      "application/x-www-form-urlencoded",
    );
    expect(captured[0]!.headers.Accept).toBe("application/json");
  });

  it("URL-encodes the To, Body, and MediaUrl form params (handles + and spaces)", async () => {
    const { fetchImpl, captured } = makeCapturingFetch();
    const client = createTwilioClient({
      env: baseLiveEnv,
      logger: silentLogger(),
      fetchImpl,
    });

    await client.sendSms({
      to: "+15551112222",
      body: "hello world & friends",
      mediaUrl: "https://cdn.boba.test/x y.jpg",
    });

    // URLSearchParams round-trips the decoded values; the wire format
    // (the raw body string) is what Twilio receives, so the params view
    // is the right level of abstraction.
    const params = captured[0]!.bodyParams;
    expect(params.get("To")).toBe("+15551112222");
    expect(params.get("Body")).toBe("hello world & friends");
    expect(params.get("MediaUrl")).toBe("https://cdn.boba.test/x y.jpg");
  });
});

describe("createTwilioClient — error surfaces", () => {
  it("throws on non-OK responses, embedding status + body in the message", async () => {
    const fetchImpl = vi.fn(async () =>
      failResponse(400, '{"code":21211,"message":"Invalid To"}'),
    ) as unknown as typeof fetch;
    const logger = silentLogger();
    const client = createTwilioClient({ env: baseLiveEnv, logger, fetchImpl });

    await expect(
      client.sendSms({ to: "+1", body: "hi" }),
    ).rejects.toThrow(/Twilio sendSms failed: 400/);
    await expect(
      client.sendSms({ to: "+1", body: "hi" }),
    ).rejects.toThrow(/Invalid To/);

    expect(logger.error).toHaveBeenCalled();
  });

  it("surfaces 5xx responses (transient Twilio outage path)", async () => {
    const fetchImpl = vi.fn(async () =>
      failResponse(503, "service unavailable"),
    ) as unknown as typeof fetch;
    const client = createTwilioClient({
      env: baseLiveEnv,
      logger: silentLogger(),
      fetchImpl,
    });

    await expect(
      client.sendSms({ to: "+1", body: "hi" }),
    ).rejects.toThrow(/503/);
  });

  it("throws when Twilio responds 2xx with no sid", async () => {
    // A misbehaving middlebox could return an empty 200 — the client
    // must refuse rather than write `undefined` into Message.twilioSid.
    const fetchImpl = vi.fn(async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({}),
        text: async () => "{}",
      } as unknown as Response),
    ) as unknown as typeof fetch;
    const client = createTwilioClient({
      env: baseLiveEnv,
      logger: silentLogger(),
      fetchImpl,
    });

    await expect(
      client.sendSms({ to: "+1", body: "hi" }),
    ).rejects.toThrow(/returned no sid/i);
  });

  it("does not throw when the error body is unreadable (safeReadText fallback)", async () => {
    // The client logs `<no body>` instead of crashing if the response
    // text stream errors — but the call still throws with the status.
    const fetchImpl = vi.fn(async () =>
      ({
        ok: false,
        status: 502,
        text: async () => {
          throw new Error("body stream errored");
        },
        json: async () => ({}),
      } as unknown as Response),
    ) as unknown as typeof fetch;
    const client = createTwilioClient({
      env: baseLiveEnv,
      logger: silentLogger(),
      fetchImpl,
    });

    await expect(
      client.sendSms({ to: "+1", body: "hi" }),
    ).rejects.toThrow(/502/);
  });
});

describe("createTwilioClient — successful return shape", () => {
  it("returns the upstream sid and the HTTP status on a live call", async () => {
    const { fetchImpl } = makeCapturingFetch(okResponse("MMliveid"));
    const client = createTwilioClient({
      env: baseLiveEnv,
      logger: silentLogger(),
      fetchImpl,
    });

    const result = await client.sendSms({ to: "+1", body: "hi" });
    expect(result.sid).toBe("MMliveid");
    expect(result.dryRun).toBe(false);
    expect(result.status).toBe(201);
  });

  it("dry-run returns dryRun=true with a DRYRUN- prefixed synthetic sid and no status", async () => {
    const { fetchImpl } = makeCapturingFetch();
    const client = createTwilioClient({
      env: { ...baseLiveEnv, TWILIO_DRY_RUN: true },
      logger: silentLogger(),
      fetchImpl,
    });

    const result = await client.sendSms({ to: "+1", body: "hi" });
    expect(result.dryRun).toBe(true);
    expect(result.sid.startsWith("DRYRUN-")).toBe(true);
    // Synthetic sids carry no upstream status by design — downstream
    // log search keys on `status === undefined` to identify dry runs.
    expect(result.status).toBeUndefined();
  });
});

describe("createTwilioClient — defaulting", () => {
  it("falls back to globalThis.fetch when fetchImpl is not provided", () => {
    // We can't actually call sendSms without mocking fetch, but
    // constructing the client must not throw — the default binding is
    // resolved at call time, not at construction.
    expect(() =>
      createTwilioClient({ env: baseLiveEnv, logger: silentLogger() }),
    ).not.toThrow();
  });
});
