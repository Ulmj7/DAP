import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ReplayGuard, TenantId, TenantScope } from "@dap/contracts";

export interface ReplayTestContext {
  readonly store: ReplayGuard;
  /** Advance the adapter's authoritative clock (including the DB clock in PostgreSQL tests). */
  readonly advanceSeconds: (seconds: number) => Promise<void>;
  readonly dispose?: () => Promise<void>;
}
const scope = (): TenantScope => ({ tenantId: randomUUID() as TenantId });

export function runReplayConformance(makeStore: () => Promise<ReplayTestContext>): void {
  describe("ReplayGuard conformance", () => {
    let ctx: ReplayTestContext;
    beforeEach(async () => { ctx = await makeStore(); });
    afterEach(async () => { await ctx?.dispose?.(); });

    it("exactly one of 32 concurrent claims wins, across 100 independent trials", async () => {
      const tenant = scope();
      for (let trial = 0; trial < 100; trial++) {
        const results = await Promise.all(Array.from({ length: 32 }, () => ctx.store.claim(tenant, `call:${trial}`, 60)));
        expect(results.filter((value) => value === "claimed")).toHaveLength(1);
        expect(results.filter((value) => value === "duplicate")).toHaveLength(31);
      }
    });
    it("keeps equal keys independent per tenant and opaque namespace", async () => {
      const a = scope(); const b = scope();
      expect(await ctx.store.claim(a, "session-a:call-1", 60)).toBe("claimed");
      expect(await ctx.store.claim(b, "session-a:call-1", 60)).toBe("claimed");
      expect(await ctx.store.claim(a, "session-b:call-1", 60)).toBe("claimed");
      expect(await ctx.store.claim(a, "session-a:call-1", 60)).toBe("duplicate");
      // Embedded tenant text cannot select the scope; only the separate trusted argument can.
      const key = JSON.stringify({ tenantId: b.tenantId, key: "call" });
      expect(await ctx.store.claim(a, key, 60)).toBe("claimed");
      expect(await ctx.store.claim(b, key, 60)).toBe("claimed");
    });
    it("uses a fixed retention boundary; duplicate claims never extend it", async () => {
      const tenant = scope();
      expect(await ctx.store.claim(tenant, "retained", 10)).toBe("claimed");
      await ctx.advanceSeconds(9);
      expect(await ctx.store.claim(tenant, "retained", 100)).toBe("duplicate");
      await ctx.advanceSeconds(1);
      expect(await ctx.store.claim(tenant, "retained", 10)).toBe("claimed");
    });
    it("canonicalizes UUID case as the database does", async () => {
      const a = scope(); const upper = { tenantId: a.tenantId.toUpperCase() as TenantId };
      expect(await ctx.store.claim(a, "case", 60)).toBe("claimed");
      expect(await ctx.store.claim(upper, "case", 60)).toBe("duplicate");
    });
    it("rejects invalid tenant/key/retention without creating a claim", async () => {
      const tenant = scope();
      for (const seconds of [0, -1, NaN, Infinity, 1.5, undefined, "60"]) {
        await expect(ctx.store.claim(tenant, "invalid", seconds as number)).rejects.toThrow();
      }
      for (const key of ["", "nul\u0000key", "x".repeat(1025), undefined, 1]) {
        await expect(ctx.store.claim(tenant, key as string, 60)).rejects.toThrow();
      }
      for (const invalid of [undefined, null, {}, { tenantId: "other" }]) {
        await expect(ctx.store.claim(invalid as TenantScope, "invalid", 60)).rejects.toThrow();
      }
      expect(await ctx.store.claim(tenant, "invalid", 60)).toBe("claimed");
    });
  });
}
