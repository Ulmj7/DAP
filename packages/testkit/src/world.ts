/**
 * @dap/testkit: world.ts (T034)
 *
 * The prepared world for scenario tests: two tenants with the SAME user id strings
 * (alice/bob/carol) reused in both, two typed resources per tenant, and a minted
 * AuthorizationContext per (tenant, user) via @dap/contracts/mint, timestamped by a
 * FakeClock so the world is fully deterministic.
 */
import type {
  AuthorizationContext,
  ResolvedResource,
  SessionId,
  TenantId,
  UserId,
} from "@dap/contracts";
import { mintAuthorizationContext } from "@dap/contracts/mint";
import { FakeClock } from "./clock.js";
import { snapshotData } from "./snapshot.js";

/** Tenant A (fixed UUID constant). */
export const TENANT_A = "2b9f6c1a-5f2e-4e81-9c4d-1a2b3c4d5e6f" as TenantId;
/** Tenant B (fixed UUID constant). */
export const TENANT_B = "7d4a2e9b-8c13-4f72-a6b9-9e8d7c6b5a40" as TenantId;

/** The SAME user id strings are reused in both tenants (cross-tenant test material). */
export const ALICE = "alice" as UserId;
export const BOB = "bob" as UserId;
export const CAROL = "carol" as UserId;

/** Host-side role knowledge (AuthorizationContext itself never carries roles). */
export type UserRole = "admin" | "member" | "read-only";

export const USER_ROLES: readonly { readonly userId: UserId; readonly role: UserRole }[] = snapshotData([
  { userId: ALICE, role: "admin" },
  { userId: BOB, role: "member" },
  { userId: CAROL, role: "read-only" },
]);

/** Two typed resources in tenant A. */
export const TENANT_A_RESOURCES: readonly ResolvedResource[] = snapshotData([
  {
    ref: { type: "document", id: "doc-a-1" },
    tenantId: TENANT_A,
    displayName: "A: Quarterly report",
  },
  {
    ref: { type: "document", id: "doc-a-2" },
    tenantId: TENANT_A,
    displayName: "A: Onboarding guide",
  },
]);

/** Two typed resources in tenant B. */
export const TENANT_B_RESOURCES: readonly ResolvedResource[] = snapshotData([
  {
    ref: { type: "document", id: "doc-b-1" },
    tenantId: TENANT_B,
    displayName: "B: Sales pipeline",
  },
  {
    ref: { type: "document", id: "doc-b-2" },
    tenantId: TENANT_B,
    displayName: "B: Vendor list",
  },
]);

const clock = new FakeClock();
const TENANTS: readonly TenantId[] = [TENANT_A, TENANT_B];
const USERS: readonly UserId[] = [ALICE, BOB, CAROL];

function key(tenantId: TenantId, userId: UserId): string {
  return `${tenantId}\u0000${userId}`;
}

const mintedContexts = new Map<string, AuthorizationContext>();
for (const tenantId of TENANTS) {
  for (const userId of USERS) {
    const authenticatedAt = clock.now();
    clock.advance(3600);
    mintedContexts.set(
      key(tenantId, userId),
      mintAuthorizationContext({
        tenantId,
        userId,
        sessionId: `${tenantId}@${userId}` as SessionId,
        authenticatedAt,
        validUntil: clock.now(),
      }),
    );
  }
}

/**
 * The minted AuthorizationContext for one (tenant, user) pair.
 * @throws when the pair is not part of the prepared world.
 */
export function ctx(tenantId: TenantId, userId: UserId): AuthorizationContext {
  const found = mintedContexts.get(key(tenantId, userId));
  if (found === undefined) {
    throw new Error(`world: no minted context for tenant ${tenantId} / user ${userId}`);
  }
  return found;
}
