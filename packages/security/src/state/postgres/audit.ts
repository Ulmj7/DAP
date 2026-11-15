/**
 * @dap/security: state/postgres/audit.ts (T094)
 *
 * The PostgreSQL audit trail: an `AuditSink` and the tenant-scoped `AuditEventSource` behind `createAuditReader`.
 * It behaves as `InMemoryAuditStore` does (the reference; both run `audit.conformance.ts`):
 *
 * - Only events made by `buildAuditEvent` are accepted, and each is re-validated here before it is written: what is stored is
 *   already the sanitized projection, never raw parameters.
 * - `append` is idempotent on the event id. The same event again is a no-op success; the same id with different content, or an id
 *   already used by ANOTHER tenant, is an error and nothing is overwritten (rows cannot be changed at all: the table is append-only).
 * - Every statement runs in a tenant transaction (`withTenant`): the tenant is the event's / the reader context's, and forced row
 *   level security enforces it again in the database.
 * - FAIL CLOSED: any database failure (connection, timeout, constraint, permission) rejects with a generic error that carries no
 *   driver text, host, database, user or SQL. The audit writer then treats the write as failed (an allow is not executed).
 * - `occurredAt` is stored as given by the event (the host clock reading made by the Gateway's event factory) and comes back as a
 *   normalized UTC instant with millisecond precision.
 */
import { z } from "zod";
import type { Pool } from "pg";
import { AUDIT_EVENT_TYPES, OUTCOMES, REASON_CODES, RISK_LEVELS } from "@dap/contracts";
import type { AuditEvent, AuditSink, JsonValue } from "@dap/contracts";
import { isBuiltAuditEvent } from "../../audit/event-builder.js";
import type { AuditEventSource } from "../../audit/audit-reader.js";
import { canonicalJson } from "../../validation/canonical.js";
import { withTenant } from "./tenant-tx.js";

const UNAVAILABLE = "Audit store unavailable";
const text = z.string().min(1).max(256);
const row = z.strictObject({
  id: z.uuid(), occurredAt: z.iso.datetime({ offset: true }), type: z.enum(AUDIT_EVENT_TYPES), requestId: text, decisionId: text, tenantId: z.uuid(), userId: text,
  aiSessionId: text, turnId: text, model: text, actionId: text.nullable(), definitionVersion: z.number().int().min(1).nullable(),
  paramsView: z.record(z.string(), z.json()), risk: z.enum(RISK_LEVELS).nullable(), outcome: z.enum(OUTCOMES).nullable(), reason: z.enum(REASON_CODES).nullable(),
  confirmationId: z.uuid().nullable(), confirmationState: z.enum(["pending", "accepted", "rejected", "invalidated"]).nullable(),
  executionResult: z.enum(["success", "failure"]).nullable(), resource: z.strictObject({ type: text, id: text }).nullable(),
});
const COLUMNS = "id, tenant_id, occurred_at, event_type, request_id, decision_id, user_id, ai_session_id, turn_id, model, action_id, definition_version, params_view, risk, outcome, reason, confirmation_id, confirmation_state, execution_result, resource_type, resource_id";

/** The normal form two copies of one event are compared in: millisecond UTC instant, canonical JSON. */
function normalized(event: AuditEvent): string {
  return canonicalJson({ ...event, occurredAt: new Date(event.occurredAt).toISOString() });
}

function toEvent(r: Record<string, unknown>): AuditEvent {
  const event = row.parse({
    id: r.id, occurredAt: (r.occurred_at as Date).toISOString(), type: r.event_type, requestId: r.request_id, decisionId: r.decision_id, tenantId: r.tenant_id, userId: r.user_id,
    aiSessionId: r.ai_session_id, turnId: r.turn_id, model: r.model, actionId: r.action_id, definitionVersion: r.definition_version, paramsView: r.params_view,
    risk: r.risk, outcome: r.outcome, reason: r.reason, confirmationId: r.confirmation_id, confirmationState: r.confirmation_state, executionResult: r.execution_result,
    resource: r.resource_type === null ? null : { type: r.resource_type, id: r.resource_id },
  });
  return Object.freeze({ ...event, resource: event.resource === null ? null : Object.freeze(event.resource) }) as unknown as AuditEvent;
}

export class PostgresAuditStore implements AuditSink, AuditEventSource {
  constructor(private readonly pool: Pool) {}

  async append(event: AuditEvent): Promise<void> {
    // Validation errors are the caller's programming errors and name no value; database errors become one generic error.
    if (!isBuiltAuditEvent(event)) throw new TypeError("Only built audit events can be appended");
    const checked = row.safeParse(event);
    if (!checked.success) throw new TypeError("Invalid audit event");
    const e = checked.data;
    const tenantId = e.tenantId.toLowerCase();
    try {
      await withTenant(this.pool, tenantId, async (client) => {
        const inserted = await client.query(
          `INSERT INTO public.sec_audit_events (${COLUMNS}) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15,$16,$17,$18,$19,$20,$21) ON CONFLICT (id) DO NOTHING`,
          [e.id, tenantId, e.occurredAt, e.type, e.requestId, e.decisionId, e.userId, e.aiSessionId, e.turnId, e.model, e.actionId, e.definitionVersion, JSON.stringify(e.paramsView satisfies Record<string, JsonValue>),
            e.risk, e.outcome, e.reason, e.confirmationId, e.confirmationState, e.executionResult, e.resource?.type ?? null, e.resource?.id ?? null],
        );
        if (inserted.command !== "INSERT" || (inserted.rowCount !== 0 && inserted.rowCount !== 1)) throw new TypeError("Invalid insert result");
        if (inserted.rowCount === 1) return;
        // The id exists: only the very same event is a success. An id held by another tenant is invisible here, so it is not found, and refused.
        const existing = await client.query(`SELECT ${COLUMNS} FROM public.sec_audit_events WHERE id=$1`, [e.id]);
        if (existing.rowCount !== 1 || normalized(toEvent(existing.rows[0] as Record<string, unknown>)) !== normalized(e as unknown as AuditEvent)) throw new TypeError("An audit event id cannot be reused with different content");
      });
    } catch { throw new Error(UNAVAILABLE); }
  }

  /** The tenant's events, oldest first; events with the same instant in commit order. */
  async listForTenant(tenantId: string): Promise<readonly AuditEvent[]> {
    if (!z.uuid().safeParse(tenantId).success) throw new TypeError("Audit queries need a UUID tenant");
    try {
      return await withTenant(this.pool, tenantId.toLowerCase(), async (client) => {
        const result = await client.query(`SELECT ${COLUMNS} FROM public.sec_audit_events WHERE tenant_id=$1 ORDER BY occurred_at, seq`, [tenantId.toLowerCase()]);
        return result.rows.map((r) => toEvent(r as Record<string, unknown>));
      });
    } catch { throw new Error(UNAVAILABLE); }
  }
}
