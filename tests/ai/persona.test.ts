import { describe, it, expect, vi } from "vitest";
import {
  AnthropicAiPersonaClient,
  StubAiPersonaClient,
} from "../../src/ai/persona.js";
import { createAiPersonaClient } from "../../src/ai/factory.js";

describe("StubAiPersonaClient", () => {
  it("returns a non-empty reply echoing the latest inbound", async () => {
    const c = new StubAiPersonaClient();
    const { body } = await c.generateReply({
      matchId: "m1",
      humanUserId: "u1",
      aiUserId: "u2",
      personaPrompt: null,
      latestInbound: { body: "What's your favorite city?", createdAtMs: 0 },
      priorTurns: [],
    });
    expect(body.length).toBeGreaterThan(0);
    expect(body).toContain("favorite city");
    expect(body).toMatch(/What about you\?$/);
  });

  it("rotates openers across turns deterministically", async () => {
    const c = new StubAiPersonaClient();
    const bodies = await Promise.all(
      [0, 1, 2, 3, 4].map((n) =>
        c.generateReply({
          matchId: "m1",
          humanUserId: "u1",
          aiUserId: "u2",
          personaPrompt: null,
          latestInbound: { body: "Hello.", createdAtMs: 0 },
          priorTurns: Array.from({ length: n }, () => ({ fromAi: false, body: "x" })),
        }).then((r) => r.body),
      ),
    );
    // All five openers should be distinct.
    const openers = bodies.map((b) => b.split(" ").slice(0, 2).join(" "));
    expect(new Set(openers).size).toBe(5);
  });
});

describe("AnthropicAiPersonaClient", () => {
  it("requires apiKey", () => {
    expect(() => new AnthropicAiPersonaClient({ apiKey: "" })).toThrow(/apiKey/);
  });

  it("sends a system + user payload and extracts text content", async () => {
    const fakeFetch = vi.fn(async () =>
      new Response(
        JSON.stringify({ content: [{ type: "text", text: "hey, what city are you near?" }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const c = new AnthropicAiPersonaClient({
      apiKey: "sk-test",
      fetchImpl: fakeFetch as unknown as typeof fetch,
    });
    const { body } = await c.generateReply({
      matchId: "m1",
      humanUserId: "u1",
      aiUserId: "u2",
      personaPrompt: "thoughtful student",
      latestInbound: { body: "where do you usually hang out?", createdAtMs: 0 },
      priorTurns: [{ fromAi: true, body: "earlier reply" }],
    });
    expect(body).toBe("hey, what city are you near?");
    expect(fakeFetch).toHaveBeenCalledOnce();
    const callArgs = fakeFetch.mock.calls[0] as unknown as [string, RequestInit];
    const init = callArgs[1];
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("sk-test");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    const payload = JSON.parse(init.body as string) as {
      system: string;
      messages: Array<{ role: string; content: string }>;
    };
    expect(payload.system).toContain("thoughtful student");
    // Prior assistant turn + new user turn.
    expect(payload.messages).toEqual([
      { role: "assistant", content: "earlier reply" },
      { role: "user", content: "where do you usually hang out?" },
    ]);
  });

  it("throws on non-2xx", async () => {
    const fakeFetch = vi.fn(async () => new Response("nope", { status: 500 }));
    const c = new AnthropicAiPersonaClient({
      apiKey: "sk-test",
      fetchImpl: fakeFetch as unknown as typeof fetch,
    });
    await expect(
      c.generateReply({
        matchId: "m1",
        humanUserId: "u1",
        aiUserId: "u2",
        personaPrompt: null,
        latestInbound: { body: "hi", createdAtMs: 0 },
        priorTurns: [],
      }),
    ).rejects.toThrow(/anthropic: 500/);
  });

  it("throws on empty content", async () => {
    const fakeFetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ content: [] }), {
          status: 200,
        }),
    );
    const c = new AnthropicAiPersonaClient({
      apiKey: "sk-test",
      fetchImpl: fakeFetch as unknown as typeof fetch,
    });
    await expect(
      c.generateReply({
        matchId: "m1",
        humanUserId: "u1",
        aiUserId: "u2",
        personaPrompt: null,
        latestInbound: { body: "hi", createdAtMs: 0 },
        priorTurns: [],
      }),
    ).rejects.toThrow(/empty response/);
  });
});

describe("createAiPersonaClient", () => {
  it("returns null when disabled", () => {
    expect(
      createAiPersonaClient({
        env: { AI_SEEDING_ENABLED: false, ANTHROPIC_API_KEY: "", NODE_ENV: "development" },
      }),
    ).toBeNull();
  });

  it("returns Anthropic client when enabled + key present", () => {
    const c = createAiPersonaClient({
      env: { AI_SEEDING_ENABLED: true, ANTHROPIC_API_KEY: "sk-xxx", NODE_ENV: "development" },
    });
    expect(c).toBeInstanceOf(AnthropicAiPersonaClient);
  });

  it("falls back to stub in dev when key missing", () => {
    const c = createAiPersonaClient({
      env: { AI_SEEDING_ENABLED: true, ANTHROPIC_API_KEY: "", NODE_ENV: "development" },
    });
    expect(c).toBeInstanceOf(StubAiPersonaClient);
  });

  it("refuses to fall back in production", () => {
    expect(() =>
      createAiPersonaClient({
        env: { AI_SEEDING_ENABLED: true, ANTHROPIC_API_KEY: "", NODE_ENV: "production" },
      }),
    ).toThrow(/production/);
  });

  it("respects test override", () => {
    const stub = new StubAiPersonaClient();
    expect(
      createAiPersonaClient({
        env: { AI_SEEDING_ENABLED: false, ANTHROPIC_API_KEY: "", NODE_ENV: "development" },
        client: stub,
      }),
    ).toBe(stub);
  });
});
