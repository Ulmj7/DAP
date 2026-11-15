/**
 * @dap/contracts: audit.ts
 *
 * AuditEvent and sinks (FR-037..FR-042). Append-only. The AI layer has no audit reader.
 *
 * Constitution: XIV, V
 */
import type {
  ConfirmationId,
  IsoInstant,
  JsonValue,
  Outcome,
  ReasonCode,
  RequestId,
  ResourceRef,
  RiskLevel,
  TenantId,
  UserId,
} from "./core.js";

export const AUDIT_EVENT_TYPES = [
  "AI_ACTION_PROPOSED",
  "AI_ACTION_ALLOWED",
  "AI_ACTION_DENIED",
  "AI_CONFIRMATION_REQUIRED",
  "AI_CONFIRMATION_ACCEPTED",
  "AI_CONFIRMATION_REJECTED",
  "AI_POLICY_VIOLATION",
  "AI_RATE_LIMITED",
  /** Added by this plan to carry the execution result (FR-038). */
  "AI_ACTION_EXECUTED",
] as const;
export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number];

/**
 * Every field's provenance: trusted context, trusted runner, validated parameters, or system.
 * Nothing here is copied from free-form model output.
 */
export interface AuditEvent {
  readonly id: string;
  readonly occurredAt: IsoInstant; // database clock when persisted
  readonly type: AuditEventType;
  readonly requestId: RequestId;
  readonly decisionId: string;
  readonly tenantId: TenantId; // from AuthorizationContext
  readonly userId: UserId; // from AuthorizationContext
  readonly aiSessionId: string; // trusted runner
  readonly turnId: string; // trusted runner
  readonly model: string; // trusted runner config, not model self-report
  /** Name as received if unresolved (truncated); the registered id once resolved. */
  readonly actionId: string | null;
  readonly definitionVersion: number | null;
  /**
   * Allowlisted, masked projection only (ActionDefinition.audit.params). Anything not
   * listed is absent. A final scrubber redacts secret-shaped values.
   */
  readonly paramsView: { readonly [key: string]: JsonValue };
  readonly risk: RiskLevel | null;
  /** Null only for AI_ACTION_PROPOSED: a proposal has no decision yet (research D13). Every other event type carries both. */
  readonly outcome: Outcome | null;
  readonly reason: ReasonCode | null;
  readonly confirmationId: ConfirmationId | null;
  readonly confirmationState: "pending" | "accepted" | "rejected" | "invalidated" | null;
  readonly executionResult: "success" | "failure" | null;
  readonly resource: ResourceRef | null;
}

/**
 * Cancellation of one append. Structural, so a real `AbortSignal` fits without any DOM library.
 * `aborted` only ever goes from false to true, and the writer sets it at most once per attempt.
 */
export interface AuditAppendOptions {
  readonly signal?: { readonly aborted: boolean };
}

/**
 * `append` resolves ONLY after the event is durably committed. A rejected promise means
 * "not recorded". For allowed actions the Gateway then refuses to execute (research D13).
 * For denials the denial stands regardless. `append` MUST be idempotent on `event.id`: a retry of
 * an event that was in fact committed leaves one row (the same id with different content is an error).
 *
 * Cancellation: the writer aborts `options.signal` when it gives up on an append (timeout, rejection,
 * wrong-shaped or late answer). A sink MUST NOT commit after `signal.aborted`: an aborted append that has not
 * committed must roll back and leave no row. If COMMIT has already been issued the outcome is uncertain
 * (documented residual risk: the trail may then show an ALLOWED event for a request that was denied and never executed).
 * A sink that cannot cancel may ignore the second argument.
 */
export interface AuditSink {
  append(event: AuditEvent, options?: AuditAppendOptions): Promise<void>;
}

export interface AuditQuery {
  readonly requestId?: RequestId;
  readonly userId?: UserId;
  readonly from?: IsoInstant;
  readonly to?: IsoInstant;
  readonly types?: readonly AuditEventType[];
  readonly limit: number;
}

/**
 * Reviewer path, tenant-scoped by the context. NOT available to the AI layer. Answers:
 * what did the AI attempt, why was it allowed, who authorized it, what changed (SC-008).
 */
export interface AuditReader {
  query(
    ctx: import("./security-context.js").AuthorizationContext,
    q: AuditQuery,
  ): Promise<readonly AuditEvent[]>;
}
