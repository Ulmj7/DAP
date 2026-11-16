/**
 * @dap/ai: index.ts
 *
 * T069. Public surface of the AI layer.
 *
 * Deliberately MINIMAL: only the planner-facing seam. The AI layer holds a
 * `ProposalSubmitter` (from @dap/contracts) and a `PlannerPort` (this package).
 * It must NOT re-export the registry's executors, the ActionRegistry,
 * AuthorizationContext, state stores, or the confirmation service — the model
 * is an untrusted proposer and never touches those (Constitution I, II, III).
 *
 * @dap/ai depends on @dap/contracts only.
 */
export type { PlannerPort, RawToolCall } from "./planner-port.js";
export { toProposalCall } from "./tool-call.js";

// Feature 003 guidance contract (Slice 1): a structured request to the GuidanceModel port, untrusted output, strict validation, closed results.
// Nothing here can carry authority: no context, token, executor, Gateway internals or walkthrough definition.
export * from "./guidance/limits.js";
export { GUIDANCE_REASONS } from "./guidance/types.js";
export type {
  Cancel, GuidanceDecision, GuidanceInput, GuidanceModel, GuidanceModelRequest, GuidanceReason, GuidanceResult, GuidanceSource, GuidanceTimers,
  SafeWalkthroughSummary, SanitizeQuery, SemanticContextElementInput, SemanticContextInput, SemanticPrivacy, SemanticRole, WalkthroughCatalogView,
} from "./guidance/types.js";
export { parseGuidanceModelRequest } from "./guidance/request.js";
export type { RequestParse } from "./guidance/request.js";
export { parseGuidanceDecision } from "./guidance/decision.js";
export { callGuidanceModel, createModelCallGuard } from "./guidance/call-model.js";
export type { ModelCallFailure, ModelCallGuard, ModelCallOutcome } from "./guidance/call-model.js";
export { unsupportedResult } from "./guidance/result.js";
