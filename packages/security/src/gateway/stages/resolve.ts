import type { ActionId, ActionRegistry, TenantActionPolicyStore } from "@dap/contracts";
import { createEnablementPolicy } from "../../registry/enablement.js";
import { denyDecision } from "../decision.js";
import { wrapHook, type HookOptions } from "../hook-wrapper.js";
import type { PolicyStage } from "../pipeline.js";

export function createResolveStage({ registry, globalAllowlist, tenantPolicy }: {
  readonly registry: ActionRegistry;
  readonly globalAllowlist: ReadonlySet<ActionId>;
  readonly tenantPolicy: TenantActionPolicyStore;
}, options: HookOptions = {}): PolicyStage {
  const allowlist = new Set(globalAllowlist);
  // Reuse R7 / unknown-id startup validation; live policy reads below retain their denial reason.
  createEnablementPolicy({ registry, globalAllowlist: allowlist, tenantPolicy });
  const get = registry.get.bind(registry);
  const reserved = registry.isReservedForbidden.bind(registry);
  const disabled = wrapHook(tenantPolicy.isDisabled.bind(tenantPolicy), "tenantPolicy", options);
  return async (request) => {
    const envelope = request.facts.intake;
    const name = envelope && typeof envelope === "object" && !Array.isArray(envelope) ? (envelope as Readonly<Record<string, unknown>>).action : undefined;
    const stop = (outcome: "DENIED" | "FORBIDDEN_POLICY" | "INVALID_ACTION", reason: "unknown_action" | "reserved_forbidden_action" | "action_not_enabled" | "tenant_action_disabled" | "dependency_failure") => ({ kind: "stop" as const, decision: denyDecision({ decisionId: request.decisionId, requestId: request.requestId, stage: "resolve", outcome, reason, ...(typeof name === "string" ? { attemptedAction: name } : {}) }) });
    if (typeof name !== "string" || !request.context) return stop("DENIED", "dependency_failure");
    if (reserved(name)) return stop("FORBIDDEN_POLICY", "reserved_forbidden_action");
    const entry = get(name);
    if (!entry) return stop("INVALID_ACTION", "unknown_action");
    const { id, version, risk } = entry.definition;
    if (risk === "FORBIDDEN") return stop("FORBIDDEN_POLICY", "reserved_forbidden_action");
    if (!allowlist.has(id)) return stop("DENIED", "action_not_enabled");
    const answer = await disabled(Object.freeze({ tenantId: request.context.tenantId }), id);
    if (!answer.ok) return stop("DENIED", answer.reason === "denied" ? "tenant_action_disabled" : "dependency_failure");
    return { kind: "continue", data: { id, version, risk, definitionHash: entry.definitionHash } };
  };
}
