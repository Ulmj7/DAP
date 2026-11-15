import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { parseStrictJson } from "../../packages/security/src/validation/strict-json.js";
import { denyDecision, toPlannerFeedback, validateParams } from "@dap/security";
import { REASON_CODES } from "@dap/contracts";
import { ALICE, TENANT_A, TENANT_B, executionViolations, mayReachExecutor, LeakScanner, testSafeEcho } from "@dap/testkit";
import type { ExecutionFacts } from "@dap/testkit";
const permittedFacts: ExecutionFacts = {
  tenantId: TENANT_A, resourceTenantId: TENANT_A, risk: "SAFE",
  authenticated: true, sessionValid: true, schemaValid: true, registered: true,
  globallyEnabled: true, tenantEnabled: true, userPermitted: true, contextAllowed: true,
  withinLimits: true, replayClaimed: true, allowEventCommitted: true, dependenciesHealthy: true,
  targetsResource: true, resourceAvailable: true, requiresConfirmation: false, confirmationAccepted: false,
};

const settings = { seed: 125001, numRuns: 250 };
const scope = { tenantId: TENANT_A, userId: ALICE };
describe("T125 catalogue invariants (recorded seed 125001)", () => {
  it("1: independent oracle rejects execution if any generated world prerequisite is absent", () => {
    fc.assert(fc.property(fc.array(fc.boolean(), { minLength: 12, maxLength: 12 }), (bits) => {
      const keys = ["authenticated", "sessionValid", "schemaValid", "registered", "globallyEnabled", "tenantEnabled", "userPermitted", "contextAllowed", "withinLimits", "replayClaimed", "allowEventCommitted", "dependenciesHealthy"];
      const facts = { ...permittedFacts, ...Object.fromEntries(keys.map((key, index) => [key, bits[index]])) };
      expect(mayReachExecutor(facts)).toBe(bits.every((bit) => bit));
      expect(executionViolations(facts, 1)).toHaveLength(bits.every((bit) => bit) ? 0 : 1);
      expect(mayReachExecutor({ ...facts, resourceTenantId: TENANT_B })).toBe(false);
    }), settings);
  });
  it.todo("1: real gateway executor call implies every oracle prerequisite incl. durable allow-event; needs authorize/audit/execute wiring and positive control (no gateway stub)");
  it("2: same proposal and scope produces byte-identical validation and digest", () => {
    fc.assert(fc.property(fc.oneof(fc.record({ message: fc.string({ minLength: 1, maxLength: 100 }) }), fc.jsonValue()), (params) => {
      expect(validateParams(testSafeEcho, params, scope)).toEqual(validateParams(testSafeEcho, params, scope));
      const positive = validateParams(testSafeEcho, { message: "benign" }, scope);
      expect(positive.ok).toBe(true);
      if (positive.ok) expect(positive.paramsDigest).toMatch(/^[a-f0-9]{64}$/);
    }), settings);
  });
  it.todo("2: same complete gateway proposal/state yields identical decision, audit reason and executor count on independent worlds; needs complete chain");
  it("3: real feedback projection contains no canary or internal reason for generated errors", () => {
    fc.assert(fc.property(fc.string(), fc.constantFrom(...REASON_CODES), (text, reason) => {
      const canary = `CANARY_PRIVATE_${text}_END`;
      const feedback = toPlannerFeedback(denyDecision({ decisionId: "d", requestId: "r" as never, stage: "authorize", outcome: "DENIED", reason, attemptedAction: canary }));
      expect(new LeakScanner({ canaries: [canary] }).scan(feedback)).toEqual([]);
      expect(Object.keys(feedback).sort()).toEqual(["category", "outcome"]);
      expect(["try_later", "not_available"]).toContain(feedback.category);
      expect(feedback.outcome).toBe("DENIED");
      expect(new LeakScanner({ canaries: [canary] }).scan({ output: canary }).some((finding) => finding.kind === "canary")).toBe(true);
    }), settings);
  });
  it.todo("3: scan all real gateway planner-visible outputs under generated port faults for canaries/internal reasons; needs full pipeline and audit projection");
  it("4: strict parameter intake rejects duplicate/escaped-colliding and prototype keys", () => {
    fc.assert(fc.property(fc.string({ minLength: 1, maxLength: 100 }), fc.constantFrom("__proto__", "constructor", "prototype"), (text, key) => {
      const quoted = JSON.stringify(text);
      const duplicates = `{"message":${quoted},"mess\\u0061ge":"second"}`;
      const prototype = `{"message":${quoted},${JSON.stringify(key)}:{}}`;
      expect(parseStrictJson(duplicates).ok).toBe(false);
      expect(parseStrictJson(prototype).ok).toBe(false);
      const positive = parseStrictJson(JSON.stringify({ message: text }));
      expect(positive.ok).toBe(true);
    }), settings);
  });
});
