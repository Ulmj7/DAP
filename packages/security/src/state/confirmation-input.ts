/**
 * Input rules shared by EVERY ConfirmationStore (memory and PostgreSQL), so code developed against one is rejected, or
 * accepted, by the other for exactly the same reasons. Everything here runs BEFORE any query: identifiers are strict,
 * the record is copied once into plain data (a getter or Proxy answers once), and nothing the caller supplies can set a
 * decision field (status, execution status, decision or creation time): the store alone writes those.
 */
import { z } from "zod";
import { RISK_LEVELS } from "@dap/contracts";
import type { ConfirmationId, ConsequenceSummary, JsonValue, NewConfirmation, ResourceRef, RiskLevel, TenantId, TenantScope } from "@dap/contracts";
import { MAX_CONFIRMATION_TTL_SECONDS, sanitizeDisplayText } from "../confirmation/binding.js";
import { parseStrictJson } from "../validation/strict-json.js";

const uuid = z.uuid();
const sha256 = /^[a-f0-9]{64}$/;
const actionId = /^[a-z][A-Za-z0-9]{2,63}$/;
export const MAX_CONFIRMATION_TEXT = 256;
export const MAX_STORED_PARAMS_BYTES = 65_536;
/** One page of a user's pending confirmations. */
export const LIST_PENDING_LIMIT = 100;

/** Text that PostgreSQL can hold and that means the same thing everywhere: no NUL, no lone surrogate, bounded. */
export function confirmationText(value: unknown, what: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > MAX_CONFIRMATION_TEXT || value.includes("\u0000") || /\p{Cs}/u.test(value) || Buffer.byteLength(value, "utf8") > 1024) throw new TypeError(`Invalid confirmation ${what}`);
  return value;
}
/** PostgreSQL's uuid is case-insensitive and renders lower case; every other spelling (braces, no hyphens, padding, urn:) is refused. */
function canonicalUuid(value: unknown, what: string): string {
  if (!uuid.safeParse(value).success) throw new TypeError(`Invalid confirmation ${what}`);
  return (value as string).toLowerCase();
}
export const captureConfirmationTenant = (scope: TenantScope): TenantId => canonicalUuid((scope as { tenantId?: unknown } | null | undefined)?.tenantId, "tenant") as TenantId;
export const captureConfirmationId = (id: unknown): ConfirmationId => canonicalUuid(id, "id") as ConfirmationId;
export function captureConfirmationUser(userId: unknown): string {
  const text = confirmationText(userId, "user");
  if (!/^[^\p{C}\p{Z}](?:[^\p{C}\p{Z}]| )*(?<! )$/u.test(text)) throw new TypeError("Invalid confirmation user");
  return text;
}
export function captureExecutionStatus(status: unknown): "succeeded" | "failed" {
  if (status !== "succeeded" && status !== "failed") throw new TypeError("Invalid confirmation execution status");
  return status;
}

export interface CapturedConfirmation {
  readonly id: ConfirmationId;
  readonly tenantId: TenantId;
  readonly userId: string;
  readonly requestId: string;
  readonly actionId: string;
  readonly definitionVersion: number;
  readonly definitionHash: string;
  readonly params: JsonValue;
  readonly paramsDigest: string;
  readonly resource: ResourceRef | null;
  readonly risk: RiskLevel;
  readonly consequence: ConsequenceSummary;
  readonly ttlSeconds: number;
}
const KEYS = ["id", "tenantId", "userId", "requestId", "actionId", "definitionVersion", "definitionHash", "params", "paramsDigest", "resource", "risk", "consequence", "ttlSeconds"] as const;

function plainText(value: unknown, bound: number, what: string): string {
  // A stored consequence is plain, single-line, bounded text already: the binding builds it that way, and nothing else may be shown.
  if (typeof value !== "string" || value.length === 0 || sanitizeDisplayText(value, bound + 1) !== value || [...value].length > bound) throw new TypeError(`Invalid confirmation ${what}`);
  return value;
}

/** The ONLY way a record enters a store. Returns a deeply frozen, detached copy with the tenant checked against the trusted scope. */
export function captureNewConfirmation(scope: TenantScope, record: NewConfirmation): CapturedConfirmation {
  const tenantId = captureConfirmationTenant(scope);
  const copy = parseStrictJson(record, { maxPayloadBytes: MAX_STORED_PARAMS_BYTES, maxJsonDepth: 16 });
  if (!copy.ok || copy.value === null || typeof copy.value !== "object" || Array.isArray(copy.value)) throw new TypeError("Invalid confirmation record");
  // RFC JSON admits escaped NUL, but PostgreSQL jsonb cannot store it in a key or string.
  const pending: unknown[] = [copy.value];
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value === "string" && value.includes("\u0000")) throw new TypeError("Invalid confirmation JSON text");
    if (value !== null && typeof value === "object") for (const [key, child] of Object.entries(value)) {
      if (key.includes("\u0000")) throw new TypeError("Invalid confirmation JSON text");
      pending.push(child);
    }
  }
  const fields = copy.value as Record<string, unknown>;
  const present = Object.keys(fields);
  if (present.length !== KEYS.length || !KEYS.every((key) => Object.hasOwn(fields, key))) throw new TypeError("Invalid confirmation record");

  if (canonicalUuid(fields.tenantId, "tenant") !== tenantId) throw new TypeError("Invalid confirmation tenant");
  const version = fields.definitionVersion;
  const ttl = fields.ttlSeconds;
  const risk = fields.risk;
  if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 1) throw new TypeError("Invalid confirmation definition version");
  if (typeof ttl !== "number" || !Number.isSafeInteger(ttl) || ttl < 1 || ttl > MAX_CONFIRMATION_TTL_SECONDS) throw new TypeError("Invalid confirmation lifetime");
  if (typeof risk !== "string" || !(RISK_LEVELS as readonly string[]).includes(risk) || risk === "FORBIDDEN") throw new TypeError("Invalid confirmation risk");
  if (typeof fields.actionId !== "string" || !actionId.test(fields.actionId)) throw new TypeError("Invalid confirmation action");
  for (const key of ["definitionHash", "paramsDigest"] as const) if (typeof fields[key] !== "string" || !sha256.test(fields[key])) throw new TypeError(`Invalid confirmation ${key}`);

  let resource: ResourceRef | null = null;
  if (fields.resource !== null) {
    const ref = fields.resource;
    if (ref === null || typeof ref !== "object" || Array.isArray(ref) || Object.keys(ref).length !== 2) throw new TypeError("Invalid confirmation resource");
    resource = Object.freeze({ type: confirmationText(Reflect.get(ref, "type"), "resource type"), id: confirmationText(Reflect.get(ref, "id"), "resource id") });
  }

  const shown = fields.consequence;
  if (shown === null || typeof shown !== "object" || Array.isArray(shown) || Object.keys(shown).length !== 3) throw new TypeError("Invalid confirmation consequence");
  const effects: unknown = Reflect.get(shown, "effects");
  if (!Array.isArray(effects) || effects.length > 10 || typeof Reflect.get(shown, "irreversible") !== "boolean") throw new TypeError("Invalid confirmation consequence");
  const consequence: ConsequenceSummary = Object.freeze({
    title: plainText(Reflect.get(shown, "title"), 120, "consequence title"),
    effects: Object.freeze(effects.map((effect) => plainText(effect, 300, "consequence effect"))),
    irreversible: Reflect.get(shown, "irreversible") as boolean,
  });

  return Object.freeze({
    id: captureConfirmationId(fields.id), tenantId, userId: captureConfirmationUser(fields.userId), requestId: confirmationText(fields.requestId, "request id"),
    actionId: fields.actionId, definitionVersion: version, definitionHash: fields.definitionHash as string, params: fields.params as JsonValue, paramsDigest: fields.paramsDigest as string,
    resource, risk: risk as RiskLevel, consequence, ttlSeconds: ttl,
  });
}
