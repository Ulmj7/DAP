/**
 * The reference host's demo ports (T131): the trusted facts the Gateway asks the host for. Minimum explicit demo behavior, not a framework.
 * Every answer is derived from the trusted AuthorizationContext (and the host's own configuration). Nothing here reads a proposal, a
 * parameter, or anything the model wrote as authority.
 */
import type { AuthorizationContext, PageContextProvider, PermissionChecker, PermissionId, ResolvedResource, ResourceAuthorizer, ResourceRef } from "@dap/contracts";
import type { DevSession } from "./dev-auth/index.js";

/** What each session may do, from the dev-session table. Keyed by the trusted session id of the context. */
export function createPermissionChecker(sessions: readonly DevSession[]): PermissionChecker {
  const grants = new Map<string, ReadonlySet<string>>(sessions.map((session) => [session.sessionId, new Set(session.permissions)]));
  return Object.freeze({ has: async (ctx: AuthorizationContext, permission: PermissionId): Promise<boolean> => grants.get(ctx.sessionId)?.has(permission) === true });
}

/**
 * Notes are private to the tenant of the caller: a note reference resolves only inside the caller's OWN tenant (taken from the context)
 * and only for a session that holds the permission. A reference to anything else resolves to null, which is also what "not found" and
 * "another tenant's" look like to the Gateway.
 */
export function createResourceAuthorizer(sessions: readonly DevSession[]): ResourceAuthorizer {
  const permissions = createPermissionChecker(sessions);
  return Object.freeze({
    async resolve(ctx: AuthorizationContext, ref: ResourceRef, permission: PermissionId): Promise<ResolvedResource | null> {
      if (ref.type !== "note" || !(await permissions.has(ctx, permission))) return null;
      return { ref: { type: "note", id: ref.id }, tenantId: ctx.tenantId, displayName: `Note ${ref.id}` };
    },
  });
}

/** The demo has no page model: no page narrowing (the capabilities allow any page). */
export function createPageContextProvider(): PageContextProvider {
  return Object.freeze({ currentPage: async () => null });
}
