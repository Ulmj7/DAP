import type { AuthorizationContext, IdGenerator, PlannerFeedback, PlannerRunMeta, PolicyDecision, PolicyGateway, ProposalCall, RequestId } from "@dap/contracts";
import { snapshotAnswer } from "./answer-snapshot.js";
import { toPlannerFeedback } from "./feedback.js";
import type { PipelineInput } from "./pipeline.js";

/** The only thing the proposal door needs from the pipeline; injectable so its invariants are testable. */
export interface DecisionPipeline { run(input: PipelineInput): Promise<PolicyDecision> }

const unavailable: PlannerFeedback = Object.freeze({ outcome: "DENIED", category: "try_later" });

/**
 * The planner-facing door. Everything a submit can return is `PlannerFeedback`: the decision, its ids and
 * its internal reasons stay inside. Any failure here, before or after the pipeline, is a generic retry.
 */
export function createProposalGateway({ pipeline, ids }: { readonly pipeline: DecisionPipeline; readonly ids: Pick<IdGenerator, "newDecisionId"> }): PolicyGateway {
  return Object.freeze({
    forSession: Object.freeze((context: AuthorizationContext, run: PlannerRunMeta) => {
      // Metadata is read once and detached; an unreadable record is passed as null and denied by the pipeline.
      let capturedRun: unknown;
      try { capturedRun = snapshotAnswer(run); } catch { capturedRun = null; }
      return Object.freeze({
        submit: Object.freeze(async (call: ProposalCall): Promise<PlannerFeedback> => {
          try {
            const id: unknown = ids.newDecisionId();
            if (typeof id !== "string" || !id) {
              // A broken synchronous port may hand back a rejecting promise; consume its rejection.
              void Promise.resolve(id).catch(() => undefined);
              return unavailable;
            }
            // One trusted identifier per proposal; the proposal itself is only read if a stage asks.
            const decision = await pipeline.run({ context, run: capturedRun, decisionId: id, requestId: id as RequestId, readProposal: () => call });
            return toPlannerFeedback(decision);
          } catch { return unavailable; }
        }),
      });
    }),
  });
}
