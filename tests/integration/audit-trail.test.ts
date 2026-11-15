/**
 * T084, SC-008. From the audit events ALONE a reviewer can answer, for a sample of 20 mixed actions: what was attempted, why it was
 * allowed or denied, who authorized it, and what resource changed. The same questions are answered, over the real chain with stand-ins
 * for the stages not built yet, by packages/security/src/gateway/audit-trail.test.ts; this file is the end-to-end version.
 */
import { describe, expect, it } from "vitest";
import type { AuditEvent } from "@dap/contracts";
import { validateGatewayConfig } from "@dap/security";
import { ALICE, CAROL, TENANT_A, WIDE_GATEWAY_CONFIG, withGateway } from "@dap/testkit";
import type { GatewayWorld, WorldUser } from "@dap/testkit";

/** What a reviewer can say about ONE request from its events alone: nothing here reads the world, the executors or the feedback. */
interface Reading { attempted: string | null; version: number | null; verdict: "executed" | "allowed-not-executed" | "denied" | "rate-limited" | "needs-confirmation" | "violation"; reason: string | null; by: string; resource: string | null }
function reconstruct(events: readonly AuditEvent[]): Reading[] {
  const byRequest = new Map<string, AuditEvent[]>();
  for (const event of events) byRequest.set(event.requestId, [...(byRequest.get(event.requestId) ?? []), event]);
  return [...byRequest.values()].map((group) => {
    const proposed = group.find((event) => event.type === "AI_ACTION_PROPOSED")!;
    const decisions = group.filter((event) => event.type !== "AI_ACTION_PROPOSED" && event.type !== "AI_ACTION_EXECUTED");
    if (decisions.length !== 1) throw new Error(`request ${proposed.requestId} has ${decisions.length} decision events`);
    const decision = decisions[0]!;
    const executed = group.find((event) => event.type === "AI_ACTION_EXECUTED");
    const verdicts = { AI_ACTION_ALLOWED: executed ? "executed" : "allowed-not-executed", AI_ACTION_DENIED: "denied", AI_RATE_LIMITED: "rate-limited", AI_CONFIRMATION_REQUIRED: "needs-confirmation", AI_POLICY_VIOLATION: "violation" } as const;
    const touched = (executed ?? decision).resource;
    return {
      attempted: decision.actionId ?? proposed.actionId, version: decision.definitionVersion, verdict: verdicts[decision.type as keyof typeof verdicts], reason: decision.reason,
      by: `${decision.tenantId}/${decision.userId}`, resource: touched === null ? null : `${touched.type}:${touched.id}`,
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
    { attempted: "testSafeEcho", version: 1, verdict: "executed", reason: "allowed", by: who(ALICE), resource: "document:doc-1" },
    { attempted: "testSafeEcho", version: 1, verdict: "denied", reason: "permission_missing", by: who(CAROL), resource: null },
    { attempted: "testSafeEcho", version: 1, verdict: "denied", reason: "invalid_parameters", by: who(ALICE), resource: null },
    { attempted: "missingOne", version: null, verdict: "denied", reason: "unknown_action", by: who(ALICE), resource: null },
    { attempted: "testSafeEcho", version: 1, verdict: "rate-limited", reason: "rate_limited_capability", by: who(ALICE), resource: null },
    { attempted: "testHighPublish", version: 1, verdict: "needs-confirmation", reason: "confirmation_required", by: who(ALICE), resource: "document:doc-1" },
    { attempted: "testHighPublish", version: 1, verdict: "denied", reason: "resource_not_available", by: who(ALICE), resource: null },
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
    return world;
  }

  it("from the events alone: what was proposed, allowed or denied and why, who initiated it, whether it executed, and the resource", async () => {
    const world = await sample();
    expect(world.executorCalls()).toBe(1); // only (a) ran: the zero-execution answers below are not read off an idle world
    expect(reconstruct(world.events())).toEqual(EXPECTED);
  });

  it("the reading is able to fail: each corrupted copy of the real trail gives an answer that differs from the truth", async () => {
    const events = [...(await sample()).events()];
    const executedIndex = events.findIndex((event) => event.type === "AI_ACTION_EXECUTED");
    const deniedIndex = events.findIndex((event) => event.reason === "permission_missing");
    const confirmIndex = events.findIndex((event) => event.type === "AI_CONFIRMATION_REQUIRED");
    const mutate = (name: string, change: (copy: AuditEvent[]) => AuditEvent[]) => [name, change(events.map((event) => ({ ...event })))] as const;
    const mutants = [
      mutate("the trail drops who initiated the request", (copy) => copy.map((event) => ({ ...event, userId: "" as never }))),
      mutate("the EXECUTED event is missing", (copy) => copy.filter((_, index) => index !== executedIndex)),
      mutate("a denial's reason is replaced", (copy) => copy.map((event, index) => index === deniedIndex ? { ...event, reason: "allowed" as never } : event)),
      mutate("the resource is omitted", (copy) => copy.map((event, index) => index === confirmIndex ? { ...event, resource: null } : event)),
      mutate("the tenant is dropped", (copy) => copy.map((event) => ({ ...event, tenantId: "" as never }))),
      mutate("the action is dropped from the decision", (copy) => copy.map((event, index) => index === deniedIndex ? { ...event, actionId: null } : event)),
    ];
    for (const [name, corrupted] of mutants) expect(reconstruct(corrupted), name).not.toEqual(EXPECTED);
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
