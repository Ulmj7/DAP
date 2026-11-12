/**
 * @dap/contracts: execution-runtime.ts — the executor guard (T022).
 *
 * Exports ONLY `defineExecutor`, `ExecutionGuardError`, and the `ExecutorSpec` type. The trusted
 * minting REGISTRIES (grant + context) live in the restricted mint tree (`./mint/*`), reachable
 * only via `@dap/contracts/mint` or relative paths from inside this package. This module imports
 * the narrow `isMintedContext` and `authorizeAndConsume` operations by relative path — it never
 * touches a registry record, and exports nothing that does.
 *
 * Fail-closed + reentrancy-safe (C): `execute` FIRST reads every decision-relevant field of
 * `call` exactly once into plain locals (this is where a hostile getter would fire, before any
 * state change), THEN in one synchronous block verifies the context is minted and consumes the
 * grant (single-use, all-five-fields), and ONLY then runs the body. A mismatched or re-entrant
 * attempt never burns a correct grant and the body runs at most once per grant.
 */
import type { ActionExecutor, ExecutionCall, ExecutionResult } from "./execution.js";
import type { ExecutorId } from "./core.js";
import { isMintedContext } from "./mint/context-registry.js";
import { authorizeAndConsume } from "./mint/grant-registry.js";

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
 *   1. `call.security` is a context minted by the mint runtime (a plain literal is rejected);
 *   2. `call.grant` was minted by the mint runtime (not a literal / copy);
 *   3. the grant has not been consumed yet;
 *   4. the grant's binding matches the call on ALL FIVE fields
 *      (requestId, actionId, paramsDigest, security.tenantId, security.userId).
 *
 * A single-field mismatch, an unminted context, or a forged/consumed grant throws
 * ExecutionGuardError and runs nothing. A mismatched attempt does NOT consume the grant, so a
 * correct later call still works. A re-entrant getter that triggers an inner execution consumes
 * the grant, so the outer call is rejected — the body runs at most once per grant.
 */
export function defineExecutor<TParams = unknown, TValue = unknown>(
  spec: ExecutorSpec<TParams, TValue>,
): ActionExecutor<TParams, TValue> {
  return {
    id: spec.id as ExecutorId,
    execute: async (call: ExecutionCall<TParams>): Promise<ExecutionResult<TValue>> => {
      // 1. Read EVERY decision-relevant field of `call` exactly once into plain locals.
      //    A hostile getter fires HERE, before any state check or body run. We never read
      //    `call.*` again after this point (the body receives the original `call`, but the guard
      //    decision is made solely from these locals).
      const security = call.security;
      const requestId = call.requestId;
      const actionId = call.actionId;
      const paramsDigest = call.paramsDigest;
      const tenantId = security.tenantId;
      const userId = security.userId;
      const mintedCtx = isMintedContext(security);

      // 2. One synchronous block: verify context provenance + consume the grant (single-use,
      //    all-five-fields). No `call.*` reads and no untrusted code between these steps.
      const granted = mintedCtx
        ? authorizeAndConsume(call.grant, { requestId, actionId, paramsDigest, tenantId, userId })
        : false;

      if (!granted) {
        throw new ExecutionGuardError(
          "Execution rejected: the grant was not a valid, unconsumed grant bound to this call.",
        );
      }

      // 3. Only now run the body.
      return spec.run(call);
    },
  };
}
