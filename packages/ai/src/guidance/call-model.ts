/**
 * One guarded call to a model. The request is validated first; there is exactly one `generate` call; the deadline comes from an injected timer port
 * (the package starts no real timer); and everything that goes wrong becomes a CLOSED reason. Nothing from the provider (a message, stack, cause,
 * key, raw object or schema error) can reach the outcome: it is built only from constants and a validated decision.
 */
import { MAX_MODEL_CALLS, MODEL_DEADLINE_MS } from "./limits.js";
import { parseGuidanceDecision } from "./decision.js";
import { parseGuidanceModelRequest } from "./request.js";
import type { GuidanceDecision, GuidanceModel, GuidanceTimers } from "./types.js";

export type ModelCallFailure = "query_invalid" | "context_invalid" | "model_unavailable" | "invalid_model_output";
export type ModelCallOutcome = { readonly ok: true; readonly decision: GuidanceDecision } | { readonly ok: false; readonly reason: ModelCallFailure };

/** Counts model calls. A guard shared by several `callGuidanceModel` calls refuses every call after the first. */
export interface ModelCallGuard { take(): boolean }
export function createModelCallGuard(limit: number = MAX_MODEL_CALLS): ModelCallGuard {
  let used = 0;
  return Object.freeze({ take: () => (used < limit ? (used++, true) : false) });
}

const failed = (reason: ModelCallFailure): ModelCallOutcome => Object.freeze({ ok: false, reason });

export function callGuidanceModel(args: { readonly model: GuidanceModel; readonly request: unknown; readonly timers: GuidanceTimers; readonly guard?: ModelCallGuard }): Promise<ModelCallOutcome> {
  return new Promise<ModelCallOutcome>((resolve) => {
    let settled = false;
    let cancel: (() => void) | null = null;
    const finish = (outcome: ModelCallOutcome): void => {
      if (settled) return; // a late answer, or a second timer, changes nothing
      settled = true;
      const release = cancel;
      cancel = null;
      try { release?.(); } catch { /* releasing is best effort */ }
      resolve(outcome);
    };
    try {
      const request = parseGuidanceModelRequest(args.request);
      if (!request.ok) return finish(failed(request.reason));
      if ((args.guard ?? createModelCallGuard()).take() !== true) return finish(failed("model_unavailable"));
      // The deadline is armed BEFORE the call: a timer port that fails means no call is made at all.
      const handle: unknown = args.timers.set(() => finish(failed("model_unavailable")), MODEL_DEADLINE_MS);
      if (typeof handle !== "function") { settled = true; return resolve(failed("model_unavailable")); }
      cancel = handle as () => void;
      let answer: unknown;
      try { answer = args.model.generate(request.request); } catch { return finish(failed("model_unavailable")); }
      Promise.resolve(answer).then(
        (value) => { const decision = parseGuidanceDecision(value); finish(decision === null ? failed("invalid_model_output") : Object.freeze({ ok: true, decision })); },
        () => finish(failed("model_unavailable")),
      );
    } catch { finish(failed("model_unavailable")); }
  });
}
