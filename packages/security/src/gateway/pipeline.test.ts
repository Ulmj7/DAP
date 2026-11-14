import { afterEach, describe, expect, it, vi } from "vitest";
import { PIPELINE_STAGES } from "@dap/contracts";
import { createPipeline, type PolicyStage } from "./pipeline.js";
import { allowedDecision } from "./decision.js";
import { input, stageMap } from "./fixtures.test-support.js";

afterEach(() => { vi.useRealTimers(); });
const allow: PolicyStage = (request) => ({ kind: "stop", decision: allowedDecision({ decisionId: request.decisionId, requestId: request.requestId, actionId: "viewProject" as never, risk: "SAFE", paramsDigest: "a".repeat(64) as never }) });

describe("ordered immutable request pipeline", () => {
  it("runs every D6 position in order and allows only a terminal decision", async () => {
    const seen: string[] = [];
    const stages = stageMap(allow);
    for (const name of [...PIPELINE_STAGES].reverse()) {
      const original = stages[name]!;
      stages[name] = (request) => { seen.push(name); return original(request); };
    }
    const result = await createPipeline(stages).run(input());
    expect(result.outcome).toBe("ALLOWED");
    expect(seen).toEqual(PIPELINE_STAGES);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("a continuing execute stage still denies", async () => {
    expect(await createPipeline(stageMap(() => ({ kind: "continue", data: {} }))).run(input())).toMatchObject({ outcome: "DENIED", reason: "dependency_failure", stage: "execute" });
  });

  it("snapshots a stage result once and does not let later stages mutate earlier facts", async () => {
    const original = { nested: { values: ["initial"] } };
    let reads = 0;
    let earlier: unknown;
    const stages = stageMap(allow);
    stages.intake = (request) => { earlier = request; return { kind: "continue", get data() { reads++; return original; } }; };
    stages.resolve = (request) => {
      const data = request.facts.intake as unknown as typeof original;
      expect(data).toEqual(original);
      original.nested.values[0] = "source changed";
      expect(data.nested.values).toEqual(["initial"]);
      expect(() => { data.nested.values.push("mutation"); }).toThrow();
      expect(Object.isFrozen(request)).toBe(true);
      expect(Object.isFrozen(request.run)).toBe(true);
      expect(Object.isFrozen(request.facts)).toBe(true);
      expect((earlier as { facts: object }).facts).not.toHaveProperty("intake");
      return { kind: "continue", data: {} };
    };
    expect((await createPipeline(stages).run(input())).outcome).toBe("ALLOWED");
    expect(reads).toBe(1);
  });

  it("reads every proposal field exactly once however many stages ask", async () => {
    let callIdReads = 0;
    let rawReads = 0;
    const raw = { action: "viewProject", params: {} };
    const call = { get callId() { callIdReads++; return "call"; }, get raw() { rawReads++; return raw; } };
    const seen: unknown[] = [];
    const stages = stageMap(allow);
    stages.intake = (request) => { seen.push(request.readProposal(), request.readProposal()); return { kind: "continue", data: {} }; };
    stages.resolve = (request) => { seen.push(request.readProposal()); return { kind: "continue", data: {} }; };
    expect((await createPipeline(stages).run({ ...input(), readProposal: () => call as never })).outcome).toBe("ALLOWED");
    expect([callIdReads, rawReads]).toEqual([1, 1]);
    expect(new Set(seen).size).toBe(1);
    expect(seen[0]).toEqual({ callId: "call", raw });
    expect(Object.isFrozen(seen[0])).toBe(true);
  });

  it("stays unavailable when the proposal throws once, without a second read", async () => {
    let reads = 0;
    let executions = 0;
    const call = { callId: "call", get raw(): never { reads++; throw new Error("CANARY"); } };
    const stages = stageMap(() => { executions++; throw new Error("unreachable"); });
    const failures: unknown[] = [];
    stages.intake = (request) => {
      for (let attempt = 0; attempt < 2; attempt++) { try { request.readProposal(); } catch (error) { failures.push(error); } }
      throw failures[0];
    };
    const decision = await createPipeline(stages).run({ ...input(), readProposal: () => call });
    expect(decision).toMatchObject({ outcome: "DENIED", reason: "internal_error", stage: "intake" });
    expect(failures).toHaveLength(2);
    expect(reads).toBe(1);
    expect(executions).toBe(0);
    expect(JSON.stringify(decision)).not.toContain("CANARY");
  });

  it.each([null, undefined, 7, "text"])("an unusable proposal object %j is unavailable, not a crash", async (value) => {
    let outcome = "";
    const stages = stageMap(allow);
    stages.intake = (request) => { try { request.readProposal(); outcome = "read"; } catch { outcome = "unavailable"; } return { kind: "continue", data: {} }; };
    await createPipeline(stages).run({ ...input(), readProposal: () => value as never });
    expect(outcome).toBe("unavailable");
  });

  it("takes a snapshot of stage registrations", async () => {
    const stages = stageMap(allow);
    const pipeline = createPipeline(stages);
    stages.execute = () => { throw new Error("replacement"); };
    expect((await pipeline.run(input())).outcome).toBe("ALLOWED");
  });

  it("isolates concurrent requests through one pipeline", async () => {
    let resume!: () => void;
    const gate = new Promise<void>((resolve) => { resume = resolve; });
    const observed: string[] = [];
    const stages = stageMap(allow);
    stages.intake = async (request) => {
      if (request.requestId === "first") await gate;
      return { kind: "continue", data: { requestId: request.requestId } };
    };
    stages.audit = (request) => {
      observed.push((request.facts.intake as { requestId: string }).requestId);
      return { kind: "continue", data: {} };
    };
    const pipeline = createPipeline(stages);
    const first = pipeline.run(input("first"));
    expect((await pipeline.run(input("second"))).requestId).toBe("second");
    resume();
    expect((await first).requestId).toBe("first");
    expect(observed).toEqual(["second", "first"]);
  });

  it("does not touch an answer arriving after timeout and handles late rejection", async () => {
    vi.useFakeTimers();
    let resolve!: (answer: unknown) => void;
    let reject!: (error: Error) => void;
    let reads = 0;
    for (const mode of ["resolve", "reject"]) {
      const stages = stageMap(allow);
      stages.intake = (() => new Promise<unknown>((yes, no) => { resolve = yes; reject = no; })) as PolicyStage;
      const pending = createPipeline(stages, { hookTimeoutMs: 20 }).run(input());
      await vi.advanceTimersByTimeAsync(20);
      expect(await pending).toMatchObject({ outcome: "DENIED", reason: "dependency_failure" });
      if (mode === "resolve") resolve({ get kind() { reads++; return "continue"; }, data: {} });
      else reject(new Error("late error"));
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(reads).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects a decision bound to a different request", async () => {
    const stages = stageMap(() => allow({ ...input("other"), context: null, facts: {} }));
    expect(await createPipeline(stages).run(input())).toMatchObject({ outcome: "DENIED", reason: "dependency_failure" });
  });

  it.each([null, false, [], "wrong", 4])("denies malformed continuation data %j", async (data) => {
    let executions = 0;
    const stages = stageMap(() => { executions++; throw new Error("unreachable"); });
    stages.intake = (() => ({ kind: "continue", data })) as unknown as PolicyStage;
    expect(await createPipeline(stages).run(input())).toMatchObject({ outcome: "DENIED", reason: "dependency_failure", stage: "intake" });
    expect(executions).toBe(0);
  });

  it("does not re-read an unexpected then getter after promise assimilation", async () => {
    let reads = 0;
    let executions = 0;
    const stages = stageMap(() => { executions++; throw new Error("unreachable"); });
    stages.intake = () => ({ kind: "continue", data: {}, get then() { reads++; return undefined; } });
    expect(await createPipeline(stages).run(input())).toMatchObject({ outcome: "DENIED", reason: "dependency_failure" });
    expect(reads).toBe(1);
    expect(executions).toBe(0);
  });
});
