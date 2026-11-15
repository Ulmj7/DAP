import { describe, expect, it, vi } from "vitest";
import type { LimitVerdict } from "../../limits/limiter.js";
import type { PipelineRecord } from "../pipeline.js";
import { context, input, run } from "../fixtures.test-support.js";
import { createRateLimitStage } from "./rate-limit.js";
import { toPlannerFeedback } from "../feedback.js";

const record = (over: Partial<PipelineRecord> = {}): PipelineRecord => ({ ...input(), context: context(), run, facts: { intake: { callId: "trusted" } }, budget: { remainingMs: () => 10000 }, ...over });
const denied = (count = true): LimitVerdict => ({ allowed: false, outcome: "DENIED", reason: "rate_limited_user", limit: "user", retryAfterSeconds: 60, countsTowardThrottle: count });
function fixture(answer: unknown = { allowed: true }) {
  const checkProposal = vi.fn(async () => answer as LimitVerdict);
  const recordDenial = vi.fn(async () => ({ recorded: true as const, throttled: false }));
  const limiter = { checkProposal, recordDenial };
  return { ...limiter, stage: createRateLimitStage(limiter) };
}
describe("T117 stage 2 rate limits", () => {
  it("continues, never ALLOWED, using only minted identity and trusted runner metadata", async () => {
    const test = fixture(); const request = record();
    expect(await test.stage(request)).toEqual({ kind: "continue", data: {} });
    expect(test.checkProposal).toHaveBeenCalledExactlyOnceWith({ scope: request.context, userId: "alice", aiSessionId: run.aiSessionId, turnId: run.turnId, chainDepth: run.depth, turnStartedAt: run.turnStartedAt });
    expect(test.recordDenial).not.toHaveBeenCalled();
  });
  it("returns the exact rate verdict and counts it exactly once only when instructed", async () => {
    for (const count of [false, true]) {
      const test = fixture(denied(count)); const request = record();
      const result = await test.stage(request);
      expect(result).toMatchObject({ kind: "stop", decision: { outcome: "DENIED", reason: "rate_limited_user", stage: "rate_limit" } });
      expect(test.recordDenial).toHaveBeenCalledTimes(count ? 1 : 0);
      if (result.kind === "stop") expect(toPlannerFeedback(result.decision)).toEqual({ outcome: "DENIED", category: "try_later" });
    }
  });
  it("a denial-recording failure never replaces the rate decision", async () => {
    const test = fixture(denied()); test.recordDenial.mockRejectedValue(new Error("capacity exhausted"));
    expect(await test.stage(record())).toMatchObject({ decision: { reason: "rate_limited_user" } });
  });
  it.each([undefined, null, {}, { allowed: "yes" }, { ...denied(), reason: "allowed" }, { ...denied(), countsTowardThrottle: "yes" }])("malformed verdict %j fails closed", async (answer) => {
    const test = fixture(answer); if (answer === undefined) test.checkProposal.mockResolvedValue(undefined as never);
    expect(await test.stage(record())).toMatchObject({ kind: "stop", decision: { reason: "dependency_failure" } });
    expect(test.recordDenial).not.toHaveBeenCalled();
  });
  it("throws/capacity errors and forged context fail closed without throttling", async () => {
    const test = fixture(); test.checkProposal.mockRejectedValue(new Error("capacity exhausted"));
    expect(await test.stage(record())).toMatchObject({ decision: { reason: "dependency_failure" } });
    test.checkProposal.mockClear();
    expect(await test.stage(record({ context: { ...context() } }))).toMatchObject({ decision: { reason: "dependency_failure" } });
    expect(test.checkProposal).not.toHaveBeenCalled();
  });
  it("a hung limiter and a hung denial recorder are bounded by deterministic timers", async () => {
    vi.useFakeTimers();
    try {
      const test = fixture(); test.checkProposal.mockImplementation(() => new Promise(() => {}));
      const pending = test.stage(record()); await vi.advanceTimersByTimeAsync(2000);
      expect(await pending).toMatchObject({ decision: { reason: "dependency_failure" } });
      const rate = fixture(denied()); rate.recordDenial.mockImplementation(() => new Promise(() => {}));
      const other = rate.stage(record()); await vi.advanceTimersByTimeAsync(2000);
      expect(await other).toMatchObject({ decision: { reason: "rate_limited_user" } });
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
});
