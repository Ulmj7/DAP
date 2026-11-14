import { z } from "zod";
import type { Clock, TenantScope } from "@dap/contracts";

const uuid = z.uuid();
const instant = z.iso.datetime({ offset: true });
export const MAX_STATE_SECONDS = 31_536_000;
export function positiveInteger(value: unknown, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > maximum) throw new TypeError("Invalid security state integer");
  return value;
}

/** Keys are opaque, including any namespace; tenant identity comes ONLY from the scope. */
export function stateKey(scope: TenantScope, key: string): string {
  const tenantId: unknown = scope?.tenantId;
  if (!uuid.safeParse(tenantId).success) throw new TypeError("Security state requires a UUID tenant");
  if (typeof key !== "string" || key.length < 1 || key.length > 1024 || key.includes("\u0000") || Buffer.byteLength(key, "utf8") > 1024) throw new TypeError("Invalid security state key");
  return JSON.stringify([(tenantId as string).toLowerCase(), key]);
}

export interface MemoryStateOptions { readonly maxEntries?: number }

/**
 * Hard per-store cap (default 10,000; configurable up to 1,000,000) plus 1024-byte keys.
 * Sweep expired entries on every operation. Full stores throw; live entries are NEVER evicted.
 * In-memory adapters are process-local, not suitable for multi-replica production security state.
 */
export class BoundedState<T extends { readonly expiresAt: number }> {
  private readonly entries = new Map<string, T>();
  private readonly capacity: number;
  private lastNow = -Infinity;
  constructor(private readonly clock: Clock, options: MemoryStateOptions = {}) {
    this.capacity = positiveInteger(options.maxEntries === undefined ? 10_000 : options.maxEntries, 1_000_000);
  }
  now(): number {
    const raw: unknown = this.clock.now();
    if (!instant.safeParse(raw).success) throw new TypeError("Invalid security state clock");
    const now = Date.parse(raw as string);
    if (!Number.isFinite(now) || now < this.lastNow) throw new TypeError("Invalid security state clock");
    this.lastNow = now;
    for (const [key, value] of this.entries) if (value.expiresAt <= now) this.entries.delete(key);
    return now;
  }
  get(key: string): T | undefined { return this.entries.get(key); }
  set(key: string, value: T): void {
    if (!this.entries.has(key) && this.entries.size >= this.capacity) throw new Error("Security state capacity exhausted");
    if (!Number.isSafeInteger(value.expiresAt) || Math.abs(value.expiresAt) > 8.64e15) throw new TypeError("Invalid security state expiry");
    this.entries.set(key, value);
  }
}
