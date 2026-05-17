// Factory: pick the right AI persona client based on env.
//
// Returns `null` when AI seeding is disabled — callers should treat
// AI-backed users as silent in that case (no reply is generated).

import type { Env } from "../config/env.js";
import {
  AnthropicAiPersonaClient,
  StubAiPersonaClient,
  type AiPersonaClient,
} from "./persona.js";

export interface AiSeedingDeps {
  env: Pick<Env, "AI_SEEDING_ENABLED" | "ANTHROPIC_API_KEY" | "NODE_ENV">;
  /** Override for tests. */
  client?: AiPersonaClient;
}

/**
 * Returns the configured AI persona client, or null when seeding is
 * disabled. The stub is used in tests and dev (no API key); the
 * Anthropic client requires `ANTHROPIC_API_KEY`.
 */
export function createAiPersonaClient(deps: AiSeedingDeps): AiPersonaClient | null {
  if (deps.client) return deps.client;
  if (!deps.env.AI_SEEDING_ENABLED) return null;
  if (deps.env.ANTHROPIC_API_KEY) {
    return new AnthropicAiPersonaClient({ apiKey: deps.env.ANTHROPIC_API_KEY });
  }
  // Enabled but no key — fall back to stub in non-prod, refuse in prod.
  if (deps.env.NODE_ENV === "production") {
    throw new Error(
      "AI_SEEDING_ENABLED=true in production but ANTHROPIC_API_KEY is empty",
    );
  }
  return new StubAiPersonaClient();
}
