import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { PostgresAuditStore } from "../postgres/audit.js";
import { withTenant } from "../postgres/tenant-tx.js";
import { auditEvent, runAuditConformance } from "./audit.conformance.js";
import { openStatePools } from "./state-pg-fixtures.js";

let app: Pool; let owner: Pool;
beforeAll(async () => { ({ app, owner } = await openStatePools(Pool)); });
// Audit rows are append-only: nothing is cleaned up, every test uses its own random tenants.
afterAll(async () => { await Promise.all([app?.end(), owner?.end()]); });

describe("PostgreSQL audit store, shared conformance", () => {
  runAuditConformance(async () => ({ store: new PostgresAuditStore(app) }));
});

describe("T094 PostgreSQL audit store: append-only and tenant isolation at the database", () => {
  it("as dap_app, UPDATE, DELETE and TRUNCATE all fail, and the stored row is untouched", async () => {
    const t = randomUUID(); const event = auditEvent(t);
    await new PostgresAuditStore(app).append(event);
    await withTenant(app, t, async (client) => {
      for (const statement of ["UPDATE public.sec_audit_events SET model='tampered'", "DELETE FROM public.sec_audit_events"]) {
        await client.query("SAVEPOINT s");
        await expect(client.query(statement), statement).rejects.toThrow(/permission denied/);
        await client.query("ROLLBACK TO SAVEPOINT s");
      }
      await client.query("SAVEPOINT s");
      await expect(client.query("TRUNCATE public.sec_audit_events")).rejects.toThrow(/permission denied/);
      await client.query("ROLLBACK TO SAVEPOINT s");
    });
    expect(await new PostgresAuditStore(app).listForTenant(t)).toEqual([event]);
  });

  it("even the table owner cannot rewrite or remove a row or truncate: the triggers refuse", async () => {
    const t = randomUUID(); const event = auditEvent(t);
    await new PostgresAuditStore(app).append(event);
    await withTenant(owner, t, async (client) => {
      await client.query("SAVEPOINT s");
      await expect(client.query("UPDATE public.sec_audit_events SET model='tampered' WHERE tenant_id=$1", [t])).rejects.toThrow(/append-only/);
      await client.query("ROLLBACK TO SAVEPOINT s");
      await expect(client.query("DELETE FROM public.sec_audit_events WHERE tenant_id=$1", [t])).rejects.toThrow(/append-only/);
      await client.query("ROLLBACK TO SAVEPOINT s");
    });
    expect(await new PostgresAuditStore(app).listForTenant(t)).toEqual([event]);
  });

  it("row-level security: with tenant A's setting, or none, dap_app sees no tenant B row, whatever the WHERE clause says", async () => {
    const a = randomUUID(); const b = randomUUID();
    const store = new PostgresAuditStore(app);
    const [ea, eb] = [auditEvent(a), auditEvent(b)];
    await store.append(ea); await store.append(eb);
    const asA = await withTenant(app, a, (client) => client.query("SELECT id, tenant_id FROM public.sec_audit_events WHERE tenant_id IN ($1,$2) OR id=$3", [a, b, eb.id]));
    expect(asA.rows).toEqual([{ id: ea.id, tenant_id: a }]);
    const none = await app.query("SELECT id FROM public.sec_audit_events WHERE tenant_id IN ($1,$2)", [a, b]);
    expect(none.rows).toEqual([]);
    const empty = await withTenant(app, "", (client) => client.query("SELECT id FROM public.sec_audit_events WHERE tenant_id=$1", [a]).catch(() => ({ rows: [] })));
    expect(empty.rows).toEqual([]);
  });

  it("an insert for another tenant than the transaction's is refused by the policy, and with no tenant setting too", async () => {
    const a = randomUUID(); const b = randomUUID(); const event = auditEvent(b);
    const insert = "INSERT INTO public.sec_audit_events (id,tenant_id,occurred_at,event_type,request_id,decision_id,user_id,ai_session_id,turn_id,model,params_view,outcome,reason) VALUES ($1,$2,now(),'AI_ACTION_DENIED','r','d','u','s','t','m','{}','DENIED','permission_missing')";
    await expect(withTenant(app, a, (client) => client.query(insert, [event.id, b]))).rejects.toThrow(/row-level security/);
    await expect(app.query(insert, [event.id, b])).rejects.toThrow(/row-level security/);
    expect(await new PostgresAuditStore(app).listForTenant(b)).toEqual([]);
  });

  it("the database refuses a malformed row on its own (closed enums, a decision without an outcome, an oversized view)", async () => {
    const t = randomUUID();
    const base = "id,tenant_id,occurred_at,event_type,request_id,decision_id,user_id,ai_session_id,turn_id,model,params_view,outcome,reason";
    const insert = (type: string, outcome: string | null, reason: string | null, view = "{}") => withTenant(app, t, (client) => client.query(`INSERT INTO public.sec_audit_events (${base}) VALUES ($1,$2,now(),$3,'r','d','u','s','t','m',$4::jsonb,$5,$6)`, [randomUUID(), t, type, view, outcome, reason]));
    await expect(insert("AI_SOMETHING_ELSE", null, null)).rejects.toThrow(/check constraint/);
    await expect(insert("AI_ACTION_DENIED", "MAYBE", "permission_missing")).rejects.toThrow(/check constraint/);
    await expect(insert("AI_ACTION_DENIED", null, null)).rejects.toThrow(/check constraint/);
    await expect(insert("AI_ACTION_PROPOSED", "DENIED", "permission_missing")).rejects.toThrow(/check constraint/);
    await expect(insert("AI_ACTION_DENIED", "DENIED", "permission_missing", "[]")).rejects.toThrow(/check constraint/);
    await expect(insert("AI_ACTION_DENIED", "DENIED", "permission_missing", JSON.stringify({ k: "x".repeat(70_000) }))).rejects.toThrow(/check constraint/);
    await expect(insert("AI_ACTION_PROPOSED", null, null)).resolves.toBeDefined(); // the control: a well-formed row goes in
  });

  it("every database failure is a generic error: no host, database, user or SQL text comes out of append or listForTenant", async () => {
    const dead = new Pool({ connectionString: "postgresql://canary_user_x:canary_pw_x@127.0.0.1:1/canary_db_x", connectionTimeoutMillis: 500 });
    try {
      const store = new PostgresAuditStore(dead);
      for (const attempt of [store.append(auditEvent(randomUUID())), store.listForTenant(randomUUID())]) {
        const error = await attempt.then(() => undefined, (thrown: unknown) => thrown as Error);
        expect(error).toBeInstanceOf(Error);
        const text = `${error!.name} ${error!.message} ${error!.stack ?? ""} ${JSON.stringify(Object.getOwnPropertyNames(error!).map((name) => String((error as unknown as Record<string, unknown>)[name])))}`;
        for (const secret of ["canary_user_x", "canary_pw_x", "canary_db_x", "127.0.0.1", "ECONNREFUSED", "sec_audit_events", "INSERT"]) expect(text, secret).not.toContain(secret);
      }
    } finally { await dead.end().catch(() => undefined); }
  });
});
