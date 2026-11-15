/**
 * Exactly ONE decision event per proposal through the real gateway, rate-limit denials included. The rate-limit event used to be written by a
 * second path next to the runner's auditor; this pins that a rate-limited proposal leaves PROPOSED and a single AI_RATE_LIMITED, and that a
 * proposal that is not rate-limited still leaves PROPOSED and a single decision event.
 */
import { describe, expect, it } from "vitest";
import type { AuditEvent, GatewayDependencies } from "@dap/contracts";
import { createPolicyGateway } from "./create-gateway.js";
import { context, dependencies, run } from "./fixtures.test-support.js";

function world(proposalsPerTurn: number) {
  const { deps, calls } = dependencies();
  const events: AuditEvent[] = [];
  let next = 0;
  const wired: GatewayDependencies = {
    ...deps,
    hooks: { ...deps.hooks, permissions: { has: async () => true } },
    audit: { append: async (event: AuditEvent) => { events.push(event); } },
    ids: { ...deps.ids, newDecisionId: () => `decision-${++next}` },
    config: { ...deps.config, limits: { ...deps.config.limits, proposalsPerTurn } },
  };
  return { wired, events, calls };
}
const forRequest = (events: readonly AuditEvent[], id: string) => events.filter((event) => event.requestId === id).map((event) => event.type);

describe("one decision event per proposal", () => {
  it("a rate-limited proposal leaves PROPOSED and exactly one AI_RATE_LIMITED, not two decision events", async () => {
    const { wired, events, calls } = world(1);
    const submitter = createPolicyGateway(wired).proposals.forSession(context(), run);
    const raw = { action: "viewProject", params: {} };
    await submitter.submit({ callId: "first", raw });
    expect(await submitter.submit({ callId: "second", raw })).toEqual({ outcome: "DENIED", category: "try_later" });
    expect(forRequest(events, "decision-2")).toEqual(["AI_ACTION_PROPOSED", "AI_RATE_LIMITED"]);
    expect(events.find((event) => event.requestId === "decision-2" && event.type === "AI_RATE_LIMITED")).toMatchObject({ outcome: "DENIED", reason: "rate_limited_turn" });
    expect(calls()).toBe(0);
  });
  it("a proposal that is not rate-limited leaves PROPOSED and exactly one decision event", async () => {
    const { wired, events } = world(5);
    await createPolicyGateway(wired).proposals.forSession(context(), run).submit({ callId: "only", raw: { action: "viewProject", params: {} } });
    const types = forRequest(events, "decision-1");
    expect(types[0]).toBe("AI_ACTION_PROPOSED");
    expect(types.slice(1)).toHaveLength(1);
    expect(types).not.toContain("AI_RATE_LIMITED");
  });
});
