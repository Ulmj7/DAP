import type { AuditEvent, GatewayDependencies, PlannerRunMeta, PolicyDecision } from "@dap/contracts";
import { isMintedContext } from "@dap/contracts/mint";
import type { PipelineInput } from "./pipeline.js";
import { wrapHook } from "./hook-wrapper.js";

/** Denials stand even when audit is down. The planner door and pipeline remain policy-neutral. */
export async function auditRateDenial(deps: GatewayDependencies, input: PipelineInput, decision: PolicyDecision): Promise<void> {
  if (decision.outcome !== "DENIED" || !(decision.reason.startsWith("rate_limited_") || decision.reason === "denial_throttle")) return;
  try {
    if (!isMintedContext(input.context)) return;
    const options = { hookTimeoutMs: deps.config.hookTimeoutMs };
    const time = await wrapHook(() => deps.clock.now(), "instant", options)();
    if (!time.ok) return;
    const run = input.run as PlannerRunMeta;
    const id: unknown = deps.ids.newDecisionId();
    if (typeof id !== "string" || !id) return;
    const event: AuditEvent = Object.freeze({
      id, occurredAt: time.value, type: "AI_RATE_LIMITED", requestId: decision.requestId, decisionId: decision.decisionId,
      tenantId: input.context.tenantId, userId: input.context.userId, aiSessionId: run.aiSessionId, turnId: run.turnId, model: run.model,
      actionId: null, definitionVersion: null, paramsView: Object.freeze({}), risk: null, outcome: decision.outcome, reason: decision.reason,
      confirmationId: null, confirmationState: null, executionResult: null, resource: null,
    });
    await wrapHook(() => deps.audit.append(event), "void", options)();
  } catch { /* An audit fault must never replace an already-final denial. */ }
}
