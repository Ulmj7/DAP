import { describe, expect, it } from "vitest";
import type { ExecutionCall, ExecutionResult } from "./execution.js";
import { defineExecutor } from "./execution-runtime.js";
import { isMintedContext, mintAuthorizationContext, mintExecutionGrant } from "./mint/index.js";
import type { GrantBinding } from "./mint/index.js";
import type { AuthenticatedPrincipal } from "./security-context.js";

// T021: defineExecutor's wrapper must verify AND consume the grant BEFORE running the body
// (FR-017, ATK-ARCH-02). No grant, a forged grant, a wrong-binding grant, and a consumed
// grant all refuse to run; the body never executes.

function principal(overrides: Partial<AuthenticatedPrincipal> = {}): AuthenticatedPrincipal {
  return {
    userId: "user-alice",
    tenantId: "11111111-1111-4111-8111-111111111111",
    sessionId: "session-1",
    authenticatedAt: "2026-01-01T00:00:00.000Z",
    validUntil: "2026-01-01T00:10:00.000Z",
    ...overrides,
  };
}

function binding(overrides: Record<string, string> = {}): GrantBinding {
  const base = {
    requestId: "req-1",
    actionId: "act-1",
    paramsDigest: "digest-1",
    tenantId: "11111111-1111-4111-8111-111111111111",
    userId: "user-alice",
    ...overrides,
  };
  return base as unknown as GrantBinding;
}

function makeWorld(overrides: Record<string, string> = {}) {
  const p = principal();
  const ctx = mintAuthorizationContext(p);
  const b = binding(overrides);
  const grant = mintExecutionGrant(b);
  let runs = 0;
  const call: ExecutionCall<Record<string, unknown>> = {
    grant,
    security: ctx,
    params: { name: "Ada" },
    resource: null,
    requestId: b.requestId,
  };
  const body = (): Promise<ExecutionResult> => {
    runs += 1;
    return Promise.resolve({ status: "success", value: "done" });
  };
  const executor = defineExecutor({ id: "exec-1", run: body });
  return { ctx, grant, call, body, executor, getRuns: () => runs };
}

describe("defineExecutor grant guard (ATK-ARCH-02)", () => {
  it("runs the body when the grant is minted, unconsumed, and matches the call", async () => {
    const { call, executor, getRuns } = makeWorld();
    const result = await executor.execute(call);
    expect(result).toEqual({ status: "success", value: "done" });
    expect(getRuns()).toBe(1);
  });

  it("throws and never runs the body when there is no grant", async () => {
    const { ctx, call, executor, getRuns } = makeWorld();
    const noGrant: ExecutionCall<Record<string, unknown>> = {
      ...call,
      grant: null as unknown as ExecutionCall<Record<string, unknown>>["grant"],
    };
    await expect(executor.execute(noGrant)).rejects.toThrow();
    expect(getRuns()).toBe(0);
    // The minted context itself is still recognized (sanity that we minted correctly).
    expect(isMintedContext(ctx)).toBe(true);
  });

  it("throws and never runs the body for a forged (plain literal) grant", async () => {
    const { call, executor, getRuns } = makeWorld();
    const forged = { requestId: "req-1", actionId: "act-1", paramsDigest: "digest-1" };
    const forgedCall: ExecutionCall<Record<string, unknown>> = {
      ...call,
      grant: forged as unknown as ExecutionCall<Record<string, unknown>>["grant"],
    };
    await expect(executor.execute(forgedCall)).rejects.toThrow();
    expect(getRuns()).toBe(0);
  });

  it("throws and never runs the body for a grant bound to a different request", async () => {
    const { call, executor, getRuns } = makeWorld({ requestId: "req-OTHER" });
    // The call carries the world's original requestId; the grant is bound to another.
    const mismatchCall = { ...call, requestId: "req-1" } as unknown as ExecutionCall<Record<string, unknown>>;
    await expect(executor.execute(mismatchCall)).rejects.toThrow();
    expect(getRuns()).toBe(0);
  });

  it("throws and never runs the body for a grant bound to a different tenant/user", async () => {
    const { call, executor, getRuns } = makeWorld({
      tenantId: "22222222-2222-4222-8222-222222222222",
      userId: "user-bob",
    });
    await expect(executor.execute(call)).rejects.toThrow();
    expect(getRuns()).toBe(0);
  });

  it("throws and never re-runs the body for a consumed grant", async () => {
    const { call, executor, getRuns } = makeWorld();
    // First call succeeds and consumes the grant.
    await executor.execute(call);
    expect(getRuns()).toBe(1);
    // The same grant + call again must be rejected (single-use).
    await expect(executor.execute(call)).rejects.toThrow();
    expect(getRuns()).toBe(1);
  });
});
