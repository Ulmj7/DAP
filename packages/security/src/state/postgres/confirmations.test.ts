import { describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { PostgresConfirmationStore } from "./confirmations.js";
import { confirmationFixture, confirmationScope } from "../conformance/confirmation.conformance.js";

/** SQL-result boundary tests only; actual state transitions are proven separately against PostgreSQL. */
function poolFor(result: unknown) {
  const commands: string[] = [];
  const pool = { async connect() { return {
    async query(sql: string) {
      commands.push(sql);
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { command: sql, rows: [], rowCount: null };
      if (sql.startsWith("SELECT set_config")) return { command: "SELECT", rows: [{}], rowCount: 1 };
      return result;
    }, release() {},
  }; } } as unknown as Pool;
  return { pool, commands };
}
describe("T103 captured SQL result metadata", () => {
  it("reads command/count/rows and returned handle exactly once", async () => {
    const scope = confirmationScope(); const input = confirmationFixture(scope); const reads = { command: 0, count: 0, rows: 0, id: 0 };
    const answer = { get command() { if (++reads.command > 1) throw new Error("repeat"); return "UPDATE"; }, get rowCount() { if (++reads.count > 1) throw new Error("repeat"); return 1; }, get rows() { if (++reads.rows > 1) throw new Error("repeat"); return [{ get id() { if (++reads.id > 1) throw new Error("repeat"); return input.id; } }]; } };
    const { pool } = poolFor(answer);
    await expect(new PostgresConfirmationStore(pool).recordExecution(scope,input.id,"succeeded")).resolves.toBeUndefined();
    expect(reads).toEqual({ command: 1, count: 1, rows: 1, id: 1 });
  });
  it.each([{}, null, { command: "SELECT", rowCount: 1, rows: [{}] }, { command: "UPDATE", rowCount: 2, rows: [] }, { command: "UPDATE", rowCount: 1, rows: [{ id: "wrong" }] }])("invalid write evidence %j rolls back", async (answer) => {
    const scope = confirmationScope(); const input = confirmationFixture(scope); const { pool, commands } = poolFor(answer);
    await expect(new PostgresConfirmationStore(pool).recordExecution(scope,input.id,"failed")).rejects.toThrow();
    expect(commands.at(-1)).toBe("ROLLBACK");
  });
  it.each([
    { command:"SELECT",rowCount:2,rows:[] },
    { command:"UPDATE",rowCount:0,rows:[] },
    { command:"SELECT",rowCount:0,rows:{length:0} },
    { command:"SELECT",rowCount:-1,rows:new Proxy([],{get(target,key,receiver){return key==="length"?-1:Reflect.get(target,key,receiver);}}) },
  ])("malformed read evidence cannot masquerade as a missing row", async (answer) => {
    const scope=confirmationScope();const row=confirmationFixture(scope);const {pool}=poolFor(answer);
    await expect(new PostgresConfirmationStore(pool).get(scope,row.id)).rejects.toThrow();
  });

});
