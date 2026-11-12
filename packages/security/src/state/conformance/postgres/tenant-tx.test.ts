import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { withTenant } from "../../postgres/tenant-tx.js";

const tenantA = "11111111-1111-4111-8111-111111111111";
const tenantB = "22222222-2222-4222-8222-222222222222";
const table = `public.tenant_tx_probe_${randomUUID().replaceAll("-", "")}`;
let app: Pool;
let owner: Pool;
let created = false;

// Live-DB tests live under conformance so `--project unit` needs no PostgreSQL.
describe("withTenant against forced PostgreSQL RLS as dap_app", () => {
  beforeAll(async () => {
    if (!process.env.DAP_DATABASE_URL || !process.env.DAP_MIGRATE_DATABASE_URL) {
      throw new Error(
        "PostgreSQL conformance requires DAP_DATABASE_URL (dap_app) and DAP_MIGRATE_DATABASE_URL " +
        "(dap_owner). Start postgres with docker compose -f deploy/compose.yaml up -d postgres " +
        "and run npm run db:migrate. These security tests must not be skipped.",
      );
    }
    app = new Pool({ connectionString: process.env.DAP_DATABASE_URL, max: 2, connectionTimeoutMillis: 2_000 });
    owner = new Pool({ connectionString: process.env.DAP_MIGRATE_DATABASE_URL, max: 1, connectionTimeoutMillis: 2_000 });
    try {
      await Promise.all([app.query("SELECT 1"), owner.query("SELECT 1")]);
    } catch (cause) {
      throw new Error(
        "PostgreSQL conformance cannot reach dap_app/dap_owner. Start deploy/compose.yaml postgres, " +
        "check DAP_DATABASE_URL and DAP_MIGRATE_DATABASE_URL, then run npm run db:migrate.",
        { cause },
      );
    }
    const { rows: [appRole] } = await app.query(
      "SELECT current_user AS name, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
    );
    expect(appRole).toEqual({ name: "dap_app", rolsuper: false, rolbypassrls: false });
    expect((await owner.query("SELECT current_user AS name")).rows).toEqual([{ name: "dap_owner" }]);
    expect((await app.query("SELECT pg_has_role(current_user, 'dap_owner', 'MEMBER') AS member")).rows)
      .toEqual([{ member: false }]);

    await owner.query(`CREATE TABLE ${table} (tenant_id uuid NOT NULL, marker text NOT NULL)`);
    created = true;
    await owner.query(`
      ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
      ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;
      CREATE POLICY tenant_scope ON ${table}
        USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
        WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
      GRANT SELECT, INSERT ON ${table} TO dap_app;
    `);
    // Seed as the owner, still subject to FORCED RLS, independently of withTenant.
    for (const tenantId of [tenantA, tenantB]) {
      await owner.query("BEGIN");
      try {
        await owner.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
        await owner.query(`INSERT INTO ${table} (tenant_id, marker) VALUES ($1, 'seed')`, [tenantId]);
        await owner.query("COMMIT");
      } catch (error) {
        await owner.query("ROLLBACK");
        throw error;
      }
    }
  });

  afterAll(async () => {
    try {
      if (created) await owner.query(`DROP TABLE ${table}`);
    } finally {
      await Promise.all([app?.end(), owner?.end()]);
    }
  });

  it("uses a table owned by dap_owner with RLS both enabled and forced", async () => {
    const result = await app.query(
      "SELECT pg_get_userbyid(relowner) AS owner, relrowsecurity, relforcerowsecurity " +
      "FROM pg_class WHERE oid = $1::regclass", [table],
    );
    expect(result.rows).toEqual([{ owner: "dap_owner", relrowsecurity: true, relforcerowsecurity: true }]);
  });

  it("returns no rows when the tenant setting has never been set", async () => {
    const unscoped = new Pool({ connectionString: process.env.DAP_DATABASE_URL, max: 1, connectionTimeoutMillis: 2_000 });
    try {
      expect((await unscoped.query("SELECT current_setting('app.tenant_id', true) AS tenant")).rows)
        .toEqual([{ tenant: null }]);
      expect((await unscoped.query(`SELECT * FROM ${table}`)).rows).toEqual([]);
      await expect(unscoped.query(`INSERT INTO ${table} VALUES ($1, 'unscoped')`, [tenantA]))
        .rejects.toMatchObject({ code: "42501" });
    } finally {
      await unscoped.end();
    }
  });

  it("exposes only the active tenant's rows (positive control)", async () => {
    const result = await withTenant(app, tenantA, (client) => client.query(`SELECT tenant_id FROM ${table}`));
    expect(result.rows).toEqual([{ tenant_id: tenantA }]);
  });

  it("returns no rows when another tenant's rows are requested", async () => {
    const result = await withTenant(app, tenantA, (client) =>
      client.query(`SELECT * FROM ${table} WHERE tenant_id = $1`, [tenantB]));
    expect(result.rows).toEqual([]);
  });

  it("rejects inserts for another tenant", async () => {
    await expect(withTenant(app, tenantA, (client) =>
      client.query(`INSERT INTO ${table} VALUES ($1, 'forbidden')`, [tenantB])))
      .rejects.toMatchObject({ code: "42501" });
    expect((await withTenant(app, tenantB, (client) =>
      client.query(`SELECT marker FROM ${table} WHERE marker = 'forbidden'`))).rows).toEqual([]);
  });

  it("commits successful work and returns the callback's result", async () => {
    const result = await withTenant(app, tenantA, async (client) => {
      await client.query(`INSERT INTO ${table} VALUES ($1, 'committed')`, [tenantA]);
      return "committed";
    });
    expect(result).toBe("committed");
    expect((await withTenant(app, tenantA, (client) =>
      client.query(`SELECT marker FROM ${table} WHERE marker = 'committed'`))).rows)
      .toEqual([{ marker: "committed" }]);
  });

  it("rolls back writes on a callback failure and preserves the original error", async () => {
    const failure = new Error("callback failure");
    await expect(withTenant(app, tenantA, async (client) => {
      await client.query(`INSERT INTO ${table} VALUES ($1, 'rolled-back')`, [tenantA]);
      throw failure;
    })).rejects.toBe(failure);
    expect((await withTenant(app, tenantA, (client) =>
      client.query(`SELECT marker FROM ${table} WHERE marker = 'rolled-back'`))).rows).toEqual([]);
  });

  it("rejects a transaction aborted by SQL even if the callback catches that error", async () => {
    await expect(withTenant(app, tenantA, async (client) => {
      await client.query(`INSERT INTO ${table} VALUES ($1, 'aborted')`, [tenantA]);
      await client.query("SELECT 1 / 0").catch(() => {});
      return "must not report success";
    })).rejects.toThrow("rolled back instead of committed");
    expect((await withTenant(app, tenantA, (client) =>
      client.query(`SELECT marker FROM ${table} WHERE marker = 'aborted'`))).rows).toEqual([]);
  });

  it("clears tenant context after commit and rollback before reusing a connection", async () => {
    const reused = new Pool({ connectionString: process.env.DAP_DATABASE_URL, max: 1, connectionTimeoutMillis: 2_000 });
    try {
      const pid = (await reused.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      for (const fail of [false, true]) {
        const operation = withTenant(reused, tenantA, async (client) => {
          expect((await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid).toBe(pid);
          expect((await client.query("SELECT current_setting('app.tenant_id', true) AS tenant")).rows)
            .toEqual([{ tenant: tenantA }]);
          if (fail) throw new Error("rollback");
        });
        if (fail) await expect(operation).rejects.toThrow("rollback");
        else await operation;
        // PostgreSQL resets a previously used custom setting to "", not SQL NULL.
        const outside = await reused.query("SELECT NULLIF(current_setting('app.tenant_id', true), '') AS tenant");
        expect(outside.rows).toEqual([{ tenant: null }]);
        expect((await withTenant(reused, tenantB, (client) =>
          client.query(`SELECT tenant_id FROM ${table} WHERE marker = 'seed'`))).rows)
          .toEqual([{ tenant_id: tenantB }]);
      }
    } finally {
      await reused.end();
    }
  });

  it("keeps simultaneous transactions for different tenants isolated", async () => {
    const results = await Promise.all([tenantA, tenantB].map((tenantId) =>
      withTenant(app, tenantId, async (client) => {
        await client.query("SELECT pg_sleep(0.01)");
        return client.query(`SELECT tenant_id FROM ${table} WHERE marker = 'seed'`);
      })));
    expect(results.map((result) => result.rows)).toEqual([
      [{ tenant_id: tenantA }], [{ tenant_id: tenantB }],
    ]);
  });
});
