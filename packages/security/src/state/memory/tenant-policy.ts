import type { ActionId, TenantActionPolicyStore, TenantScope } from "@dap/contracts";

/**
 * In-memory `TenantActionPolicyStore` for tests and local development.
 *
 * Nested Maps (tenantId -> actionId -> disabled) so the composite key can never
 * collide on a separator, and an absent entry always means "not disabled".
 */
export class InMemoryTenantActionPolicyStore implements TenantActionPolicyStore {
  private readonly disabledByTenant = new Map<string, Map<string, boolean>>();

  async isDisabled(scope: TenantScope, actionId: ActionId): Promise<boolean> {
    return this.disabledByTenant.get(scope.tenantId)?.get(actionId) ?? false;
  }

  async setDisabled(scope: TenantScope, actionId: ActionId, disabled: boolean): Promise<void> {
    let byAction = this.disabledByTenant.get(scope.tenantId);
    if (byAction === undefined) {
      byAction = new Map<string, boolean>();
      this.disabledByTenant.set(scope.tenantId, byAction);
    }
    byAction.set(actionId, disabled);
  }
}
