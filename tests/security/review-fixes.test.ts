/** Focused regressions for EXEC-01, LOGIC-01 and TEST-01/03. */
import { describe, expect, it, vi } from "vitest";
import { defineExecutor } from "@dap/contracts";
import type { GatewayDependencies } from "@dap/contracts";
import { createPolicyGateway } from "@dap/security";
import { withGateway, WIDE_GATEWAY_CONFIG } from "@dap/testkit";
import { assemble } from "../../packages/security/src/gateway/create-gateway.js";
import { createPipeline } from "../../packages/security/src/gateway/pipeline.js";

const alice = { tenant: "A", user: "alice" } as const;
const ok = { outcome: "ALLOWED", category: "ok" };
const types = (w: ReturnType<typeof withGateway>) => w.events().map(e => e.type);
const submit = async (w: ReturnType<typeof withGateway>, overrides: Partial<GatewayDependencies>, action = "testSafeEcho") => {
  const bound = await w.submitterFor(alice);
  return createPolicyGateway({ ...w.deps, ...overrides }).proposals.forSession(bound.context, bound.run).submit(w.proposal(action));
};

describe("EXEC-01 / TEST-03: real guarded executors may return arbitrary values", () => {
  it.each([new Date(0), new Map(), new (class Row { id = 1; })(), 10n, { id: 1 }])("success is preserved for value %s without exposing it", async value => {
    const w = withGateway(); let calls = 0;
    const executor = defineExecutor({ id: "real-result", run: async () => { calls++; return { status: "success", value }; } });
    expect(await submit(w, { executors: { executorFor: () => executor } })).toEqual(ok);
    expect(calls).toBe(1);
    expect(w.events().at(-1)).toMatchObject({ type: "AI_ACTION_EXECUTED", executionResult: "success" });
    expect(JSON.stringify(w.events())).not.toContain('"value"');
  });
  it("never reads value or lets malformed affected metadata turn a known success into failure", async () => {
    const w = withGateway(); let reads = 0;
    const executor = defineExecutor({ id: "real-result", run: async () => ({ status: "success", get value() { reads++; throw new Error("secret"); }, get affected() { throw new Error("secret"); } }) });
    expect(await submit(w, { executors: { executorFor: () => executor } })).toEqual(ok);
    expect(reads).toBe(0);
    expect(w.events().at(-1)?.executionResult).toBe("success");
    expect(JSON.stringify(w.events())).not.toContain("secret");
  });
});

describe("LOGIC-01 / TEST-01: durable ALLOW is the final policy decision", () => {
  it("missing executor binding is rejected before durable ALLOW", async () => {
    const w = withGateway();
    expect(await submit(w, { executors: { executorFor: () => undefined } })).toEqual({ outcome: "DENIED", category: "try_later" });
    expect(types(w)).toEqual(["AI_ACTION_PROPOSED", "AI_ACTION_DENIED"]);
    expect(w.executorCalls()).toBe(0);
  });
  it.each([9999.6, 10000])("budget exhausted after committed ALLOW at %s never executes or produces a contradictory denial", async elapsed => {
    const w = withGateway(); const bound = await w.submitterFor(alice); let time = 0;
    const timer = { now: () => time, setTimeout: () => 0, clearTimeout: () => {} };
    const { stages, auditor } = assemble({ ...w.deps, audit: { append: async (e, o) => { await w.deps.audit.append(e, o); if (e.type === "AI_ACTION_ALLOWED") time = elapsed; } } });
    const result = await createPipeline(stages, { timer, audit: auditor }).evaluate({ context: bound.context, run: bound.run, decisionId: "budget", requestId: "budget" as never, readProposal: () => w.proposal("testSafeEcho") });
    expect(result.decision.outcome).toBe("ALLOWED"); expect(result.executionStatus).toBe("failure");
    expect(w.executorCalls()).toBe(0);
    expect(types(w)).toEqual(["AI_ACTION_PROPOSED", "AI_ACTION_ALLOWED"]);
  });
  it.each([false, true])("bounded completion with hung result append, executor hangs=%s", async hangs => {
    vi.useFakeTimers();
    try {
      const w = withGateway({ config: { ...WIDE_GATEWAY_CONFIG, hookTimeoutMs: 40, proposalBudgetMs: 120 }, auditSink: { append: e => e.type === "AI_ACTION_EXECUTED" ? new Promise(() => {}) : Promise.resolve() } });
      if (hangs) w.executor("testSafeEcho").onRun(() => new Promise(() => {}));
      const pending = w.submit(alice, w.proposal("testSafeEcho"));
      await vi.advanceTimersByTimeAsync(1000);
      expect(await pending).toEqual({ outcome: "ALLOWED", category: hangs ? "try_later" : "ok" });
      expect(w.executorCalls()).toBe(1);
      expect(types(w)).toEqual(["AI_ACTION_PROPOSED", "AI_ACTION_ALLOWED"]);
    } finally { vi.useRealTimers(); }
  });
  it.each(["throws", "hangs", "malformed"])("a known successful execution remains success after outer stage %s", async mode => {
    vi.useFakeTimers();
    try {
      const w = withGateway(); const bound = await w.submitterFor(alice);
      const { stages, auditor } = assemble(w.deps);
      const execute = stages.execute!;
      stages.execute = async request => {
        await execute(request);
        if (mode === "throws") throw new Error("post-execution fault");
        if (mode === "hangs") return new Promise(() => {});
        return {} as never;
      };
      const pending = createPipeline(stages, { audit: auditor }).evaluate({ context: bound.context, run: bound.run, decisionId: "outer", requestId: "outer" as never, readProposal: () => w.proposal("testSafeEcho") });
      await vi.advanceTimersByTimeAsync(20_000);
      const result = await pending;
      expect(result.decision.outcome).toBe("ALLOWED"); expect(result.executionStatus).toBe("success");
      expect(w.executorCalls()).toBe(1);
      expect(types(w)).toEqual(["AI_ACTION_PROPOSED", "AI_ACTION_ALLOWED", "AI_ACTION_EXECUTED"]);
    } finally { vi.useRealTimers(); }
  });
  it("a binding lost after ALLOW fails closed without minting an executable call or denying policy", async () => {
    const w = withGateway(); let committed = false;
    expect(await submit(w, {
      audit: { append: async (e, o) => { await w.deps.audit.append(e, o); if (e.type === "AI_ACTION_ALLOWED") committed = true; } },
      executors: { executorFor: id => committed ? undefined : w.deps.executors.executorFor(id) },
    })).toEqual({ outcome: "ALLOWED", category: "try_later" });
    expect(w.executorCalls()).toBe(0); expect(types(w)).toEqual(["AI_ACTION_PROPOSED", "AI_ACTION_ALLOWED"]);
  });
});
