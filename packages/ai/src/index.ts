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
