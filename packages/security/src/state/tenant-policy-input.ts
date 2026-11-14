import { z } from "zod";
import type { ActionId, TenantId, TenantScope } from "@dap/contracts";

const uuid = z.uuid();
export function policyInput(scope: TenantScope, actionId: ActionId): { tenantId: TenantId; actionId: ActionId } {
  const tenantId: unknown = scope.tenantId;
  if (!uuid.safeParse(tenantId).success) throw new TypeError("Tenant policy requires a UUID tenant");
  if (typeof actionId !== "string" || actionId.length === 0 || actionId.includes("\u0000")) throw new TypeError("Tenant policy requires a text action id");
  // PostgreSQL's uuid type is case-insensitive; memory must use the same tenant identity.
  return Object.freeze({ tenantId: (tenantId as string).toLowerCase() as TenantId, actionId });
}

export function policyFlag(disabled: boolean): void {
  if (typeof disabled !== "boolean") throw new TypeError("Tenant policy requires a literal boolean flag");
}
