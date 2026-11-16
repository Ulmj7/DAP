/** T131: the demo ports answer from the trusted context and the host's own table, never from what a proposal says. */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { AuthorizationContext, Clock, IsoInstant, PermissionId, PlannerRunMeta } from "@dap/contracts";
import { createSecurityContextFactory } from "@dap/security";
import { createDevAuthentication, parseDevSessions } from "./dev-auth/index.js";
import { createPageContextProvider, createPermissionChecker, createResourceAuthorizer } from "./host-ports.js";

const TENANT = randomUUID();
const FUTURE = new Date(Date.now() + 3_600_000).toISOString();
const clock: Clock = { now: () => new Date().toISOString() as IsoInstant };
const sessions = parseDevSessions(JSON.stringify([
  { token: `tok-${randomUUID()}`, userId: "alice", tenantId: TENANT, sessionId: "s-alice", validUntil: FUTURE, permissions: ["perm.demo.save-note"] },
  { token: `tok-${randomUUID()}`, userId: "bob", tenantId: TENANT, sessionId: "s-bob", validUntil: FUTURE },
]));
const contextOf = async (index: number): Promise<AuthorizationContext> => {
  const context = await createSecurityContextFactory({ authentication: createDevAuthentication(sessions, clock), clock }).establish(sessions[index]!.token);
  if (context === null) throw new Error("no context");
  return context;
};
const SAVE = "perm.demo.save-note" as PermissionId;

describe("the permission checker", () => {
  it("answers only for the permissions the session's own table entry lists", async () => {
    const checker = createPermissionChecker(sessions);
    const [alice, bob] = [await contextOf(0), await contextOf(1)];
    expect(await checker.has(alice, SAVE)).toBe(true);
    expect(await checker.has(alice, "perm.demo.publish-note" as PermissionId)).toBe(false);
    expect(await checker.has(bob, SAVE)).toBe(false);
    expect(await checker.has(alice, "__proto__" as PermissionId)).toBe(false);
  });
});

describe("the resource authorizer", () => {
  it("resolves a note only inside the caller's own tenant, taken from the context, and only for a session holding the permission", async () => {
    const resources = createResourceAuthorizer(sessions);
    const [alice, bob] = [await contextOf(0), await contextOf(1)];
    expect(await resources.resolve(alice, { type: "note", id: "note-1" }, SAVE)).toEqual({ ref: { type: "note", id: "note-1" }, tenantId: TENANT, displayName: "Note note-1" });
    expect(await resources.resolve(bob, { type: "note", id: "note-1" }, SAVE), "no permission, no resource").toBeNull();
    expect(await resources.resolve(alice, { type: "document", id: "note-1" }, SAVE), "another resource type").toBeNull();
  });
});

describe("the page provider", () => {
  it("reports no page: the demo has no page model, so there is nothing for a proposal to spoof", async () => {
    const run: PlannerRunMeta = { aiSessionId: "s", turnId: "t", model: "m", depth: 0, turnStartedAt: new Date().toISOString() as IsoInstant };
    expect(await createPageContextProvider().currentPage(await contextOf(0), run)).toBeNull();
  });
});
