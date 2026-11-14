import { z } from "zod";
import type { AuthorizationContext, ConfirmationService, GatewayConfig, GatewayDependencies, PlannerFeedback, PlannerRunMeta, PolicyGateway, ProposalCall, RequestId } from "@dap/contracts";
import { snapshotAnswer } from "./answer-snapshot.js";
import { toPlannerFeedback } from "./feedback.js";
import { createPipeline } from "./pipeline.js";
import { createContextStage } from "./stages/context.js";
import { createResolveStage } from "./stages/resolve.js";

const positive = z.number().int().positive();
const rule = z.strictObject({ limit: positive, windowSeconds: positive });
const configSchema = z.strictObject({
  limits: z.strictObject({ proposalsPerTurn: positive, executionsPerTurn: positive, maxChainDepth: z.number().int().nonnegative(), turnBudgetMs: positive, perUserPerMinute: rule, perTenantPerMinute: rule, perUserPerCapabilityPerMinute: rule, highRiskPerUserPerHour: rule, denialThrottle: z.strictObject({ denials: positive, windowSeconds: positive, blockSeconds: positive }) }),
  maxPayloadBytes: positive, maxJsonDepth: positive, replayRetentionSeconds: positive, confirmationDefaultTtlSeconds: positive.max(900), hookTimeoutMs: positive.max(0x7fff_ffff),
});
const unavailable: PlannerFeedback = Object.freeze({ outcome: "DENIED", category: "try_later" });

/** Capture the dependency graph once; method receivers remain the host's own port objects. */
function captureDependencies(source: GatewayDependencies): GatewayDependencies {
  const reads = new WeakMap<object, Map<string, unknown>>();
  const read = (parent: unknown, key: string): unknown => {
    if (!parent || typeof parent !== "object") throw new TypeError("Missing gateway dependency");
    let cached = reads.get(parent);
    if (!cached) { cached = new Map(); reads.set(parent, cached); }
    if (!cached.has(key)) cached.set(key, Reflect.get(parent, key));
    return cached.get(key);
  };
  const port = (parent: unknown, key: string, methods: readonly string[]): object => {
    const object = read(parent, key);
    const captured = Object.create(null) as Record<string, unknown>;
    for (const method of methods) {
      const fn = read(object, method);
      if (typeof fn !== "function") throw new TypeError("Missing gateway dependency");
      captured[method] = Object.freeze((...args: unknown[]) => Reflect.apply(fn, object, args));
    }
    return Object.freeze(captured);
  };
  try {
    const hooks = read(source, "hooks");
    const state = read(source, "state");
    const registrySource = read(source, "registry");
    const fingerprint = read(registrySource, "fingerprint");
    if (typeof fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(fingerprint)) throw new TypeError("Invalid registry");
    const registry = Object.freeze({ ...port(source, "registry", ["get", "list", "isReservedForbidden"]), fingerprint });
    const global = read(source, "globalAllowlist");
    if (!global || typeof global !== "object") throw new TypeError("Missing gateway dependency");
    const globalAllowlist = new Set(global as GatewayDependencies["globalAllowlist"]);
    const config = snapshotAnswer(read(source, "config"));
    if (!configSchema.safeParse(config).success) throw new TypeError("Invalid gateway config");
    return Object.freeze({
      registry, globalAllowlist, config: config as GatewayConfig,
      executors: port(source, "executors", ["executorFor"]),
      hooks: Object.freeze({ permissions: port(hooks, "permissions", ["has"]), resources: port(hooks, "resources", ["resolve"]), pages: port(hooks, "pages", ["currentPage"]) }),
      state: Object.freeze({ ...port(source, "state", ["ping"]), replay: port(state, "replay", ["claim"]), rateLimiter: port(state, "rateLimiter", ["hit", "isBlocked", "block"]), confirmations: port(state, "confirmations", ["create", "get", "listPending", "tryAccept", "tryReject", "invalidate", "recordExecution"]), tenantPolicy: port(state, "tenantPolicy", ["isDisabled"]) }),
      audit: port(source, "audit", ["append"]), confirmationChannel: port(source, "confirmationChannel", ["deliver"]), clock: port(source, "clock", ["now"]), ids: port(source, "ids", ["newDecisionId", "newConfirmationId"]),
    }) as unknown as GatewayDependencies;
  } catch { throw new TypeError("Missing or invalid gateway dependency"); }
}

export function createPolicyGateway(source: GatewayDependencies): Readonly<{ proposals: PolicyGateway; confirmations: ConfirmationService }> {
  const deps = captureDependencies(source);
  const options = { hookTimeoutMs: deps.config.hookTimeoutMs };
  const pipeline = createPipeline({
    context: createContextStage(deps.clock, options),
    resolve: createResolveStage({ registry: deps.registry, globalAllowlist: deps.globalAllowlist, tenantPolicy: deps.state.tenantPolicy }, options),
    // Unimplemented D6 positions remain absent and therefore deny before later hooks run.
  }, options);
  const proposals: PolicyGateway = Object.freeze({ forSession: Object.freeze((context: AuthorizationContext, run: PlannerRunMeta) => {
    let capturedRun: unknown;
    try { capturedRun = snapshotAnswer(run); } catch { capturedRun = null; }
    return Object.freeze({ submit: Object.freeze(async (call: ProposalCall): Promise<PlannerFeedback> => {
      try {
        const decisionId: unknown = deps.ids.newDecisionId();
        if (typeof decisionId !== "string" || !decisionId) {
          // A broken synchronous port may return a rejecting promise; consume its rejection.
          void Promise.resolve(decisionId).catch(() => {});
          return unavailable;
        }
        const decision = await pipeline.run({ context, run: capturedRun as Parameters<PolicyGateway["forSession"]>[1], decisionId, requestId: decisionId as RequestId, readProposal: () => call });
        return toPlannerFeedback(decision);
      } catch { return unavailable; }
    }) });
  }) });
  const confirmations: ConfirmationService = Object.freeze({
    decide: Object.freeze(async () => Object.freeze({ status: "not_valid", category: "not_found" } as const)),
    listPending: Object.freeze(async () => Object.freeze([])),
  });
  return Object.freeze({ proposals, confirmations });
}
