import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { PostgresConfirmationStore } from "../postgres/confirmations.js";
import { TEST_CLOCK } from "../postgres/state-runtime.js";
import { openStatePools } from "./state-pg-fixtures.js";
import { confirmationFixture, confirmationScope, runConfirmationConformance } from "./confirmation.conformance.js";
let app: Pool; let second: Pool; let owner: Pool;
beforeAll(async () => { ({ app, owner } = await openStatePools(Pool)); second = new Pool({ connectionString: process.env.DAP_DATABASE_URL, max: 4, connectionTimeoutMillis: 2000 }); });
afterAll(async () => { await Promise.all([app?.end(), second?.end(), owner?.end()]); });
runConfirmationConformance(async () => {
  let now = Date.parse("2099-01-01T00:00:00Z");
  const options = { [TEST_CLOCK]: async () => new Date(now) };
  return { store: new PostgresConfirmationStore(app, options), second: new PostgresConfirmationStore(second, options), now: () => new Date(now).toISOString() as never, advanceSeconds: async (seconds) => { now += seconds * 1000; } };
});
describe("PostgreSQL confirmation boundaries", () => {
  it("default timestamps come from the database clock, with TTL exactly preserved", async () => {
    const scope = confirmationScope(); const row = confirmationFixture(scope, { ttlSeconds: 37 });
    const before = (await app.query("SELECT clock_timestamp() AS now")).rows[0].now as Date;
    const store = new PostgresConfirmationStore(app); await store.create(scope, row);
    const after = (await app.query("SELECT clock_timestamp() AS now")).rows[0].now as Date;
    const got = await store.get(scope, row.id);
    expect(Date.parse(got!.createdAt)).toBeGreaterThanOrEqual(before.getTime()); expect(Date.parse(got!.createdAt)).toBeLessThanOrEqual(after.getTime());
    expect(Date.parse(got!.expiresAt)-Date.parse(got!.createdAt)).toBe(37000);
  });
  it("refuses named clocks/options and invalid ids before opening a connection", async () => {
    let connects = 0; const pool = { connect() { connects++; throw new Error("Unexpected query"); } } as unknown as Pool;
    expect(() => new PostgresConfirmationStore(pool, { now: async () => new Date() } as never)).toThrow();
    const store = new PostgresConfirmationStore(pool); const scope = confirmationScope();
    await expect(store.get(scope, "bad" as never)).rejects.toThrow();
    await expect(store.tryAccept(scope, "bad" as never, "alice" as never)).rejects.toThrow();
    await expect(store.listPending(scope, "alice\u200b" as never)).rejects.toThrow();
    await expect(store.create(scope, confirmationFixture(scope, { ttlSeconds: 0 }))).rejects.toThrow();
    await expect(store.create(scope, confirmationFixture(scope, { params: { nested: "bad\u0000text" } }))).rejects.toThrow();
    await expect(store.create(scope, confirmationFixture(scope, { params: { ["bad\u0000key"]: "value" } }))).rejects.toThrow();
    expect(connects).toBe(0);
  });
});
