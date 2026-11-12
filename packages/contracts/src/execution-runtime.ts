/**
 * @dap/contracts: execution-runtime.ts — the trusted minting REGISTRIES and the executor guard (T022).
 *
 * This module is the single source of truth for two module-private registries, both reachable only
 * through the mint subpath (`@dap/contracts/mint`) and through `defineExecutor`:
 *   - `mintedContexts`: a WeakSet of AuthorizationContexts minted by `mintContext`;
 *   - `grantRegistry`: a WeakMap of grants -> { binding, consumed }, minted by `registerGrant`.
 *
 * Because nothing is exported from the package barrel that reaches these registries, no external
 * module can fabricate, re-register, or reset an entry. A plain data literal with the same fields,
 * a spread copy, or a fabricated object is never recognized.
 *
 * The trusted MINTING entry points (mintAuthorizationContext / mintExecutionGrant /
 * consumeExecutionGrant) live in `@dap/contracts/mint` and delegate to these registries. The AI
 * layer and `@dap/actions` never import the mint subpath; they receive a pre-minted grant only
 * through a Gateway-approved ExecutionCall.
 *
 * Fail-closed: `defineExecutor`'s wrapper throws and runs nothing unless the security context is
 * minted AND the grant is minted, unconsumed, and bound to the call on ALL FIVE fields. A
 * mismatched attempt does NOT consume the grant, so a correct later call still succeeds.
 */
import type { ActionExecutor, ExecutionCall, ExecutionResult } from "./execution.js";
import type { AuthorizationContext, AuthenticatedPrincipal } from "./security-context.js";
import type { ActionId, ExecutorId, RequestId, Sha256Hex, TenantId, UserId } from "./core.js";

/**
 * The full grant binding (data-model.md): bound to
 * (requestId, actionId, paramsDigest, tenantId, userId), single-use.
 * `tenantId` is validated as a UUID by the caller (@dap/security), not by the runtime.
 */
export interface GrantBinding {
  readonly requestId: RequestId;
  readonly actionId: ActionId;
  readonly paramsDigest: Sha256Hex;
  readonly tenantId: TenantId;
  readonly userId: UserId;
}

interface GrantRecord {
  readonly binding: GrantBinding;
  consumed: boolean;
}

// --- Minted contexts: the single source of truth for context provenance. ---
// Module-private: not re-exported from the barrel, so no external module can add/clear entries.
const mintedContexts = new WeakSet<AuthorizationContext>();

/**
 * Mint an AuthorizationContext from a strictly-validated principal. The returned object is
 * FROZEN (runtime mutation of tenantId/userId/sessionId would defeat tenant isolation) and is
 * recognized ONLY by identity via `isMintedContext`; a structurally identical literal is not.
 */
export function mintContext(principal: AuthenticatedPrincipal): AuthorizationContext {
  const ctx = {
    userId: principal.userId,
    tenantId: principal.tenantId,
    sessionId: principal.sessionId,
    authenticatedAt: principal.authenticatedAt,
    validUntil: principal.validUntil,
  };
  Object.freeze(ctx);
  mintedContexts.add(ctx as AuthorizationContext);
  return ctx as AuthorizationContext;
}

/**
 * Type guard. True ONLY for an object minted by `mintContext`. A plain literal with the same
 * fields, a spread copy, or any other object returns false.
 */
export function isMintedContext(ctx: unknown): ctx is AuthorizationContext {
  return typeof ctx === "object" && ctx !== null && mintedContexts.has(ctx as AuthorizationContext);
}

// --- Grants: the single source of truth for grant identity + consumption. ---
const grantRegistry = new WeakMap<object, GrantRecord>();

/** Internal: create and register a grant bound to the 5-tuple. The grant object is FROZEN. */
export function registerGrant(binding: GrantBinding): object {
  const grant: object = {
    requestId: binding.requestId,
    actionId: binding.actionId,
    paramsDigest: binding.paramsDigest,
  };
  Object.freeze(grant);
  grantRegistry.set(grant, { binding, consumed: false });
  return grant;
}

/** Internal: the registry record for a minted grant, or undefined for any foreign object. */
export function grantRecord(grant: unknown): GrantRecord | undefined {
  if (typeof grant !== "object" || grant === null) return undefined;
  return grantRegistry.get(grant);
}

/** Thrown when the executor guard refuses to run (unminted context, forged/mismatched/consumed grant). */
export class ExecutionGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExecutionGuardError";
  }
}

export interface ExecutorSpec<TParams = unknown, TValue = unknown> {
  /** Stable executor id, distinct from the actionId (data-model.md). Supplied by the composition root. */
  readonly id: string;
  /** The action body. Runs only after the guard has verified and consumed the grant. */
  readonly run: (call: ExecutionCall<TParams>) => Promise<ExecutionResult<TValue>>;
}

/**
 * Create an ActionExecutor whose `execute` verifies AND consumes the grant BEFORE running the
 * body. The body never runs unless ALL of the following hold:
 *   1. `call.security` is a context minted by `mintContext` (a plain literal is rejected);
 *   2. `call.grant` was minted by the mint runtime (not a literal / copy);
 *   3. the grant has not been consumed yet;
 *   4. the grant's binding matches the call on ALL FIVE fields
 *      (requestId, actionId, paramsDigest, security.tenantId, security.userId).
 *
 * A single-field mismatch, an unminted context, or a forged/consumed grant throws
 * ExecutionGuardError and runs nothing. A mismatched attempt does NOT consume the grant, so a
 * correct later call still works.
 */
export function defineExecutor<TParams = unknown, TValue = unknown>(
  spec: ExecutorSpec<TParams, TValue>,
): ActionExecutor<TParams, TValue> {
  return {
    id: spec.id as ExecutorId,
    execute: async (call: ExecutionCall<TParams>): Promise<ExecutionResult<TValue>> => {
      if (!isMintedContext(call.security)) {
        throw new ExecutionGuardError(
          "Execution rejected: the security context was not minted by the trusted mint runtime.",
        );
      }
      const record = grantRecord(call.grant);
      if (!record) {
        throw new ExecutionGuardError(
          "Execution rejected: the grant was not minted by the trusted mint runtime.",
        );
      }
      if (record.consumed) {
        throw new ExecutionGuardError("Execution rejected: the grant has already been used.");
      }
      const b = record.binding;
      if (
        b.requestId !== call.requestId ||
        b.actionId !== call.actionId ||
        b.paramsDigest !== call.paramsDigest ||
        b.tenantId !== call.security.tenantId ||
        b.userId !== call.security.userId
      ) {
        throw new ExecutionGuardError(
          "Execution rejected: the grant binding does not match this call.",
        );
      }
      record.consumed = true;
      return spec.run(call);
    },
  };
}
