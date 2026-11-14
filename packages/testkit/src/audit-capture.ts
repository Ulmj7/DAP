/**
 * @dap/testkit: audit-capture.ts (T033)
 *
 * In-memory AuditSink for tests. Captures events as DEEP-FROZEN copies (the caller can
 * never mutate the log through a returned reference), hands out fresh copies of the list
 * from `events`, and offers a `failAppend` switch to simulate an unavailable audit store
 * (append rejects; the log is unchanged — "not recorded").
 */
import type { AuditEvent, AuditSink } from "@dap/contracts";

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null) return value;
  Object.freeze(value);
  for (const key of Object.keys(value)) {
    const child = (value as Record<string, unknown>)[key];
    if (typeof child === "object" && child !== null) {
      deepFreeze(child);
    }
  }
  return value;
}

function deepCopy<T>(value: T): T {
  if (typeof value !== "object" || value === null) return value;
  if (Array.isArray(value)) {
    return value.map((item) => deepCopy(item)) as unknown as T;
  }
  const clone: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    clone[key] = deepCopy(child);
  }
  return clone as T;
}

export class InMemoryAuditSink implements AuditSink {
  private readonly log: AuditEvent[] = [];
  private failing = false;

  /** The captured events, as a fresh copy (elements are deep-frozen). */
  get events(): readonly AuditEvent[] {
    return [...this.log];
  }

  /** Make append() reject (audit unavailable). False restores normal operation. */
  failAppend(failing: boolean): void {
    this.failing = failing;
  }

  async append(event: AuditEvent): Promise<void> {
    if (this.failing) {
      throw new Error("InMemoryAuditSink: audit append disabled (failAppend is on)");
    }
    this.log.push(deepFreeze(deepCopy(event)));
  }
}
