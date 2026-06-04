// Contract pins for `src/ai/persona.ts` + `src/ai/factory.ts`.
//
// `tests/ai/persona.test.ts` exercises the happy path, but several
// production-critical contracts of the Anthropic client, the stub
// client, and the factory aren't pinned — silent refactors could
// swap models, drop max_tokens, lose stat-fishing guidance, change
// the override-vs-prod-key precedence in the factory, or leak the
// stub onto the network. Each `describe` below names a single
// seam and pins one observable behavior at a time.

import { describe, it, expect, vi } from "vitest";
import {
  AnthropicAiPersonaClient,
  StubAiPersonaClient,
  type AiReplyRequest,
} from "../../src/ai/persona.js";
import { createAiPersonaClient } from "../../src/ai/factory.js";

// ─── helpers ────────────────────────────────────────────────────────────────

const baseReq: AiReplyRequest = {
  matchId: "m1",
  humanUserId: "u-human",
  aiUserId: "u-ai",
  personaPrompt: null,
  latestInbound: { body: "hi", createdAtMs: 0 },
  priorTurns: [],
};

function fakeResponse(text: string, status = 200): Response {
  return new Response(
    JSON.stringify({ content: [{ type: "text", text }] }),
    { status, headers: { "content-type": "application/json" } },
  );
}

function readBody(init: RequestInit): {
  model: string;
  max_tokens: number;
  system: string;
  messages: Array<{ role: string; content: string }>;
} {
  return JSON.parse(init.body as string) as ReturnType<typeof readBody>;
}

function captureCall(fakeFetch: ReturnType<typeof vi.fn>): {
  url: string;
  init: RequestInit;
} {
  const calls = fakeFetch.mock.calls;
  if (calls.length === 0) throw new Error("fakeFetch was not called");
  const [url, init] = calls[0] as unknown as [string, RequestInit];
  return { url, init };
}

// ─── AnthropicAiPersonaClient — request URL + model + max_tokens ────────────

describe("AnthropicAiPersonaClient: request URL composition", () => {
  it("defaults to the canonical messages endpoint", async () => {
    const fakeFetch = vi.fn(async () => fakeResponse("ok"));
    const c = new AnthropicAiPersonaClient({
      apiKey: "sk-test",
      fetchImpl: fakeFetch as unknown as typeof fetch,
    });
    await c.generateReply(baseReq);
    expect(captureCall(fakeFetch).url).toBe("https://api.anthropic.com/v1/messages");
  });

  it("appends /messages to a custom baseUrl (no double slash, no trailing slash)", async () => {
    const fakeFetch = vi.fn(async () => fakeResponse("ok"));
    const c = new AnthropicAiPersonaClient({
      apiKey: "sk-test",
      baseUrl: "https://proxy.example.com/anthropic",
      fetchImpl: fakeFetch as unknown as typeof fetch,
    });
    await c.generateReply(baseReq);
    expect(captureCall(fakeFetch).url).toBe(
      "https://proxy.example.com/anthropic/messages",
    );
  });

  it("uses POST and sets the three required headers exactly", async () => {
    const fakeFetch = vi.fn(async () => fakeResponse("ok"));
    const c = new AnthropicAiPersonaClient({
      apiKey: "sk-secret-42",
      fetchImpl: fakeFetch as unknown as typeof fetch,
    });
    await c.generateReply(baseReq);
    const { init } = captureCall(fakeFetch);
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("sk-secret-42");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(headers["content-type"]).toBe("application/json");
  });
});

describe("AnthropicAiPersonaClient: model + max_tokens pins", () => {
  it("defaults the model to claude-haiku-4-5 (cost guardrail)", async () => {
    const fakeFetch = vi.fn(async () => fakeResponse("ok"));
    const c = new AnthropicAiPersonaClient({
      apiKey: "sk-test",
      fetchImpl: fakeFetch as unknown as typeof fetch,
    });
    await c.generateReply(baseReq);
    expect(readBody(captureCall(fakeFetch).init).model).toBe("claude-haiku-4-5");
  });

  it("honours an explicit model override", async () => {
    const fakeFetch = vi.fn(async () => fakeResponse("ok"));
    const c = new AnthropicAiPersonaClient({
      apiKey: "sk-test",
      model: "claude-sonnet-4-6",
      fetchImpl: fakeFetch as unknown as typeof fetch,
    });
    await c.generateReply(baseReq);
    expect(readBody(captureCall(fakeFetch).init).model).toBe("claude-sonnet-4-6");
  });

  it("pins max_tokens at 200 (SMS-sized replies)", async () => {
    const fakeFetch = vi.fn(async () => fakeResponse("ok"));
    const c = new AnthropicAiPersonaClient({
      apiKey: "sk-test",
      fetchImpl: fakeFetch as unknown as typeof fetch,
    });
    await c.generateReply(baseReq);
    expect(readBody(captureCall(fakeFetch).init).max_tokens).toBe(200);
  });
});

// ─── AnthropicAiPersonaClient — system prompt structure ─────────────────────

describe("AnthropicAiPersonaClient: system prompt structure", () => {
  async function systemPromptFor(personaPrompt: string | null): Promise<string> {
    const fakeFetch = vi.fn(async () => fakeResponse("ok"));
    const c = new AnthropicAiPersonaClient({
      apiKey: "sk-test",
      fetchImpl: fakeFetch as unknown as typeof fetch,
    });
    await c.generateReply({ ...baseReq, personaPrompt });
    return readBody(captureCall(fakeFetch).init).system;
  }

  it("uses the warm-curious default when personaPrompt is null", async () => {
    const sys = await systemPromptFor(null);
    expect(sys).toContain("A warm, curious, conversational person");
    expect(sys).toContain("one to three SMS-style sentences");
  });

  it("uses the default when personaPrompt is an empty string", async () => {
    expect(await systemPromptFor("")).toContain("A warm, curious, conversational person");
  });

  it("uses the default when personaPrompt is whitespace-only", async () => {
    expect(await systemPromptFor("   \n\t ")).toContain(
      "A warm, curious, conversational person",
    );
  });

  it("trims a user-supplied persona before embedding it", async () => {
    const sys = await systemPromptFor("  shy poetry student  ");
    expect(sys).toContain("Persona: shy poetry student");
    // Surrounding whitespace must not leak through verbatim.
    expect(sys).not.toContain("Persona:   shy poetry student  ");
  });

  it("retains the stat-fishing deflection instruction", async () => {
    const sys = await systemPromptFor("any persona");
    expect(sys).toContain("stat-fishing question");
    expect(sys).toContain("change the subject");
  });

  it("retains the do-not-disclose-AI instruction", async () => {
    const sys = await systemPromptFor("any persona");
    expect(sys).toContain("Don't announce that you are an AI");
  });

  it("retains the gated-info list (names, schools, socials, photos, addresses)", async () => {
    const sys = await systemPromptFor("any persona");
    expect(sys).toContain("full names");
    expect(sys).toContain("schools");
    expect(sys).toContain("social handles");
    expect(sys).toContain("photos");
    expect(sys).toContain("addresses");
  });

  it("retains the Boba product framing (other party can't see stats/photo)", async () => {
    const sys = await systemPromptFor("any persona");
    expect(sys).toContain("Boba");
    expect(sys).toContain("conversation-first dating app");
    expect(sys).toContain("cannot see your stats or photo");
  });

  it("joins the four sections with a blank-line separator, in fixed order", async () => {
    const sys = await systemPromptFor("any persona");
    // Four sections → exactly three `\n\n` separators between them.
    const blocks = sys.split("\n\n");
    expect(blocks.length).toBe(4);
    expect(blocks[0]).toContain("role-playing");
    expect(blocks[1]).toMatch(/^Persona: /);
    expect(blocks[2]).toMatch(/^Style:/);
    expect(blocks[3]).toContain("stat-fishing question");
  });
});

// ─── AnthropicAiPersonaClient — message history ─────────────────────────────

describe("AnthropicAiPersonaClient: message history shape", () => {
  it("emits only the latest inbound when there are no prior turns", async () => {
    const fakeFetch = vi.fn(async () => fakeResponse("ok"));
    const c = new AnthropicAiPersonaClient({
      apiKey: "sk-test",
      fetchImpl: fakeFetch as unknown as typeof fetch,
    });
    await c.generateReply({
      ...baseReq,
      latestInbound: { body: "first message", createdAtMs: 0 },
      priorTurns: [],
    });
    expect(readBody(captureCall(fakeFetch).init).messages).toEqual([
      { role: "user", content: "first message" },
    ]);
  });

  it("maps fromAi:true → assistant and fromAi:false → user, preserving order", async () => {
    const fakeFetch = vi.fn(async () => fakeResponse("ok"));
    const c = new AnthropicAiPersonaClient({
      apiKey: "sk-test",
      fetchImpl: fakeFetch as unknown as typeof fetch,
    });
    await c.generateReply({
      ...baseReq,
      latestInbound: { body: "newest", createdAtMs: 0 },
      priorTurns: [
        { fromAi: false, body: "h-1" },
        { fromAi: true, body: "a-1" },
        { fromAi: false, body: "h-2" },
        { fromAi: true, body: "a-2" },
      ],
    });
    expect(readBody(captureCall(fakeFetch).init).messages).toEqual([
      { role: "user", content: "h-1" },
      { role: "assistant", content: "a-1" },
      { role: "user", content: "h-2" },
      { role: "assistant", content: "a-2" },
      { role: "user", content: "newest" },
    ]);
  });

  it("always appends the latest inbound as the LAST message, as role:user", async () => {
    const fakeFetch = vi.fn(async () => fakeResponse("ok"));
    const c = new AnthropicAiPersonaClient({
      apiKey: "sk-test",
      fetchImpl: fakeFetch as unknown as typeof fetch,
    });
    await c.generateReply({
      ...baseReq,
      latestInbound: { body: "TRAILER", createdAtMs: 0 },
      priorTurns: [{ fromAi: true, body: "prior-assistant" }],
    });
    const msgs = readBody(captureCall(fakeFetch).init).messages;
    expect(msgs[msgs.length - 1]).toEqual({ role: "user", content: "TRAILER" });
  });

  it("each message carries exactly the two keys {role, content}", async () => {
    const fakeFetch = vi.fn(async () => fakeResponse("ok"));
    const c = new AnthropicAiPersonaClient({
      apiKey: "sk-test",
      fetchImpl: fakeFetch as unknown as typeof fetch,
    });
    await c.generateReply({
      ...baseReq,
      priorTurns: [{ fromAi: true, body: "a" }],
    });
    for (const m of readBody(captureCall(fakeFetch).init).messages) {
      expect(Object.keys(m).sort()).toEqual(["content", "role"]);
    }
  });
});

// ─── AnthropicAiPersonaClient — response parsing ────────────────────────────

describe("AnthropicAiPersonaClient: response content extraction", () => {
  it("joins multiple text blocks with a single newline", async () => {
    const fakeFetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            content: [
              { type: "text", text: "line one" },
              { type: "text", text: "line two" },
            ],
          }),
          { status: 200 },
        ),
    );
    const c = new AnthropicAiPersonaClient({
      apiKey: "sk-test",
      fetchImpl: fakeFetch as unknown as typeof fetch,
    });
    const { body } = await c.generateReply(baseReq);
    expect(body).toBe("line one\nline two");
  });

  it("ignores non-text blocks (tool_use, image, etc.)", async () => {
    const fakeFetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            content: [
              { type: "tool_use", text: "should be ignored" },
              { type: "text", text: "kept" },
              { type: "image", text: "also ignored" },
            ],
          }),
          { status: 200 },
        ),
    );
    const c = new AnthropicAiPersonaClient({
      apiKey: "sk-test",
      fetchImpl: fakeFetch as unknown as typeof fetch,
    });
    expect((await c.generateReply(baseReq)).body).toBe("kept");
  });

  it("ignores text blocks where .text is missing or not a string", async () => {
    const fakeFetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            content: [
              { type: "text" }, // no text field
              { type: "text", text: 7 as unknown as string }, // wrong type
              { type: "text", text: "real" },
            ],
          }),
          { status: 200 },
        ),
    );
    const c = new AnthropicAiPersonaClient({
      apiKey: "sk-test",
      fetchImpl: fakeFetch as unknown as typeof fetch,
    });
    expect((await c.generateReply(baseReq)).body).toBe("real");
  });

  it("trims surrounding whitespace from the joined body", async () => {
    const fakeFetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ content: [{ type: "text", text: "  padded  " }] }),
          { status: 200 },
        ),
    );
    const c = new AnthropicAiPersonaClient({
      apiKey: "sk-test",
      fetchImpl: fakeFetch as unknown as typeof fetch,
    });
    expect((await c.generateReply(baseReq)).body).toBe("padded");
  });

  it("throws 'empty response' when content array is missing entirely", async () => {
    const fakeFetch = vi.fn(
      async () => new Response(JSON.stringify({}), { status: 200 }),
    );
    const c = new AnthropicAiPersonaClient({
      apiKey: "sk-test",
      fetchImpl: fakeFetch as unknown as typeof fetch,
    });
    await expect(c.generateReply(baseReq)).rejects.toThrow(/empty response/);
  });

  it("throws 'empty response' when joined text is whitespace-only", async () => {
    const fakeFetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ content: [{ type: "text", text: "   \n   " }] }),
          { status: 200 },
        ),
    );
    const c = new AnthropicAiPersonaClient({
      apiKey: "sk-test",
      fetchImpl: fakeFetch as unknown as typeof fetch,
    });
    await expect(c.generateReply(baseReq)).rejects.toThrow(/empty response/);
  });
});

// ─── AnthropicAiPersonaClient — error path ──────────────────────────────────

describe("AnthropicAiPersonaClient: non-2xx error surfaces", () => {
  it("includes status, statusText, and a slice of the body in the error", async () => {
    const fakeFetch = vi.fn(
      async () =>
        new Response("rate limit: try again in 30s", {
          status: 429,
          statusText: "Too Many Requests",
        }),
    );
    const c = new AnthropicAiPersonaClient({
      apiKey: "sk-test",
      fetchImpl: fakeFetch as unknown as typeof fetch,
    });
    await expect(c.generateReply(baseReq)).rejects.toThrow(
      /anthropic: 429 Too Many Requests: rate limit: try again in 30s/,
    );
  });

  it("truncates the body slice at 200 characters", async () => {
    const long = "x".repeat(500);
    const fakeFetch = vi.fn(async () => new Response(long, { status: 500 }));
    const c = new AnthropicAiPersonaClient({
      apiKey: "sk-test",
      fetchImpl: fakeFetch as unknown as typeof fetch,
    });
    let caught: unknown;
    try {
      await c.generateReply(baseReq);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    const msg = (caught as Error).message;
    // The first 200 x's must be present, the 201st must not.
    expect(msg).toContain("x".repeat(200));
    expect(msg).not.toContain("x".repeat(201));
  });

  it("still throws a 'anthropic: <status>' error even if res.text() rejects", async () => {
    // Simulate a Response whose .text() throws — the client must
    // swallow that and still report the upstream status.
    const fakeFetch = vi.fn(async () => {
      const r = new Response("ignored", { status: 503 });
      // Override .text to throw.
      (r as unknown as { text: () => Promise<string> }).text = async () => {
        throw new Error("body unreadable");
      };
      return r;
    });
    const c = new AnthropicAiPersonaClient({
      apiKey: "sk-test",
      fetchImpl: fakeFetch as unknown as typeof fetch,
    });
    await expect(c.generateReply(baseReq)).rejects.toThrow(/anthropic: 503/);
  });
});

// ─── AnthropicAiPersonaClient — constructor guards ──────────────────────────

describe("AnthropicAiPersonaClient: constructor", () => {
  it("rejects undefined apiKey at construction (not at request time)", () => {
    expect(
      () => new AnthropicAiPersonaClient({ apiKey: undefined as unknown as string }),
    ).toThrow(/apiKey/);
  });
});

// ─── StubAiPersonaClient — no-network + truncation ──────────────────────────

describe("StubAiPersonaClient: side-effect freedom", () => {
  it("does NOT invoke global fetch (safe to use in tests without env)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      const c = new StubAiPersonaClient();
      await c.generateReply(baseReq);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe("StubAiPersonaClient: echo content", () => {
  it("echoes only the FIRST sentence of a multi-sentence inbound", async () => {
    const c = new StubAiPersonaClient();
    const { body } = await c.generateReply({
      ...baseReq,
      latestInbound: {
        body: "I love hiking. But I hate camping. And bugs.",
        createdAtMs: 0,
      },
    });
    expect(body).toContain("I love hiking.");
    expect(body).not.toContain("hate camping");
    expect(body).not.toContain("bugs");
  });

  it("always closes with 'What about you?'", async () => {
    const c = new StubAiPersonaClient();
    const { body } = await c.generateReply(baseReq);
    expect(body.endsWith("What about you?")).toBe(true);
  });

  it("truncates a sentence longer than 160 chars to exactly 160 with a trailing ellipsis", async () => {
    const c = new StubAiPersonaClient();
    // Single sentence (no terminator) of length 200.
    const longInbound = "a".repeat(200);
    const { body } = await c.generateReply({
      ...baseReq,
      latestInbound: { body: longInbound, createdAtMs: 0 },
    });
    // The echoed fragment is 157 "a"s + "…" → 158 chars.
    expect(body).toContain("a".repeat(157) + "…");
    // No 158-a run should appear: the 158th char is the ellipsis.
    expect(body).not.toContain("a".repeat(158));
  });

  it("leaves a short sentence untouched (no spurious ellipsis)", async () => {
    const c = new StubAiPersonaClient();
    const { body } = await c.generateReply({
      ...baseReq,
      latestInbound: { body: "Short sentence.", createdAtMs: 0 },
    });
    expect(body).not.toContain("…");
    expect(body).toContain("Short sentence.");
  });
});

// ─── createAiPersonaClient — precedence + edge cases ────────────────────────

describe("createAiPersonaClient: precedence and edge cases", () => {
  it("disabled wins even when an API key is present (returns null)", () => {
    expect(
      createAiPersonaClient({
        env: {
          AI_SEEDING_ENABLED: false,
          ANTHROPIC_API_KEY: "sk-present-but-ignored",
          NODE_ENV: "production",
        },
      }),
    ).toBeNull();
  });

  it("client override beats the production-no-key safeguard", () => {
    // Without the override this combo would throw. The override must
    // short-circuit before that check so tests can always inject a
    // deterministic client.
    const stub = new StubAiPersonaClient();
    expect(
      createAiPersonaClient({
        env: {
          AI_SEEDING_ENABLED: true,
          ANTHROPIC_API_KEY: "",
          NODE_ENV: "production",
        },
        client: stub,
      }),
    ).toBe(stub);
  });

  it("client override beats the disabled-returns-null branch", () => {
    const stub = new StubAiPersonaClient();
    expect(
      createAiPersonaClient({
        env: {
          AI_SEEDING_ENABLED: false,
          ANTHROPIC_API_KEY: "",
          NODE_ENV: "production",
        },
        client: stub,
      }),
    ).toBe(stub);
  });

  it("production refusal mentions both flags in the error", () => {
    expect(() =>
      createAiPersonaClient({
        env: {
          AI_SEEDING_ENABLED: true,
          ANTHROPIC_API_KEY: "",
          NODE_ENV: "production",
        },
      }),
    ).toThrow(/AI_SEEDING_ENABLED=true.*ANTHROPIC_API_KEY/s);
  });

  it("returns a fresh Anthropic client instance per call (not a memoized singleton)", () => {
    const env = {
      AI_SEEDING_ENABLED: true as const,
      ANTHROPIC_API_KEY: "sk-x",
      NODE_ENV: "development" as const,
    };
    const a = createAiPersonaClient({ env });
    const b = createAiPersonaClient({ env });
    expect(a).toBeInstanceOf(AnthropicAiPersonaClient);
    expect(b).toBeInstanceOf(AnthropicAiPersonaClient);
    expect(a).not.toBe(b);
  });

  it("returns a fresh Stub instance per call when falling back in dev", () => {
    const env = {
      AI_SEEDING_ENABLED: true as const,
      ANTHROPIC_API_KEY: "",
      NODE_ENV: "development" as const,
    };
    const a = createAiPersonaClient({ env });
    const b = createAiPersonaClient({ env });
    expect(a).toBeInstanceOf(StubAiPersonaClient);
    expect(b).toBeInstanceOf(StubAiPersonaClient);
    expect(a).not.toBe(b);
  });
});
