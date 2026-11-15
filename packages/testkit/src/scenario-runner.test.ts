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

describe("runScenario hands through the controls a scenario drives beyond a plain target", () => {
  type Driven = ScenarioTarget & { setAnswer(answer: unknown): void; boom(): void; readonly names: string[] };
  const driving = (run: (target: Driven) => Promise<PlannerFeedback[]>): AttackScenario => ({
    id: "T-EXT", category: "privilege-escalation", title: "drives extra controls", appliesTo: () => true,
    async run(t) {
      const target = t as Driven;
      const feedback = await run(target);
      return { feedback, executorCalls: target.executor.calls, auditEvents: target.audit.events, leakFindings: [] };
    },
    verify: () => [],
  });

  it("calls an extra method on the real target (with its own `this`), and reads an extra value, while submissions stay guarded", async () => {
    const log: unknown[] = [];
    const target = Object.assign(targetFor(), {
      state: "s0", setAnswer(this: { state: string }, answer: unknown) { log.push([answer, this.state]); },
      get names() { return ["planted"]; },
    });
    const scenario = driving(async (t) => { t.setAnswer("yes"); log.push(t.names); return [await t.submit({ callId: "c", raw: "{}" })]; });
    const observation = await runScenario(scenario, target);
    expect(log).toEqual([["yes", "s0"], ["planted"]]);
    expect(observation.feedback).toEqual([{ outcome: "ALLOWED", category: "ok" }]);
  });

  it("an extra member can neither replace the guarded submitter nor the recording executor", async () => {
    const real = makeExecutor();
    const target = { ...targetFor({ executor: real }), executorCalls: 0 };
    const scenario = driving(async (t) => {
      for (const key of ["submit", "executor", "audit"]) { try { (t as unknown as Record<string, unknown>)[key] = {}; } catch { /* frozen */ } }
      return [await t.submit({ callId: "c", raw: "{}" })];
    });
    const observation = await runScenario(scenario, target);
    expect(observation.feedback).toEqual([{ outcome: "ALLOWED", category: "ok" }]);
    expect(observation.executorCalls).toBe(real.calls);
  });

  it("is still fail-closed: an extra control that throws is a recorded failure, not a crash", async () => {
    const target = Object.assign(targetFor(), { boom() { throw new Error("CANARY-boom"); } });
    const observation = await runScenario(driving(async (t) => { t.boom(); return []; }), target);
    expect(observation.feedback).toEqual([{ outcome: "DENIED", category: "not_available" }]);
    expect(JSON.stringify(observation)).not.toContain("CANARY-boom");
  });
});
