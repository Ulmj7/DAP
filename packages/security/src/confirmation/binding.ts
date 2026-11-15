/**
 * @dap/security: confirmation/binding.ts (T100)
 *
 * What a stored confirmation is bound to, when one is needed (FR-010), how long it lives (research D10) and how drift is
 * detected. Pure and synchronous: nothing here touches state, the clock or the network.
 *
 * The consequence a person reads before confirming is built here, from exactly two inputs: the capability's own
 * `describeConsequence`, the validated parameters and the TRUSTED resolved resource. Every string that reaches the person is
 * plain text (control, bidirectional, zero-width and private-use characters removed, whitespace collapsed, length capped), so
 * a resource display name cannot forge extra lines, reorder text or push a destructive effect out of view. Strings that do not
 * fit are REFUSED rather than truncated: a cut-off effect could hide the one that matters. Renderers must still treat the
 * result as text, never as markup.
 */
import { z } from "zod";
import { RISK_LEVELS } from "@dap/contracts";
import type { AnyActionDefinition, ConfirmationRequest, ConsequenceSummary, GatewayConfig, NewConfirmation, RegisteredAction, ResolvedResource, ResourceRef, RiskLevel, Sha256Hex } from "@dap/contracts";
import { canonicalJson } from "../validation/canonical.js";
import { paramsDigest } from "../validation/params.js";
import type { ValidatedParams } from "../validation/params.js";

export const MAX_CONFIRMATION_TTL_SECONDS = 900;
const MAX_TITLE = 120;
const MAX_EFFECT = 300;
const MAX_EFFECTS = 10;
const MAX_DISPLAY_NAME = 80;
const MAX_ID_TEXT = 256;
const uuid = z.uuid();
const sha256 = /^[a-f0-9]{64}$/;

/**
 * Does executing this capability need a person's confirmation? HIGH and CRITICAL always; MEDIUM unless it opted out WITH a
 * written justification; SAFE and LOW not, unless the definition explicitly says so. Anything unreadable, unknown or
 * FORBIDDEN answers `true`: the safe direction is to ask, and a FORBIDDEN capability can never be confirmed (it is refused
 * below), so it can never run.
 */
export function requiresConfirmation(definition: Pick<AnyActionDefinition, "risk" | "confirmation">): boolean {
  try {
    const risk: unknown = definition.risk;
    const policy: unknown = definition.confirmation;
    const kind: unknown = policy !== null && typeof policy === "object" ? Reflect.get(policy, "kind") : undefined;
    if (kind === "required") return true;
    if (risk === "SAFE" || risk === "LOW") return false;
    if (risk === "MEDIUM") {
      const justification: unknown = kind === "not-required" ? Reflect.get(policy as object, "justification") : undefined;
      return !(typeof justification === "string" && justification.trim().length > 0);
    }
    return true;
  } catch { return true; }
}

/** The lifetime of one confirmation: the configured default, never above 900 s; a capability may only SHORTEN it. */
export function effectiveTtlSeconds(definition: Pick<AnyActionDefinition, "confirmationTtlSeconds">, config: Pick<GatewayConfig, "confirmationDefaultTtlSeconds">): number {
  const base: unknown = config.confirmationDefaultTtlSeconds;
  if (typeof base !== "number" || !Number.isSafeInteger(base) || base < 1 || base > MAX_CONFIRMATION_TTL_SECONDS) throw new TypeError("Invalid confirmation default lifetime");
  const own: unknown = definition.confirmationTtlSeconds;
  if (own === undefined) return base;
  if (typeof own !== "number" || !Number.isSafeInteger(own) || own < 1) throw new TypeError("Invalid capability confirmation lifetime");
  return Math.min(own, base);
}

/**
 * Plain, bounded, single-line display text: NFC, tabs and line breaks become one space, every control, format (bidirectional,
 * zero-width), surrogate, private-use and unassigned character is dropped, runs of spaces collapse, the ends are trimmed
 * and a text longer than `maxCodePoints` is cut on a code point boundary and marked with an ellipsis.
 */
export function sanitizeDisplayText(text: string, maxCodePoints: number): string {
  if (!Number.isSafeInteger(maxCodePoints) || maxCodePoints < 1) throw new TypeError("Invalid display text bound");
  const cleaned = text.replace(/[\t\n\r\u2028\u2029]/g, " ").replace(/[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}]/gu, "").normalize("NFC").replace(/ {2,}/g, " ").trim();
  const points = [...cleaned];
  return points.length <= maxCodePoints ? cleaned : `${points.slice(0, maxCodePoints - 1).join("").trimEnd()}\u2026`;
}

const consequenceShape = z.strictObject({ title: z.string(), effects: z.array(z.string()).max(MAX_EFFECTS), irreversible: z.boolean() });
function usable(value: string, bound: number): string {
  const clean = sanitizeDisplayText(value, bound + 1);
  // Refuse, never truncate: a cut-off effect could hide the one that matters.
  if (clean.length === 0 || [...clean].length > bound) throw new TypeError("Confirmation consequence is unusable");
  return clean;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") { for (const child of Object.values(value)) deepFreeze(child); Object.freeze(value); }
  return value;
}
function identifier(value: unknown, what: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > MAX_ID_TEXT || value.includes("\u0000") || /\p{Cs}/u.test(value)) throw new TypeError(`Invalid ${what}`);
  return value;
}
function canonicalUuid(value: unknown, what: string): string {
  if (!uuid.safeParse(value).success) throw new TypeError(`Invalid ${what}`);
  return (value as string).toLowerCase();
}
const sameRef = (left: ResourceRef | null, right: ResourceRef | null): boolean => left === null ? right === null : right !== null && left.type === right.type && left.id === right.id;

export interface ConfirmationBindingInput {
  readonly action: RegisteredAction;
  /** From `IdGenerator.newConfirmationId()`: a crypto-grade UUID that is also the only handle (research D10). */
  readonly confirmationId: string;
  readonly requestId: string;
  /** From the minted AuthorizationContext, never from the proposal. */
  readonly tenantId: string;
  readonly userId: string;
  readonly validated: Extract<ValidatedParams, { readonly ok: true }>;
  /** The host's trusted resolution of the resource the validated parameters point at, or null when there is none. */
  readonly resource: ResolvedResource | null;
  readonly config: Pick<GatewayConfig, "confirmationDefaultTtlSeconds">;
}

/**
 * The record the confirmation store persists: the exact capability definition (version and hash), the NORMALIZED parameters
 * that will be executed as stored, the digest binding them to the action, resource, tenant and user, and the consequence.
 * Deeply frozen and detached from every input. Throws a TypeError, with no detail, for anything that cannot be confirmed.
 */
export function buildConfirmationFields(input: ConfirmationBindingInput): NewConfirmation {
  const { action, validated } = input;
  const definition = action.definition;
  const id = canonicalUuid(input.confirmationId, "confirmation id");
  const tenantId = canonicalUuid(input.tenantId, "tenant");
  const userId = identifier(input.userId, "user");
  const requestId = identifier(input.requestId, "request id");
  const risk: unknown = definition.risk;
  if (typeof risk !== "string" || !(RISK_LEVELS as readonly string[]).includes(risk) || risk === "FORBIDDEN") throw new TypeError("This capability can never be confirmed");
  if (!requiresConfirmation(definition)) throw new TypeError("This capability does not use confirmation");
  const describe: unknown = definition.describeConsequence;
  if (!sha256.test(action.definitionHash)) throw new TypeError("Invalid definition hash");
  const ttlSeconds = effectiveTtlSeconds(definition, input.config);

  // The digest the validate stage produced must be the one this record would recompute: a foreign or tampered digest binds nothing.
  const resource = validated.resource === null ? null : Object.freeze({ type: validated.resource.type, id: validated.resource.id });
  if (paramsDigest({ actionId: definition.id, version: definition.version, params: validated.normalized, resource, tenantId, userId }) !== validated.paramsDigest) throw new TypeError("Parameters are not bound to this action, tenant and user");

  // The trusted resolved resource must be the very resource the digest binds, in this tenant.
  const trusted = input.resource;
  if (resource === null ? trusted !== null : trusted === null || !sameRef(trusted.ref, resource) || String(trusted.tenantId).toLowerCase() !== tenantId) throw new TypeError("The resolved resource does not match the proposal");

  const params = deepFreeze(JSON.parse(canonicalJson(validated.normalized)) as ConfirmationRequest["params"]);
  const consequence = buildConsequence(describe as (input: unknown) => unknown, params, trusted);
  return deepFreeze({
    id: id as NewConfirmation["id"], tenantId: tenantId as NewConfirmation["tenantId"], userId: userId as NewConfirmation["userId"], requestId: requestId as NewConfirmation["requestId"],
    actionId: definition.id, definitionVersion: definition.version, definitionHash: action.definitionHash, params, paramsDigest: validated.paramsDigest,
    resource, risk: risk as RiskLevel, consequence, ttlSeconds,
  });
}

function buildConsequence(describe: (input: unknown) => unknown, params: unknown, trusted: ResolvedResource | null): ConsequenceSummary {
  try {
    const shown = trusted === null ? null : deepFreeze({ ref: { type: trusted.ref.type, id: trusted.ref.id }, tenantId: trusted.tenantId, displayName: sanitizeDisplayText(trusted.displayName, MAX_DISPLAY_NAME) });
    const answer = consequenceShape.parse(describe({ params, resource: shown }));
    return { title: usable(answer.title, MAX_TITLE), effects: answer.effects.map((effect) => usable(effect, MAX_EFFECT)), irreversible: answer.irreversible };
  } catch { throw new TypeError("Confirmation consequence is unusable"); }
}

/** Has the capability changed since the confirmation was created? A missing capability, another version or another hash all count. */
export function definitionDrift(stored: { readonly definitionVersion: number; readonly definitionHash: Sha256Hex }, current: RegisteredAction | undefined): boolean {
  if (current === undefined) return true;
  return current.definition.version !== stored.definitionVersion || current.definitionHash !== stored.definitionHash;
}

export type BindingCheck = { readonly ok: true } | { readonly ok: false; readonly reason: "definition_changed" | "digest_mismatch" };

/** T105's two binding checks in order: the capability is unchanged, then the digest recomputed from the STORED fields equals the stored one. */
export function verifyBinding(stored: ConfirmationRequest, current: RegisteredAction | undefined): BindingCheck {
  if (definitionDrift(stored, current)) return { ok: false, reason: "definition_changed" };
  try {
    const recomputed = paramsDigest({ actionId: stored.actionId, version: stored.definitionVersion, params: stored.params, resource: stored.resource, tenantId: stored.tenantId, userId: stored.userId });
    return recomputed === stored.paramsDigest ? { ok: true } : { ok: false, reason: "digest_mismatch" };
  } catch { return { ok: false, reason: "digest_mismatch" }; }
}
