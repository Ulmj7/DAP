import { z } from "zod";
import type {
  ActionId, ActionRegistry, AuditSink, Clock, ConfirmationChannel, ConfirmationService, ConfirmationStore, ExecutorTable, GatewayConfig, GatewayDependencies,
  IdGenerator, PageContextProvider, PermissionChecker, PolicyGateway, RateLimiter, ReplayGuard, ResourceAuthorizer,
  SecurityStateStore, TenantActionPolicyStore,
} from "@dap/contracts";
import { snapshotAnswer } from "./answer-snapshot.js";
import { createPipeline, type StageMap } from "./pipeline.js";
import { createProposalGateway } from "./submitter.js";
import { createIntakeStage } from "./stages/intake.js";
import { createAuthorizeStage } from "./stages/authorize.js";
import { createValidateStage } from "./stages/validate.js";
import { createContextStage } from "./stages/context.js";
import { createResolveStage } from "./stages/resolve.js";

const positive = z.number().int().positive();
const rule = z.strictObject({ limit: positive, windowSeconds: positive });
const configSchema = z.strictObject({
  limits: z.strictObject({ proposalsPerTurn: positive, executionsPerTurn: positive, maxChainDepth: z.number().int().nonnegative(), turnBudgetMs: positive, perUserPerMinute: rule, perTenantPerMinute: rule, perUserPerCapabilityPerMinute: rule, highRiskPerUserPerHour: rule, denialThrottle: z.strictObject({ denials: positive, windowSeconds: positive, blockSeconds: positive }) }),
  maxPayloadBytes: positive, maxJsonDepth: positive, replayRetentionSeconds: positive, confirmationDefaultTtlSeconds: positive.max(900), hookTimeoutMs: positive.max(0x7fff_ffff), proposalBudgetMs: positive.max(0x7fff_ffff).optional(),
});

/**
 * Compile-time exhaustive method lists: a method added to (or removed from) a contract port
 * fails type-checking here instead of being silently dropped from the captured dependency.
 */
type Methods<T> = { readonly [K in keyof T]-?: true };
const registryMethods: Methods<Omit<ActionRegistry, "fingerprint">> = { get: true, list: true, isReservedForbidden: true };
const permissionMethods: Methods<PermissionChecker> = { has: true };
const resourceMethods: Methods<ResourceAuthorizer> = { resolve: true };
const pageMethods: Methods<PageContextProvider> = { currentPage: true };
const replayMethods: Methods<ReplayGuard> = { claim: true };
const rateLimiterMethods: Methods<RateLimiter> = { hit: true, isBlocked: true, block: true };
const confirmationStoreMethods: Methods<ConfirmationStore> = { create: true, get: true, listPending: true, tryAccept: true, tryReject: true, invalidate: true, recordExecution: true };
const tenantPolicyMethods: Methods<TenantActionPolicyStore> = { isDisabled: true };
const stateMethods: Methods<Pick<SecurityStateStore, "ping">> = { ping: true };
const executorMethods: Methods<ExecutorTable> = { executorFor: true };
const auditMethods: Methods<AuditSink> = { append: true };
const channelMethods: Methods<ConfirmationChannel> = { deliver: true };
const clockMethods: Methods<Clock> = { now: true };
const idMethods: Methods<IdGenerator> = { newDecisionId: true, newConfirmationId: true };

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
  const port = <T extends object>(parent: unknown, key: string, methods: Methods<T>): T => {
    const object = read(parent, key);
    const captured = Object.create(null) as Record<string, unknown>;
    for (const method of Object.keys(methods)) {
      const fn = read(object, method);
      if (typeof fn !== "function") throw new TypeError("Missing gateway dependency");
      captured[method] = Object.freeze((...args: unknown[]) => Reflect.apply(fn, object, args));
    }
    return Object.freeze(captured) as T;
  };
  try {
    const hooks = read(source, "hooks");
    const state = read(source, "state");
    const registrySource = read(source, "registry");
    const fingerprint = read(registrySource, "fingerprint");
    if (typeof fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(fingerprint)) throw new TypeError("Invalid registry");
    const registry: ActionRegistry = Object.freeze({ ...port<Omit<ActionRegistry, "fingerprint">>(source, "registry", registryMethods), fingerprint: fingerprint as ActionRegistry["fingerprint"] });
    const global = read(source, "globalAllowlist");
    if (!global || typeof global !== "object") throw new TypeError("Missing gateway dependency");
    const globalAllowlist: ReadonlySet<ActionId> = new Set(global as ReadonlySet<ActionId>);
    const config = snapshotAnswer(read(source, "config"));
    if (!configSchema.safeParse(config).success) throw new TypeError("Invalid gateway config");
    return Object.freeze({
      registry, globalAllowlist, config: config as GatewayConfig,
      executors: port<ExecutorTable>(source, "executors", executorMethods),
      hooks: Object.freeze({ permissions: port<PermissionChecker>(hooks, "permissions", permissionMethods), resources: port<ResourceAuthorizer>(hooks, "resources", resourceMethods), pages: port<PageContextProvider>(hooks, "pages", pageMethods) }),
      state: Object.freeze({
        ...port<Pick<SecurityStateStore, "ping">>(source, "state", stateMethods),
        replay: port<ReplayGuard>(state, "replay", replayMethods), rateLimiter: port<RateLimiter>(state, "rateLimiter", rateLimiterMethods),
        confirmations: port<ConfirmationStore>(state, "confirmations", confirmationStoreMethods), tenantPolicy: port<TenantActionPolicyStore>(state, "tenantPolicy", tenantPolicyMethods),
      }),
      audit: port<AuditSink>(source, "audit", auditMethods), confirmationChannel: port<ConfirmationChannel>(source, "confirmationChannel", channelMethods),
      clock: port<Clock>(source, "clock", clockMethods), ids: port<IdGenerator>(source, "ids", idMethods),
    });
  } catch { throw new TypeError("Missing or invalid gateway dependency"); }
}

/**
 * The D6 stages implemented so far, bound to the captured dependencies. Positions not listed stay absent, and the
 * pipeline denies fail-closed at the first absent one. Exported for tests only; not part of the package surface.
 */
export function composeStages(deps: GatewayDependencies): StageMap {
  const options = { hookTimeoutMs: deps.config.hookTimeoutMs };
  const caps = { maxPayloadBytes: deps.config.maxPayloadBytes, maxJsonDepth: deps.config.maxJsonDepth };
  return {
    context: createContextStage(deps.clock, options),
    intake: createIntakeStage(caps),
    resolve: createResolveStage({ registry: deps.registry, globalAllowlist: deps.globalAllowlist, tenantPolicy: deps.state.tenantPolicy }, options),
    validate: createValidateStage(deps.registry, caps),
    authorize: createAuthorizeStage({ registry: deps.registry, permissions: deps.hooks.permissions, resources: deps.hooks.resources, pages: deps.hooks.pages, clock: deps.clock }, options),
  };
}

export function createPolicyGateway(source: GatewayDependencies): Readonly<{ proposals: PolicyGateway; confirmations: ConfirmationService }> {
  const deps = captureDependencies(source);
  const pipeline = createPipeline(composeStages(deps), { hookTimeoutMs: deps.config.hookTimeoutMs, ...(deps.config.proposalBudgetMs === undefined ? {} : { proposalBudgetMs: deps.config.proposalBudgetMs }) });
  const proposals = createProposalGateway({ pipeline, ids: deps.ids });
  const confirmations: ConfirmationService = Object.freeze({
    decide: Object.freeze(async () => Object.freeze({ status: "not_valid", category: "not_found" } as const)),
    listPending: Object.freeze(async () => Object.freeze([])),
  });
  return Object.freeze({ proposals, confirmations });
}
