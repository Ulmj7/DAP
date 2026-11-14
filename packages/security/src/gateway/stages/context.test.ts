import { describe, expect, it, vi, afterEach } from "vitest";
import type { AuthorizationContext, Clock } from "@dap/contracts";
import { mintAuthorizationContext } from "@dap/contracts/mint";
import { createContextStage } from "./context.js";
import { createPipeline } from "../pipeline.js";
import { allowedDecision } from "../decision.js";
import { context, input, stageMap } from "../fixtures.test-support.js";

afterEach(() => { vi.useRealTimers(); });
describe("minted context stage", () => {
  async function check(ctx: unknown, clock: Clock = { now: () => "2026-01-01T00:00:00Z" as never }) {
    let executions = 0;
    const stages = stageMap((request) => { executions++; return { kind: "stop", decision: allowedDecision({ decisionId: request.decisionId, requestId: request.requestId, actionId: "viewProject" as never, risk: "SAFE", paramsDigest: "a".repeat(64) as never }) }; });
    stages.context = createContextStage(clock, { hookTimeoutMs: 20 });
    const decision = await createPipeline(stages).run({ ...input(), context: ctx, readProposal: () => { throw new Error("proposal must not be read"); } });
    return { decision, executions };
  }
  it.each([null, undefined, {}, { ...context() }, new Proxy(context(), {})])("rejects a non-minted context %j", async (ctx) => {
    const { decision, executions } = await check(ctx);
    expect(decision).toMatchObject({ outcome: "UNAUTHORIZED", reason: "unauthenticated", stage: "context" });
    expect(executions).toBe(0);
  });
  it("never reads properties on a forged context", async () => {
    let reads = 0;
    const ctx = { get userId() { reads++; throw new Error("CANARY"); } } as unknown as AuthorizationContext;
    const result = await check(ctx);
    expect(result.decision.outcome).toBe("UNAUTHORIZED");
    expect(result.executions).toBe(0);
    expect(reads).toBe(0);
  });
  it.each(["2026-01-01T01:00:00Z", "2026-01-01T02:00:00Z"])("denies at or after expiry %s", async (time) => {
    const { decision, executions } = await check(context(), { now: () => time as never });
    expect(decision).toMatchObject({ outcome: "UNAUTHORIZED", reason: "session_expired" });
    expect(executions).toBe(0);
  });
  const minted = (authenticatedAt: string, validUntil: string) => mintAuthorizationContext({ userId: "alice", tenantId: "00000000-0000-4000-8000-000000000001", sessionId: "session", authenticatedAt: authenticatedAt as never, validUntil: validUntil as never });
  it.each([
    ["authenticated after the clock reading", "2026-01-01T00:00:01Z", "2026-01-01T01:00:00Z"],
    ["valid-until before authentication", "2025-12-31T23:00:00Z", "2025-12-31T22:00:00Z"],
    ["valid-until equal to authentication", "2025-12-31T23:00:00Z", "2025-12-31T23:00:00Z"],
    ["unparseable instants", "never", "forever"],
  ])("a minted context with an incoherent validity window (%s) is unauthenticated", async (_label, authenticatedAt, validUntil) => {
    const { decision, executions } = await check(minted(authenticatedAt, validUntil));
    expect(decision).toMatchObject({ outcome: "UNAUTHORIZED", reason: "unauthenticated", stage: "context" });
    expect(executions).toBe(0);
  });
  it("accepts a context authenticated exactly at the clock reading", async () => {
    const result = await check(minted("2026-01-01T00:00:00Z", "2026-01-01T01:00:00Z"));
    expect(result.decision.outcome).toBe("ALLOWED");
  });
  it("accepts the original minted identity before expiry", async () => {
    const result = await check(context());
    expect(result.decision.outcome).toBe("ALLOWED");
    expect(result.executions).toBe(1);
  });
  it.each([undefined, null, 1, "yesterday"])("malformed clock %j denies", async (value) => {
    const { decision, executions } = await check(context(), { now: () => value } as Clock);
    expect(decision).toMatchObject({ outcome: "DENIED", reason: "dependency_failure" });
    expect(executions).toBe(0);
  });
  it("contains a throwing clock", async () => {
    const { decision, executions } = await check(context(), { now: () => { throw new Error("CANARY"); } });
    expect(decision).toMatchObject({ outcome: "DENIED", reason: "dependency_failure" });
    expect(executions).toBe(0);
    expect(JSON.stringify(decision)).not.toContain("CANARY");
  });
  it("times out a clock that violates its synchronous contract", async () => {
    vi.useFakeTimers();
    const pending = check(context(), { now: () => new Promise(() => {}) } as unknown as Clock);
    await vi.advanceTimersByTimeAsync(20);
    const { decision, executions } = await pending;
    expect(decision).toMatchObject({ outcome: "DENIED", reason: "dependency_failure" });
    expect(executions).toBe(0);
  });
});
