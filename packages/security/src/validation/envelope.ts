/**
 * @dap/security: validation/envelope.ts
 *
 * T062 / FR-014. Strict envelope intake: exactly `{action, params}`.
 *
 * - `action` must be a string matching `^[a-z][A-Za-z0-9]{2,63}$`.
 * - `params` must be a plain object (deep-frozen by the parser).
 * - Any missing key, extra key (`callId`, `requestId`, `userConfirmed`, ...),
 *   or malformed field yields `INVALID_ACTION` with an existing ReasonCode.
 *   The one exception is a number that is not finite (ATK-PARAMS-10) or an
 *   integer literal a double cannot hold exactly, which are parameter faults:
 *   `INVALID_PARAMETERS` with `invalid_parameters`.
 * - The failure result carries only (outcome, reason): the offending key or
 *   value is never echoed back to the planner. Results are frozen.
 */
import type { JsonValue, ReasonCode } from "@dap/contracts";
import { parseStrictJsonDeferred } from "./strict-json.js";
import type { NumberFault, StrictJsonCode, StrictJsonOptions } from "./strict-json.js";

/** Exact action-id grammar (D3). 3-64 chars, starts with a lowercase letter. */
const ACTION_ID_GRAMMAR = /^[a-z][A-Za-z0-9]{2,63}$/;
export const isActionIdGrammar = (text: unknown): text is string => typeof text === "string" && ACTION_ID_GRAMMAR.test(text);

/**
 * Success exposes the action id and the frozen params. Failure is a fail-closed decision outcome with an
 * existing ReasonCode only: `INVALID_ACTION`, or `INVALID_PARAMETERS` for a non-finite number.
 */
export type EnvelopeFailure = {
  readonly ok: false;
  readonly outcome: "INVALID_ACTION" | "INVALID_PARAMETERS";
  readonly reason: ReasonCode;
};
export type EnvelopeResult =
  | {
      readonly ok: true;
      readonly action: string;
      readonly params: Readonly<Record<string, JsonValue>>;
    }
  | EnvelopeFailure;

const failure = (outcome: EnvelopeFailure["outcome"], reason: ReasonCode): EnvelopeFailure => Object.freeze({ ok: false, outcome, reason });
const malformed = (): EnvelopeFailure => failure("INVALID_ACTION", "malformed_envelope");

/**
 * Every structural strict-json failure maps to an existing outcome and ReasonCode. Only the size cap has its
 * own reason; everything else is a malformed envelope. A number fault is handled in `parseEnvelope`, after
 * the envelope's own shape has been judged.
 */
const STRICT_JSON_FAILURE: Record<Exclude<StrictJsonCode, NumberFault>, () => EnvelopeFailure> = {
  too_large: () => failure("INVALID_ACTION", "payload_too_large"),
  too_deep: malformed,
  duplicate_key: malformed,
  forbidden_key: malformed,
  not_plain: malformed,
  syntax: malformed,
};

/**
 * Strict intake of one proposal envelope (T062).
 *
 * Accepts a JSON text or already-parsed value, under the configured caps
 * (`maxPayloadBytes`, `maxJsonDepth`; the defaults are the research D12 values).
 * Returns the action id and deeply frozen params, or a fail-closed failure. The
 * failure result never contains the offending key or value.
 */
export function parseEnvelope(value: unknown, options: StrictJsonOptions = {}): EnvelopeResult {
  // Structure decides first: a number fault is deferred until the envelope is known to be well formed, so a
  // planner cannot choose its own outcome by putting a number fault ahead of a structural one.
  const parsed = parseStrictJsonDeferred(value, options);
  if (!parsed.ok) return STRICT_JSON_FAILURE[parsed.code]();
  const candidate = parsed.value;
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) return malformed();
  const record = candidate as Record<string, JsonValue>;
  // Exactly two keys: action and params. Anything else is invalid.
  if (Object.keys(record).length !== 2 || !Object.hasOwn(record, "action") || !Object.hasOwn(record, "params")) return malformed();
  const { action, params } = record;
  if (!isActionIdGrammar(action)) return malformed();
  if (params === null || typeof params !== "object" || Array.isArray(params)) return malformed();
  // Only now is a deferred number fault a parameter fault; `params` holds placeholders in that case and is never returned.
  if (parsed.numberFault) return failure("INVALID_PARAMETERS", "invalid_parameters");
  return Object.freeze({ ok: true, action, params: params as Readonly<Record<string, JsonValue>> });
}
