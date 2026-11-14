import { z } from "zod";
import type { Clock } from "@dap/contracts";
import { isMintedContext } from "@dap/contracts/mint";
import { denyDecision } from "../decision.js";
import { wrapHook, type HookOptions } from "../hook-wrapper.js";
import type { PolicyStage } from "../pipeline.js";

export function createContextStage(clock: Clock, options: HookOptions = {}): PolicyStage {
  const currentTime = wrapHook(clock.now.bind(clock), "page", options);
  return async (request) => {
    const stop = (outcome: "DENIED" | "UNAUTHORIZED", reason: "unauthenticated" | "session_expired" | "dependency_failure") => ({ kind: "stop" as const, decision: denyDecision({ decisionId: request.decisionId, requestId: request.requestId, stage: "context", outcome, reason }) });
    const ctx = request.context;
    if (!isMintedContext(ctx)) return stop("UNAUTHORIZED", "unauthenticated");
    const answer = await currentTime();
    if (!answer.ok || !z.iso.datetime({ offset: true }).safeParse(answer.value).success) return stop("DENIED", "dependency_failure");
    const now = Date.parse(answer.value);
    const validUntil = Date.parse(ctx.validUntil);
    const authenticatedAt = Date.parse(ctx.authenticatedAt);
    if (!Number.isFinite(validUntil) || !Number.isFinite(authenticatedAt) || authenticatedAt > now || validUntil <= authenticatedAt) return stop("UNAUTHORIZED", "unauthenticated");
    if (validUntil <= now) return stop("UNAUTHORIZED", "session_expired");
    return { kind: "continue", data: {} };
  };
}
