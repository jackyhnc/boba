// Public surface for the milestone-unlock layer.

export { scoreMessageDepth, averageDepthScore, type DepthInput } from "./depth.js";
export {
  nextMilestoneToUnlock,
  summarize,
  type UnlockInput,
  type UnlockEvaluation,
} from "./unlock.js";
export {
  recordMilestone,
  loadUnlockedMilestones,
  type MilestonePrisma,
} from "./prisma-deps.js";
export {
  DEFAULT_UNLOCK_THRESHOLDS,
  type ConversationDepthStats,
  type MessageForDepth,
  type MessageForUnlock,
  type UnlockThreshold,
} from "./types.js";
