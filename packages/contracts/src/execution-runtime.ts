/**
 * @dap/contracts: execution-runtime.ts — the grant lifecycle and the executor guard (T022).
 *
 * Owns the module-private registry that tracks minted ExecutionGrants and their single-use
 * "consumed" flag, and provides `defineExecutor`, whose wrapper verifies AND consumes a grant
 * BEFORE the action body runs (FR-017, ATK-ARCH-02).
 *
 * The trusted MINTING entry points (mintAuthorizationContext / mintExecutionGrant /
 * consumeExecutionGrant) live in `@dap/contracts/mint`, which registers grants into this
 * registry. The AI layer and `@dap/actions` never import the mint subpath; they receive a
 * pre-minted grant only through a Gateway-approved ExecutionCall.
 *
 * Fail-closed: the wrapper throws and runs nothing for a missing, forged, mismatched, or
 * already-consumed grant.
 */
import type { ActionExecutor, ExecutionCall, ExecutionResult } from "./execution.js";
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

// The single source of truth for grant identity + consumption. Module-private: it is not
// re-exported from the package barrel, so no external module can register, clear, or reset a
// grant. Only the mint subpath (via registerGrant/grantRecord) and defineExecutor touch it.
const grantRegistry = new WeakMap<object, GrantRecord>();

/** Internal: create and register a grant bound to the 5-tuple. Returns the grant object. */
export function registerGrant(binding: GrantBinding): object {
  const grant: object = {
    requestId: binding.requestId,
    actionId: binding.actionId,
    paramsDigest: binding.paramsDigest,
  };
  grantRegistry.set(grant, { binding, consumed: false });
  return grant;
}

/** Internal: the registry record for a minted grant, or undefined for any foreign object. */
export function grantRecord(grant: unknown): GrantRecord | undefined {
  if (typeof grant !== "object" || grant === null) return undefined;
  return grantRegistry.get(grant);
}

/** Thrown when the executor guard refuses to run (missing / forged / mismatched / consumed grant). */
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
 * Create an ActionExecutor whose `execute` verifies AND consumes the grant before running the
 * body. The body never runs for a missing, forged, mismatched, or already-consumed grant.
 *
 * Verified against the call: the grant was minted by the mint subpath, has not been consumed,
 * and its binding matches the call's (requestId, tenantId, userId). The actionId and
 * paramsDigest fields of the binding are enforced at mint time by the Policy Gateway, which
 * mints the grant for the specific resolved action and validated params and pairs that exact
 * grant with that exact call.
 */
export function defineExecutor<TParams = unknown, TValue = unknown>(
  spec: ExecutorSpec<TParams, TValue>,
): ActionExecutor<TParams, TValue> {
  return {
    id: spec.id as ExecutorId,
    execute: async (call: ExecutionCall<TParams>): Promise<ExecutionResult<TValue>> => {
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
