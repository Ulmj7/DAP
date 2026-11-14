import type { AttackCategory, AttackObservation, AttackScenario, CapabilityTraits, Outcome, ProposalCall, ReasonCode } from "@dap/contracts";
import type { ScenarioTarget } from "../scenario-runner.js";

/** Inputs are regenerated for each run so hostile getters and Proxies are never reused. */
export interface DenialCase {
  readonly raw: unknown;
  readonly outcome: Outcome;
  readonly reason: ReasonCode;
}
export interface DenialScenario extends AttackScenario {
  readonly cases: (target: CapabilityTraits) => readonly DenialCase[];
}

/** Only submits to the supplied real gateway; this helper makes no policy decisions. */
export function denialScenario(id: string, category: AttackCategory, title: string,
  cases: DenialScenario["cases"]): DenialScenario {
  return {
    id, category, title, cases, appliesTo: () => true,
    async run(traits) {
      const target = traits as ScenarioTarget;
      const inputs = cases(target);
      const feedback = [];
      for (const [index, item] of inputs.entries()) {
        const call: ProposalCall = { callId: `${id}-${index}`, raw: item.raw };
        feedback.push(await target.submit(call));
      }
      return { feedback, executorCalls: target.executor.calls, auditEvents: target.audit.events, leakFindings: [] };
    },
    verify(observation: AttackObservation) {
      const violations: string[] = [];
      // cases are capability-independent except the exact registered id under attack.
      const expected = cases({ actionId: "testSafeEcho", risk: "SAFE", changesState: false, targetsResource: false, requiresConfirmation: false });
      if (observation.executorCalls !== 0) violations.push("executor ran");
      if (observation.leakFindings.length !== 0) violations.push("planner output leaked");
      if (observation.feedback.length !== expected.length) violations.push("submission count mismatch");
      for (const [index, item] of expected.entries()) {
        const feedback = observation.feedback[index];
        if (feedback?.outcome !== item.outcome || feedback.category !== (item.outcome === "INVALID_PARAMETERS" ? "invalid_input" : "not_available")) violations.push(`decision mismatch at ${index}`);
      }
      const proposed = observation.auditEvents.filter((event) => event.type === "AI_ACTION_PROPOSED");
      if (proposed.length !== expected.length || new Set(proposed.map((event) => event.requestId)).size !== expected.length) violations.push("proposed event count/linkage mismatch");
      for (const [index, event] of proposed.entries()) {
        const item = expected[index]!;
        const decisions = observation.auditEvents.filter((entry) => entry.requestId === event.requestId && entry.type !== "AI_ACTION_PROPOSED");
        if (decisions.length !== 1 || decisions[0]?.outcome !== item.outcome || decisions[0]?.reason !== item.reason || decisions[0]?.type !== (item.outcome === "FORBIDDEN_POLICY" ? "AI_POLICY_VIOLATION" : "AI_ACTION_DENIED")) violations.push(`audit mismatch at ${index}`);
      }
      if (observation.auditEvents.length !== expected.length * 2) violations.push("unexpected audit events");
      return violations;
    },
  };
}
