import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool, type PoolClient } from "pg";
import { openStatePools } from "./state-pg-fixtures.js";

let app: Pool; let owner: Pool;
beforeAll(async () => { ({ app, owner } = await openStatePools(Pool)); });
afterAll(async () => { await Promise.all([app?.end(), owner?.end()]); });
async function transaction(pool: Pool, action: (client: PoolClient, tenant: string, id: string) => Promise<void>) {
  const client = await pool.connect(); const tenant = randomUUID(); const id = randomUUID();
  try { await client.query("BEGIN"); await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenant]); await action(client, tenant, id); }
  finally { await client.query("ROLLBACK"); client.release(); }
}
async function seed(client: PoolClient, tenant: string, id: string, expired = false) {
  await client.query(`INSERT INTO public.sec_confirmations
    (id,tenant_id,user_id,request_id,action_id,definition_version,definition_hash,params,params_digest,resource_type,resource_id,risk,consequence,created_at,expires_at)
    VALUES ($1,$2,'alice','request','publishDocument',1,$3,'{}',$3,NULL,NULL,'HIGH',$4,
      now()-interval '600 seconds',now()+$5*interval '1 second')`, [id, tenant, "a".repeat(64), JSON.stringify({ title: "Publish", effects: ["Visible"], irreversible: false }), expired ? -300 : 300]);
}
async function refused(client: PoolClient, sql: string, values: unknown[]) {
  await client.query("SAVEPOINT probe");
  try { await expect(client.query(sql, values)).rejects.toMatchObject({ code: "42501" }); }
  finally { await client.query("ROLLBACK TO SAVEPOINT probe"); }
}
describe("T102 confirmations database boundary", () => {
  it("pins owner, forced RLS, column-only UPDATE and no DELETE/TRUNCATE", async () => {
    expect((await app.query("SELECT pg_get_userbyid(relowner) AS owner,relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='public.sec_confirmations'::regclass")).rows).toEqual([{ owner: "dap_owner", relrowsecurity: true, relforcerowsecurity: true }]);
    for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"]) expect((await app.query("SELECT has_table_privilege('dap_app','public.sec_confirmations',$1) AS allowed", [privilege])).rows).toEqual([{ allowed: ["SELECT", "INSERT"].includes(privilege) }]);
    const columns = await app.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='sec_confirmations' ORDER BY ordinal_position");
    for (const { column_name } of columns.rows) expect((await app.query("SELECT has_column_privilege('dap_app','public.sec_confirmations',$1,'UPDATE') AS allowed", [column_name])).rows).toEqual([{ allowed: ["status", "execution_status", "decided_at"].includes(column_name) }]);
    const { rows } = await app.query("SELECT policyname,cmd,qual,with_check FROM pg_policies WHERE tablename='sec_confirmations' ORDER BY policyname");
    expect(rows.map((row) => row.cmd).sort()).toEqual(["INSERT", "SELECT", "UPDATE"]);
    for (const row of rows) expect(`${row.qual ?? ''} ${row.with_check ?? ''}`).toContain("NULLIF(current_setting('app.tenant_id'");
    expect((await app.query("SELECT 1 FROM pg_class c,LATERAL aclexplode(c.relacl) a WHERE c.oid='public.sec_confirmations'::regclass AND a.grantee=0")).rows).toEqual([]);
  });
  it("reapplication restores least privilege and its state/binding/expiry triggers", async () => {
    await transaction(owner, async (client, tenant, id) => {
      await client.query("GRANT UPDATE,DELETE,TRUNCATE ON public.sec_confirmations TO dap_app");
      await client.query("GRANT UPDATE (id) ON public.sec_confirmations TO dap_app");
      // PostgreSQL 16 REVOKE ALL ON TABLE clears attacl as well; see both before/after checks.
      expect((await client.query("SELECT has_column_privilege('dap_app','public.sec_confirmations','id','UPDATE') AS allowed")).rows).toEqual([{ allowed:true }]);
      await client.query(await readFile(new URL("../../../../../db/migrations/030_sec_confirmations.sql", import.meta.url), "utf8"));
      for (const privilege of ["UPDATE","DELETE","TRUNCATE"]) expect((await client.query("SELECT has_table_privilege('dap_app','public.sec_confirmations',$1) AS allowed",[privilege])).rows).toEqual([{ allowed:false }]);
      expect((await client.query("SELECT has_column_privilege('dap_app','public.sec_confirmations','id','UPDATE') AS allowed")).rows).toEqual([{ allowed:false }]);
      await seed(client,tenant,id);
      await refused(client,"UPDATE public.sec_confirmations SET definition_hash=repeat('b',64) WHERE id=$1",[id]);
      await refused(client,"UPDATE public.sec_confirmations SET execution_status='succeeded' WHERE id=$1",[id]);
      await client.query("UPDATE public.sec_confirmations SET status='accepted',decided_at=clock_timestamp() WHERE id=$1",[id]);
      await refused(client,"UPDATE public.sec_confirmations SET status='rejected' WHERE id=$1",[id]);
      await client.query("UPDATE public.sec_confirmations SET execution_status='failed' WHERE id=$1",[id]);
      await refused(client,"UPDATE public.sec_confirmations SET execution_status='succeeded' WHERE id=$1",[id]);
      const expired=randomUUID(); await seed(client,tenant,expired,true);
      await refused(client,"UPDATE public.sec_confirmations SET status='accepted',decided_at=clock_timestamp() WHERE id=$1",[expired]);
      await client.query("SELECT set_config('app.tenant_id','',true)");
      expect((await client.query("SELECT id FROM public.sec_confirmations WHERE id=$1",[id])).rows).toEqual([]);
    });
  });
  it("as dap_app, B is visible only under B and no setting means no rows; foreign insert is denied", async () => {
    await transaction(app, async (client, tenant, id) => {
      await seed(client, tenant, id);
      expect((await client.query("SELECT id FROM public.sec_confirmations WHERE id=$1", [id])).rows).toHaveLength(1);
      await client.query("SELECT set_config('app.tenant_id',$1,true)", [randomUUID()]);
      expect((await client.query("SELECT id FROM public.sec_confirmations WHERE id=$1", [id])).rows).toEqual([]);
      await refused(client, "INSERT INTO public.sec_confirmations SELECT * FROM jsonb_populate_record(NULL::public.sec_confirmations,$1::jsonb)", [JSON.stringify({ id: randomUUID(), tenant_id: tenant, user_id: "alice", request_id: "r", action_id: "publishDocument", definition_version: 1, definition_hash: "a".repeat(64), params: {}, params_digest: "a".repeat(64), resource_type: null, resource_id: null, risk: "HIGH", consequence: { title: "Publish", effects: [], irreversible: false }, status: "pending", execution_status: "none", created_at: "2020-01-01T00:00:00Z", expires_at: "2020-01-01T00:05:00Z", decided_at: null })]);
      await client.query("SELECT set_config('app.tenant_id','',true)");
      expect((await client.query("SELECT id FROM public.sec_confirmations WHERE id=$1", [id])).rows).toEqual([]);
    });
  });
  it("even owner SQL cannot modify any bound field", async () => {
    const updates = ["id=$2", "tenant_id=$2", "user_id='bob'", "request_id='other'", "action_id='otherAction'", "definition_version=2", "definition_hash=repeat('b',64)", "params='{}'::jsonb || '{\"changed\":true}'::jsonb", "params_digest=repeat('b',64)", "resource_type='document'", "resource_id='other'", "risk='CRITICAL'", "consequence='{}'::jsonb", "created_at=created_at-interval '1 second'", "expires_at=expires_at+interval '1 second'"];
    await transaction(owner, async (client, tenant, id) => {
      await seed(client, tenant, id);
      for (const update of updates) await refused(client, `UPDATE public.sec_confirmations SET ${update} WHERE id=$1`, update.includes("$2") ? [id, randomUUID()] : [id]);
    });
  });
  it("pending-only decisions and accepted-only one-shot execution cannot be bypassed with raw SQL", async () => {
    await transaction(app, async (client, tenant, id) => {
      await seed(client, tenant, id);
      await refused(client, "UPDATE public.sec_confirmations SET execution_status='succeeded' WHERE id=$1", [id]);
      await client.query("UPDATE public.sec_confirmations SET status='accepted',decided_at=clock_timestamp() WHERE id=$1", [id]);
      for (const status of ["pending", "rejected", "invalidated", "expired"]) await refused(client, "UPDATE public.sec_confirmations SET status=$2 WHERE id=$1", [id, status]);
      await client.query("UPDATE public.sec_confirmations SET execution_status='failed' WHERE id=$1", [id]);
      await refused(client, "UPDATE public.sec_confirmations SET execution_status='succeeded' WHERE id=$1", [id]);
    });
    await transaction(app, async (client, tenant, id) => {
      await seed(client, tenant, id, true);
      await refused(client, "UPDATE public.sec_confirmations SET status='accepted',decided_at=clock_timestamp() WHERE id=$1", [id]);
      await client.query("UPDATE public.sec_confirmations SET status='expired',decided_at=clock_timestamp() WHERE id=$1", [id]);
      await refused(client, "UPDATE public.sec_confirmations SET status='pending',decided_at=NULL WHERE id=$1", [id]);
    });
  });
});
