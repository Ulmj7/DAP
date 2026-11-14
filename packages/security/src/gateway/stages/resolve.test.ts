import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActionId, GatewayDependencies, TenantActionPolicyStore } from "@dap/contracts";
import { buildRegistry } from "../../registry/build-registry.js";
import { createEnablementPolicy } from "../../registry/enablement.js";
import { createResolveStage } from "./resolve.js";
import { createPipeline } from "../pipeline.js";
import { allowedDecision } from "../decision.js";
import { context, dependencies, input, stageMap } from "../fixtures.test-support.js";

afterEach(() => { vi.useRealTimers(); });
function harness(overrides: Partial<Pick<GatewayDependencies, "registry" | "globalAllowlist">> = {}, store: TenantActionPolicyStore = { isDisabled: async () => false }) {
  const { deps } = dependencies();
  let executions = 0;
  const stages = stageMap((request) => { executions++; return { kind: "stop", decision: allowedDecision({ decisionId: request.decisionId, requestId: request.requestId, actionId: "viewProject" as never, risk: "SAFE", paramsDigest: "a".repeat(64) as never }) }; });
  const resolve = createResolveStage({ registry: deps.registry, globalAllowlist: deps.globalAllowlist, ...overrides, tenantPolicy: store }, { hookTimeoutMs: 20 });
  stages.resolve = resolve;
  return { calls: () => executions, async submit(action: string) {
    stages.intake = () => ({ kind: "continue", data: { callId: "call", action, params: {} } });
    return createPipeline(stages).run(input());
  } };
}
describe("exact resolution and live default-deny enablement", () => {
  it.each(["ViewProject", "viewproject", " viewProject", "viewProject ", "viewProject\u200b", "viеwProject", "__proto__", "constructor", "toString", "hasOwnProperty", "missingAction"])("%s never matches", async (name) => {
    const test = harness();
    expect(await test.submit(name)).toMatchObject({ outcome: "INVALID_ACTION", reason: "unknown_action" });
    expect(test.calls()).toBe(0);
  });
  it.each(["executeShell", "EXECUTE_SHELL", "execute-shell", "runQuery", "fetchUrl"])("%s is a reserved policy denial", async (name) => {
    const test = harness();
    expect(await test.submit(name)).toMatchObject({ outcome: "FORBIDDEN_POLICY", reason: "reserved_forbidden_action" });
    expect(test.calls()).toBe(0);
  });
  it("requires the global allowlist before consulting the tenant", async () => {
    let reads = 0;
    const test = harness({ globalAllowlist: new Set() }, { isDisabled: async () => { reads++; return false; } });
    expect(await test.submit("viewProject")).toMatchObject({ outcome: "DENIED", reason: "action_not_enabled" });
    expect(reads).toBe(0);
    expect(test.calls()).toBe(0);
  });
  it("rechecks tenant policy on every request, passing only minted tenant and exact id", async () => {
    let disabled = true;
    const seen: unknown[] = [];
    const test = harness({}, { isDisabled: async (scope, id) => { seen.push([scope, id]); expect(Object.isFrozen(scope)).toBe(true); return disabled; } });
    expect(await test.submit("viewProject")).toMatchObject({ outcome: "DENIED", reason: "tenant_action_disabled" });
    expect(test.calls()).toBe(0);
    disabled = false;
    expect((await test.submit("viewProject")).outcome).toBe("ALLOWED");
    expect(test.calls()).toBe(1);
    expect(seen).toEqual([[{ tenantId: input().context && (input().context as { tenantId: string }).tenantId }, "viewProject"], [{ tenantId: (input().context as { tenantId: string }).tenantId }, "viewProject"]]);
  });
  it.each([undefined, null, 0, "false", {}])("tenant malformed answer %j is dependency failure", async (answer) => {
    const test = harness({}, { isDisabled: async () => answer } as TenantActionPolicyStore);
    expect(await test.submit("viewProject")).toMatchObject({ outcome: "DENIED", reason: "dependency_failure" });
    expect(test.calls()).toBe(0);
  });
  it("contains tenant exceptions and timeouts", async () => {
    vi.useFakeTimers();
    for (const isDisabled of [async () => { throw new Error("CANARY"); }, () => new Promise<boolean>(() => {})]) {
      const test = harness({}, { isDisabled });
      const pending = test.submit("viewProject");
      await vi.advanceTimersByTimeAsync(20);
      expect(await pending).toMatchObject({ outcome: "DENIED", reason: "dependency_failure" });
      expect(test.calls()).toBe(0);
    }
  });
  it("never permits a FORBIDDEN registry entry", async () => {
    const { definition } = dependencies();
    const registry = buildRegistry([{ ...definition, id: "blockedAction" as ActionId, risk: "FORBIDDEN" }]);
    const test = harness({ registry, globalAllowlist: new Set() });
    expect(await test.submit("blockedAction")).toMatchObject({ outcome: "FORBIDDEN_POLICY", reason: "reserved_forbidden_action" });
    expect(test.calls()).toBe(0);
    expect(() => harness({ registry, globalAllowlist: new Set(["blockedAction" as ActionId]) })).toThrow();
  });

  it.each([{}, { action: 5 }, { action: null }, { action: ["viewProject"] }, { params: {} }])("an intake result without a string action (%j) is a dependency failure", async (facts) => {
    let tenantReads = 0;
    let executions = 0;
    const { deps } = dependencies();
    const stages = stageMap(() => { executions++; throw new Error("unreachable"); });
    stages.intake = () => ({ kind: "continue", data: facts as never });
    stages.resolve = createResolveStage({ registry: deps.registry, globalAllowlist: deps.globalAllowlist, tenantPolicy: { isDisabled: async () => { tenantReads++; return false; } } }, { hookTimeoutMs: 20 });
    expect(await createPipeline(stages).run(input())).toMatchObject({ outcome: "DENIED", reason: "dependency_failure", stage: "resolve" });
    expect(tenantReads).toBe(0);
    expect(executions).toBe(0);
  });

  it("denies when the request carries no minted context, without consulting the tenant", async () => {
    let reads = 0;
    const { deps } = dependencies();
    let executions = 0;
    const stages = stageMap(() => { executions++; throw new Error("unreachable"); });
    stages.context = () => ({ kind: "continue", data: {} });
    stages.intake = () => ({ kind: "continue", data: { action: "viewProject" } });
    stages.resolve = createResolveStage({ registry: deps.registry, globalAllowlist: deps.globalAllowlist, tenantPolicy: { isDisabled: async () => { reads++; return false; } } });
    expect(await createPipeline(stages).run({ ...input(), context: { ...context() } })).toMatchObject({ outcome: "DENIED", reason: "dependency_failure", stage: "resolve" });
    expect(reads).toBe(0);
    expect(executions).toBe(0);
  });

  it("truncates a very long attempted action name in the decision", async () => {
    const decision = await harness().submit("x".repeat(100_000));
    expect(decision).toMatchObject({ outcome: "INVALID_ACTION", reason: "unknown_action" });
    expect((decision as { attemptedAction: string }).attemptedAction).toHaveLength(64);
  });

  it("continues with only the registry facts later stages may trust", async () => {
    let facts: unknown;
    const { deps, definition } = dependencies();
    const stages = stageMap(() => { throw new Error("unreachable"); });
    stages.intake = () => ({ kind: "continue", data: { action: "viewProject", params: { a: 1 } } });
    stages.resolve = createResolveStage({ registry: deps.registry, globalAllowlist: deps.globalAllowlist, tenantPolicy: { isDisabled: async () => false } });
    stages.validate = (request) => { facts = request.facts.resolve; return { kind: "continue", data: {} }; };
    await createPipeline(stages).run(input());
    expect(facts).toEqual({ id: definition.id, version: 1, risk: "SAFE", definitionHash: deps.registry.get(definition.id)!.definitionHash });
  });

  it("snapshots the global allowlist at construction", async () => {
    const { deps, definition } = dependencies();
    const allowlist = new Set([definition.id]);
    const stage = createResolveStage({ registry: deps.registry, globalAllowlist: allowlist, tenantPolicy: { isDisabled: async () => false } });
    allowlist.clear();
    const stages = stageMap(() => { throw new Error("unreachable"); });
    stages.intake = () => ({ kind: "continue", data: { action: "viewProject" } });
    stages.resolve = stage;
    stages.validate = () => ({ kind: "stop", decision: allowedDecision({ decisionId: "decision-request", requestId: "request" as never, actionId: "viewProject" as never, risk: "SAFE", paramsDigest: "a".repeat(64) as never }) });
    expect(await createPipeline(stages).run(input())).toMatchObject({ outcome: "DENIED", reason: "dependency_failure", stage: "validate" });
  });

  // Resolve keeps richer denial reasons than the boolean enablement policy, but must never disagree on whether
  // an action is enabled: it continues exactly when createEnablementPolicy says so.
  describe.each([
    { allowlisted: true, tenant: false }, { allowlisted: true, tenant: true }, { allowlisted: false, tenant: false }, { allowlisted: true, tenant: "throw" },
    { allowlisted: true, tenant: undefined }, { allowlisted: true, tenant: "false" }, { allowlisted: false, tenant: true },
  ] as const)("agrees with the enablement policy for %j", ({ allowlisted, tenant }) => {
    it("allows or denies identically", async () => {
      const { deps, definition } = dependencies();
      const store = { isDisabled: async () => { if (tenant === "throw") throw new Error("down"); return tenant; } } as unknown as TenantActionPolicyStore;
      const globalAllowlist = new Set(allowlisted ? [definition.id] : []);
      const enabled = await createEnablementPolicy({ registry: deps.registry, globalAllowlist, tenantPolicy: store }).isEnabled({ tenantId: context().tenantId }, "viewProject").catch(() => false);
      let reached = false;
      const stages = stageMap(() => { throw new Error("unreachable"); });
      stages.intake = () => ({ kind: "continue", data: { action: "viewProject" } });
      stages.resolve = createResolveStage({ registry: deps.registry, globalAllowlist, tenantPolicy: store });
      stages.validate = () => { reached = true; return { kind: "continue", data: {} }; };
      const decision = await createPipeline(stages).run(input());
      expect(reached).toBe(enabled);
      expect(decision.outcome === "DENIED" && decision.stage === "resolve").toBe(!enabled);
      expect(enabled).toBe(allowlisted && tenant === false);
    });
  });
});
