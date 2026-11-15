import { z } from "zod";
import type { Clock, ConfirmationId, ConfirmationRequest, ConfirmationStore, IsoInstant, NewConfirmation, TenantScope, UserId } from "@dap/contracts";
import { captureConfirmationId, captureConfirmationTenant, captureConfirmationUser, captureExecutionStatus, captureNewConfirmation, LIST_PENDING_LIMIT } from "../confirmation-input.js";

/**
 * DEV/TEST ONLY, process-local. Keep consumed/expired handles as tombstones: no UUID may be resurrected.
 * The hard process-wide cap (default 1000, maximum 10000 records of at most 64 KiB each) fails closed
 * when full; one user can exhaust it for all tenants. Production uses the PostgreSQL store.
 */
export class InMemoryConfirmationStore implements ConfirmationStore {
  private readonly rows = new Map<ConfirmationId, ConfirmationRequest>();
  private readonly readClock: () => IsoInstant;
  private readonly capacity: number;
  private lastNow = -Infinity;
  constructor(clock: Clock, options: { readonly maxEntries?: number } = {}) {
    const parsed = z.strictObject({ maxEntries: z.number().int().min(1).max(10000).optional() }).parse(options);
    this.capacity = parsed.maxEntries ?? 1000; this.readClock = clock.now.bind(clock);
  }
  private now(): number {
    const value: unknown = this.readClock();
    if (!z.iso.datetime({ offset: true }).safeParse(value).success) throw new TypeError("Invalid confirmation store clock");
    const now = Date.parse(value as string);
    if (!Number.isFinite(now) || now < this.lastNow) throw new TypeError("Invalid confirmation store clock");
    this.lastNow = now; return now;
  }
  private row(tenant: string, id: ConfirmationId): ConfirmationRequest | null {
    const row = this.rows.get(id); return row?.tenantId === tenant ? row : null;
  }
  async create(scope: TenantScope, record: NewConfirmation): Promise<void> {
    const captured = captureNewConfirmation(scope, record); const now = this.now();
    const { ttlSeconds, ...fields } = captured;
    const expires = now + ttlSeconds * 1000;
    if (!Number.isSafeInteger(expires) || Math.abs(expires) > 8.64e15) throw new TypeError("Invalid confirmation expiry");
    if (this.rows.has(captured.id)) throw new Error("Duplicate confirmation");
    if (this.rows.size >= this.capacity) throw new Error("Confirmation capacity exhausted");
    const row = Object.freeze({ ...fields, status: "pending", executionStatus: "none", createdAt: new Date(now).toISOString(), expiresAt: new Date(expires).toISOString(), decidedAt: null }) as ConfirmationRequest;
    this.rows.set(captured.id, row);
  }
  async get(scope: TenantScope, id: ConfirmationId): Promise<ConfirmationRequest | null> {
    const tenant = captureConfirmationTenant(scope); const handle = captureConfirmationId(id); this.now();
    return this.row(tenant, handle);
  }
  async listPending(scope: TenantScope, userId: UserId): Promise<readonly ConfirmationRequest[]> {
    const tenant = captureConfirmationTenant(scope); const user = captureConfirmationUser(userId); const now = this.now();
    return Object.freeze([...this.rows.values()].filter((row) => row.tenantId === tenant && row.userId === user && row.status === "pending" && Date.parse(row.expiresAt) > now)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)).slice(0, LIST_PENDING_LIMIT));
  }
  private decide(scope: TenantScope, id: ConfirmationId, userId: UserId, status: "accepted" | "rejected"): boolean {
    const tenant = captureConfirmationTenant(scope); const handle = captureConfirmationId(id); const user = captureConfirmationUser(userId); const now = this.now();
    const row = this.row(tenant, handle);
    // Synchronous check/update: competing calls cannot both consume the pending state.
    if (!row || row.userId !== user || row.status !== "pending" || Date.parse(row.expiresAt) <= now) return false;
    this.rows.set(handle, Object.freeze({ ...row, status, decidedAt: new Date(now).toISOString() as IsoInstant })); return true;
  }
  async tryAccept(scope: TenantScope, id: ConfirmationId, userId: UserId): Promise<boolean> { return this.decide(scope, id, userId, "accepted"); }
  async tryReject(scope: TenantScope, id: ConfirmationId, userId: UserId): Promise<boolean> { return this.decide(scope, id, userId, "rejected"); }
  async invalidate(scope: TenantScope, id: ConfirmationId): Promise<void> {
    const tenant = captureConfirmationTenant(scope); const handle = captureConfirmationId(id); const now = this.now(); const row = this.row(tenant, handle);
    if (row?.status === "pending") this.rows.set(handle, Object.freeze({ ...row, status: "invalidated", decidedAt: new Date(now).toISOString() as IsoInstant }));
  }
  async recordExecution(scope: TenantScope, id: ConfirmationId, status: "succeeded" | "failed"): Promise<void> {
    const tenant = captureConfirmationTenant(scope); const handle = captureConfirmationId(id); const execution = captureExecutionStatus(status); this.now(); const row = this.row(tenant, handle);
    if (!row || row.status !== "accepted" || row.executionStatus !== "none") throw new Error("Confirmation execution cannot be recorded");
    this.rows.set(handle, Object.freeze({ ...row, executionStatus: execution }));
  }
}
