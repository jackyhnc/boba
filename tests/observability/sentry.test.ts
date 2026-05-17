import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  _resetSentryForTests,
  initSentry,
} from "../../src/observability/sentry.js";

vi.mock("@sentry/node", () => {
  const init = vi.fn();
  return {
    init,
    withScope: (fn: (s: { setTag: () => void; setExtra: () => void }) => void) =>
      fn({ setTag: () => undefined, setExtra: () => undefined }),
    captureException: vi.fn(),
  };
});

import * as SentryMock from "@sentry/node";

beforeEach(() => {
  _resetSentryForTests();
  vi.clearAllMocks();
});

afterEach(() => {
  _resetSentryForTests();
});

describe("initSentry", () => {
  it("no-ops when DSN is empty", () => {
    const ok = initSentry({
      env: {
        SENTRY_DSN: "",
        SENTRY_TRACES_SAMPLE_RATE: 0,
        NODE_ENV: "development",
      },
    });
    expect(ok).toBe(false);
    expect((SentryMock.init as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(0);
  });

  it("initializes with DSN + sample rate", () => {
    const ok = initSentry({
      env: {
        SENTRY_DSN: "https://abc@sentry.io/1",
        SENTRY_TRACES_SAMPLE_RATE: 0.25,
        NODE_ENV: "production",
      },
    });
    expect(ok).toBe(true);
    const calls = (SentryMock.init as unknown as { mock: { calls: Array<[unknown]> } }).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toMatchObject({
      dsn: "https://abc@sentry.io/1",
      environment: "production",
      tracesSampleRate: 0.25,
    });
  });

  it("is idempotent (second init is a no-op)", () => {
    initSentry({
      env: {
        SENTRY_DSN: "https://abc@sentry.io/1",
        SENTRY_TRACES_SAMPLE_RATE: 0,
        NODE_ENV: "production",
      },
    });
    initSentry({
      env: {
        SENTRY_DSN: "https://abc@sentry.io/1",
        SENTRY_TRACES_SAMPLE_RATE: 0,
        NODE_ENV: "production",
      },
    });
    expect((SentryMock.init as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(1);
  });
});
