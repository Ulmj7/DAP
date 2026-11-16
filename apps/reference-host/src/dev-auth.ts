import { createHash } from "node:crypto";
import type { AuthenticationPort, AuthorizationContext, PermissionChecker } from "@dap/contracts";
import type { DevSession } from "./config.js";

const digest = (token: string): string => createHash("sha256").update(token).digest("hex");

export function createDevAuth(sessions: readonly DevSession[]): {
  authentication: AuthenticationPort<string | undefined>;
  permissions: PermissionChecker;
} {
  const byToken = new Map(sessions.map((session) => [digest(session.token), session]));
  const key = (ctx: { readonly tenantId: string; readonly userId: string; readonly sessionId: string }): string => JSON.stringify([ctx.tenantId, ctx.userId, ctx.sessionId]);
  const byPrincipal = new Map(sessions.map((session) => [key(session), session]));
  return {
    authentication: {
      async authenticate(header) {
        if (typeof header !== "string" || header.length > 263 || !/^Bearer [A-Za-z0-9_-]{32,256}$/.test(header)) return null;
        const session = byToken.get(digest(header.slice(7)));
        if (!session) return null;
        const { userId, tenantId, sessionId, authenticatedAt, validUntil } = session;
        return { userId, tenantId, sessionId, authenticatedAt, validUntil };
      },
    },
    permissions: {
      async has(ctx: AuthorizationContext, permission) {
        const session = byPrincipal.get(key(ctx));
        const now = Date.now();
        return session !== undefined && Date.parse(session.authenticatedAt) <= now && Date.parse(session.validUntil) > now &&
          session.permissions.some((allowed) => allowed === permission);
      },
    },
  };
}
