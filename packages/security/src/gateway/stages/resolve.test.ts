import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActionId, GatewayDependencies, TenantActionPolicyStore } from "@dap/contracts";
import { buildRegistry } from "../../registry/build-registry.js";
import { createResolveStage } from "./resolve.js";
import { createPipeline } from "../pipeline.js";
import { allowedDecision } from "../decision.js";
import { dependencies, input, stageMap } from "../fixtures.test-support.js";

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
});
