import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ConfirmationId, ConfirmationStore, IsoInstant, NewConfirmation, TenantId, TenantScope, UserId } from "@dap/contracts";
import { paramsDigest } from "../../validation/params.js";

export interface ConfirmationTestContext {
  readonly store: ConfirmationStore;
  readonly second?: ConfirmationStore;
  now(): IsoInstant;
  advanceSeconds(seconds: number): Promise<void>;
  dispose?(): Promise<void>;
}
export interface ConfirmationConformanceCase { readonly name: string; run(ctx: ConfirmationTestContext): Promise<void> }
export const confirmationScope = (): TenantScope => ({ tenantId: randomUUID() as TenantId });
export const confirmationFixture = (scope: TenantScope, over: Partial<NewConfirmation> = {}): NewConfirmation => {
  const values = { id: randomUUID(), tenantId: scope.tenantId, userId: "alice", requestId: randomUUID(), actionId: "publishDocument", definitionVersion: 1, definitionHash: "a".repeat(64), params: { message: "bound" }, resource: null, risk: "HIGH", consequence: { title: "Publish document", effects: ["Visible to the team"], irreversible: false }, ttlSeconds: 10, ...over };
  return { ...values, paramsDigest: over.paramsDigest ?? paramsDigest({ actionId: values.actionId, version: values.definitionVersion, params: values.params, resource: values.resource, tenantId: values.tenantId, userId: values.userId }) } as NewConfirmation;
};
const alice = "alice" as UserId; const bob = "bob" as UserId;
export const confirmationConformanceCases: readonly ConfirmationConformanceCase[] = [
  { name: "create/get preserves every binding and snapshots deeply frozen input", async run(ctx) {
    const scope = confirmationScope(); const input = confirmationFixture(scope); const expected = structuredClone(input);
    await ctx.store.create(scope, input);
    const row = await ctx.store.get(scope, input.id);
    const { ttlSeconds, ...fields } = expected;
    expect(row).toMatchObject({ ...fields, status: "pending", executionStatus: "none", decidedAt: null, createdAt: ctx.now() });
    expect(Date.parse(row!.expiresAt) - Date.parse(row!.createdAt)).toBe(ttlSeconds * 1000);
    expect(Object.isFrozen(row)).toBe(true); expect(Object.isFrozen(row!.params)).toBe(true);
    Reflect.set(input.params as object, "message", "changed");
    expect((await ctx.store.get(scope, input.id))!.params).toEqual(expected.params);
  } },
  { name: "100 trials: exactly one of two concurrent accepts across adapters wins", async run(ctx) {
    const scope = confirmationScope();
    for (let trial = 0; trial < 100; trial++) {
      const input = confirmationFixture(scope); await ctx.store.create(scope, input);
      const results = await Promise.all([ctx.store.tryAccept(scope, input.id, alice), (ctx.second ?? ctx.store).tryAccept(scope, input.id, alice)]);
      expect(results.filter(Boolean)).toHaveLength(1);
      expect((await ctx.store.get(scope, input.id))!.status).toBe("accepted");
    }
  } },
  { name: "tenant isolation: foreign tenant cannot read, list, accept, reject or invalidate", async run(ctx) {
    const a = confirmationScope(); const b = confirmationScope(); const input = confirmationFixture(a); await ctx.store.create(a, input);
    expect(await ctx.store.get(b, input.id)).toBeNull(); expect(await ctx.store.listPending(b, alice)).toEqual([]);
    expect(await ctx.store.tryAccept(b, input.id, alice)).toBe(false); expect(await ctx.store.tryReject(b, input.id, alice)).toBe(false);
    await ctx.store.invalidate(b, input.id);
    expect((await ctx.store.get(a, input.id))!.status).toBe("pending");
    await expect(ctx.store.create(b, confirmationFixture(a))).rejects.toThrow();
  } },
  { name: "user ownership: pending lists and accept/reject never use another user's row", async run(ctx) {
    const scope = confirmationScope(); const input = confirmationFixture(scope); await ctx.store.create(scope, input);
    expect(await ctx.store.listPending(scope, bob)).toEqual([]);
    expect(await ctx.store.listPending(scope, alice)).toHaveLength(1);
    expect(await ctx.store.tryAccept(scope, input.id, bob)).toBe(false); expect(await ctx.store.tryReject(scope, input.id, bob)).toBe(false);
    expect((await ctx.store.get(scope, input.id))!.status).toBe("pending");
  } },
  { name: "expiry uses the store clock and exact boundary for accept/reject/list", async run(ctx) {
    const scope = confirmationScope(); const input = confirmationFixture(scope, { ttlSeconds: 2 }); await ctx.store.create(scope, input);
    await ctx.advanceSeconds(1); expect(await ctx.store.listPending(scope, alice)).toHaveLength(1);
    await ctx.advanceSeconds(1); expect(await ctx.store.listPending(scope, alice)).toEqual([]);
    expect(await ctx.store.tryAccept(scope, input.id, alice)).toBe(false); expect(await ctx.store.tryReject(scope, input.id, alice)).toBe(false);
    // The internal read retains the expired record for ConfirmationService to diagnose expiry.
    expect(await ctx.store.get(scope, input.id)).not.toBeNull();
  } },
  { name: "terminal states cannot resurrect or be overwritten by reject/invalidate/accept", async run(ctx) {
    const scope = confirmationScope();
    for (const terminal of ["accepted", "rejected", "invalidated"] as const) {
      const row = confirmationFixture(scope); await ctx.store.create(scope, row);
      if (terminal === "accepted") expect(await ctx.store.tryAccept(scope, row.id, alice)).toBe(true);
      else if (terminal === "rejected") expect(await ctx.store.tryReject(scope, row.id, alice)).toBe(true);
      else await ctx.store.invalidate(scope, row.id);
      expect(await ctx.store.tryAccept(scope, row.id, alice)).toBe(false); expect(await ctx.store.tryReject(scope, row.id, alice)).toBe(false);
      await ctx.store.invalidate(scope, row.id);
      expect((await ctx.store.get(scope, row.id))!.status).toBe(terminal);
      expect((await ctx.store.listPending(scope, alice)).some((item) => item.id === row.id)).toBe(false);
    }
  } },
  { name: "execution records only once after acceptance, never on pending/rejected/foreign state", async run(ctx) {
    const scope = confirmationScope(); const input = confirmationFixture(scope); await ctx.store.create(scope, input);
    await expect(ctx.store.recordExecution(scope, input.id, "succeeded")).rejects.toThrow();
    expect((await ctx.store.get(scope, input.id))!.executionStatus).toBe("none");
    expect(await ctx.store.tryAccept(scope, input.id, alice)).toBe(true);
    await ctx.advanceSeconds(11); // execution may finish after the confirmation lifetime
    await expect(ctx.store.recordExecution(confirmationScope(), input.id, "succeeded")).rejects.toThrow();
    await ctx.store.recordExecution(scope, input.id, "failed");
    await expect(ctx.store.recordExecution(scope, input.id, "succeeded")).rejects.toThrow();
    expect((await ctx.store.get(scope, input.id))!.executionStatus).toBe("failed");
  } },
  { name: "duplicate create never replaces consumed state, even after expiry", async run(ctx) {
    const scope = confirmationScope(); const input = confirmationFixture(scope); await ctx.store.create(scope, input);
    expect(await ctx.store.tryAccept(scope, input.id, alice)).toBe(true);
    await ctx.advanceSeconds(11);
    await expect(ctx.store.create(scope, input)).rejects.toThrow();
    expect((await ctx.store.get(scope, input.id))!.status).toBe("accepted");
  } },
  { name: "strict identifier spellings reject padding, controls, aliases and invalid UUIDs", async run(ctx) {
    const scope = confirmationScope(); const input = confirmationFixture(scope); await ctx.store.create(scope, input);
    for (const id of ["", "invalid", `{${input.id}}`, input.id.replaceAll("-", ""), ` ${input.id}`, `${input.id}\u200b`]) {
      await expect(ctx.store.get(scope, id as ConfirmationId)).rejects.toThrow();
      await expect(ctx.store.tryAccept(scope, id as ConfirmationId, alice)).rejects.toThrow();
    }
    for (const user of ["", " alice", "alice ", "alice\u0000", "alice\u200b", "alice\ud800"]) {
      await expect(ctx.store.listPending(scope, user as UserId)).rejects.toThrow();
      await expect(ctx.store.tryAccept(scope, input.id, user as UserId)).rejects.toThrow();
    }
    for (const tenantId of ["invalid", ` ${scope.tenantId}`, scope.tenantId.replaceAll("-", "")]) await expect(ctx.store.get({ tenantId: tenantId as TenantId }, input.id)).rejects.toThrow();
    expect(await ctx.store.get({ tenantId: scope.tenantId.toUpperCase() as TenantId }, input.id.toUpperCase() as ConfirmationId)).not.toBeNull();
  } },
  { name: "decisions use current store time and never mutate previously returned snapshots", async run(ctx) {
    const scope = confirmationScope(); const input = confirmationFixture(scope); await ctx.store.create(scope, input);
    const pending = await ctx.store.get(scope, input.id); await ctx.advanceSeconds(1);
    expect(await ctx.store.tryAccept(scope, input.id, alice)).toBe(true);
    const accepted = await ctx.store.get(scope, input.id);
    expect(accepted!.decidedAt).toBe(ctx.now()); expect(pending!.status).toBe("pending"); expect(pending!.decidedAt).toBeNull();
  } },
];
export function runConfirmationConformance(make: () => Promise<ConfirmationTestContext>): void {
  describe("ConfirmationStore conformance", () => {
    let ctx: ConfirmationTestContext;
    beforeEach(async () => { ctx = await make(); }); afterEach(async () => { await ctx?.dispose?.(); });
    for (const item of confirmationConformanceCases) it(item.name, async () => item.run(ctx), 30000);
  });
}
