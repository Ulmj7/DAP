import { describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { assertCrossTenantStores } from "./cross-tenant-store.js";

/** Synthetic catalog evidence tests probe sensitivity; the separate DB suite proves actual isolation. */
function evidence(options: { enabled?: boolean; forced?: boolean; noTables?: boolean; leakA?: boolean; leakUnscoped?: boolean; acceptWrite?: boolean; missingFixture?: boolean; unsafeRole?: boolean } = {}): Pool {
  let tenant = ""; let seeded = false;
  const client = {
    release() {},
    async query(sql: string, values: unknown[] = []) {
      if (sql.includes("current_user")) return { rows: [{ name: "dap_app", rolsuper: options.unsafeRole ?? false, rolbypassrls: false }] };
      if (sql.includes("FROM pg_class")) return { rows: options.noTables ? [] : [{ oid: 1, schema: "public", name: "sec_probe", relrowsecurity: options.enabled ?? true, relforcerowsecurity: options.forced ?? true }] };
      if (sql.includes("FROM pg_attribute")) return { rows: [{ name: "tenant_id", type: "uuid", nullable: false, generated: false, enum_value: null }] };
      if (sql.startsWith("SELECT set_config")) { tenant = values[0] as string ?? ""; return { rows: [] }; }
      if (sql.startsWith("INSERT")) {
        if (seeded && !options.acceptWrite) throw Object.assign(new Error("RLS"), { code: "42501" });
        seeded = true; return { rows: [] };
      }
      if (sql.startsWith("SELECT tenant_id")) {
        const visible = !options.missingFixture && (tenant === "B" || (tenant === "A" && options.leakA) || (tenant === "" && options.leakUnscoped));
        return { rows: visible ? [{ tenant_id: "B" }] : [] };
      }
      if (["BEGIN", "ROLLBACK", "SAVEPOINT foreign_write", "ROLLBACK TO SAVEPOINT foreign_write"].includes(sql)) return { rows: [] };
      throw new Error(`Unexpected probe SQL: ${sql}`);
    },
  };
  return { connect: async () => client } as unknown as Pool;
}
const tenants = { tenantA: "A", tenantB: "B" };
describe("ATK-XTENANT-05 probe sensitivity", () => {
  it("accepts complete good evidence and discovers its table", async () => {
    expect(await assertCrossTenantStores(evidence(), tenants)).toEqual({ tables: ["public.sec_probe"], violations: [] });
  });
  it.each([
    [{ enabled: false }, "RLS must be enabled AND forced"],
    [{ forced: false }, "RLS must be enabled AND forced"],
    [{ leakA: true }, "foreign row visible as A"],
    [{ leakUnscoped: true }, "row visible without tenant"],
    [{ acceptWrite: true }, "foreign write accepted"],
    [{ missingFixture: true }, "missing positive B fixture"],
  ] as const)("rejects corrupted evidence %j", async (options, violation) => {
    expect((await assertCrossTenantStores(evidence(options), tenants)).violations).toContain(`public.sec_probe: ${violation}`);
  });
  it("fails loudly with no tables, unsafe role, or identical scopes", async () => {
    await expect(assertCrossTenantStores(evidence({ noTables: true }), tenants)).rejects.toThrow("no sec_* tables");
    await expect(assertCrossTenantStores(evidence({ unsafeRole: true }), tenants)).rejects.toThrow("dap_app");
    await expect(assertCrossTenantStores(evidence(), { tenantA: "A", tenantB: "A" })).rejects.toThrow("distinct tenants");
  });
});
