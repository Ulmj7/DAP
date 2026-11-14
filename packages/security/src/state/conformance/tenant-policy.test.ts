import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import type { ActionId, TenantId } from "@dap/contracts";
import { withTenant } from "../postgres/tenant-tx.js";
import { InMemoryTenantActionPolicyStore } from "../memory/tenant-policy.js";
import { PostgresTenantActionPolicyStore } from "../postgres/tenant-policy.js";
import { runTenantPolicyConformance } from "./tenant-policy.conformance.js";

// Live-DB tests live under conformance so `--project unit` needs no PostgreSQL.

const TENANT_A = "11111111-1111-4111-8111-111111111111" as TenantId;
const TENANT_B = "22222222-2222-4222-8222-222222222222" as TenantId;

const freshActionId = (): ActionId => `conformance-${randomUUID()}` as ActionId;

describe("InMemoryTenantActionPolicyStore", () => {
  runTenantPolicyConformance(async () => {
    const store = new InMemoryTenantActionPolicyStore();
    return { store, setDisabled: (scope, actionId, disabled) => store.setDisabled(scope, actionId, disabled) };
  });
});

let app: Pool;
let owner: Pool;

describe("PostgresTenantActionPolicyStore", () => {
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
    // The sec_ table must exist; fail loudly and point at the migration.
    const { rows: [table] } = await owner.query(
      "SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'sec_tenant_action_policy'",
    );
    if (!table) {
      throw new Error("sec_tenant_action_policy is missing. Run npm run db:migrate before the conformance suite.");
    }
  });

  afterAll(async () => {
    // Conformance rows use `conformance-` action ids; clean both tenants as owner.
    for (const tenantId of [TENANT_A, TENANT_B]) {
      await owner.query("BEGIN");
      await owner.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      await owner.query("DELETE FROM public.sec_tenant_action_policy WHERE action_id LIKE 'conformance-%'");
      await owner.query("COMMIT");
    }
    await app.end();
    await owner.end();
  });

  runTenantPolicyConformance(async () => {
    const store = new PostgresTenantActionPolicyStore(app);
    return {
      store,
      setDisabled: (scope, actionId, disabled) => store.setDisabled(scope, actionId, disabled, "conformance-test"),
    };
  });

  it("keeps tenant A rows invisible to tenant B and to an unscoped connection", async () => {
    const store = new PostgresTenantActionPolicyStore(app);
    const id = freshActionId();
    await store.setDisabled({ tenantId: TENANT_A }, id, true, "probe");
    // Same action id under tenant B's RLS context: zero rows.
    const asB = await withTenant(app, TENANT_B, (client) =>
      client.query("SELECT disabled FROM public.sec_tenant_action_policy WHERE action_id = $1", [id]),
    );
    expect(asB.rows).toEqual([]);
    // No app.tenant_id at all: NULLIF(...) is NULL, zero rows, no 22P02 cast error.
    const unscoped = new Pool({ connectionString: process.env.DAP_DATABASE_URL, max: 1, connectionTimeoutMillis: 2_000 });
    try {
      const asNobody = await unscoped.query(
        "SELECT disabled FROM public.sec_tenant_action_policy WHERE action_id = $1",
        [id],
      );
      expect(asNobody.rows).toEqual([]);
    } finally {
      await unscoped.end();
    }
  });

  it("rejects writing a row for a different tenant (RLS WITH CHECK)", async () => {
    const id = freshActionId();
    await expect(
      withTenant(app, TENANT_A, (client) =>
        client.query(
          "INSERT INTO public.sec_tenant_action_policy (tenant_id, action_id, disabled, updated_by) VALUES ($1, $2, false, 'attacker')",
          [TENANT_B, id],
        ),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });
});
