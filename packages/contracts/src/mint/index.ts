/**
 * @dap/contracts/mint — the trusted minting runtime (research D5).
 *
 * The ONLY way to produce a recognized `AuthorizationContext` or `ExecutionGrant`. Both are
 * tracked in module-private structures (a WeakSet of contexts here; a WeakMap of grants in the
 * contracts execution runtime) that no other module can reach, so a plain data literal with the
 * same fields, a spread copy, or a fabricated object fails verification.
 *
 * This subpath is importable ONLY by @dap/security and @dap/testkit (enforced by lint,
 * ATK-ARCH-05). Production code in @dap/actions and the AI layer must not import it — they
 * receive a pre-minted grant only through a Gateway-approved ExecutionCall.
 *
 * Fail-closed: every check below rejects on anything it cannot prove to be minted and valid.
 */
import type { AuthorizationContext, AuthenticatedPrincipal } from "../security-context.js";
import type { ExecutionGrant } from "../execution.js";
import { grantRecord, registerGrant, type GrantBinding } from "../execution-runtime.js";

/**
 * The full grant binding: bound to (requestId, actionId, paramsDigest, tenantId, userId),
 * single-use. Re-exported so @dap/security can name it. `tenantId` is validated as a UUID by
 * the caller (@dap/security), not here.
 */
export type { GrantBinding } from "../execution-runtime.js";

// Module-private registry of minted contexts. Nothing is exported, so no caller can add,
// remove, or clear entries.
const mintedContexts = new WeakSet<AuthorizationContext>();

/**
 * Mint an AuthorizationContext from a strictly-validated principal. The returned object is
 * recognized ONLY by identity via `isMintedContext`; a structurally identical literal is not.
 */
export function mintAuthorizationContext(principal: AuthenticatedPrincipal): AuthorizationContext {
  const ctx = {
    userId: principal.userId,
    tenantId: principal.tenantId,
    sessionId: principal.sessionId,
    authenticatedAt: principal.authenticatedAt,
    validUntil: principal.validUntil,
  };
  mintedContexts.add(ctx as AuthorizationContext);
  return ctx as AuthorizationContext;
}

/**
 * Type guard. True ONLY for an object minted by `mintAuthorizationContext`. A plain literal
 * with the same fields, a spread copy, or any other object returns false.
 */
export function isMintedContext(ctx: unknown): ctx is AuthorizationContext {
  return typeof ctx === "object" && ctx !== null && mintedContexts.has(ctx as AuthorizationContext);
}

/**
 * Mint an ExecutionGrant bound to the 5-tuple. The grant is single-use: it can be consumed
 * exactly once, and only by a call whose binding matches all five fields.
 */
export function mintExecutionGrant(binding: GrantBinding): ExecutionGrant {
  return registerGrant(binding) as unknown as ExecutionGrant;
}

/**
 * Verify and consume a grant atomically.
 *
 * Returns true exactly once, and only if:
 *   - `grant` was minted by `mintExecutionGrant` (not a literal / copy), and
 *   - it has not been consumed yet, and
 *   - its stored binding matches `expected` on ALL FIVE fields (requestId, actionId,
 *     paramsDigest, tenantId, userId).
 *
 * Any mismatch (or a forged / already-used grant) returns false and does NOT consume the
 * grant, so a later call carrying the correct binding can still succeed.
 */
export function consumeExecutionGrant(grant: unknown, expected: GrantBinding): boolean {
  const record = grantRecord(grant);
  if (!record) return false; // not minted by this module (forged / plain literal)
  if (record.consumed) return false; // single-use

  const b = record.binding;
  const matches =
    b.requestId === expected.requestId &&
    b.actionId === expected.actionId &&
    b.paramsDigest === expected.paramsDigest &&
    b.tenantId === expected.tenantId &&
    b.userId === expected.userId;
  if (!matches) return false;

  record.consumed = true;
  return true;
}
