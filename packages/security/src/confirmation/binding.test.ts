/**
 * T098. The confirmation binding: what a stored confirmation is bound to, when one is needed (FR-010), how long it lives
 * (D10) and how drift is detected. Every assertion is written to fail when the property it names is dropped.
 */
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { defineAction } from "@dap/contracts";
import type { ActionId, ExecutorId, PermissionId, RegisteredAction, ResolvedResource, ResourceRef, RiskLevel, TenantId } from "@dap/contracts";
import { buildRegistry } from "../registry/build-registry.js";
import { paramsDigest, validateParams } from "../validation/params.js";
import { buildConfirmationFields, definitionDrift, effectiveTtlSeconds, MAX_CONFIRMATION_TTL_SECONDS, requiresConfirmation, sanitizeDisplayText, verifyBinding } from "./binding.js";

const TENANT = "00000000-0000-4000-8000-0000000000a1";
const OTHER_TENANT = "00000000-0000-4000-8000-0000000000b2";
const USER = "user-one";
const CONFIRMATION_ID = "5b1d6f2e-8c3a-4f9e-9a57-0e2f4d6c8b10";
const config = { confirmationDefaultTtlSeconds: 300 };
const deepFrozen = (node: unknown): boolean => node === null || typeof node !== "object" || (Object.isFrozen(node) && Object.values(node).every(deepFrozen));

function define(overrides: Record<string, unknown> = {}): RegisteredAction {
  const definition = defineAction<{ documentId: string; note?: string }>({
    id: "publishDocument" as ActionId, version: 3, description: "Publish", inputSchema: z.strictObject({ documentId: z.string().max(64), note: z.string().max(200).optional() }),
    risk: "HIGH", requiredPermission: "document:publish" as PermissionId, allowedPages: "any", confirmation: { kind: "required" }, changesState: true,
    audit: { params: [] }, executorId: "publishExecutor" as ExecutorId,
    resource: (params: { documentId: string }) => ({ type: "document", id: params.documentId }),
    describeConsequence: ({ resource }: { resource: ResolvedResource | null }) => ({ title: `Publish ${resource?.displayName ?? "a document"}`, effects: ["The document becomes visible to the team"], irreversible: false }),
    ...overrides,
  } as never);
  return buildRegistry([definition]).get("publishDocument")!;
}
/** Bypasses registration (R9, R11 and friends) to exercise the runtime guards on definitions registration would refuse. */
function raw(changes: Record<string, unknown>): RegisteredAction {
  const base = define();
  return { definition: { ...base.definition, ...changes }, definitionHash: base.definitionHash } as unknown as RegisteredAction;
}
const resolved = (displayName = "Quarterly report", tenantId = TENANT, ref: ResourceRef = { type: "document", id: "doc-1" }): ResolvedResource => ({ ref, tenantId: tenantId as TenantId, displayName });
function validated(action: RegisteredAction, params: unknown = { documentId: "doc-1" }, scope = { tenantId: TENANT, userId: USER }) {
  const result = validateParams(action.definition, params, scope);
  if (!result.ok) throw new Error("fixture must validate");
  return result;
}
function build(over: { action?: RegisteredAction; params?: unknown; resource?: ResolvedResource | null; tenantId?: string; userId?: string; confirmationId?: string; requestId?: string; config?: { confirmationDefaultTtlSeconds: number } } = {}) {
  const action = over.action ?? define();
  const tenantId = over.tenantId ?? TENANT; const userId = over.userId ?? USER;
  return buildConfirmationFields({
    action, confirmationId: over.confirmationId ?? CONFIRMATION_ID, requestId: over.requestId ?? "request-1", tenantId, userId,
    validated: validated(action, over.params, { tenantId, userId }), resource: over.resource === undefined ? resolved() : over.resource, config: over.config ?? config,
  });
}

describe("T098 paramsDigest binds action, version, parameters, resource, tenant and user", () => {
  const base = { actionId: "publishDocument", version: 3, params: { documentId: "doc-1" } as unknown, resource: { type: "document", id: "doc-1" } as ResourceRef | null, tenantId: TENANT, userId: USER };
  const digest = (over: Partial<typeof base> = {}) => paramsDigest({ ...base, ...over });
  it("is a stable lowercase SHA-256 that ignores key order", () => {
    expect(digest()).toMatch(/^[a-f0-9]{64}$/);
    expect(digest()).toBe(digest());
    expect(digest({ params: { a: 1, b: 2 } })).toBe(digest({ params: { b: 2, a: 1 } }));
  });
  it.each([
    ["action", { actionId: "deleteDocument" }], ["version", { version: 4 }], ["parameters", { params: { documentId: "doc-2" } }],
    ["resource type", { resource: { type: "page", id: "doc-1" } }], ["resource id", { resource: { type: "document", id: "doc-2" } }], ["no resource", { resource: null }],
    ["tenant", { tenantId: OTHER_TENANT }], ["user", { userId: "user-two" }],
  ] as const)("changes when the %s changes", (_name, change) => {
    expect(digest(change as Partial<typeof base>)).not.toBe(digest());
  });
  it("does not mix fields: swapping tenant and user text changes the digest", () => {
    expect(digest({ tenantId: "a", userId: "b" })).not.toBe(digest({ tenantId: "b", userId: "a" }));
  });
});

describe("T098 requiresConfirmation (FR-010)", () => {
  const needs = (risk: RiskLevel, confirmation: unknown) => requiresConfirmation({ risk, confirmation } as never);
  it.each(["SAFE", "LOW"] as const)("%s needs none", (risk) => expect(needs(risk, { kind: "not-required" })).toBe(false));
  it("MEDIUM needs it unless the capability opts out WITH a written justification", () => {
    expect(needs("MEDIUM", { kind: "required" })).toBe(true);
    expect(needs("MEDIUM", { kind: "not-required", justification: "Reversible draft in the user's own workspace" })).toBe(false);
    for (const justification of [undefined, "", "   ", "\n\t", 5, null]) expect(needs("MEDIUM", { kind: "not-required", justification })).toBe(true);
    expect(needs("MEDIUM", { kind: "not-required" })).toBe(true);
  });
  it.each(["HIGH", "CRITICAL"] as const)("%s ALWAYS needs it, whatever the definition says", (risk) => {
    expect(needs(risk, { kind: "required" })).toBe(true);
    expect(needs(risk, { kind: "not-required" })).toBe(true);
    expect(needs(risk, { kind: "not-required", justification: "trust me" })).toBe(true);
    expect(needs(risk, undefined)).toBe(true);
  });
  it("an explicit 'required' on a SAFE or LOW capability is honoured (never weaker than declared)", () => {
    expect(needs("SAFE", { kind: "required" })).toBe(true);
    expect(needs("LOW", { kind: "required" })).toBe(true);
  });
  it("FORBIDDEN, unknown or malformed definitions fail closed: they are never treated as needing no confirmation", () => {
    for (const risk of ["FORBIDDEN", "NONE", "", undefined, 5, null]) expect(needs(risk as RiskLevel, { kind: "not-required" })).toBe(true);
    expect(() => requiresConfirmation(null as never)).not.toThrow();
    expect(requiresConfirmation(null as never)).toBe(true);
    expect(requiresConfirmation({ risk: "MEDIUM", confirmation: null } as never)).toBe(true);
    expect(requiresConfirmation({ risk: "MEDIUM", confirmation: "not-required" } as never)).toBe(true);
  });
  it("unreadable nested policy getters also fail closed without throwing", () => {
    const kind = { get kind() { throw new Error("untrusted policy"); } };
    const justification = { kind: "not-required", get justification() { throw new Error("untrusted justification"); } };
    expect(requiresConfirmation({ risk: "SAFE", confirmation: kind } as never)).toBe(true);
    expect(requiresConfirmation({ risk: "MEDIUM", confirmation: justification } as never)).toBe(true);
  });
  it("reads each field once, so a getter cannot answer differently the second time", () => {
    let reads = 0;
    const hostile = { get risk() { reads++; return reads === 1 ? "SAFE" : "HIGH"; }, confirmation: { kind: "not-required" } };
    expect(requiresConfirmation(hostile as never)).toBe(false);
    expect(reads).toBe(1);
  });
});

describe("T098 effectiveTtlSeconds (D10)", () => {
  const ttl = (confirmationTtlSeconds: unknown, defaultSeconds: unknown = 300) => effectiveTtlSeconds({ confirmationTtlSeconds } as never, { confirmationDefaultTtlSeconds: defaultSeconds as number });
  it("defaults to the configured value (300 s) and is never above 900 s", () => {
    expect(ttl(undefined)).toBe(300);
    expect(ttl(undefined, 900)).toBe(900);
    expect(MAX_CONFIRMATION_TTL_SECONDS).toBe(900);
    expect(effectiveTtlSeconds({} as never, { confirmationDefaultTtlSeconds: 300 })).toBe(300);
  });
  it("a capability may only SHORTEN it", () => {
    expect(ttl(60)).toBe(60);
    expect(ttl(1)).toBe(1);
    expect(ttl(300)).toBe(300);
    expect(ttl(301)).toBe(300);
    expect(ttl(900)).toBe(300);
    expect(ttl(100_000, 900)).toBe(900);
    expect(ttl(600, 900)).toBe(600);
  });
  it("a malformed capability TTL or default fails closed instead of choosing a lifetime", () => {
    for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "60", null]) expect(() => ttl(value)).toThrow(TypeError);
    for (const value of [0, -1, 901, 1.5, Number.NaN, "300", null, 100_000]) expect(() => ttl(undefined, value)).toThrow(TypeError);
    expect(() => effectiveTtlSeconds({} as never, {} as never)).toThrow(TypeError);
  });
});

describe("T098 buildConfirmationFields", () => {
  it("binds exactly the definition version and hash, the normalized params, the digest, the resource, the user, the tenant and the risk", () => {
    const action = define();
    const fields = build({ action });
    expect(fields).toMatchObject({
      id: CONFIRMATION_ID, tenantId: TENANT, userId: USER, requestId: "request-1", actionId: "publishDocument", definitionVersion: 3,
      definitionHash: action.definitionHash, params: { documentId: "doc-1" }, resource: { type: "document", id: "doc-1" }, risk: "HIGH", ttlSeconds: 300,
    });
    expect(fields.paramsDigest).toBe(paramsDigest({ actionId: "publishDocument", version: 3, params: { documentId: "doc-1" }, resource: { type: "document", id: "doc-1" }, tenantId: TENANT, userId: USER }));
    expect(Object.keys(fields).sort()).toEqual(["actionId", "consequence", "definitionHash", "definitionVersion", "id", "params", "paramsDigest", "requestId", "resource", "risk", "tenantId", "ttlSeconds", "userId"]);
  });
  it("is deeply frozen and detached from the validated input", () => {
    const fields = build();
    expect(deepFrozen(fields)).toBe(true);
    const normalized: Record<string, unknown> = { documentId: "doc-1" };
    const action = define();
    const result = { ok: true as const, normalized: normalized as never, resource: { type: "document", id: "doc-1" }, paramsDigest: paramsDigest({ actionId: "publishDocument", version: 3, params: normalized, resource: { type: "document", id: "doc-1" }, tenantId: TENANT, userId: USER }) };
    const built = buildConfirmationFields({ action, confirmationId: CONFIRMATION_ID, requestId: "r", tenantId: TENANT, userId: USER, validated: result, resource: resolved(), config });
    normalized.documentId = "changed-later";
    expect(built.params).toEqual({ documentId: "doc-1" });
  });
  it("uses the capability's TTL when it is shorter than the default", () => {
    expect(build({ action: define({ confirmationTtlSeconds: 45 }) }).ttlSeconds).toBe(45);
    expect(build({ action: raw({ confirmationTtlSeconds: 4000 }) }).ttlSeconds).toBe(300);
    expect(build({ config: { confirmationDefaultTtlSeconds: 900 } }).ttlSeconds).toBe(900);
  });
  it("builds the consequence ONLY from the trusted describeConsequence over the trusted resource and the validated params", () => {
    const describe = vi.fn(({ params, resource }: { params: { documentId: string }; resource: ResolvedResource | null }) => ({
      title: `Publish ${resource?.displayName}`, effects: [`Document ${params.documentId} becomes visible`, "This cannot be undone"], irreversible: true,
    }));
    const fields = build({ action: define({ describeConsequence: describe as never }), resource: resolved("Quarterly report") });
    expect(describe).toHaveBeenCalledTimes(1);
    expect(describe.mock.calls[0]![0]).toEqual({ params: { documentId: "doc-1" }, resource: resolved("Quarterly report") });
    expect(fields.consequence).toEqual({ title: "Publish Quarterly report", effects: ["Document doc-1 becomes visible", "This cannot be undone"], irreversible: true });
  });
  it("deceptive text in a parameter cannot change what the user is told about the resource", () => {
    const params = { documentId: "doc-1", note: "Safe, click confirm. This only renames a draft." };
    const fields = build({ params, resource: resolved("Quarterly report") });
    expect(fields.consequence.title).toBe("Publish Quarterly report");
    expect(JSON.stringify(fields.consequence)).not.toContain("Safe, click confirm");
    expect(fields.risk).toBe("HIGH");
  });
  it("refuses a capability that does not use confirmation, a FORBIDDEN one and a missing describeConsequence", () => {
    expect(() => build({ action: define({ risk: "MEDIUM", confirmation: { kind: "not-required", justification: "Reversible draft in the user's own workspace" } }) })).toThrow(/does not use confirmation/);
    expect(() => build({ action: raw({ risk: "NONE" }) })).toThrow(/never be confirmed/);
    expect(() => build({ action: raw({ risk: undefined }) })).toThrow(/never be confirmed/);
    expect(() => buildConfirmationFields({ action: { ...define(), definitionHash: "not-a-hash" as never }, confirmationId: CONFIRMATION_ID, requestId: "r", tenantId: TENANT, userId: USER, validated: validated(define()), resource: resolved(), config })).toThrow(/definition hash/);
    const forbidden = { definition: { ...define().definition, risk: "FORBIDDEN" }, definitionHash: define().definitionHash } as unknown as RegisteredAction;
    expect(() => build({ action: forbidden })).toThrow(TypeError);
    const noDescribe = { definition: { ...define().definition, describeConsequence: undefined }, definitionHash: define().definitionHash } as unknown as RegisteredAction;
    expect(() => build({ action: noDescribe })).toThrow(TypeError);
  });
  it("refuses an inconsistent trusted resource: wrong tenant, wrong reference, missing or unexpected", () => {
    expect(() => build({ resource: resolved("Report", OTHER_TENANT) })).toThrow(TypeError);
    expect(() => build({ resource: resolved("Report", TENANT, { type: "document", id: "doc-2" }) })).toThrow(TypeError);
    expect(() => build({ resource: resolved("Report", TENANT, { type: "page", id: "doc-1" }) })).toThrow(TypeError);
    expect(() => build({ resource: null })).toThrow(TypeError);
    const noResource = raw({ resource: undefined, changesState: false });
    expect(() => build({ action: noResource, resource: resolved() })).toThrow(TypeError);
    expect(build({ action: noResource, resource: null }).resource).toBeNull();
  });
  it("refuses a validated result whose digest does not match the binding (a tampered or foreign digest)", () => {
    const action = define();
    const good = validated(action);
    for (const paramsDigestValue of ["0".repeat(64), paramsDigest({ actionId: "publishDocument", version: 3, params: { documentId: "doc-1" }, resource: { type: "document", id: "doc-1" }, tenantId: OTHER_TENANT, userId: USER })]) {
      expect(() => buildConfirmationFields({ action, confirmationId: CONFIRMATION_ID, requestId: "r", tenantId: TENANT, userId: USER, validated: { ...good, paramsDigest: paramsDigestValue as never }, resource: resolved(), config })).toThrow(TypeError);
    }
    expect(() => buildConfirmationFields({ action, confirmationId: CONFIRMATION_ID, requestId: "r", tenantId: TENANT, userId: "someone-else", validated: good, resource: resolved(), config })).toThrow(TypeError);
  });
  it.each([
    ["a non-UUID confirmation id", { confirmationId: "not-a-uuid" }], ["a brace UUID", { confirmationId: `{${CONFIRMATION_ID}}` }], ["a hyphenless UUID", { confirmationId: CONFIRMATION_ID.replaceAll("-", "") }],
    ["a padded UUID", { confirmationId: ` ${CONFIRMATION_ID}` }], ["an empty request id", { requestId: "" }], ["a NUL request id", { requestId: "a\u0000b" }],
    ["an oversized request id", { requestId: "r".repeat(257) }], ["an empty user", { userId: "" }], ["a lone-surrogate user", { userId: "a\ud800b" }], ["a lone-surrogate request id", { requestId: "\udc00" }], ["a NUL user", { userId: "a\u0000" }], ["an oversized user", { userId: "u".repeat(257) }], ["a non-UUID tenant", { tenantId: "tenant-a" }],
  ] as const)("refuses %s", (_name, change) => {
    expect(() => build(change as never)).toThrow(TypeError);
  });
  it("canonicalizes an upper-case confirmation id and tenant to the database spelling", () => {
    const action = define();
    const withTenant = (tenantId: string, validatedFor: string, resourceTenant = TENANT) => buildConfirmationFields({ action, confirmationId: CONFIRMATION_ID.toUpperCase(), requestId: "r", tenantId, userId: USER, validated: validated(action, undefined, { tenantId: validatedFor, userId: USER }), resource: resolved("Report", resourceTenant), config });
    const fields = withTenant(TENANT.toUpperCase(), TENANT);
    expect(fields.id).toBe(CONFIRMATION_ID);
    expect(fields.tenantId).toBe(TENANT);
    expect(withTenant(TENANT, TENANT, TENANT.toUpperCase()).tenantId).toBe(TENANT);
    // A digest made over the other spelling is not the digest of the stored (canonical) tenant: refused.
    expect(() => withTenant(TENANT.toUpperCase(), TENANT.toUpperCase())).toThrow(TypeError);
  });
  it("fails closed, with a generic error and no leaked detail, when describeConsequence throws or answers badly", () => {
    const secret = "sk-live-0123456789abcdefghij";
    expect(() => build({ action: define({ describeConsequence: () => { throw new Error(secret); } }) })).toThrow(/Confirmation consequence is unusable/);
    try { build({ action: define({ describeConsequence: () => { throw new Error(secret); } }) }); } catch (error) { expect(String((error as Error).message)).not.toContain(secret); }
    const bad: unknown[] = [
      undefined, null, "text", 5, [], {}, { title: "", effects: [], irreversible: false }, { title: "   ", effects: [], irreversible: false },
      { title: "T", effects: "x", irreversible: false }, { title: "T", effects: [1], irreversible: false }, { title: "T", effects: [], irreversible: "no" },
      { title: "T", effects: [], irreversible: false, extra: true }, { title: "T", irreversible: false },
      { title: "T".repeat(121), effects: [], irreversible: false }, { title: "T", effects: ["e".repeat(301)], irreversible: false },
      { title: "T", effects: Array.from({ length: 11 }, () => "e"), irreversible: false }, { title: "\u200b\u202e", effects: [], irreversible: false },
      { title: "T", effects: ["\u0000"], irreversible: false },
    ];
    for (const answer of bad) expect(() => build({ action: define({ describeConsequence: (() => answer) as never }) }), JSON.stringify(answer)?.slice(0, 40)).toThrow(TypeError);
  });
  it("reads a hostile consequence once, never from a getter or Proxy that changes its answer", () => {
    let reads = 0;
    const hostile = { get title() { reads++; return reads === 1 ? "Publish a report" : "Delete everything"; }, effects: ["Visible"], irreversible: false };
    const fields = build({ action: define({ describeConsequence: (() => hostile) as never }) });
    expect(fields.consequence.title).toBe("Publish a report");
    expect(reads).toBe(1);
    expect(() => build({ action: define({ describeConsequence: (() => new Proxy({}, { get() { throw new Error("proxy"); }, ownKeys() { throw new Error("proxy"); } })) as never }) })).toThrow(TypeError);
  });
  it("neutralizes control, bidi, zero-width and over-long text in the trusted display name before and after describeConsequence", () => {
    const hostileName = "\u001b[31mQuarterly\u202e\u0000 report\u200b\r\n\tfinal";
    const fields = build({ resource: resolved(hostileName) });
    expect(fields.consequence.title).toBe("Publish [31mQuarterly report final");
    const long = build({ resource: resolved("x".repeat(5000)) });
    expect([...long.consequence.title]).toHaveLength("Publish ".length + 80);
    expect(long.consequence.title.endsWith("\u2026")).toBe(true);
  });
  it("one confirmation never aliases another: two builds share no mutable state", () => {
    const first = build(); const second = build({ confirmationId: "6c2e7a3f-9d4b-4a0f-8b68-1f3a5e7d9c21" });
    expect(first).not.toBe(second);
    expect(first.params).not.toBe(second.params);
    expect(first.consequence).not.toBe(second.consequence);
  });
});

describe("T098 sanitizeDisplayText", () => {
  it("leaves ordinary text, accents, CJK and emoji untouched", () => {
    for (const text of ["Quarterly report", "Café ñandú", "季度报告", "Launch \u{1f680} plan", "a'b\"c<d>&e"]) expect(sanitizeDisplayText(text, 100)).toBe(text);
  });
  it("normalizes to NFC, collapses line breaks and tabs to one space, and drops control, bidi, zero-width, private-use and lone-surrogate characters", () => {
    expect(sanitizeDisplayText("e\u0301", 10)).toBe("é");
    expect(sanitizeDisplayText("a\r\nb\tc\nd", 100)).toBe("a b c d");
    expect(sanitizeDisplayText("a\u2028b\u2029c", 100)).toBe("a b c");
    for (const unit of ["\u0000", "\u001b", "\u007f", "\u0085", "\u200b", "\u200e", "\u202a", "\u202e", "\u2066", "\u2069", "\ufeff", "\ue000", "\ud800", "\udc00"]) expect(sanitizeDisplayText(`a${unit}b`, 100), JSON.stringify(unit)).toBe("ab");
  });
  it("trims, caps by code points (never splitting a pair) and marks the cut", () => {
    expect(sanitizeDisplayText("  padded  ", 100)).toBe("padded");
    expect(sanitizeDisplayText("abcdef", 6)).toBe("abcdef");
    expect(sanitizeDisplayText("abcdefg", 6)).toBe("abcde\u2026");
    expect(sanitizeDisplayText("\u{1f600}".repeat(10), 4)).toBe("\u{1f600}\u{1f600}\u{1f600}\u2026");
    expect([...sanitizeDisplayText("界".repeat(500), 50)]).toHaveLength(50);
  });
  it("refuses anything that is not text or a usable bound", () => {
    for (const value of [undefined, null, 5, {}, []]) expect(() => sanitizeDisplayText(value as never, 10)).toThrow(TypeError);
    for (const max of [0, -1, 1.5, Number.NaN]) expect(() => sanitizeDisplayText("x", max)).toThrow(TypeError);
    expect(sanitizeDisplayText("", 10)).toBe("");
  });
});

describe("T098 definition drift and stored-binding verification", () => {
  const action = define();
  const stored = () => ({ ...build({ action }), status: "pending" as const, executionStatus: "none" as const, createdAt: "2026-01-01T00:00:00Z", expiresAt: "2026-01-01T00:05:00Z", decidedAt: null }) as never as Parameters<typeof verifyBinding>[0];
  it("detects a changed version, a changed hash and a removed capability; an identical definition is not drift", () => {
    const binding = { definitionVersion: 3, definitionHash: action.definitionHash };
    expect(definitionDrift(binding, action)).toBe(false);
    expect(definitionDrift({ ...binding, definitionVersion: 4 }, action)).toBe(true);
    expect(definitionDrift({ ...binding, definitionHash: "0".repeat(64) as never }, action)).toBe(true);
    expect(definitionDrift(binding, undefined)).toBe(true);
    const changed = define({ risk: "CRITICAL" });
    expect(changed.definitionHash).not.toBe(action.definitionHash);
    expect(definitionDrift(binding, changed)).toBe(true);
    const bumped = define({ version: 4 });
    expect(definitionDrift(binding, bumped)).toBe(true);
  });
  it("detects hash drift even when the version number did not change (an unbumped edit)", () => {
    const edited = define({ requiredPermission: "document:admin" as PermissionId });
    expect(edited.definition.version).toBe(action.definition.version);
    expect(definitionDrift({ definitionVersion: 3, definitionHash: action.definitionHash }, edited)).toBe(true);
  });
  it("verifyBinding accepts an untouched record and names the first failing binding otherwise", () => {
    const record = stored();
    expect(verifyBinding(record, action)).toEqual({ ok: true });
    expect(verifyBinding(record, define({ risk: "CRITICAL" }))).toEqual({ ok: false, reason: "definition_changed" });
    expect(verifyBinding(record, undefined)).toEqual({ ok: false, reason: "definition_changed" });
    for (const change of [{ params: { documentId: "doc-2" } }, { userId: "user-two" }, { tenantId: OTHER_TENANT }, { resource: { type: "document", id: "doc-9" } }, { actionId: "deleteDocument" }, { definitionVersion: 4 }, { paramsDigest: "f".repeat(64) }]) {
      const result = verifyBinding({ ...record, ...change } as never, action);
      expect(result.ok, JSON.stringify(change)).toBe(false);
    }
    expect(verifyBinding({ ...record, params: { documentId: "doc-2" } } as never, action)).toEqual({ ok: false, reason: "digest_mismatch" });
    expect(verifyBinding({ ...record, params: { get documentId() { throw new Error("x"); } } } as never, action)).toEqual({ ok: false, reason: "digest_mismatch" });
  });
  it("checks definition drift before the digest (a changed definition is reported as such)", () => {
    const record = { ...stored(), params: { documentId: "doc-2" } } as never;
    expect(verifyBinding(record, define({ risk: "CRITICAL" }))).toEqual({ ok: false, reason: "definition_changed" });
  });
});
