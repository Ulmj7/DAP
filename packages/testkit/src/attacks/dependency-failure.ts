import type { AttackObservation, AttackScenario, CapabilityTraits, ProposalCall } from "@dap/contracts";
import type { ScenarioTarget } from "../scenario-runner.js";
import type { FaultMode } from "../fault-injection.js";

export const DEPENDENCY_PORTS = Object.freeze(["authentication", "permissions", "resources", "pages", "replay", "rate-limiter", "confirmations-store", "tenant-policy", "audit-append"] as const);
export const DEPENDENCY_FAULTS: readonly FaultMode[] = Object.freeze(["throws", "hangs", "undefined", "wrong-type"]);
export type DependencyPort = (typeof DEPENDENCY_PORTS)[number];
export interface DependencyFailureScenario extends AttackScenario {
  readonly port: DependencyPort;
  readonly mode: FaultMode;
  /** Bind a fresh, one-shot fixture BEFORE passing the scenario to runScenario. */
  prepare(fixture: DependencyFailureFixture): AttackScenario;
}
/**
 * Fixtures install the selected fault before a REAL submission. Specialize wrong-type for pages:
 * generic faulty() returns "yes", which is a valid PageId, so use a non-string instead.
 * Audit append's undefined case means a missing awaitable commit receipt, NOT a healthy
 * Promise<void> resolving to undefined. Its eventual gateway test must distinguish those.
 */
export interface DependencyFailureFixture {
  readonly validProposal: ProposalCall;
  installFault(port: DependencyPort, mode: FaultMode): Promise<void>;
  faultCalls(port: DependencyPort): number;
}
export const dependencyFailureScenarios: readonly DependencyFailureScenario[] = Object.freeze(DEPENDENCY_PORTS.flatMap((port) => DEPENDENCY_FAULTS.map((mode): DependencyFailureScenario => Object.freeze({
  id: `ATK-DEP-${port}-${mode}`, category: "dependency-failure", title: `${port} returns ${mode}`,
  port, mode,
  appliesTo: (traits: CapabilityTraits) => port === "resources" ? traits.targetsResource : port === "confirmations-store" ? traits.requiresConfirmation : true,
  async run(traits: CapabilityTraits) {
    const target = traits as ScenarioTarget;
    return { feedback: [], executorCalls: target.executor.calls, auditEvents: target.audit.events, leakFindings: ["scenario-setup:$"] };
  },
  prepare(fixture: DependencyFailureFixture): AttackScenario {
    let attempts = 0;
    let proof = false;
    const definition = dependencyFailureScenarios.find((scenario) => scenario.port === port && scenario.mode === mode)!;
    return {
      id: definition.id, title: definition.title, category: definition.category, appliesTo: definition.appliesTo,
      async run(traits: CapabilityTraits) {
        proof = false;
        if (++attempts !== 1) throw new Error("Prepare a fresh dependency fixture per run");
        const target = traits as ScenarioTarget;
        await fixture.installFault(port, mode);
        const before = fixture.faultCalls(port);
        const feedback = await target.submit(fixture.validProposal);
        const after = fixture.faultCalls(port);
        const report = { feedback: [feedback], executorCalls: target.executor.calls, auditEvents: target.audit.events, leakFindings: [] };
        proof = Number.isSafeInteger(before) && before >= 0 && Number.isSafeInteger(after) && after > before;
        return report;
      },
      verify(observation: AttackObservation) {
        return [...definition.verify(observation), ...(attempts === 1 && proof ? [] : ["faulted port was not observed through a completed submission"])];
      },
    };
  },
  verify(observation: AttackObservation) {
    const violations: string[] = [];
    if (observation.feedback.length !== 1) violations.push("missing or surplus decision");
    if (observation.executorCalls !== 0) violations.push("executor ran under dependency fault");
    if (observation.feedback.some((feedback) => !["DENIED", "UNAUTHORIZED"].includes(feedback.outcome) || !["try_later", "not_available"].includes(feedback.category))) violations.push("dependency fault did not deny");
    if (observation.feedback.some((feedback) => Object.keys(feedback).sort().join(",") !== "category,outcome")) violations.push("unexpected feedback fields");
    if (observation.leakFindings.length !== 0) violations.push("planner output leaked");
    // Audit append itself may be down: an absent event must never permit execution.
    return violations;
  },
}))));
export const confirmationChannelFailure = Object.freeze({
  id: "ATK-DEP-confirmation-channel", port: "confirmation-channel", modes: DEPENDENCY_FAULTS,
  expectedOutcome: "REQUIRES_CONFIRMATION", pendingRequestSurvives: true,
});
