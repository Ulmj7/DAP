import { randomUUID } from "node:crypto";
import type { GatewayConfig, GatewayDependencies, ProposalCall, ReplayGuard, TenantId } from "@dap/contracts";
import { bindExecutors, buildRegistry, createPolicyGateway, createSecurityContextFactory, DEFAULT_GATEWAY_CONFIG, InMemoryRateLimiter, InMemoryReplayGuard, validateGatewayConfig } from "@dap/security";
import { ALL_TEST_CAPABILITIES, FakeClock, IdGenerator, InMemoryAuditSink, RecordingExecutor } from "@dap/testkit";
import type { Actor, LimiterFault, SequenceTarget } from "../../packages/testkit/src/attacks/sequence-scenario.js";

/** REAL gateway through stage 6. No risk/confirmation/audit-allow/execute replacement is installed. */
export function gatewaySequence(options: { config?: GatewayConfig; replay?: ReplayGuard } = {}) {
  const clock = new FakeClock("2099-01-01T00:00:00Z");
  const tenants = { A: randomUUID() as TenantId, B: randomUUID() as TenantId };
  const config = validateGatewayConfig(options.config ?? DEFAULT_GATEWAY_CONFIG);
  const registry = buildRegistry(ALL_TEST_CAPABILITIES);
  const executors = ALL_TEST_CAPABILITIES.filter((definition) => definition.risk !== "FORBIDDEN").map((definition) => new RecordingExecutor({ id: definition.executorId, result: { status: "success" } }));
  const replay = options.replay ?? new InMemoryReplayGuard(clock);
  const rate = new InMemoryRateLimiter(clock);
  const audit = new InMemoryAuditSink(); const ids = new IdGenerator(117);
  const claims: { tenantId: string; key: string; answer: string }[] = [];
  let shared = 0; let permissions = 0; let fault: LimiterFault | null = null;
  const stateRate = {
    async hit(...args: Parameters<typeof rate.hit>) {
      shared++;
      if (fault === "throws" || fault === "full_store") throw new Error(fault === "full_store" ? "capacity exhausted" : "state down");
      if (fault === "hangs") return new Promise<never>(() => {});
      if (fault === "wrong_type") return "yes" as never;
      return rate.hit(...args);
    },
    async isBlocked(...args: Parameters<typeof rate.isBlocked>) {
      shared++;
      if (fault === "throws" || fault === "full_store") throw new Error("capacity exhausted");
      if (fault === "hangs") return new Promise<never>(() => {});
      if (fault === "wrong_type") return "yes" as never;
      return rate.isBlocked(...args);
    },
    async block(...args: Parameters<typeof rate.block>) { shared++; return rate.block(...args); },
  };
  const absent = async (): Promise<never> => { throw new Error("stage beyond current implementation"); };
  const deps: GatewayDependencies = {
    registry, globalAllowlist: new Set(ALL_TEST_CAPABILITIES.filter((definition) => definition.risk !== "FORBIDDEN").map((definition) => definition.id)),
    executors: bindExecutors(registry, executors.map((recording) => recording.executor)),
    hooks: { permissions: { has: async () => { permissions++; return true; } }, pages: { currentPage: async () => "test-page" as never }, resources: { resolve: async (security, ref) => ({ tenantId: security.tenantId, ref, displayName: "Authorized fixture resource" }) } },
    state: { replay: { async claim(scope, key, seconds) { shared++; const answer = await replay.claim(scope, key, seconds); claims.push({ tenantId: scope.tenantId, key, answer }); return answer; } }, rateLimiter: stateRate, tenantPolicy: { isDisabled: async () => false }, confirmations: { create: absent, get: absent, listPending: absent, tryAccept: absent, tryReject: absent, invalidate: absent, recordExecution: absent }, ping: async () => true },
    audit, confirmationChannel: { deliver: absent }, ids, clock, config,
  };
  const gateways = new Map<number, ReturnType<typeof createPolicyGateway>>();
  const starts = new Map<string, ReturnType<typeof clock.now>>();
  const contexts = new Map<string, Awaited<ReturnType<ReturnType<typeof createSecurityContextFactory>["establish"]>>>();
  const target: SequenceTarget = {
    actionId: "testSafeEcho", risk: "SAFE", targetsResource: false, changesState: false, requiresConfirmation: false,
    executor: { get calls() { return executors.reduce((total, recording) => total + recording.calls, 0); } }, audit, visibleOutput: null,
    get sharedStoreCalls() { return shared; },
    async submitAs(actor: Actor, call: ProposalCall) {
      let gateway = gateways.get(actor.instance);
      if (!gateway) { gateway = createPolicyGateway(deps); gateways.set(actor.instance, gateway); }
      const contextKey = JSON.stringify([actor.tenant, actor.user, actor.session]);
      let context = contexts.get(contextKey);
      if (!context) {
        context = await createSecurityContextFactory({ authentication: { authenticate: async () => ({ userId: actor.user, tenantId: tenants[actor.tenant], sessionId: actor.session, authenticatedAt: "2099-01-01T00:00:00Z" as never, validUntil: "2100-01-01T00:00:00Z" as never }) }, clock }).establish(null);
        if (!context) throw new Error("Invalid actor fixture"); contexts.set(contextKey, context);
      }
      const turnKey = JSON.stringify([contextKey, actor.turn]);
      let started = starts.get(turnKey);
      if (!started) { started = clock.now(); starts.set(turnKey, started); }
      return gateway.proposals.forSession(context, { aiSessionId: actor.session, turnId: actor.turn, model: "scripted", depth: actor.depth, turnStartedAt: started }).submit(call);
    },
    async advanceSeconds(seconds) { clock.advance(seconds); },
    async injectLimiterFault(value) { fault = value; },
  };
  return { target, claims, tenants, clock, config, get permissions() { return permissions; }, restart(instance: number) { gateways.delete(instance); } };
}
