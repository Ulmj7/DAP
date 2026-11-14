import type { ActionId, ActionRegistry, RegistrationIssue, TenantActionPolicyStore, TenantScope } from "@dap/contracts";
import { RegistrationError } from "./registration-error.js";

export interface EnablementPolicy {
  isEnabled(scope: TenantScope, actionId: string): Promise<boolean>;
}

export function createEnablementPolicy({ registry, globalAllowlist = new Set<ActionId>(), tenantPolicy }: {
  readonly registry: ActionRegistry;
  readonly globalAllowlist?: ReadonlySet<ActionId>;
  readonly tenantPolicy: TenantActionPolicyStore;
}): EnablementPolicy {
  const allowlist = new Set(globalAllowlist);
  const issues: RegistrationIssue[] = [];
  for (const id of allowlist) {
    const action = registry.get(id);
    if (!action) issues.push({ actionId: id, rule: "R1", detail: "global allowlist contains an unknown action id" });
    else if (action.definition.risk === "FORBIDDEN") issues.push({ actionId: id, rule: "R7", detail: "global allowlist cannot enable a FORBIDDEN action" });
  }
  if (issues.length > 0) throw new RegistrationError(issues);
  return Object.freeze({
    async isEnabled(scope: TenantScope, actionId: string): Promise<boolean> {
      const entry = registry.get(actionId);
      if (!entry || entry.definition.risk === "FORBIDDEN" || !allowlist.has(entry.definition.id)) return false;
      return await tenantPolicy.isDisabled(scope, entry.definition.id) === false;
    },
  });
}
