import { describe, it, expect, vi } from "vitest";
import { createTwilioClient } from "../../src/twilio/client.js";

type ClientEnv = Parameters<typeof createTwilioClient>[0]["env"];

const liveEnv: ClientEnv = {
  TWILIO_ACCOUNT_SID: "AC" + "0".repeat(32),
  TWILIO_AUTH_TOKEN: "tok",
  TWILIO_PHONE_NUMBER: "+15550000000",
  TWILIO_MESSAGING_SERVICE_SID: "",
  TWILIO_DRY_RUN: false,
};

const silentLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

function okResponse(): Response {
  return {
    ok: true,
    status: 201,
    json: async () => ({ sid: "MMabc" }),
    text: async () => "",
  } as unknown as Response;
}

describe("twilio client MMS media", () => {
  it("sets the MediaUrl form param when mediaUrl is provided", async () => {
    let capturedBody = "";
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      capturedBody = (init?.body as string) ?? "";
      return okResponse();
    }) as unknown as typeof fetch;

    const client = createTwilioClient({ env: liveEnv, logger: silentLogger, fetchImpl });
    const result = await client.sendSms({
      to: "+15551112222",
      body: "here's your match",
      mediaUrl: "https://cdn.boba.test/photo.jpg",
    });

    expect(result.sid).toBe("MMabc");
    const params = new URLSearchParams(capturedBody);
    expect(params.get("MediaUrl")).toBe("https://cdn.boba.test/photo.jpg");
    expect(params.get("To")).toBe("+15551112222");
    expect(params.get("Body")).toBe("here's your match");
  });

  it("omits the MediaUrl form param for a plain SMS", async () => {
    let capturedBody = "";
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      capturedBody = (init?.body as string) ?? "";
      return okResponse();
    }) as unknown as typeof fetch;

    const client = createTwilioClient({ env: liveEnv, logger: silentLogger, fetchImpl });
    await client.sendSms({ to: "+15551112222", body: "just text" });

    const params = new URLSearchParams(capturedBody);
    expect(params.has("MediaUrl")).toBe(false);
  });

  it("short-circuits MMS in dry-run mode without calling fetch", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const client = createTwilioClient({
      env: { ...liveEnv, TWILIO_DRY_RUN: true },
      logger: silentLogger,
      fetchImpl,
    });

    const result = await client.sendSms({
      to: "+15551112222",
      body: "reveal",
      mediaUrl: "https://cdn.boba.test/photo.jpg",
    });

    expect(result.dryRun).toBe(true);
    expect(result.sid).toMatch(/^DRYRUN-/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
