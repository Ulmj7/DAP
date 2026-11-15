import { describe, expect, it, vi } from "vitest";
import type { IsoInstant, RateLimiter, TenantId } from "@dap/contracts";
import { createLimiter } from "./limiter.js";
import { DEFAULT_LIMIT_CONFIG } from "./limit-config.js";
import { InMemoryRateLimiter } from "../state/memory/rate-limiter.js";

const tenantId = "00000000-0000-4000-8000-00000000000a" as TenantId;
const scope = { tenantId };
const session = { scope, aiSessionId: "session", turnId: "original" };
function setup() {
  let ms = Date.parse("2026-01-01T00:00:29Z");
  const clock = { now: () => new Date(ms).toISOString() as IsoInstant };
  const store = new InMemoryRateLimiter(clock);
  const limiter = createLimiter({ rateLimiter: store, config: DEFAULT_LIMIT_CONFIG, clock, maxLocalTurns: 1 });
  const proposal = { ...session, userId: "alice", chainDepth: 0, turnStartedAt: clock.now() };
  return { limiter, clock, proposal, advance: () => { ms += 2000; } };
}
describe("QA: active turns cannot be forgotten", () => {
  it("evict/re-admit across a shared window boundary never exceeds the proposal cap inside the same valid turn", async () => {
    const { limiter, proposal, advance } = setup();
    for (let i = 0; i < DEFAULT_LIMIT_CONFIG.proposalsPerTurn; i++) expect((await limiter.checkProposal(proposal)).allowed).toBe(true);
    await limiter.checkProposal({ ...proposal, turnId: "evictor" });
    advance();
    expect((await limiter.checkProposal(proposal)).allowed).toBe(false);
  });
  it("evict/re-admit across a shared window boundary never exceeds the execution cap", async () => {
    const { limiter, advance } = setup();
    for (let i = 0; i < DEFAULT_LIMIT_CONFIG.executionsPerTurn; i++) expect((await limiter.claimExecution(session)).allowed).toBe(true);
    await limiter.claimExecution({ ...session, turnId: "evictor" });
    advance();
    expect((await limiter.claimExecution(session)).allowed).toBe(false);
  });
  it.each(["fault", "block"] as const)("a same-turn 10,000-request %s flood has bounded shared reads", async (mode) => {
    const clock = { now: () => "2026-01-01T00:00:00Z" as IsoInstant };
    const isBlocked = vi.fn(async () => { if (mode === "fault") throw new Error("store unavailable"); return true; });
    const store: RateLimiter = { isBlocked, hit: async () => { throw new Error("unreachable"); }, block: async () => {} };
    const limiter = createLimiter({ rateLimiter: store, config: DEFAULT_LIMIT_CONFIG, clock });
    const input = { ...session, userId: "alice", chainDepth: 0, turnStartedAt: clock.now() };
    for (let i = 0; i < 10_000; i++) expect(await limiter.checkProposal(input)).toMatchObject({ allowed: false, reason: mode === "fault" ? "dependency_failure" : "denial_throttle", countsTowardThrottle: false });
    expect(isBlocked.mock.calls.length).toBeLessThanOrEqual(DEFAULT_LIMIT_CONFIG.proposalsPerTurn);
  });  it("a bare undefined block answer cannot count as a placed denial block", async () => {
    const { clock } = setup();
    const limiter = createLimiter({ clock, config: DEFAULT_LIMIT_CONFIG, rateLimiter: {
      isBlocked: async () => false, hit: async () => ({ allowed: false, retryAfterSeconds: 1 }), block: (() => undefined) as never,
    } });
    expect(await limiter.recordDenial(session)).toEqual({ recorded: false });
  });
  it.each([Object.assign([], { allowed: true, retryAfterSeconds: 0 }), { allowed: true, retryAfterSeconds: 0, extra: "drift" }])("malformed rate answers cannot admit a capability: %j", async (answer) => {
    const { clock } = setup();
    const limiter = createLimiter({ clock, config: DEFAULT_LIMIT_CONFIG, rateLimiter: {
      isBlocked: async () => false, hit: async () => answer as never, block: async () => {},
    } });
    expect(await limiter.checkCapability({ scope, userId: "alice", actionId: "action", risk: "SAFE" })).toMatchObject({ allowed: false, reason: "dependency_failure" });
  });
  it("a turn that expires while shared calls are pending cannot be admitted", async () => {
    let ms = Date.parse("2026-01-01T00:00:00Z");
    const clock = { now: () => new Date(ms).toISOString() as IsoInstant };
    const limiter = createLimiter({ clock, config: DEFAULT_LIMIT_CONFIG, rateLimiter: {
      isBlocked: async () => { ms += DEFAULT_LIMIT_CONFIG.turnBudgetMs + 1; return false; },
      hit: async () => ({ allowed: true, retryAfterSeconds: 0 }), block: async () => {},
    } });
    const input = { ...session, userId: "alice", chainDepth: 0, turnStartedAt: clock.now() };
    expect(await limiter.checkProposal(input)).toMatchObject({ allowed: false, reason: "rate_limited_turn", limit: "turn_budget" });
  });
  it("fails closed when the process clock moves back within an otherwise valid turn", async () => {
    let ms = Date.parse("2026-01-01T00:00:00Z"); const start = ms;
    const clock = { now: () => new Date(ms).toISOString() as IsoInstant };
    const limiter = createLimiter({ clock, config: DEFAULT_LIMIT_CONFIG, rateLimiter: new InMemoryRateLimiter(clock) });
    const input = { ...session, userId: "alice", chainDepth: 0, turnStartedAt: clock.now() };
    ms = start + 2000; expect((await limiter.checkProposal(input)).allowed).toBe(true);
    ms = start + 1000; expect(await limiter.checkProposal(input)).toMatchObject({ allowed: false, reason: "dependency_failure" });
    expect(() => createLimiter({ clock, config: DEFAULT_LIMIT_CONFIG, rateLimiter: new InMemoryRateLimiter(clock), maxLocalTurns: 1_000_001 })).toThrow();
  });

});
