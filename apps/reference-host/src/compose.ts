/**
 * The reference host's composition root (T131): the ONE place the pieces are wired together.
 *
 *   dev session token -> trusted AuthorizationContext (dev-auth + the security context factory)
 *     -> AI-facing session (`submit` only) -> the real Policy Gateway (rate/replay, resolve, validate, authorize, risk, confirmation
 *     placeholder, execution cap, durable ALLOWED audit in PostgreSQL) -> trusted executor -> EXECUTED audit.
 *
 * It is NOT an application platform and NOT a production authentication system. It builds, from the production packages only (never the
 * testkit): the Action Registry and executor bindings, the PostgreSQL audit/replay/rate-limit/tenant-policy stores, the host's demo
 * permission/resource/page ports, a trusted clock and id generator, and the Gateway. `loadConfig` validates the environment first, so a
 * missing or malformed value (or development authentication in production) fails startup before anything is created.
 *
 * What the AI layer gets (`AiSession`): ONE function, `submit(rawToolCall)`. It does not get the registry, the executors, the stores or pool,
 * the audit reader, any mint API, the confirmation service, or the context it is bound to. The call id is assigned HERE (trusted runner,
 * research D11) from the session, the turn and the provider's id; identity and the page never come from the proposal.
 */
import { randomUUID } from "node:crypto";
import type { AuditEvent, Clock, ConfirmationChannel, ConfirmationId, GatewayDependencies, IdGenerator, IsoInstant, PlannerFeedback, PlannerRunMeta, SecurityStateStore } from "@dap/contracts";
import { toProposalCall } from "@dap/ai";
import type { RawToolCall } from "@dap/ai";
import {
  PostgresAuditStore, PostgresRateLimiter, PostgresReplayGuard, PostgresTenantActionPolicyStore, bindExecutors, buildRegistry, createPolicyGateway,
  createPostgresPool, createSecurityContextFactory,
} from "@dap/security";
import { DEMO_DEFINITIONS, createDemoExecutors } from "./capabilities.js";
import type { TrustedHandle } from "./capabilities.js";
import { loadConfig } from "./config.js";
import type { Environment } from "./config.js";
import { createDevAuthentication } from "./dev-auth/index.js";
import { createPageContextProvider, createPermissionChecker, createResourceAuthorizer } from "./host-ports.js";

/** The ONLY thing the AI layer is given for one authenticated session. */
export interface AiSession {
  submit(call: RawToolCall): Promise<PlannerFeedback>;
}

/** The host side (transport/session layer). Not given to the AI layer. */
export interface ReferenceHost {
  /**
   * Turns session evidence (the token the host's transport received) into an `AiSession`, or `null` when there is no valid session.
   * Fails closed: an unknown, malformed, expired or missing session mints no context and yields nothing to submit through.
   */
  openSession(evidence: unknown): Promise<AiSession | null>;
  /** Releases the database pool. */
  close(): Promise<void>;
}

export interface ComposedHost {
  readonly host: ReferenceHost;
  /** The host's own view of its executors (call counts, what they received, effects). Never reachable from an `AiSession`. */
  readonly trusted: TrustedHandle;
}

const systemClock: Clock = Object.freeze({ now: (): IsoInstant => new Date().toISOString() as IsoInstant });
const systemIds: IdGenerator = Object.freeze({
  newDecisionId: (): string => `dec-${randomUUID()}`,
  newConfirmationId: (): ConfirmationId => randomUUID() as ConfirmationId,
});

/** The confirmation service does not exist yet (HIGH/CRITICAL capabilities stop at REQUIRES_CONFIRMATION). Every method rejects. */
const confirmationUnavailable = async (): Promise<never> => { throw new Error("The confirmation service is not built: this placeholder is fail-closed"); };
const confirmationStorePlaceholder: SecurityStateStore["confirmations"] = Object.freeze({
  create: confirmationUnavailable, get: confirmationUnavailable, listPending: confirmationUnavailable, tryAccept: confirmationUnavailable,
  tryReject: confirmationUnavailable, invalidate: confirmationUnavailable, recordExecution: confirmationUnavailable,
});
const confirmationChannelPlaceholder: ConfirmationChannel = Object.freeze({ deliver: confirmationUnavailable });

/** Validates `env` (throws on anything missing or malformed, before any connection is made) and assembles the host. */
export async function composeReferenceHost(env: Environment): Promise<ComposedHost> {
  const config = loadConfig(env);
  const registry = buildRegistry(DEMO_DEFINITIONS);
  const { executors, trusted } = createDemoExecutors();
  const executorTable = bindExecutors(registry, executors);
  const pool = createPostgresPool(config.databaseUrl);
  try {
    const clock = systemClock;
    const audit = new PostgresAuditStore(pool);
    const state: SecurityStateStore = Object.freeze({
      replay: new PostgresReplayGuard(pool),
      rateLimiter: new PostgresRateLimiter(pool),
      tenantPolicy: new PostgresTenantActionPolicyStore(pool),
      confirmations: confirmationStorePlaceholder,
      ping: async (): Promise<boolean> => { try { await pool.query("SELECT 1"); return true; } catch { return false; } },
    });
    const deps: GatewayDependencies = {
      registry,
      executors: executorTable,
      globalAllowlist: new Set(config.enabledActions as readonly never[]),
      hooks: { permissions: createPermissionChecker(config.devSessions), resources: createResourceAuthorizer(config.devSessions), pages: createPageContextProvider() },
      state,
      audit: { append: (event: AuditEvent, options) => audit.append(event, options) },
      confirmationChannel: confirmationChannelPlaceholder,
      config: config.gateway,
      clock,
      ids: systemIds,
    };
    const { proposals } = createPolicyGateway(deps);
    const contexts = createSecurityContextFactory({ authentication: createDevAuthentication(config.devSessions, clock), clock });

    const host: ReferenceHost = Object.freeze({
      async openSession(evidence: unknown): Promise<AiSession | null> {
        const context = await contexts.establish(evidence);
        if (context === null) return null;
        const run: PlannerRunMeta = Object.freeze({ aiSessionId: context.sessionId, turnId: randomUUID(), model: "reference-host", depth: 0, turnStartedAt: clock.now() });
        const bound = proposals.forSession(context, run);
        return Object.freeze({
          submit: Object.freeze(async (call: RawToolCall): Promise<PlannerFeedback> => {
            let providerCallId: unknown; let argumentsText: unknown;
            try {
              providerCallId = call.providerCallId;
              argumentsText = call.arguments;
            } catch { return bound.submit(toProposalCall("", "")); }
            // Do not coerce provider objects or let transport getters escape the generic Gateway feedback.
            if (typeof providerCallId !== "string" || !/^[\x21-\x7e]{1,256}$/.test(providerCallId)) return bound.submit(toProposalCall("", ""));
            return bound.submit(toProposalCall(`${run.aiSessionId}.${run.turnId}.${providerCallId}`, typeof argumentsText === "string" ? argumentsText : ""));
          }),
        });
      },
      close: async () => { await pool.end(); },
    });
    return Object.freeze({ host, trusted });
  } catch (error) {
    await pool.end();
    throw error;
  }
}
