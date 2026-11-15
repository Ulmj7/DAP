import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { mintAuthorizationContext } from "@dap/contracts/mint";
import { createAuditReader } from "../../audit/audit-reader.js";
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

  it("dap_app cannot bypass append-only controls through role, trigger, replication, truncate or upsert privileges", async () => {
    expect((await app.query("SELECT pg_has_role(current_user,'dap_owner','MEMBER') AS member, rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user")).rows).toEqual([{ member: false, rolsuper: false, rolbypassrls: false }]);
    expect((await app.query("SELECT prosecdef, has_function_privilege('dap_app',oid,'EXECUTE') AS executable FROM pg_proc WHERE oid='public.sec_audit_events_refuse()'::regprocedure")).rows).toEqual([{ prosecdef: false, executable: false }]);
    const t = randomUUID(); const event = auditEvent(t); await new PostgresAuditStore(app).append(event);
    await withTenant(app, t, async (client) => {
      for (const sql of ["SET ROLE dap_owner", "SET LOCAL session_replication_role='replica'", "ALTER TABLE public.sec_audit_events DISABLE TRIGGER ALL", "ALTER TABLE public.sec_audit_events DISABLE ROW LEVEL SECURITY", "TRUNCATE public.sec_audit_events CASCADE", "INSERT INTO public.sec_audit_events (id) VALUES ('" + event.id + "') ON CONFLICT (id) DO UPDATE SET model='changed'"]) {
        await client.query("SAVEPOINT s");
        await expect(client.query(sql)).rejects.toMatchObject({ code: "42501" });
        await client.query("ROLLBACK TO SAVEPOINT s");
      }
      await client.query("SAVEPOINT s");
      await expect(client.query("COPY public.sec_audit_events FROM STDIN")).rejects.toMatchObject({ code: "0A000" });
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
    const empty = await withTenant(app, "", (client) => client.query("SELECT id FROM public.sec_audit_events WHERE tenant_id=$1", [a]));
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

  it("a decision cannot omit only one of outcome/reason or use an unknown reason", async () => {
    const t = randomUUID();
    for (const [outcome, reason] of [[null, "permission_missing"], ["DENIED", null], ["DENIED", "made_up_reason"]]) {
      await expect(withTenant(app, t, (client) => client.query("INSERT INTO public.sec_audit_events (id,tenant_id,occurred_at,event_type,request_id,decision_id,user_id,ai_session_id,turn_id,model,params_view,outcome,reason) VALUES ($1,$2,now(),'AI_ACTION_DENIED','r','d','u','s','t','m','{}',$3,$4)", [randomUUID(), t, outcome, reason]))).rejects.toThrow(/check constraint/);
    }
  });

  it("preserves microseconds: a retry succeeds, but a distinct instant in the same millisecond is not the same body", async () => {
    const t = randomUUID(); const id = randomUUID(); const store = new PostgresAuditStore(app);
    const event = auditEvent(t, { id, occurredAt: "2026-01-01T00:00:10.123456Z" });
    await store.append(event);
    await expect(store.append(event)).resolves.toBeUndefined();
    expect((await store.listForTenant(t))[0]!.occurredAt).toBe(event.occurredAt);
    await expect(store.append(auditEvent(t, { id, occurredAt: "2026-01-01T00:00:10.123999Z" }))).rejects.toThrow("Audit store unavailable");
  });

  it("does not equate a different jsonb number after the JS parser rounds it", async () => {
    const t = randomUUID(); const event = auditEvent(t, { paramsView: { n: 9007199254740992 } });
    await withTenant(app, t, (client) => client.query("INSERT INTO public.sec_audit_events (id,tenant_id,occurred_at,event_type,request_id,decision_id,user_id,ai_session_id,turn_id,model,action_id,definition_version,params_view,risk,outcome,reason) VALUES ($1,$2,$3,'AI_ACTION_DENIED','req-1','dec-1','alice','session-1','turn-1','scripted','testSafeEcho',1,'{\"n\":9007199254740993}','SAFE','DENIED','permission_missing')", [event.id,t,event.occurredAt]));
    await expect(new PostgresAuditStore(app).append(event)).rejects.toThrow("Audit store unavailable");
  });

  it("replays JSON numeric negative zero in its jsonb normal form", async () => {
    const store = new PostgresAuditStore(app); const event = auditEvent(randomUUID(), { paramsView: { n: -0 } });
    await store.append(event);
    await expect(store.append(event)).resolves.toBeUndefined();
  });

  it("round-trips builder-valid versions above the PostgreSQL int4 range", async () => {
    const t = randomUUID(); const store = new PostgresAuditStore(app);
    const event = auditEvent(t, { action: { kind: "registered", id: "testSafeEcho", version: 2147483648 } });
    await store.append(event);
    expect(await store.listForTenant(t)).toEqual([event]);
  });

  it("handles idle-pool errors without throwing driver text or adding a listener per store", async () => {
    const pool = new Pool({ connectionString: process.env.DAP_DATABASE_URL, max: 1 });
    try {
      new PostgresAuditStore(pool); new PostgresAuditStore(pool);
      expect(pool.listenerCount("error")).toBe(1);
      expect(() => pool.emit("error", new Error("CANARY driver host password"))).not.toThrow();
      expect((await pool.query("SELECT 1 AS ok")).rows).toEqual([{ ok: 1 }]);
    } finally { await pool.end(); }
  });

  it("read-only failures do not exhaust a one-client pool", async () => {
    const pool = new Pool({ connectionString: process.env.DAP_DATABASE_URL, options: "-c default_transaction_read_only=on", max: 1, connectionTimeoutMillis: 500 });
    try {
      const store = new PostgresAuditStore(pool);
      for (let i = 0; i < 12; i++) await expect(store.append(auditEvent(randomUUID()))).rejects.toThrow("Audit store unavailable");
      expect(pool.waitingCount).toBe(0); expect(pool.idleCount).toBe(1); expect(pool.totalCount).toBe(1);
      expect((await pool.query("SELECT 1 AS ok")).rows).toEqual([{ ok: 1 }]);
    } finally { await pool.end(); }
  });

  it("the reviewer uses SQL filters BEFORE a bounded limit, never the full-history source", async () => {
    const t = randomUUID(); const store = new PostgresAuditStore(app);
    const earlier = auditEvent(t, { user: "bob" });
    const match = auditEvent(t, { user: "alice", requestId: "needle", occurredAt: "2026-01-01T00:00:11.000Z" });
    await store.append(earlier); await store.append(match); await store.append(auditEvent(t, { user: "alice", requestId: "needle", occurredAt: "2026-01-01T00:00:12.000Z" }));
    const ctx = mintAuthorizationContext({ tenantId: t, userId: "reviewer", sessionId: "s", authenticatedAt: "2026-01-01T00:00:00Z", validUntil: "2026-01-01T01:00:00Z" });
    const reader = createAuditReader({ listForTenant: () => { throw new Error("unbounded path must not run"); }, queryForTenant: store.queryForTenant.bind(store) });
    expect(await reader.query(ctx, { requestId: "needle" as never, userId: "alice" as never, types: ["AI_ACTION_DENIED"], from: "2026-01-01T00:00:11Z" as never, to: "2026-01-01T00:00:12Z" as never, limit: 1 })).toEqual([match]);
    await expect(store.queryForTenant(t, { limit: 0 })).rejects.toThrow();
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
