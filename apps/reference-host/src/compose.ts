import { randomUUID } from "node:crypto";
import { z } from "zod";
import { createGuidanceExecutor, GUIDANCE_EXECUTOR_ID } from "@dap/actions";
import type { Guidance } from "@dap/actions";
import { defineAction } from "@dap/contracts";
import type { ActionId, ConfirmationId, ConfirmationStore, IsoInstant, PermissionId, SecurityStateStore } from "@dap/contracts";
import { toProposalCall } from "@dap/ai";
import {
  bindExecutors, buildRegistry, createEnablementPolicy, createPolicyGateway, createSecurityContextFactory,
  DEFAULT_GATEWAY_CONFIG, PostgresAuditStore, PostgresRateLimiter, PostgresReplayGuard, PostgresTenantActionPolicyStore,
} from "@dap/security";
import type { HostConfig } from "./config.js";
import { createDatabase } from "./database.js";
import { createDevAuth } from "./dev-auth.js";

const getGuidance = defineAction({
  id: "getGuidance" as ActionId, version: 1,
  description: "Read developer-authored product guidance for a registered topic.",
  inputSchema: z.strictObject({ topicId: z.string().min(1).max(64) }),
  risk: "SAFE", requiredPermission: "guidance:read" as PermissionId,
  allowedPages: "any", confirmation: { kind: "not-required" }, changesState: false,
  audit: { params: [{ path: "/topicId", mode: "plain" }] }, executorId: GUIDANCE_EXECUTOR_ID,
});

// No pending confirmation can exist. Accidental use stops execution.
const unsupported = async (): Promise<never> => { throw new Error("Confirmation is unavailable"); };
const confirmations: ConfirmationStore = {
  create: unsupported, get: unsupported, listPending: unsupported, tryAccept: unsupported,
  tryReject: unsupported, invalidate: unsupported, recordExecution: unsupported,
};

export function composeHost(config: HostConfig) {
  const registry = buildRegistry([getGuidance]);
  const db = createDatabase(config.databaseUrl);
  const auth = createDevAuth(config.sessions);
  const clock = { now: () => new Date().toISOString() as IsoInstant };
  const contexts = createSecurityContextFactory({ authentication: auth.authentication, clock });
  const state: SecurityStateStore = {
    replay: new PostgresReplayGuard(db.pool), rateLimiter: new PostgresRateLimiter(db.pool),
    tenantPolicy: new PostgresTenantActionPolicyStore(db.pool), confirmations, ping: db.ready,
  };
  createEnablementPolicy({ registry, globalAllowlist: config.globalAllowlist, tenantPolicy: state.tenantPolicy });
  const audit = new PostgresAuditStore(db.pool);

  async function guidance(header: string | undefined, topicId: string) {
    const context = await contexts.establish(header);
    if (!context) return { status: 401, body: { error: "unauthenticated" } };
    if (!await db.ready()) return { status: 503, body: { feedback: { outcome: "DENIED", category: "try_later" } } };
    // One closure per submission: concurrent or abandoned requests cannot share results.
    let guide: Guidance | undefined;
    let accepting = true;
    const executor = createGuidanceExecutor((value) => { if (accepting) guide = value; });
    try {
      const { proposals } = createPolicyGateway({
        registry, executors: bindExecutors(registry, [executor]), globalAllowlist: config.globalAllowlist,
        hooks: { permissions: auth.permissions, resources: { resolve: async () => null }, pages: { currentPage: async () => null } },
        state, audit, confirmationChannel: { deliver: unsupported }, config: DEFAULT_GATEWAY_CONFIG, clock,
        ids: { newDecisionId: randomUUID, newConfirmationId: () => randomUUID() as ConfirmationId },
      });
      const feedback = await proposals.forSession(context, {
        aiSessionId: context.sessionId, turnId: randomUUID(), model: "host-guidance", depth: 0, turnStartedAt: clock.now(),
      }).submit(toProposalCall(randomUUID(), JSON.stringify({ action: "getGuidance", params: { topicId } })));
      if (feedback.outcome === "ALLOWED" && feedback.category === "ok" && guide) {
        return { status: 200, body: { feedback, guide } };
      }
      return { status: feedback.category === "try_later" || feedback.outcome === "ALLOWED" ? 503 : 403, body: { feedback } };
    } finally { accepting = false; guide = undefined; }
  }
  return { guidance, authenticate: contexts.establish, ready: db.ready, close: () => db.pool.end() };
}
