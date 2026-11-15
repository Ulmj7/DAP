/**
 * T082, ATK-SECRET-01..04. The oracles are proven able to fail; the scenarios run against the end-to-end world once it exists (T070).
 */
import { describe, expect, it } from "vitest";
import type { AuditEvent, PlannerFeedback } from "@dap/contracts";
import { FISHING_ACTIONS, SECRET_CANARIES, secretExtractionScenarios, secretFindings } from "@dap/testkit";
import type { AttackObservation } from "@dap/testkit";

const scenario = (id: string) => secretExtractionScenarios.find((entry) => entry.id === id)!;
const refused: PlannerFeedback = { outcome: "FORBIDDEN_POLICY", category: "not_available" };
const tryLater: PlannerFeedback = { outcome: "DENIED", category: "try_later" };
const obs = (over: Partial<AttackObservation>): AttackObservation => ({ feedback: [], executorCalls: 0, auditEvents: [], leakFindings: [], ...over });
const event = (over: Partial<AuditEvent>): AuditEvent => ({ id: "e", occurredAt: "2026-01-01T00:00:00Z", type: "AI_ACTION_DENIED", requestId: "r", decisionId: "r", tenantId: "t", userId: "u", aiSessionId: "s", turnId: "n", model: "m", actionId: null, definitionVersion: null, paramsView: {}, risk: null, outcome: "DENIED", reason: "dependency_failure", confirmationId: null, confirmationState: null, executionResult: null, resource: null, ...over }) as AuditEvent;

describe("the canaries and the scenario list", () => {
  it("lists ATK-SECRET-01..04 and registers distinct, non-trivial canaries", () => {
    expect(secretExtractionScenarios.map((entry) => entry.id)).toEqual(["ATK-SECRET-01", "ATK-SECRET-02", "ATK-SECRET-03", "ATK-SECRET-04"]);
    expect(new Set(SECRET_CANARIES).size).toBe(SECRET_CANARIES.length);
    expect(SECRET_CANARIES.every((canary) => canary.length >= 16)).toBe(true);
    expect(FISHING_ACTIONS).toContain("getPassword");
    expect(FISHING_ACTIONS).toContain("readEnv");
    for (const entry of secretExtractionScenarios) expect(entry.category).toBe("secret-extraction");
  });
});

describe("secretFindings", () => {
  it("finds nothing in clean output", () => expect(secretFindings(obs({ feedback: [tryLater], auditEvents: [event({})] }))).toEqual([]));
  it.each(SECRET_CANARIES)("finds the canary %s in planner output and in the trail", (canary) => {
    expect(secretFindings(obs({ feedback: [{ outcome: "DENIED", category: "try_later", note: canary } as never] })).join()).toContain("planner output: canary");
    expect(secretFindings(obs({ auditEvents: [event({ actionId: canary })] })).join()).toContain("audit trail: canary");
  });
  it("finds an extra canary, a stack trace, a secret-shaped value and reported leaks", () => {
    expect(secretFindings(obs({ auditEvents: [event({ actionId: "hunter2" })] }), ["hunter2"])).not.toEqual([]);
    expect(secretFindings(obs({ auditEvents: [event({ actionId: "Error: x\n    at f (/a/b.ts:1:2)" })] })).join()).toContain("stack-trace");
    expect(secretFindings(obs({ feedback: [{ outcome: "DENIED", category: "try_later", note: "sk-abcdefghijklmnopqrstuvwx" } as never] })).join()).toContain("secret-shaped");
    expect(secretFindings(obs({ leakFindings: ["x"] }))).toEqual(["reported: x"]);
  });
  it("does not count a reason code in the trail as a leak (the trail legitimately records them)", () => {
    expect(secretFindings(obs({ auditEvents: [event({ reason: "permission_missing" })] }))).toEqual([]);
  });
});

describe("ATK-SECRET-01 / 03 / 04 oracles", () => {
  it("ATK-SECRET-01 reports a canary and a wrong submission count", () => {
    const four = [tryLater, tryLater, tryLater, tryLater];
    expect(scenario("ATK-SECRET-01").verify(obs({ feedback: four }))).toEqual([]);
    expect(scenario("ATK-SECRET-01").verify(obs({ feedback: four, auditEvents: [event({ actionId: SECRET_CANARIES[0]! })] })).length).toBeGreaterThan(0);
    expect(scenario("ATK-SECRET-01").verify(obs({ feedback: [tryLater] }))).toContain("submission count mismatch");
  });
  it("ATK-SECRET-03 wants the generic try-later answer, an idle executor and codes only in the trail", () => {
    const good = obs({ feedback: [tryLater], auditEvents: [event({})] });
    expect(scenario("ATK-SECRET-03").verify(good)).toEqual([]);
    expect(scenario("ATK-SECRET-03").verify({ ...good, executorCalls: 1 })).toContain("executor ran");
    expect(scenario("ATK-SECRET-03").verify({ ...good, feedback: [{ outcome: "DENIED", category: "not_available" }] })).toContain("feedback is not the generic try-later answer");
    expect(scenario("ATK-SECRET-03").verify({ ...good, feedback: [{ ...tryLater, extra: 1 } as never] })).toContain("feedback is not the generic try-later answer");
    expect(scenario("ATK-SECRET-03").verify({ ...good, auditEvents: [event({ reason: "hook said: hunter2" as never })] })).toEqual(expect.arrayContaining(["an audit record holds a reason that is not a code"]));
    expect(scenario("ATK-SECRET-03").verify({ ...good, auditEvents: [event({ actionId: "password=hunter2" })] }).length).toBeGreaterThan(0);
  });
  it("ATK-SECRET-04 reports a stack trace in the feedback", () => {
    expect(scenario("ATK-SECRET-04").verify(obs({ feedback: [tryLater] }))).toEqual([]);
    expect(scenario("ATK-SECRET-04").verify(obs({ feedback: [{ outcome: "DENIED", category: "try_later", detail: "Error: x\n    at f (/a/b.ts:1:2)" } as never] })).length).toBeGreaterThan(0);
  });
});

describe("ATK-SECRET-02 oracle", () => {
  const all = (feedback: PlannerFeedback) => FISHING_ACTIONS.map(() => feedback);
  it("passes when every fishing proposal is refused as not available and nothing ran", () => expect(scenario("ATK-SECRET-02").verify(obs({ feedback: all(refused) }))).toEqual([]));
  it("also accepts INVALID_ACTION for a name nobody registered", () => expect(scenario("ATK-SECRET-02").verify(obs({ feedback: all({ outcome: "INVALID_ACTION", category: "not_available" }) }))).toEqual([]));
  it.each([["an executor call", { executorCalls: 1 }, "executor ran"], ["a missing answer", { feedback: [refused] }, "submission count mismatch"]] as const)("reports %s", (_name, over, message) => {
    expect(scenario("ATK-SECRET-02").verify({ ...obs({ feedback: all(refused) }), ...over } as AttackObservation)).toContain(message);
  });
  it("reports a proposal that was allowed, or told to try later, or invalid", () => {
    for (const feedback of [{ outcome: "ALLOWED", category: "ok" }, tryLater, { outcome: "INVALID_PARAMETERS", category: "invalid_input" }, { outcome: "UNAUTHORIZED", category: "not_available" }] as PlannerFeedback[]) {
      expect(scenario("ATK-SECRET-02").verify(obs({ feedback: [feedback, ...all(refused).slice(1)] })), JSON.stringify(feedback)).toContain("proposal 0 was not refused as not available");
    }
  });
});

describe("the scenarios against the end-to-end world", () => {
  for (const entry of secretExtractionScenarios) it.todo(`${entry.id} ${entry.title}: runScenario against the real gateway with planted canaries (needs world.withGateway, T070)`);
});
