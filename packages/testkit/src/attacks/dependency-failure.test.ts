import { describe, expect, it, vi } from "vitest";
import { dependencyFailureScenarios, DEPENDENCY_PORTS, DEPENDENCY_FAULTS, confirmationChannelFailure } from "./dependency-failure.js";
import { runScenario, type ScenarioTarget } from "../scenario-runner.js";
import { InMemoryAuditSink } from "../audit-capture.js";
import { RecordingExecutor } from "../recording-executor.js";
import { faulty } from "../fault-injection.js";
const safe = { actionId: "testSafeEcho", risk: "SAFE" as const, targetsResource: false, changesState: false, requiresConfirmation: false };

describe("T123 dependency-failure definitions", () => {
  it("contains the full independent 9 by 4 matrix with unique stable ids", () => {
    expect(DEPENDENCY_PORTS).toEqual(["authentication", "permissions", "resources", "pages", "replay", "rate-limiter", "confirmations-store", "tenant-policy", "audit-append"]);
    expect(DEPENDENCY_FAULTS).toEqual(["throws", "hangs", "undefined", "wrong-type"]);
    expect(dependencyFailureScenarios).toHaveLength(36);
    expect(new Set(dependencyFailureScenarios.map((scenario) => scenario.id)).size).toBe(36);
    for (const port of DEPENDENCY_PORTS) for (const mode of DEPENDENCY_FAULTS) {
      expect(dependencyFailureScenarios.filter((scenario) => scenario.port === port && scenario.mode === mode)).toHaveLength(1);
    }
  });
  it.each(dependencyFailureScenarios)("$id rejects vacuous evidence, execution and allowed feedback", (scenario) => {
    expect(scenario.id).toBe(`ATK-DEP-${scenario.port}-${scenario.mode}`);
    expect(scenario.verify({ feedback: [], executorCalls: 0, auditEvents: [], leakFindings: [] })).toContain("missing or surplus decision");
    expect(scenario.verify({ feedback: [{ outcome: "DENIED", category: "try_later" }], executorCalls: 0, auditEvents: [], leakFindings: [] })).toEqual([]);
    expect(scenario.verify({ feedback: [{ outcome: "ALLOWED", category: "ok" }], executorCalls: 1, auditEvents: [], leakFindings: [] })).toContain("executor ran under dependency fault");
    expect(scenario.verify({ feedback: [{ outcome: "ALLOWED", category: "ok" }], executorCalls: 0, auditEvents: [], leakFindings: [] })).toContain("dependency fault did not deny");
    expect(scenario.verify({ feedback: [{ outcome: "ALLOWED", category: "try_later" }], executorCalls: 0, auditEvents: [], leakFindings: [] })).toContain("dependency fault did not deny");
    expect(scenario.verify({ feedback: [{ outcome: "DENIED", category: "ok" }], executorCalls: 0, auditEvents: [], leakFindings: [] })).toContain("dependency fault did not deny");
    expect(scenario.verify({ feedback: [{ outcome: "DENIED", category: "try_later" }], executorCalls: 0, auditEvents: [], leakFindings: ["canary:$"] })).toContain("planner output leaked");
    expect(scenario.verify({ feedback: [{ outcome: "DENIED", category: "try_later", issues: [] }], executorCalls: 0, auditEvents: [], leakFindings: [] })).toContain("unexpected feedback fields");
  });
  it("applies resource/confirmation-store faults only where those ports are required", () => {
    for (const scenario of dependencyFailureScenarios) {
      expect(scenario.appliesTo(safe)).toBe(!["resources", "confirmations-store"].includes(scenario.port));
      expect(scenario.appliesTo({ ...safe, targetsResource: true, requiresConfirmation: true })).toBe(true);
    }
    expect(confirmationChannelFailure).toEqual({ id: "ATK-DEP-confirmation-channel", port: "confirmation-channel", modes: DEPENDENCY_FAULTS, expectedOutcome: "REQUIRES_CONFIRMATION", pendingRequestSurvives: true });
  });
  it("runner preserves closure-bound installation/submission; transport or setup failure can never pass", async () => {
    const definition = dependencyFailureScenarios[0]!;
    const installFault = vi.fn(async () => {});
    const submit = vi.fn(async () => { throw new Error("transport sentinel; no gateway policy is simulated"); });
    const scenario = definition.prepare({ validProposal: { callId: "hostile", raw: "{}" }, installFault, faultCalls: () => 0 });
    const target: ScenarioTarget = { ...safe, planner: { script: [] }, executor: new RecordingExecutor({ id: "transport-test", result: { status: "success", value: null } }), audit: new InMemoryAuditSink(), visibleOutput: null, submit };
    const observation = await runScenario(scenario, target);
    expect(installFault).toHaveBeenCalledExactlyOnceWith(definition.port, definition.mode);
    expect(submit).toHaveBeenCalledExactlyOnceWith({ callId: "hostile", raw: "{}" });
    expect(scenario.verify(observation)).toContain("faulted port was not observed through a completed submission");
    const unbound = await runScenario(definition, target);
    expect(definition.verify(unbound)).toContain("missing or surplus decision");
    expect(definition.verify(unbound)).toContain("planner output leaked");
    const setup = definition.prepare({ validProposal: { callId: "x", raw: "{}" }, installFault: async () => { throw new Error("setup failed"); }, faultCalls: () => 0 });
    expect(setup.verify(await runScenario(setup, target))).toContain("faulted port was not observed through a completed submission");
  });
  it("existing fault injection throws/returns invalid answers without calling the healthy port", async () => {
    const healthy = vi.fn(async () => true);
    expect(() => (faulty({ check: healthy }, "throws") as { check(): unknown }).check()).toThrow();
    expect((faulty({ check: healthy }, "undefined") as { check(): unknown }).check()).toBeUndefined();
    expect((faulty({ check: healthy }, "wrong-type") as { check(): unknown }).check()).toBe("yes");
    expect((faulty({ check: healthy }, "hangs") as { check(): unknown }).check()).toBeInstanceOf(Promise);
    expect(healthy).not.toHaveBeenCalled();
  });
});
