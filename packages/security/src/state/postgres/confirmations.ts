import type { Pool, PoolClient } from "pg";
import type { ConfirmationId, ConfirmationRequest, ConfirmationStore, NewConfirmation, TenantScope, UserId } from "@dap/contracts";
import { captureConfirmationId, captureConfirmationTenant, captureConfirmationUser, captureExecutionStatus, captureNewConfirmation, LIST_PENDING_LIMIT } from "../confirmation-input.js";
import { checkedDate, databaseNow, resolveStateClock, type PostgresStateTestOptions } from "./state-runtime.js";
import { withTenant } from "./tenant-tx.js";

function rowsFrom(result: unknown, command: string, maximum: number): readonly unknown[] {
  if (!result || typeof result !== "object") throw new TypeError("Invalid confirmation SQL result");
  const { rows, rowCount, command: actual } = result as Record<string, unknown>;
  if (actual !== command || !Array.isArray(rows)) throw new TypeError("Invalid confirmation SQL result");
  const length: unknown = rows.length;
  if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0 || length > maximum || rowCount !== length) throw new TypeError("Invalid confirmation SQL row count");
  const captured: unknown[] = []; for (let index = 0; index < length; index++) captured.push(rows[index]);
  return captured;
}
function changed(result: unknown, id: ConfirmationId): boolean {
  const rows = rowsFrom(result, "UPDATE", 1);
  if (rows.length === 0) return false;
  const row = rows[0];
  if (!row || typeof row !== "object") throw new TypeError("Invalid confirmation update row");
  const handle: unknown = Reflect.get(row, "id");
  if (handle !== id) throw new TypeError("Invalid confirmation update binding");
  return true;
}
function stored(row: unknown): ConfirmationRequest {
  if (!row || typeof row !== "object") throw new TypeError("Invalid stored confirmation");
  // Every SQL field is captured exactly once before validation; nothing returns a driver's live object.
  const { id,tenant_id,user_id,request_id,action_id,definition_version,definition_hash,params,params_digest,resource_type,resource_id,risk,consequence,status,execution_status,created_at,expires_at,decided_at } = row as Record<string, unknown>;
  const created = checkedDate(created_at); const expires = checkedDate(expires_at);
  const decided = decided_at === null ? null : checkedDate(decided_at).toISOString();
  if (!["pending","accepted","rejected","invalidated"].includes(status as string) || !["none","succeeded","failed"].includes(execution_status as string) || (status === "pending") !== (decided === null) || (execution_status !== "none" && status !== "accepted")) throw new TypeError("Invalid confirmation state");
  const resource = resource_type === null && resource_id === null ? null : { type: resource_type, id: resource_id };
  const captured = captureNewConfirmation({ tenantId: tenant_id as never }, { id,tenantId:tenant_id,userId:user_id,requestId:request_id,actionId:action_id,definitionVersion:definition_version,definitionHash:definition_hash,params,paramsDigest:params_digest,resource,risk,consequence,ttlSeconds:(expires.getTime()-created.getTime())/1000 } as NewConfirmation);
  const { ttlSeconds, ...fields } = captured; void ttlSeconds;
  return Object.freeze({ ...fields, status, executionStatus:execution_status,createdAt:created.toISOString(),expiresAt:expires.toISOString(),decidedAt:decided }) as ConfirmationRequest;
}
export class PostgresConfirmationStore implements ConfirmationStore {
  private readonly clock: ReturnType<typeof resolveStateClock>;
  constructor(private readonly pool: Pool, options: PostgresStateTestOptions = {}) { this.clock = resolveStateClock(options); }
  private async testNow(client: PoolClient): Promise<Date | null> { return this.clock === databaseNow ? null : checkedDate(await this.clock(client)); }
  async create(scope: TenantScope, record: NewConfirmation): Promise<void> {
    const value = captureNewConfirmation(scope, record);
    await withTenant(this.pool, value.tenantId, async (client) => {
      const now = await this.testNow(client);
      const result = await client.query(`WITH instant AS (SELECT COALESCE($15::timestamptz,clock_timestamp()) AS t)
        INSERT INTO public.sec_confirmations (id,tenant_id,user_id,request_id,action_id,definition_version,definition_hash,params,params_digest,resource_type,resource_id,risk,consequence,created_at,expires_at)
        SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,t,t+$14*interval '1 second' FROM instant`,
        [value.id,value.tenantId,value.userId,value.requestId,value.actionId,value.definitionVersion,value.definitionHash,JSON.stringify(value.params),value.paramsDigest,value.resource?.type??null,value.resource?.id??null,value.risk,JSON.stringify(value.consequence),value.ttlSeconds,now]);
      const { command,rowCount,rows } = result;
      if (command !== "INSERT" || rowCount !== 1 || !Array.isArray(rows) || rows.length !== 0) throw new TypeError("Invalid confirmation create result");
    });
  }
  async get(scope: TenantScope, id: ConfirmationId): Promise<ConfirmationRequest | null> {
    const tenant = captureConfirmationTenant(scope); const handle = captureConfirmationId(id);
    return withTenant(this.pool, tenant, async (client) => {
      const rows = rowsFrom(await client.query("SELECT * FROM public.sec_confirmations WHERE tenant_id=$1 AND id=$2 AND status<>'expired'", [tenant,handle]), "SELECT", 1);
      if (rows.length === 0) return null;
      const row = stored(rows[0]); if (row.id !== handle || row.tenantId !== tenant) throw new TypeError("Invalid confirmation read binding");
      return row;
    });
  }
  async listPending(scope: TenantScope, userId: UserId): Promise<readonly ConfirmationRequest[]> {
    const tenant = captureConfirmationTenant(scope); const user = captureConfirmationUser(userId);
    return withTenant(this.pool, tenant, async (client) => {
      const now = await this.testNow(client);
      const rows = rowsFrom(await client.query("SELECT * FROM public.sec_confirmations WHERE tenant_id=$1 AND user_id=$2 AND status='pending' AND expires_at>COALESCE($3::timestamptz,clock_timestamp()) ORDER BY created_at,id LIMIT $4", [tenant,user,now,LIST_PENDING_LIMIT]), "SELECT", LIST_PENDING_LIMIT);
      return Object.freeze(rows.map((raw) => { const row = stored(raw); if (row.tenantId !== tenant || row.userId !== user || row.status !== "pending") throw new TypeError("Invalid pending confirmation binding"); return row; }));
    });
  }
  private async decide(scope: TenantScope, id: ConfirmationId, userId: UserId, status: "accepted" | "rejected"): Promise<boolean> {
    const tenant = captureConfirmationTenant(scope); const handle = captureConfirmationId(id); const user = captureConfirmationUser(userId);
    return withTenant(this.pool, tenant, async (client) => {
      const now = await this.testNow(client);
      // Exactly ONE atomic conditional UPDATE: the database, not a check-then-use read, elects the winner.
      return changed(await client.query("UPDATE public.sec_confirmations SET status=$5,decided_at=COALESCE($4::timestamptz,clock_timestamp()) WHERE tenant_id=$1 AND id=$2 AND user_id=$3 AND status='pending' AND expires_at>COALESCE($4::timestamptz,clock_timestamp()) RETURNING id", [tenant,handle,user,now,status]), handle);
    });
  }
  async tryAccept(scope: TenantScope, id: ConfirmationId, userId: UserId): Promise<boolean> { return this.decide(scope,id,userId,"accepted"); }
  async tryReject(scope: TenantScope, id: ConfirmationId, userId: UserId): Promise<boolean> { return this.decide(scope,id,userId,"rejected"); }
  async invalidate(scope: TenantScope, id: ConfirmationId): Promise<void> {
    const tenant = captureConfirmationTenant(scope); const handle = captureConfirmationId(id);
    await withTenant(this.pool, tenant, async (client) => { const now = await this.testNow(client); changed(await client.query("UPDATE public.sec_confirmations SET status='invalidated',decided_at=COALESCE($3::timestamptz,clock_timestamp()) WHERE tenant_id=$1 AND id=$2 AND status='pending' RETURNING id", [tenant,handle,now]), handle); });
  }
  async recordExecution(scope: TenantScope, id: ConfirmationId, status: "succeeded" | "failed"): Promise<void> {
    const tenant = captureConfirmationTenant(scope); const handle = captureConfirmationId(id); const execution = captureExecutionStatus(status);
    await withTenant(this.pool, tenant, async (client) => {
      const result = await client.query("UPDATE public.sec_confirmations SET execution_status=$3 WHERE tenant_id=$1 AND id=$2 AND status='accepted' AND execution_status='none' RETURNING id", [tenant,handle,execution]);
      if (!changed(result,handle)) throw new Error("Confirmation execution cannot be recorded");
    });
  }
}
