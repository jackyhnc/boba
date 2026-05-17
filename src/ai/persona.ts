// AI-seeding persona client interface.
//
// During cold-start we seed the app with AI-backed "users" so early
// real users get a match and experience the loop. The actual model
// integration is intentionally pluggable — the conversation router
// just emits an `AiReplyRequest`, and the route handler hands it to
// whatever `AiPersonaClient` implementation is wired up at build time.
//
// Two clients ship today:
//   - `StubAiPersonaClient`: deterministic, no network. Used in tests
//     and as the default until ANTHROPIC_API_KEY is set.
//   - `AnthropicAiPersonaClient`: thin fetch-based client targeting
//     Anthropic's messages API. Selected when `AI_SEEDING_ENABLED=true`
//     and `ANTHROPIC_API_KEY` is non-empty.
//
// AI seeding is OFF by default (`AI_SEEDING_ENABLED=false`). Even when
// on, only users whose `User.isAiBacked = true` are routed this way.

export interface AiReplyRequest {
  matchId: string;
  /** The human user the AI is replying TO. */
  humanUserId: string;
  /** The AI-backed partner user id (whose persona we generate as). */
  aiUserId: string;
  /** Free-form persona prompt seeded during onboarding. */
  personaPrompt: string | null;
  /** The most recent inbound (from the human). */
  latestInbound: { body: string; createdAtMs: number };
  /** Prior turns, oldest first. Used as conversational context. */
  priorTurns: ReadonlyArray<{
    fromAi: boolean;
    body: string;
  }>;
}

export interface AiPersonaClient {
  generateReply(req: AiReplyRequest): Promise<{ body: string }>;
}

// ─── Stub client ────────────────────────────────────────────────────────────

/**
 * Deterministic, side-effect-free client.
 *
 * Reflects a fragment of the inbound back as a question — enough to
 * keep the conversation moving in dev/tests without burning credits
 * or relying on network access. Real personas should plug in the
 * Anthropic client below.
 */
export class StubAiPersonaClient implements AiPersonaClient {
  async generateReply(req: AiReplyRequest): Promise<{ body: string }> {
    const opening = openingForTurn(req.priorTurns.length);
    const echo = trimToFirstSentence(req.latestInbound.body);
    const body = `${opening} ${echo} What about you?`.trim();
    return { body };
  }
}

function openingForTurn(turn: number): string {
  // Slight variety so the loop doesn't read as a single canned line.
  const openers = [
    "Honestly, same here —",
    "Ha, that's a good one.",
    "Oh interesting,",
    "Mood. Anyway —",
    "Right? I was just thinking about",
  ];
  return openers[turn % openers.length] ?? openers[0]!;
}

function trimToFirstSentence(body: string): string {
  const match = /[^.!?]*[.!?]?/.exec(body.trim());
  const text = (match?.[0] ?? body).trim();
  return text.length > 160 ? `${text.slice(0, 157)}…` : text;
}

// ─── Anthropic client ───────────────────────────────────────────────────────

export interface AnthropicConfig {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  /** Fetch implementation; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

const DEFAULT_MODEL = "claude-haiku-4-5";
const DEFAULT_BASE_URL = "https://api.anthropic.com/v1";

/**
 * Anthropic-backed persona client. Uses the messages API; thin wrapper
 * so we don't pull in the SDK. The `model` defaults to Haiku 4.5 for
 * fast, cheap conversational replies — change via config when warranted.
 */
export class AnthropicAiPersonaClient implements AiPersonaClient {
  private readonly cfg: Required<AnthropicConfig>;

  constructor(cfg: AnthropicConfig) {
    if (!cfg.apiKey) throw new Error("AnthropicAiPersonaClient: apiKey required");
    this.cfg = {
      apiKey: cfg.apiKey,
      model: cfg.model ?? DEFAULT_MODEL,
      baseUrl: cfg.baseUrl ?? DEFAULT_BASE_URL,
      fetchImpl: cfg.fetchImpl ?? fetch,
    };
  }

  async generateReply(req: AiReplyRequest): Promise<{ body: string }> {
    const system = buildSystemPrompt(req);
    const messages = buildMessageHistory(req);

    const res = await this.cfg.fetchImpl(`${this.cfg.baseUrl}/messages`, {
      method: "POST",
      headers: {
        "x-api-key": this.cfg.apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: this.cfg.model,
        max_tokens: 200,
        system,
        messages,
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`anthropic: ${res.status} ${res.statusText}: ${text.slice(0, 200)}`);
    }

    const data = (await res.json()) as {
      content?: Array<{ type: string; text?: string }>;
    };
    const text = (data.content ?? [])
      .filter((c) => c.type === "text" && typeof c.text === "string")
      .map((c) => c.text as string)
      .join("\n")
      .trim();
    if (!text) {
      throw new Error("anthropic: empty response");
    }
    return { body: text };
  }
}

function buildSystemPrompt(req: AiReplyRequest): string {
  const persona =
    req.personaPrompt?.trim() ||
    "A warm, curious, conversational person on a dating app. Keep replies short and natural — one to three SMS-style sentences.";
  return [
    "You are role-playing a person on Boba, a conversation-first dating app. The other person cannot see your stats or photo; they only know what you tell them through conversation.",
    "Persona: " + persona,
    "Style: SMS. 1–3 sentences. Don't announce that you are an AI. Don't ask for or volunteer identifying info like full names, schools, social handles, photos, or addresses — the app gates those.",
    "If the other person asks a stat-fishing question, change the subject playfully.",
  ].join("\n\n");
}

function buildMessageHistory(req: AiReplyRequest): Array<{ role: "user" | "assistant"; content: string }> {
  const msgs: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (const t of req.priorTurns) {
    msgs.push({ role: t.fromAi ? "assistant" : "user", content: t.body });
  }
  msgs.push({ role: "user", content: req.latestInbound.body });
  return msgs;
}
