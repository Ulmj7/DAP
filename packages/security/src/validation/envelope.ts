/**
 * @dap/security: validation/envelope.ts
 *
 * T062 / FR-014. Strict envelope intake: exactly `{action, params}`.
 *
 * - `action` must be a string matching `^[a-z][A-Za-z0-9]{2,63}$`.
 * - `params` must be a plain object (deep-frozen by the parser).
 * - Any missing key, extra key (`callId`, `requestId`, `userConfirmed`, ...),
 *   or malformed field yields `INVALID_ACTION` with an existing ReasonCode.
 * - The failure result carries only (outcome, reason): the offending key or
 *   value is never echoed back to the planner.
 */
import type { JsonValue, ReasonCode } from "@dap/contracts";
import { parseStrictJson } from "./strict-json.js";
import type { StrictJsonCode } from "./strict-json.js";

/** Exact action-id grammar (D3). 3-64 chars, starts with a lowercase letter. */
export const ACTION_ID_PATTERN: RegExp = /^[a-z][A-Za-z0-9]{2,63}$/;

export interface Envelope {
  readonly action: string;
  readonly params: Readonly<Record<string, JsonValue>>;
}

/**
 * Success exposes the action id and the frozen params. Failure is a
 * fail-closed `INVALID_ACTION` decision with an existing ReasonCode only.
 */
export type EnvelopeResult =
  | {
      readonly ok: true;
      readonly action: string;
      readonly params: Readonly<Record<string, JsonValue>>;
    }
  | {
      readonly ok: false;
      readonly outcome: "INVALID_ACTION";
      readonly reason: ReasonCode;
    };

/**
 * Every strict-json failure maps to an existing ReasonCode. Only the size
 * cap has its own reason; everything else is a malformed envelope.
 */
const STRICT_JSON_REASON: Record<StrictJsonCode, ReasonCode> = {
  too_large: "payload_too_large",
  too_deep: "malformed_envelope",
  duplicate_key: "malformed_envelope",
  forbidden_key: "malformed_envelope",
  not_finite: "malformed_envelope",
  not_plain: "malformed_envelope",
  syntax: "malformed_envelope",
};

/**
 * Strict intake of one proposal envelope (T062).
 *
 * Accepts a JSON text or already-parsed value. Returns the action id and
 * deeply frozen params, or a fail-closed INVALID_ACTION decision. The
 * failure result never contains the offending key or value.
 */
export function parseEnvelope(value: unknown): EnvelopeResult {
  const parsed = parseStrictJson(value);
  if (!parsed.ok) {
    return {
      ok: false,
      outcome: "INVALID_ACTION",
      reason: STRICT_JSON_REASON[parsed.code],
    };
  }
  const candidate = parsed.value;
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    Array.isArray(candidate)
  ) {
    return { ok: false, outcome: "INVALID_ACTION", reason: "malformed_envelope" };
  }
  const record = candidate as Record<string, JsonValue>;
  // Exactly two keys: action and params. Anything else is invalid.
  const keys = Object.keys(record);
  if (
    keys.length !== 2 ||
    !Object.hasOwn(record, "action") ||
    !Object.hasOwn(record, "params")
  ) {
    return { ok: false, outcome: "INVALID_ACTION", reason: "malformed_envelope" };
  }
  const action = record.action;
  if (typeof action !== "string" || !ACTION_ID_PATTERN.test(action)) {
    return { ok: false, outcome: "INVALID_ACTION", reason: "malformed_envelope" };
  }
  const params = record.params;
  if (
    params === null ||
    typeof params !== "object" ||
    Array.isArray(params)
  ) {
    return { ok: false, outcome: "INVALID_ACTION", reason: "malformed_envelope" };
  }
  return {
    ok: true,
    action,
    params: params as Readonly<Record<string, JsonValue>>,
  };
}
