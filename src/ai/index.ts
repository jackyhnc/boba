// Public surface for the AI-seeding plumbing.

export {
  AnthropicAiPersonaClient,
  StubAiPersonaClient,
  type AiPersonaClient,
  type AiReplyRequest,
  type AnthropicConfig,
} from "./persona.js";
export { createAiPersonaClient, type AiSeedingDeps } from "./factory.js";
