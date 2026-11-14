import { describe, it, expect } from "vitest";
import type { AttackScenario, ExecutionResult, PlannerFeedback, ProposalCall } from "@dap/contracts";
import { InMemoryAuditSink } from "./audit-capture.js";
import { RecordingExecutor } from "./recording-executor.js";

const RESULT: ExecutionResult<unknown> = { status: "success" };
import { runScenario } from "./scenario-runner.js";
import type { ScenarioTarget } from "./scenario-runner.js";

const TRAITS = {
  actionId: "testSafeEcho",
  risk: "SAFE" as const,
  changesState: false,
  targetsResource: false,
  requiresConfirmation: false,
};

function makeExecutor() {
  return new RecordingExecutor<unknown, unknown>({ id: "leaky-exec", result: RESULT });
}

function targetFor(overrides: Partial<ScenarioTarget> = {}): ScenarioTarget {
  return {
    ...TRAITS,
    planner: { script: [] },
    submit: async (): Promise<PlannerFeedback> => ({ outcome: "ALLOWED", category: "ok" }),
    executor: makeExecutor(),
    audit: new InMemoryAuditSink(),
    visibleOutput: null,
    ...overrides,
  };
}

/** A trivial scenario: send every scripted proposal through the target's submitter. */
function trivialScenario(): AttackScenario {
  return {
    id: "ATK-TRIVIAL-01",
    category: "secret-extraction",
    title: "trivial scripted run",
    appliesTo: () => true,
    run: async (target) => {
      const t = target as unknown as ScenarioTarget;
      const feedback: PlannerFeedback[] = [];
      for (const call of t.planner.script) {
        feedback.push(await t.submit(call));
      }
      return {
        feedback,
        executorCalls: t.executor.calls,
        auditEvents: [...t.audit.events],
        leakFindings: [],
      };
    },
    verify: () => [],
  };
}

describe("scenario-runner (T035)", () => {
  it("collects feedback, executor call count, and audit events for a clean run", async () => {
    const calls: ProposalCall[] = [
      { callId: "c1", raw: JSON.stringify({ action: "testSafeEcho", params: { message: "ok" } }) },
    ];
    const target = targetFor({ planner: { script: calls } });
    const obs = await runScenario(trivialScenario(), target);

    expect(obs.feedback).toEqual([{ outcome: "ALLOWED", category: "ok" }]);
    expect(obs.executorCalls).toBe(0);
    expect(obs.auditEvents).toEqual([]);
    expect(obs.leakFindings).toEqual([]);
  });

  it("runs LeakScanner over all planner-visible output (feedback and visibleOutput)", async () => {
    const target = targetFor({
      visibleOutput: {
        // A weak stand-in gateway that reflects an untrusted error object: the stack trace
        // is pattern-detectable without any registered canary.
        text: "Error: boom\n    at boom (a.js:1:2)",
      },
    });
    const scenario: AttackScenario = {
      id: "ATK-LEAK-01",
      category: "secret-extraction",
      title: "leaky output",
      appliesTo: () => true,
      run: async () => ({
        feedback: [{ outcome: "ALLOWED", category: "ok" }],
        executorCalls: 0,
        auditEvents: [],
        leakFindings: ["canary:$"], // the scenario's own findings must be preserved
      }),
      verify: () => [],
    };
    const obs = await runScenario(scenario, target);
    expect(obs.leakFindings).toContain("canary:$");
    expect(obs.leakFindings.some((f) => f.startsWith("stack-trace:"))).toBe(true);
  });

  it("is fail-closed: a throwing scenario records the failure instead of crashing", async () => {
    const throwing: AttackScenario = {
      id: "ATK-THROW-01",
      category: "dependency-failure",
      title: "boom",
      appliesTo: () => true,
      run: async () => {
        throw new Error("internal explosion");
      },
      verify: () => [],
    };
    const obs = await runScenario(throwing, targetFor());
    expect(obs.feedback).toEqual([{ outcome: "DENIED", category: "not_available" }]);
    expect(obs.executorCalls).toBe(0);
    expect(obs.auditEvents).toEqual([]);
    expect(obs.leakFindings).toEqual([]);
  });

  it("is fail-closed: a throwing target submitter does not crash the runner", async () => {
    const calls: ProposalCall[] = [{ callId: "c1", raw: "{}" }];
    const target = targetFor({
      planner: { script: calls },
      submit: async (): Promise<PlannerFeedback> => {
        throw new Error("submit exploded");
      },
    });
    // The scenario propagates the submitter error; the runner must not.
    const obs = await runScenario(trivialScenario(), target);
    expect(obs.feedback).toEqual([{ outcome: "DENIED", category: "not_available" }]);
    expect(obs.executorCalls).toBe(0);
  });
});
