import { describe, expect, it } from "vitest";
import type { AttackObservation, AuditEvent } from "@dap/contracts";
import { buildRegistry, createEnablementPolicy, InMemoryTenantActionPolicyStore } from "@dap/security";
import { ALICE, ctx, TENANT_A, TENANT_B, testSafeEcho, RESERVED_ATTACK_NAMES, PROTOTYPE_ACTION_NAMES, lookalikeNames, unknownActionScenarios } from "@dap/testkit";

const registry = buildRegistry([testSafeEcho]);
describe("T052 unknown actions", () => {
  it("ATK-UNKNOWN-01 never-registered action has no lookup", () => {
    expect(registry.get(testSafeEcho.id)).toBeDefined();
    expect(registry.get("deleteEverything")).toBeUndefined();
  });
  it.each(RESERVED_ATTACK_NAMES)("ATK-UNKNOWN-02 classifies %s as forbidden", (name) => {
    expect(registry.isReservedForbidden(name)).toBe(true);
    expect(registry.get(name)).toBeUndefined();
  });
  it.each(lookalikeNames(testSafeEcho.id))("ATK-UNKNOWN-03 rejects look-alike %j", (name) => {
    expect(registry.get(name)).toBeUndefined();
  });
  it.each(PROTOTYPE_ACTION_NAMES)("ATK-UNKNOWN-04 rejects prototype name %s", (name) => {
    expect(registry.get(name)).toBeUndefined();
  });
  it("ATK-UNKNOWN-05 global enablement defaults to deny", async () => {
    const policy = createEnablementPolicy({ registry, tenantPolicy: new InMemoryTenantActionPolicyStore() });
    expect(await policy.isEnabled(ctx(TENANT_A, ALICE), testSafeEcho.id)).toBe(false);
  });
  it("ATK-UNKNOWN-06 tenant disable takes effect immediately and only in that tenant", async () => {
    const tenantPolicy = new InMemoryTenantActionPolicyStore();
    const policy = createEnablementPolicy({ registry, tenantPolicy, globalAllowlist: new Set([testSafeEcho.id]) });
    expect(await policy.isEnabled(ctx(TENANT_A, ALICE), testSafeEcho.id)).toBe(true);
    await tenantPolicy.setDisabled(ctx(TENANT_A, ALICE), testSafeEcho.id, true);
    expect(await policy.isEnabled(ctx(TENANT_A, ALICE), testSafeEcho.id)).toBe(false);
    expect(await policy.isEnabled(ctx(TENANT_B, ALICE), testSafeEcho.id)).toBe(true);
  });
  // 07 (FORBIDDEN allowlist startup) and 08 (property writes/no mutator) already have registry unit tests.
  it.todo("ATK-UNKNOWN-08 submit 'register tool X' text through the real gateway: fingerprint/definitions unchanged, no executor (pending complete proposal/audit/execution path)");
  it("ATK-UNKNOWN-01 oracle accepts complete evidence and detects corrupted decisions, audit linkage and leaks", () => {
    // Synthetic observations test the oracle itself; no gateway is simulated.
    const proposed: AuditEvent = {
      id: "event-1", occurredAt: ctx(TENANT_A, ALICE).authenticatedAt,
      type: "AI_ACTION_PROPOSED", requestId: "request-1" as AuditEvent["requestId"],
      decisionId: "decision-1", tenantId: TENANT_A, userId: ALICE,
      aiSessionId: "session-1", turnId: "turn-1", model: "scripted",
      actionId: "deleteEverything", definitionVersion: null, paramsView: {}, risk: null,
      outcome: "INVALID_ACTION", reason: "unknown_action", confirmationId: null,
      confirmationState: null, executionResult: null, resource: null,
    };
    const denied: AuditEvent = { ...proposed, id: "event-2", type: "AI_ACTION_DENIED" };
    const observation: AttackObservation = {
      feedback: [{ outcome: "INVALID_ACTION", category: "not_available" }],
      executorCalls: 0, auditEvents: [proposed, denied], leakFindings: [],
    };
    const scenario = unknownActionScenarios[0]!;
    expect(scenario.verify(observation)).toEqual([]);
    expect(scenario.verify({ ...observation, feedback: [{ outcome: "INVALID_ACTION", category: "invalid_input" }] })).toContain("decision mismatch at 0");
    expect(scenario.verify({ ...observation, feedback: [{ outcome: "ALLOWED", category: "ok" }] })).toContain("decision mismatch at 0");
    expect(scenario.verify({ ...observation, auditEvents: [proposed, { ...denied, reason: "internal_error" }] })).toContain("audit mismatch at 0");
    expect(scenario.verify({ ...observation, auditEvents: [proposed, { ...denied, requestId: "wrong" as AuditEvent["requestId"] }] })).toContain("audit mismatch at 0");
    expect(scenario.verify({ ...observation, leakFindings: ["canary:$"] })).toContain("planner output leaked");
  });
  for (const scenario of unknownActionScenarios) {
    it(`${scenario.id} independent oracle rejects empty evidence and execution`, () => {
      const empty = { feedback: [], executorCalls: 0, auditEvents: [], leakFindings: [] };
      expect(scenario.verify(empty)).toContain("submission count mismatch");
      expect(scenario.verify({ ...empty, executorCalls: 1 })).toContain("executor ran");
    });
    // Waiting for complete gateway intake + audit + execution, then runScenario(scenario, realTarget).
    it.todo(`${scenario.id} ${scenario.title}: real gateway feedback/audit linkage, executorCalls === 0, no leaks`);
  }
});
