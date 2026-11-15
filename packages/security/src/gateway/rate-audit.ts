import type { GatewayDependencies, PlannerRunMeta, PolicyDecision } from "@dap/contracts";
import { isMintedContext } from "@dap/contracts/mint";
import type { PipelineInput } from "./pipeline.js";
import { wrapHook } from "./hook-wrapper.js";
import { createAuditEventBuilder } from "../audit/event-builder.js";
import { createAuditWriter } from "../audit/audit-writer.js";

/** Denials stand even when audit is down. The planner door and pipeline remain policy-neutral. */
export async function auditRateDenial(deps: GatewayDependencies, input: PipelineInput, decision: PolicyDecision): Promise<void> {
  if (decision.outcome !== "DENIED" || !(decision.reason.startsWith("rate_limited_") || decision.reason === "denial_throttle")) return;
  try {
    if (!isMintedContext(input.context)) return;
    const options = { hookTimeoutMs: deps.config.hookTimeoutMs };
    const time = await wrapHook(() => deps.clock.now(), "instant", options)();
    if (!time.ok) return;
    const run = input.run as PlannerRunMeta;
    const event = createAuditEventBuilder({ now: () => time.value }).build({
      type: "AI_RATE_LIMITED", requestId: decision.requestId, decisionId: decision.decisionId,
      context: input.context, run, outcome: decision.outcome, reason: decision.reason,
    });
    await createAuditWriter({ sink: deps.audit }, options).recordDecision(event);
  } catch { /* An audit fault must never replace an already-final denial. */ }
}
