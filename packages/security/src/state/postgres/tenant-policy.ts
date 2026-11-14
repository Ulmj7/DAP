import type { Pool } from "pg";
import type { ActionId, TenantActionPolicyStore, TenantScope } from "@dap/contracts";
import { withTenant } from "./tenant-tx.js";

/**
 * `TenantActionPolicyStore` backed by `sec_tenant_action_policy` (T048).
 *
 * Every read and write goes through `withTenant`, so the forced RLS policy
 * (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
 * scopes rows to the tenant even if this adapter is bypassed.
 */
export class PostgresTenantActionPolicyStore implements TenantActionPolicyStore {
  constructor(private readonly pool: Pool) {}

  async isDisabled(scope: TenantScope, actionId: ActionId): Promise<boolean> {
    const result = await withTenant(this.pool, scope.tenantId, (client) =>
      client.query(
        "SELECT disabled FROM public.sec_tenant_action_policy WHERE tenant_id = $1 AND action_id = $2",
        [scope.tenantId, actionId],
      ),
    );
    return result.rows[0]?.disabled === true;
  }

  async setDisabled(scope: TenantScope, actionId: ActionId, disabled: boolean, updatedBy: string): Promise<void> {
    await withTenant(this.pool, scope.tenantId, (client) =>
      client.query(
        `INSERT INTO public.sec_tenant_action_policy (tenant_id, action_id, disabled, updated_at, updated_by)
         VALUES ($1, $2, $3, now(), $4)
         ON CONFLICT (tenant_id, action_id)
         DO UPDATE SET disabled = EXCLUDED.disabled, updated_at = now(), updated_by = EXCLUDED.updated_by`,
        [scope.tenantId, actionId, disabled, updatedBy],
      ),
    );
  }
}
