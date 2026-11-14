import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RateLimiter, RateLimitRule, TenantId, TenantScope } from "@dap/contracts";

export interface RateLimiterTestContext {
  readonly store: RateLimiter;
  readonly advanceSeconds: (seconds: number) => Promise<void>;
  readonly dispose?: () => Promise<void>;
}
const scope = (): TenantScope => ({ tenantId: randomUUID() as TenantId });
const rule = { limit: 20, windowSeconds: 60 };

export function runRateLimiterConformance(makeStore: () => Promise<RateLimiterTestContext>): void {
  describe("RateLimiter conformance", () => {
    let ctx: RateLimiterTestContext;
    beforeEach(async () => { ctx = await makeStore(); });
    afterEach(async () => { await ctx?.dispose?.(); });

    it("never loses concurrent hits: exactly the limit wins in each of 100 trials", async () => {
      const tenant = scope();
      for (let trial = 0; trial < 100; trial++) {
        const key = `user:${trial}`;
        const results = await Promise.all(Array.from({ length: 64 }, () => ctx.store.hit(tenant, key, rule)));
        expect(results.filter((value) => value.allowed)).toHaveLength(20);
        expect(results.filter((value) => !value.allowed)).toHaveLength(44);
        expect(await ctx.store.hit(tenant, key, rule)).toMatchObject({ allowed: false });
        for (const result of results) {
          expect(Number.isInteger(result.retryAfterSeconds)).toBe(true);
          expect(result.retryAfterSeconds).toBe(result.allowed ? 0 : 60);
        }
      }
    });
    // Factory starts the authoritative clock at a minute boundary for these fixed-window checks.
    it("rolls over exactly at the epoch-aligned fixed-window boundary", async () => {
      const tenant = scope(); const rule = { limit: 1, windowSeconds: 60 };
      expect(await ctx.store.hit(tenant, "window", rule)).toEqual({ allowed: true, retryAfterSeconds: 0 });
      await ctx.advanceSeconds(59.5);
      expect(await ctx.store.hit(tenant, "window", rule)).toEqual({ allowed: false, retryAfterSeconds: 1 });
      await ctx.advanceSeconds(0.5);
      expect(await ctx.store.hit(tenant, "window", rule)).toEqual({ allowed: true, retryAfterSeconds: 0 });
    });
    it("isolates tenant counts, buckets, and caller-supplied tenant text", async () => {
      const a = scope(); const b = scope(); const one = { limit: 1, windowSeconds: 60 };
      const key = `user:${b.tenantId}:cap:echo`;
      expect((await ctx.store.hit(a, key, one)).allowed).toBe(true);
      expect((await ctx.store.hit(a, key, one)).allowed).toBe(false);
      expect((await ctx.store.hit(b, key, one)).allowed).toBe(true);
      expect((await ctx.store.hit(a, `${key}:other`, one)).allowed).toBe(true);
    });
    it("blocks only the scoped key, expires at the boundary, and cannot be shortened", async () => {
      const a = scope(); const b = scope();
      expect(await ctx.store.isBlocked(a, "deny")).toBe(false);
      await ctx.store.block(a, "deny", 10);
      expect(await ctx.store.isBlocked(a, "deny")).toBe(true);
      expect(await ctx.store.isBlocked(b, "deny")).toBe(false);
      expect(await ctx.store.isBlocked(a, "other")).toBe(false);
      await ctx.advanceSeconds(5);
      await ctx.store.block(a, "deny", 1);
      await ctx.advanceSeconds(4);
      expect(await ctx.store.isBlocked(a, "deny")).toBe(true);
      await ctx.advanceSeconds(1);
      expect(await ctx.store.isBlocked(a, "deny")).toBe(false);
    });
    it("concurrent blocks preserve the longest expiry and can extend a live block", async () => {
      const tenant = scope();
      await Promise.all([30, 5, 20, 1].map((seconds) => ctx.store.block(tenant, "deny", seconds)));
      await ctx.advanceSeconds(29);
      expect(await ctx.store.isBlocked(tenant, "deny")).toBe(true);
      await ctx.store.block(tenant, "deny", 10);
      await ctx.advanceSeconds(1);
      expect(await ctx.store.isBlocked(tenant, "deny")).toBe(true);
      await ctx.advanceSeconds(9);
      expect(await ctx.store.isBlocked(tenant, "deny")).toBe(false);
    });
    it("canonicalizes UUID case for both counters and blocks", async () => {
      const tenant = scope(); const upper = { tenantId: tenant.tenantId.toUpperCase() as TenantId };
      const one = { limit: 1, windowSeconds: 60 };
      expect((await ctx.store.hit(tenant, "case", one)).allowed).toBe(true);
      expect((await ctx.store.hit(upper, "case", one)).allowed).toBe(false);
      await ctx.store.block(tenant, "case", 10);
      expect(await ctx.store.isBlocked(upper, "case")).toBe(true);
    });
    it("rejects changing rules inside a live window instead of resetting the counter", async () => {
      const tenant = scope();
      await ctx.store.hit(tenant, "rule", rule);
      for (const changed of [{ limit: 100, windowSeconds: 60 }, { limit: 20, windowSeconds: 1 }]) {
        await expect(ctx.store.hit(tenant, "rule", changed)).rejects.toThrow();
      }
    });
    it("rejects invalid scope/key/rule/block duration without consuming a valid hit", async () => {
      const tenant = scope();
      for (const value of [0, -1, NaN, Infinity, 1.5, undefined, "1"]) {
        await expect(ctx.store.hit(tenant, "invalid", { limit: value, windowSeconds: 60 } as RateLimitRule)).rejects.toThrow();
        await expect(ctx.store.hit(tenant, "invalid", { limit: 1, windowSeconds: value } as RateLimitRule)).rejects.toThrow();
        await expect(ctx.store.block(tenant, "invalid", value as number)).rejects.toThrow();
      }
      for (const invalid of [undefined, null, {}, { tenantId: "other" }]) {
        await expect(ctx.store.hit(invalid as TenantScope, "invalid", rule)).rejects.toThrow();
        await expect(ctx.store.block(invalid as TenantScope, "invalid", 10)).rejects.toThrow();
        await expect(ctx.store.isBlocked(invalid as TenantScope, "invalid")).rejects.toThrow();
      }
      for (const key of ["", "nul\u0000key", "x".repeat(1025), undefined, 1]) {
        await expect(ctx.store.hit(tenant, key as string, rule)).rejects.toThrow();
        await expect(ctx.store.block(tenant, key as string, 10)).rejects.toThrow();
        await expect(ctx.store.isBlocked(tenant, key as string)).rejects.toThrow();
      }
      expect(await ctx.store.hit(tenant, "invalid", { limit: 1, windowSeconds: 60 })).toEqual({ allowed: true, retryAfterSeconds: 0 });
      expect(await ctx.store.isBlocked(tenant, "invalid")).toBe(false);
    });
  });
}
