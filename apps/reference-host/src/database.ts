import pg from "pg";

const requiredTables = ["sec_audit_events", "sec_replay_claims", "sec_rate_counters", "sec_rate_blocks", "sec_tenant_action_policy"];

export function createDatabase(databaseUrl: string) {
  const pool = new pg.Pool({
    connectionString: databaseUrl, max: 5, connectionTimeoutMillis: 1500,
    statement_timeout: 1500, query_timeout: 1800, idleTimeoutMillis: 10_000,
  });
  pool.on("error", () => { /* never log driver credentials */ });

  async function ready(): Promise<boolean> {
    try {
      // No fake audit inserts. Actual durable appends remain authoritative.
      const result = await pool.query<{ ready: boolean }>(`
        SELECT current_user = 'dap_app' AND NOT r.rolsuper AND NOT r.rolbypassrls
          AND NOT r.rolcreaterole AND NOT r.rolcreatedb AND NOT r.rolreplication
          AND NOT pg_has_role(current_user, 'dap_owner', 'MEMBER')
          AND (SELECT count(*) = 5 AND bool_and(c.relrowsecurity AND c.relforcerowsecurity
                AND pg_get_userbyid(c.relowner) = 'dap_owner'
                AND has_table_privilege(current_user, c.oid, 'SELECT'))
               FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
               WHERE n.nspname='public' AND c.relname = ANY($1::text[]))
          AND has_table_privilege(current_user, 'public.sec_audit_events', 'INSERT')
          AND has_table_privilege(current_user, 'public.sec_replay_claims', 'INSERT')
          AND has_table_privilege(current_user, 'public.sec_replay_claims', 'DELETE')
          AND has_table_privilege(current_user, 'public.sec_rate_counters', 'INSERT')
          AND has_table_privilege(current_user, 'public.sec_rate_counters', 'UPDATE')
          AND has_table_privilege(current_user, 'public.sec_rate_blocks', 'INSERT')
          AND has_table_privilege(current_user, 'public.sec_rate_blocks', 'UPDATE') AS ready
        FROM pg_roles r WHERE r.rolname=current_user`, [requiredTables]);
      return result.rows.length === 1 && result.rows[0]?.ready === true;
    } catch { return false; }
  }
  return { pool, ready };
}
