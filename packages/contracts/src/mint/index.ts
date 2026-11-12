/**
 * @dap/contracts/mint — the trusted minting runtime (research D5).
 *
 * The ONLY way to produce a recognized `AuthorizationContext` or `ExecutionGrant`. Both are
 * tracked in module-private registries that live in the contracts execution runtime
 * (a WeakSet of minted contexts and a WeakMap of grants), which no other module can reach. A
 * plain data literal with the same fields, a spread copy, or a fabricated object therefore fails
 * verification.
 *
 * This subpath is importable ONLY by @dap/security and @dap/testkit (enforced by lint,
 * ATK-ARCH-05). Production code in @dap/actions and the AI layer must not import it — they
 * receive a pre-minted grant only through a Gateway-approved ExecutionCall.
 *
 * Fail-closed: every check below rejects on anything it cannot prove to be minted and valid.
 */
import type { ExecutionGrant } from "../execution.js";
import { grantRecord, registerGrant, type GrantBinding } from "../execution-runtime.js";

// The full grant binding (requestId, actionId, paramsDigest, tenantId, userId), single-use.
// Re-exported so @dap/security can name it. `tenantId` is validated as a UUID by the caller.
export type { GrantBinding } from "../execution-runtime.js";

// Minting of AuthorizationContexts is owned by the execution runtime (so defineExecutor can
// require a minted context). Exposed HERE from the mint subpath only — never from the barrel.
export { isMintedContext, mintContext as mintAuthorizationContext } from "../execution-runtime.js";

/**
 * Mint an ExecutionGrant bound to the 5-tuple. The grant is single-use: it can be consumed
 * exactly once, and only by a call whose binding matches all five fields. The grant object is
 * frozen.
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
