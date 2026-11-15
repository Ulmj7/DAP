/**
 * T084, SC-008. A small representative M1 sample through the shared real Gateway.
 * The separate stage-level 20-action test remains in packages/security/src/gateway/audit-trail.test.ts.
 */
import { describe, expect, it } from "vitest";
import type { AuditEvent } from "@dap/contracts";
import { validateGatewayConfig } from "@dap/security";
import { ALICE, CAROL, TENANT_A, WIDE_GATEWAY_CONFIG, withGateway } from "@dap/testkit";
import type { GatewayWorld, WorldUser } from "@dap/testkit";

/** What a reviewer can say about ONE request from its events alone: nothing here reads the world, the executors or the feedback. */
interface Reading { attempted: string | null; version: number | null; verdict: "executed" | "allowed-not-executed" | "denied" | "rate-limited" | "needs-confirmation" | "violation"; reason: string | null; by: string; resource: string | null; executionResult: "success" | "failure" | null }
function reconstruct(events: readonly AuditEvent[]): Reading[] {
  const byRequest = new Map<string, AuditEvent[]>();
  for (const event of events) byRequest.set(event.requestId, [...(byRequest.get(event.requestId) ?? []), event]);
  return [...byRequest.values()].map((group) => {
    const proposals = group.filter((event) => event.type === "AI_ACTION_PROPOSED");
    if (proposals.length !== 1 || group[0] !== proposals[0]) throw new Error("missing, duplicate or out-of-order proposal");
    const proposed = proposals[0]!;
    const decisions = group.filter((event) => event.type !== "AI_ACTION_PROPOSED" && event.type !== "AI_ACTION_EXECUTED");
    if (decisions.length !== 1) throw new Error(`request ${proposed.requestId} has ${decisions.length} decision events`);
    const decision = decisions[0]!;
    const executions = group.filter((event) => event.type === "AI_ACTION_EXECUTED");
    const executed = executions[0];
    if (executions.length > 1 || group[1] !== decision || (executed && (decision.type !== "AI_ACTION_ALLOWED" || group[2] !== executed || !["success", "failure"].includes(executed.executionResult!)))) throw new Error("invalid execution trail");
    if (group.some((event) => event.tenantId !== proposed.tenantId || event.userId !== proposed.userId || event.decisionId !== proposed.decisionId || event.actionId !== proposed.actionId)) throw new Error("inconsistent request binding");
    if (executed && executed.definitionVersion !== decision.definitionVersion) throw new Error("inconsistent version binding");
    const verdicts = { AI_ACTION_ALLOWED: executed ? "executed" : "allowed-not-executed", AI_ACTION_DENIED: "denied", AI_RATE_LIMITED: "rate-limited", AI_CONFIRMATION_REQUIRED: "needs-confirmation", AI_POLICY_VIOLATION: "violation" } as const;
    const touched = (executed ?? decision).resource;
    return {
      attempted: decision.actionId ?? proposed.actionId, version: decision.definitionVersion, verdict: verdicts[decision.type as keyof typeof verdicts], reason: decision.reason,
      executionResult: executed?.executionResult ?? null, by: `${decision.tenantId}/${decision.userId}`, resource: touched === null ? null : `${touched.type}:${touched.id}`,
    };
  });
}

describe("T084 audit trail (SC-008)", () => {
  it.todo("20 mixed proposals through the real gateway and the PostgreSQL audit store: every question answered from events alone (the PostgreSQL sink is T094)");
  /** Representative, not twenty: one request of each kind the trail must explain. The expectations are the test's own knowledge of what it sent and who sent it. */
  const A_ALICE: WorldUser = { tenant: "A", user: ALICE };
  const A_CAROL: WorldUser = { tenant: "A", user: CAROL };
  const who = (user: string) => `${TENANT_A}/${user}`;
  const EXPECTED: readonly Reading[] = [
    { attempted: "testSafeEcho", version: 1, verdict: "executed", reason: "allowed", by: who(ALICE), resource: "document:doc-1", executionResult: "success" },
    { attempted: "testSafeEcho", version: 1, verdict: "denied", reason: "permission_missing", by: who(CAROL), resource: null, executionResult: null },
    { attempted: "testSafeEcho", version: 1, verdict: "denied", reason: "invalid_parameters", by: who(ALICE), resource: null, executionResult: null },
    { attempted: "missingOne", version: null, verdict: "denied", reason: "unknown_action", by: who(ALICE), resource: null, executionResult: null },
    { attempted: "testSafeEcho", version: 1, verdict: "rate-limited", reason: "rate_limited_capability", by: who(ALICE), resource: null, executionResult: null },
    { attempted: "testHighPublish", version: 1, verdict: "needs-confirmation", reason: "confirmation_required", by: who(ALICE), resource: "document:doc-1", executionResult: null },
    { attempted: "testHighPublish", version: 1, verdict: "denied", reason: "resource_not_available", by: who(ALICE), resource: null, executionResult: null },
    { attempted: "testLowNavigate", version: 1, verdict: "executed", reason: "allowed", by: who(ALICE), resource: null, executionResult: "failure" },
  ];
  async function sample(): Promise<GatewayWorld> {
    const config = validateGatewayConfig({ ...WIDE_GATEWAY_CONFIG, limits: { ...WIDE_GATEWAY_CONFIG.limits, perUserPerCapabilityPerMinute: { limit: 1, windowSeconds: 60 } } });
    const world = withGateway({ config });
    world.executor("testSafeEcho").setNextResult({ status: "success", affected: { type: "document", id: "doc-1" } });
    const send = (user: WorldUser, raw: unknown, callId: string) => world.submit(user, { callId, raw });
    await send(A_ALICE, world.proposal("testSafeEcho").raw, "a");
    await send(A_CAROL, world.proposal("testSafeEcho").raw, "b");
    await send(A_ALICE, { action: "testSafeEcho", params: {} }, "c1");
    await send(A_ALICE, { action: "missingOne", params: {} }, "c2");
    await send(A_ALICE, world.proposal("testSafeEcho").raw, "d");
    await send(A_ALICE, world.proposal("testHighPublish").raw, "e1");
    await send(A_ALICE, world.resourceProposal("testHighPublish", "other-tenant").raw, "e2");
    world.executor("testLowNavigate").failWith("trusted executor failed");
    await send(A_ALICE, world.proposal("testLowNavigate").raw, "f");
    return world;
  }

  it("from the events alone: what was proposed, allowed or denied and why, who initiated it, whether it executed, and the resource", async () => {
    const world = await sample();
    expect(world.executorCalls()).toBe(2); // the success and failure bodies ran; decisions alone are not execution evidence
    expect(reconstruct(world.events())).toEqual(EXPECTED);
  });

  it("the reading is able to fail: each corrupted copy of the real trail gives an answer that differs from the truth", async () => {
    const events = [...(await sample()).events()];
    const executedIndex = events.findIndex((event) => event.type === "AI_ACTION_EXECUTED");
    const deniedIndex = events.findIndex((event) => event.reason === "permission_missing");
    const confirmIndex = events.findIndex((event) => event.type === "AI_CONFIRMATION_REQUIRED");
    const mutate = (name: string, change: (copy: AuditEvent[]) => AuditEvent[]) => [name, change(events.map((event) => ({ ...event })))] as const;
    const mutants = [
      mutate("a failed execution is reported as successful", (copy) => copy.map((event) => event.executionResult === "failure" ? { ...event, executionResult: "success" } : event)),
      mutate("the version is lost", (copy) => copy.map((event) => ({ ...event, definitionVersion: null }))),
      mutate("the trail drops who initiated the request", (copy) => copy.map((event) => ({ ...event, userId: "" as never }))),
      mutate("the EXECUTED event is missing", (copy) => copy.filter((_, index) => index !== executedIndex)),
      mutate("a denial's reason is replaced", (copy) => copy.map((event, index) => index === deniedIndex ? { ...event, reason: "allowed" as never } : event)),
      mutate("the resource is omitted", (copy) => copy.map((event, index) => index === confirmIndex ? { ...event, resource: null } : event)),
      mutate("the tenant is dropped", (copy) => copy.map((event) => ({ ...event, tenantId: "" as never }))),
      mutate("the action is dropped from the whole request (a decision alone still names it through the proposal, so both go)", (copy) => copy.map((event) => event.requestId === events[deniedIndex]!.requestId ? { ...event, actionId: null } : event)),
    ];
    for (const [name, corrupted] of mutants) expect(reconstruct(corrupted), name).not.toEqual(EXPECTED);
    expect(() => reconstruct(events.filter((event) => event.type !== "AI_ACTION_PROPOSED"))).toThrow(/proposal/);
    expect(() => reconstruct(events.map((event, index) => index === deniedIndex ? { ...event, requestId: "split" as never } : event))).toThrow();
    expect(() => reconstruct(events.map((event, index) => index === executedIndex ? { ...event, userId: "other" as never } : event))).toThrow(/binding/);
    // a decision recorded twice is not a different reading but an inconsistent trail: it is refused outright
    expect(() => reconstruct([...events.slice(0, deniedIndex + 1), { ...events[deniedIndex]! }, ...events.slice(deniedIndex + 1)])).toThrow(/decision events/);
  });

  it("every request has exactly one PROPOSED and one decision event, linked by request id, user and tenant, and the order is PROPOSED, decision, EXECUTED", async () => {
    const world = await sample();
    const ids = world.requestIds();
    expect(ids).toHaveLength(EXPECTED.length);
    for (const id of ids) {
      const group = world.eventsFor(id);
      expect(group.filter((event) => event.type === "AI_ACTION_PROPOSED")).toHaveLength(1);
      expect(group[0]!.type).toBe("AI_ACTION_PROPOSED");
      expect(new Set(group.map((event) => `${event.tenantId}/${event.userId}/${event.requestId}`)).size).toBe(1);
    }
    expect(world.eventsFor(ids[0]!).map((event) => event.type)).toEqual(["AI_ACTION_PROPOSED", "AI_ACTION_ALLOWED", "AI_ACTION_EXECUTED"]);
  });

  it.todo("a reviewer in tenant A cannot answer anything about tenant B's actions from the events it can read (ATK-XTENANT-09, T094)");
});
