import { afterEach, describe, expect, it, vi } from "vitest";
import { PIPELINE_STAGES } from "@dap/contracts";
import type { GatewayDependencies, PolicyDecision } from "@dap/contracts";
import { mintExecutionGrant } from "@dap/contracts/mint";
import { createPipeline, type PolicyStage } from "./pipeline.js";
import { createPolicyGateway } from "./create-gateway.js";
import { allowedDecision, denyDecision } from "./decision.js";
import { context, dependencies, input, stageMap } from "./fixtures.test-support.js";

afterEach(() => { vi.useRealTimers(); });

describe("pipeline fail-closed boundary (T058)", () => {
  for (const stage of PIPELINE_STAGES) {
    it.each(["throw", "reject", "undefined", "wrong shape", "getter", "timeout"])(`${stage}: %s denies before execution`, async (fault) => {
      vi.useFakeTimers();
      let executions = 0;
      const stages = stageMap(() => { executions++; throw new Error("terminal should not run"); });
      const broken = (() => {
        if (fault === "throw") throw new Error("CANARY_SECRET");
        if (fault === "reject") return Promise.reject(new Error("CANARY_SECRET"));
        if (fault === "timeout") return new Promise(() => {});
        if (fault === "getter") return { get kind() { throw new Error("CANARY_SECRET"); } };
        return fault === "undefined" ? undefined : { kind: "continue", data: { value: () => true } };
      }) as PolicyStage;
      stages[stage] = broken;
      const pending = createPipeline(stages, { hookTimeoutMs: 20 }).run(input());
      await vi.advanceTimersByTimeAsync(20);
      const decision = await pending;
      expect(decision).toMatchObject({ outcome: "DENIED", reason: ["throw", "reject"].includes(fault) ? "internal_error" : "dependency_failure", stage });
      expect(executions).toBe(0);
      expect(JSON.stringify(decision)).not.toContain("CANARY");
    });
  }

  it.each(PIPELINE_STAGES.filter((name) => name !== "execute"))("%s cannot short-circuit to ALLOWED", async (stage) => {
    let executions = 0;
    const stages = stageMap(() => { executions++; throw new Error("unreachable"); });
    stages[stage] = (request) => ({ kind: "stop", decision: allowedDecision({ decisionId: request.decisionId, requestId: request.requestId, actionId: "viewProject" as never, risk: "SAFE", paramsDigest: "a".repeat(64) as never }) });
    const decision = await createPipeline(stages).run(input());
    expect(decision).toMatchObject({ outcome: "DENIED", reason: "dependency_failure", stage });
    expect(executions).toBe(0);
  });

  it.each(PIPELINE_STAGES)("a missing %s denies before terminal execution", async (missing) => {
    let executions = 0;
    const stages = stageMap(() => { executions++; throw new Error("unreachable"); });
    delete stages[missing];
    expect(await createPipeline(stages).run(input())).toMatchObject({ outcome: "DENIED", reason: "dependency_failure", stage: missing });
    expect(executions).toBe(0);
  });

  it.each([null, {}, { outcome: "ALLOWED" }, { outcome: "DENIED", reason: "allowed" }])("rejects malformed decision %j", async (decision) => {
    let executions = 0;
    const stages = stageMap(() => { executions++; throw new Error("unreachable"); });
    stages.authorize = () => ({ kind: "stop", decision: decision as PolicyDecision });
    expect(await createPipeline(stages).run(input())).toMatchObject({ outcome: "DENIED", reason: "dependency_failure" });
    expect(executions).toBe(0);
  });

  const missing = ["registry", "registry.get", "registry.list", "registry.isReservedForbidden", "registry.fingerprint", "executors", "executors.executorFor", "globalAllowlist", "hooks", "hooks.permissions", "hooks.permissions.has", "hooks.resources", "hooks.resources.resolve", "hooks.pages", "hooks.pages.currentPage", "state", "state.replay", "state.replay.claim", "state.rateLimiter", "state.rateLimiter.hit", "state.rateLimiter.isBlocked", "state.rateLimiter.block", "state.confirmations", "state.confirmations.create", "state.confirmations.get", "state.confirmations.listPending", "state.confirmations.tryAccept", "state.confirmations.tryReject", "state.confirmations.invalidate", "state.confirmations.recordExecution", "state.tenantPolicy", "state.tenantPolicy.isDisabled", "state.ping", "audit", "audit.append", "confirmationChannel", "confirmationChannel.deliver", "config", "clock", "clock.now", "ids", "ids.newDecisionId", "ids.newConfirmationId", "config.limits", "config.maxPayloadBytes", "config.maxJsonDepth", "config.replayRetentionSeconds", "config.confirmationDefaultTtlSeconds", "config.hookTimeoutMs", "config.limits.proposalsPerTurn", "config.limits.executionsPerTurn", "config.limits.maxChainDepth", "config.limits.turnBudgetMs", "config.limits.perUserPerMinute", "config.limits.perTenantPerMinute", "config.limits.perUserPerCapabilityPerMinute", "config.limits.highRiskPerUserPerHour", "config.limits.denialThrottle"];
  it.each(missing)("gateway rejects missing dependency %s at construction", (path) => {
    const { deps, calls } = dependencies();
    const keys = path.split(".");
    let parent = deps as unknown as Record<string, unknown>;
    for (const key of keys.slice(0, -1)) {
      const child = { ...(parent[key] as object) };
      parent[key] = child;
      parent = child;
    }
    delete parent[keys.at(-1)!];
    expect(() => createPolicyGateway(deps as GatewayDependencies)).toThrow();
    expect(calls()).toBe(0);
  });

  it("preserves the first denial and never runs a later stage", async () => {
    let executions = 0;
    const expected = denyDecision({ decisionId: "decision-request", requestId: "request" as never, outcome: "UNAUTHORIZED", reason: "permission_missing", stage: "authorize" });
    const stages = stageMap(() => { executions++; throw new Error("unreachable"); });
    stages.authorize = () => ({ kind: "stop", decision: expected });
    expect(await createPipeline(stages).run(input())).toEqual(expected);
    expect(executions).toBe(0);
  });

  it("uses a real guarded executor whose counter does change for a valid grant", async () => {
    const { deps, definition, calls } = dependencies();
    const security = context();
    const binding = { requestId: "request" as never, actionId: definition.id, paramsDigest: "a".repeat(64) as never, tenantId: security.tenantId, userId: security.userId };
    const executor = deps.executors.executorFor(definition.executorId)!;
    expect(await executor.execute({ ...binding, security, grant: mintExecutionGrant(binding), params: {}, resource: null })).toEqual({ status: "success" });
    expect(calls()).toBe(1);
  });
});
