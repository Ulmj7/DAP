import { z } from "zod";
import type { PoolClient } from "pg";
import type { TenantScope } from "@dap/contracts";

const uuid = z.uuid();
export function captureStateInput(scope: TenantScope, key: string): { readonly tenantId: string; readonly key: string } {
  const tenantId: unknown = scope?.tenantId;
  if (!uuid.safeParse(tenantId).success) throw new TypeError("Security state requires a UUID tenant");
  // Rejected BEFORE any query: PostgreSQL text cannot hold NUL, and a lone surrogate has no UTF-8 form, so the driver
  // would silently turn two different keys into the same U+FFFD text.
  if (typeof key !== "string" || key.length < 1 || key.length > 1024 || key.includes("\u0000") || /\p{Cs}/u.test(key) || Buffer.byteLength(key, "utf8") > 1024) throw new TypeError("Invalid security state key");
  return { tenantId: (tenantId as string).toLowerCase(), key };
}
export function stateInteger(value: unknown, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > maximum) throw new TypeError("Invalid security state integer");
  return value;
}

/** Trusted composition-root seam for deterministic tests, never a model/SQL-callable override. */
export interface PostgresStateOptions { readonly now?: (client: PoolClient) => Promise<Date> }
export async function databaseNow(client: PoolClient): Promise<Date> {
  const result = await client.query("SELECT clock_timestamp() AS now");
  if (result.command !== "SELECT" || result.rowCount !== 1) throw new TypeError("Invalid database clock result");
  return checkedDate(result.rows[0]?.now);
}
export function checkedDate(value: unknown): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new TypeError("Invalid database clock");
  return new Date(value.getTime());
}
