/**
 * @dap/security: gateway/telemetry.ts
 *
 * T087 / research D18. What the Gateway counts, as an interface the host maps onto its metrics: decisions by outcome, reason,
 * risk and action; audit write failures; dependency failures; rate-limit hits. NO tenant or user is ever passed (cardinality and
 * privacy), and every label is from a closed vocabulary, so a hostile proposal cannot mint a new metric series.
 *
 * Telemetry observes; it never decides. `safeTelemetry` wraps whatever the host supplied so that a method that is missing, throws,
 * rejects or hangs changes nothing: calls are fire-and-forget, nothing is awaited, and every failure is swallowed.
 */
import { OUTCOMES, REASON_CODES, RISK_LEVELS } from "@dap/contracts";
import type { Outcome, ReasonCode, RiskLevel } from "@dap/contracts";
import { isValidActionId } from "../registry/reserved-names.js";

export const AUDIT_WRITE_KINDS = ["proposed", "decision", "allowed", "executed"] as const;
export type AuditWriteKind = (typeof AUDIT_WRITE_KINDS)[number];
export const DEPENDENCIES = ["authentication", "permissions", "resources", "pages", "clock", "replay", "rate_limiter", "confirmations", "tenant_policy", "audit", "confirmation_channel", "executor"] as const;
export type DependencyName = (typeof DEPENDENCIES)[number];
export const RATE_LIMIT_SCOPES = ["turn", "user", "tenant", "capability", "risk", "throttle"] as const;
export type RateLimitScope = (typeof RATE_LIMIT_SCOPES)[number];

export interface DecisionSample {
  readonly outcome: Outcome;
  readonly reason: ReasonCode;
  readonly risk: RiskLevel | null;
  /** The registered action id; null when the action never resolved. */
  readonly action: string | null;
}
export interface GatewayTelemetry {
  decision(sample: DecisionSample): void;
  auditWriteFailed(kind: AuditWriteKind): void;
  dependencyFailed(dependency: DependencyName): void;
  rateLimited(scope: RateLimitScope): void;
}

const noop = (): void => undefined;
/** The default: counts nothing. */
export const noopTelemetry: GatewayTelemetry = Object.freeze({ decision: noop, auditWriteFailed: noop, dependencyFailed: noop, rateLimited: noop });

const UNKNOWN = "unknown";
const oneOf = <T extends string>(allowed: readonly T[], value: unknown): T | typeof UNKNOWN => (typeof value === "string" && (allowed as readonly string[]).includes(value) ? value as T : UNKNOWN);

/** Calls `method` on `target` and swallows everything: a throw, a rejection, a hang (never awaited). */
function fire(target: object, method: unknown, args: readonly unknown[]): void {
  if (typeof method !== "function") return;
  try {
    const result: unknown = Reflect.apply(method, target, args);
    if (result !== null && typeof result === "object" && typeof (result as { then?: unknown }).then === "function") void Promise.resolve(result).then(noop, noop);
  } catch { /* telemetry never changes a decision */ }
}

/**
 * The host's telemetry, made safe. Methods are read once; every label is checked against its closed vocabulary (anything else is
 * `unknown`); a missing method counts nothing.
 */
export function safeTelemetry(source?: Partial<GatewayTelemetry>): GatewayTelemetry {
  if (source === undefined || source === null || typeof source !== "object") return noopTelemetry;
  let methods: Record<keyof GatewayTelemetry, unknown>;
  try {
    methods = { decision: source.decision, auditWriteFailed: source.auditWriteFailed, dependencyFailed: source.dependencyFailed, rateLimited: source.rateLimited };
  } catch { return noopTelemetry; }
  return Object.freeze({
    decision: Object.freeze((sample: DecisionSample): void => {
      let label: DecisionSample | undefined;
      try {
        label = Object.freeze({
          outcome: oneOf(OUTCOMES, sample.outcome) as Outcome, reason: oneOf(REASON_CODES, sample.reason) as ReasonCode,
          risk: sample.risk === null ? null : oneOf(RISK_LEVELS, sample.risk) as RiskLevel,
          action: sample.action === null ? null : isValidActionId(sample.action) ? sample.action : UNKNOWN,
        });
      } catch { return; }
      fire(source, methods.decision, [label]);
    }),
    auditWriteFailed: Object.freeze((kind: AuditWriteKind): void => { fire(source, methods.auditWriteFailed, [oneOf(AUDIT_WRITE_KINDS, kind)]); }),
    dependencyFailed: Object.freeze((dependency: DependencyName): void => { fire(source, methods.dependencyFailed, [oneOf(DEPENDENCIES, dependency)]); }),
    rateLimited: Object.freeze((scope: RateLimitScope): void => { fire(source, methods.rateLimited, [oneOf(RATE_LIMIT_SCOPES, scope)]); }),
  });
}
