/**
 * T083, POS-01 and ATK-PRIV-04. A suite of denials cannot tell a working Gateway from one that denies everything: these must ALLOW.
 * The oracles are proven able to fail; the scenarios run against the end-to-end world once it exists (T070).
 */
import { describe, expect, it } from "vitest";
import type { AuthorizationContext, AuditEvent } from "@dap/contracts";
import { ALICE, BOB, TENANT_A, TENANT_B, contextViolations, ctx, positiveScenarios } from "@dap/testkit";
import type { PositiveObservation } from "@dap/testkit";

const alice = ctx(TENANT_A, ALICE);
const scenario = (id: string) => positiveScenarios.find((entry) => entry.id === id)!;
const ev = (type: AuditEvent["type"]) => ({ type }) as AuditEvent;
const validated = { message: "hello" };
const good = (over: Partial<PositiveObservation> = {}): PositiveObservation => ({
  feedback: [{ outcome: "ALLOWED", category: "ok" }], executorCalls: 1, auditEvents: [ev("AI_ACTION_PROPOSED"), ev("AI_ACTION_ALLOWED"), ev("AI_ACTION_EXECUTED")], leakFindings: [],
  executorContexts: [alice], serviceIdentityCalls: 0, requestingUser: alice, validated, receivedParams: [{ message: "hello" }], ...over,
});
const safe = { actionId: "x", risk: "SAFE", changesState: false, targetsResource: false, requiresConfirmation: false } as const;

describe("which capabilities the positive controls apply to", () => {
  it("applies to SAFE capabilities that need no confirmation, and to nothing else", () => {
    for (const entry of positiveScenarios) {
      expect(entry.appliesTo(safe)).toBe(true);
      for (const risk of ["LOW", "MEDIUM", "HIGH", "CRITICAL", "FORBIDDEN"] as const) expect(entry.appliesTo({ ...safe, risk }), `${entry.id} ${risk}`).toBe(false);
      expect(entry.appliesTo({ ...safe, requiresConfirmation: true })).toBe(false);
    }
    expect(positiveScenarios.map((entry) => entry.id)).toEqual(["POS-01", "ATK-PRIV-04"]);
  });
});

describe("POS-01 oracle", () => {
  it("passes one allowed execution with exactly the validated parameters and the full trail", () => expect(scenario("POS-01").verify(good())).toEqual([]));
  it.each([
    ["the proposal was denied", { feedback: [{ outcome: "DENIED", category: "not_available" }] }, "the proposal was not allowed"],
    ["the planner was told try_later", { feedback: [{ outcome: "ALLOWED", category: "try_later" }] }, "the proposal was not allowed"],
    ["two answers", { feedback: [{ outcome: "ALLOWED", category: "ok" }, { outcome: "ALLOWED", category: "ok" }] }, "the proposal was not allowed"],
    ["the executor never ran", { executorCalls: 0 }, "the executor did not run exactly once"], ["the executor ran twice", { executorCalls: 2 }, "the executor did not run exactly once"],
    ["the trail lacks the allow-event", { auditEvents: [ev("AI_ACTION_PROPOSED"), ev("AI_ACTION_EXECUTED")] }, "the trail is not PROPOSED, ALLOWED, EXECUTED"],
    ["the trail has a denial too", { auditEvents: [ev("AI_ACTION_PROPOSED"), ev("AI_ACTION_ALLOWED"), ev("AI_ACTION_DENIED"), ev("AI_ACTION_EXECUTED")] }, "the trail is not PROPOSED, ALLOWED, EXECUTED"],
    ["the executor received other parameters", { receivedParams: [{ message: "other" }] }, "the executor did not receive exactly the validated parameters"],
    ["the executor received extra parameters", { receivedParams: [{ message: "hello", extra: 1 }] }, "the executor did not receive exactly the validated parameters"],
    ["no parameters were received", { receivedParams: [] }, "the executor did not receive exactly the validated parameters"],
  ] as const)("reports: %s", (_name, over, message) => expect(scenario("POS-01").verify(good(over as Partial<PositiveObservation>))).toContain(message));
});

describe("ATK-PRIV-04 oracle", () => {
  it("passes the requesting user's own context and no service identity", () => expect(scenario("ATK-PRIV-04").verify(good())).toEqual([]));
  it("reports an executor that did not run exactly once, and a missing observation", () => {
    expect(scenario("ATK-PRIV-04").verify(good({ executorCalls: 0 }))).toEqual(["the executor did not run exactly once"]);
    expect(scenario("ATK-PRIV-04").verify(good({ executorContexts: [alice, alice] }))).toEqual(["the executor did not run exactly once"]);
    expect(scenario("ATK-PRIV-04").verify({ ...good(), requestingUser: undefined } as never)).toEqual(["no requesting user was observed"]);
  });
  it.each([
    ["another user's context", ctx(TENANT_A, BOB), 0, "the executor was not given the requesting user's own context object"],
    ["a copy of the context", { ...alice } as AuthorizationContext, 0, "the executor was not given the requesting user's own context object"],
    ["another tenant", ctx(TENANT_B, ALICE), 0, "the executor's identity differs from the requesting user's"],
    ["a service identity hook call", alice, 1, "a service-identity hook was invoked"],
  ] as const)("reports %s", (_name, received, calls, message) => {
    expect(contextViolations(received, alice, calls)).toContain(message);
    expect(scenario("ATK-PRIV-04").verify(good({ executorContexts: [received], serviceIdentityCalls: calls }))).toContain(message);
  });
});

describe("the scenarios against the end-to-end world", () => {
  for (const entry of positiveScenarios) it.todo(`${entry.id} ${entry.title}: runScenario against the real gateway (needs world.withGateway, T070)`);
});
