// Public surface for the onboarding layer.

export {
  STEP_IDS,
  STEP_ORDER,
  type AdvanceResult,
  type OnboardingUpdates,
  type ParseFailure,
  type ParseResult,
  type ParseSuccess,
  type StepId,
} from "./types.js";
export { COPY, advance, mergeUpdates } from "./flow.js";
export {
  persistOnboardingUpdates,
  type OnboardingPrisma,
} from "./prisma-deps.js";
