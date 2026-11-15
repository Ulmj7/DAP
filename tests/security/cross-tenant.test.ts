/**
 * T073, ATK-XTENANT-01..04. Runs now: the scenario definitions, every oracle proven able to FAIL with hand-built observations, and the
 * REAL feedback builder from @dap/security: the planner's answer for another tenant's resource, a missing resource and a resource the host
 * returned for the wrong tenant is the same bytes. The scenario runs against the whole chain are `it.todo` with their precise blockers.
 */
import { describe, expect, it } from "vitest";
import type { AttackObservation, AuditEvent, CapabilityTraits, PlannerFeedback, ReasonCode } from "@dap/contracts";
import { denyDecision, toPlannerFeedback } from "@dap/security";
import { NOT_AVAILABLE_BYTES, TENANT_B, TENANT_B_RESOURCES, byteIdentical, crossTenantScenarios, validParamsFor } from "@dap/testkit";
import type { DenialScenario } from "@dap/testkit";

const scenario = (id: string) => crossTenantScenarios.find((entry) => entry.id === id)!;
const traits = (over: Partial<CapabilityTraits> = {}): CapabilityTraits => ({ actionId: "testMediumDraft", risk: "MEDIUM", changesState: true, targetsResource: true, requiresConfirmation: true, ...over });
const event = (over: Partial<AuditEvent>): AuditEvent => ({ id: "e", occurredAt: "2026-01-01T00:00:00Z", type: "AI_ACTION_DENIED", requestId: "r", decisionId: "r", tenantId: "t", userId: "u", aiSessionId: "s", turnId: "n", model: "m", actionId: null, definitionVersion: null, paramsView: {}, risk: null, outcome: "DENIED", reason: "resource_not_available", confirmationId: null, confirmationState: null, executionResult: null, resource: null, ...over }) as AuditEvent;
const generic: PlannerFeedback = { outcome: "DENIED", category: "not_available" };
const FOREIGN = TENANT_B_RESOURCES.map((resource) => resource.displayName);
const obs = (over: Partial<AttackObservation> & { foreignDisplayNames?: readonly string[] }): AttackObservation => ({ feedback: [generic, generic], executorCalls: 0, auditEvents: [], leakFindings: [], foreignDisplayNames: FOREIGN, ...over }) as AttackObservation;
const decisions = (...reasons: string[]) => reasons.map((reason, index) => event({ id: `d${index}`, reason: reason as ReasonCode }));

describe("the scenarios", () => {
  it("are ATK-XTENANT-01..04, in order, of category cross-tenant", () => {
    expect(crossTenantScenarios.map((entry) => entry.id)).toEqual(["ATK-XTENANT-01", "ATK-XTENANT-02", "ATK-XTENANT-03", "ATK-XTENANT-04"]);
    for (const entry of crossTenantScenarios) expect(entry.category).toBe("cross-tenant");
  });
  it("01, 02 and 04 apply only to capabilities that target a resource; 03 applies to every non-forbidden capability", () => {
    for (const id of ["ATK-XTENANT-01", "ATK-XTENANT-02", "ATK-XTENANT-04"]) {
      expect(scenario(id).appliesTo(traits()), id).toBe(true);
      expect(scenario(id).appliesTo(traits({ targetsResource: false })), id).toBe(false);
      expect(scenario(id).appliesTo(traits({ risk: "FORBIDDEN" })), id).toBe(false);
    }
    expect(scenario("ATK-XTENANT-03").appliesTo(traits({ targetsResource: false }))).toBe(true);
    expect(scenario("ATK-XTENANT-03").appliesTo(traits({ risk: "FORBIDDEN" }))).toBe(false);
  });
});

describe("byte-identical feedback, from the real feedback builder", () => {
  const feedbackFor = (reason: ReasonCode, extra: object = {}) => toPlannerFeedback(denyDecision({ decisionId: "d", requestId: "r", outcome: "DENIED", reason, stage: "authorize", ...extra } as never));
  it("is the same bytes for another tenant's resource, a missing resource, a resource the user may not use and a foreign resource the host returned", () => {
    const answers = [feedbackFor("resource_not_available"), feedbackFor("resource_not_available", { attemptedAction: "testMediumDraft" }), feedbackFor("tenant_mismatch"), feedbackFor("tenant_mismatch", { attemptedAction: "other", stage: "authorize" })];
    expect(byteIdentical(answers)).toBe(true);
    for (const answer of answers) expect(JSON.stringify(answer)).toBe(NOT_AVAILABLE_BYTES);
    expect(NOT_AVAILABLE_BYTES).toBe('{"outcome":"DENIED","category":"not_available"}');
  });
  it("does not depend on a canary display name, a tenant id or a resource id carried by the decision", () => {
    const hostile = feedbackFor("tenant_mismatch", { attemptedAction: `${TENANT_B_RESOURCES[0]!.displayName} ${TENANT_B} doc-b-1`, issues: [{ path: "/documentId", code: "invalid" }] });
    expect(JSON.stringify(hostile)).toBe(NOT_AVAILABLE_BYTES);
  });
  it("is NOT the same as an outage, so the planner can tell 'no' from 'try later' without learning why", () => {
    expect(JSON.stringify(feedbackFor("dependency_failure"))).not.toBe(NOT_AVAILABLE_BYTES);
  });
  it("byteIdentical is strict: key order, a differing value, an extra key and an empty list all fail", () => {
    expect(byteIdentical([generic, generic])).toBe(true);
    expect(byteIdentical([generic, { category: "not_available", outcome: "DENIED" } as PlannerFeedback])).toBe(false);
    expect(byteIdentical([generic, { outcome: "DENIED", category: "try_later" }])).toBe(false);
    expect(byteIdentical([generic, { ...generic, issues: [] } as PlannerFeedback])).toBe(false);
    expect(byteIdentical([])).toBe(false);
    expect(byteIdentical([generic])).toBe(true);
  });
});

describe("ATK-XTENANT-01 / 02 oracles", () => {
  for (const id of ["ATK-XTENANT-01", "ATK-XTENANT-02"]) {
    const good = obs({ auditEvents: decisions("resource_not_available", "resource_not_available") });
    describe(id, () => {
      it("passes identical generic feedback, an idle executor and the same internal reason", () => expect(scenario(id).verify(good)).toEqual([]));
      it.each([
        ["the executor ran", { executorCalls: 1 }, "executor ran"], ["a missing answer", { feedback: [generic] }, "submission count mismatch"],
        ["feedback that differs", { feedback: [generic, { outcome: "DENIED", category: "try_later" }] }, "the planner can tell the cases apart: feedback is not byte-identical"],
        ["identical feedback that is not the generic answer", { feedback: [{ outcome: "DENIED", category: "try_later" }, { outcome: "DENIED", category: "try_later" }] }, "feedback is not exactly the generic not-available answer"],
        ["identical feedback with extra detail", { feedback: [{ ...generic, issues: [] }, { ...generic, issues: [] }] }, "feedback is not exactly the generic not-available answer"],
        ["the same keys in another order", { feedback: [{ category: "not_available", outcome: "DENIED" }, { category: "not_available", outcome: "DENIED" }] }, "feedback is not exactly the generic not-available answer"],
        ["another tenant's resource recorded as a mismatch", { auditEvents: decisions("tenant_mismatch", "resource_not_available") }, `audit reasons are ["tenant_mismatch","resource_not_available"], expected ["resource_not_available","resource_not_available"]`],
        ["no decision records", { auditEvents: [] }, `audit reasons are [], expected ["resource_not_available","resource_not_available"]`],
        ["a display name of the other tenant in the trail", { auditEvents: [...decisions("resource_not_available", "resource_not_available"), event({ actionId: FOREIGN[0]! })] }, "another tenant's display name reached this tenant's output"],
        ["a display name of the other tenant in the feedback", { feedback: [{ ...generic, note: FOREIGN[1] } as never, generic] }, "another tenant's display name reached this tenant's output"],
        ["a leak", { leakFindings: ["canary:$"] }, "planner output leaked"],
      ] as const)("reports: %s", (_name, over, message) => expect(scenario(id).verify({ ...good, ...over } as AttackObservation)).toContain(message));
      it("reports an observation that carries no foreign display names", () => {
        const { foreignDisplayNames: _f, ...bare } = good as AttackObservation & { foreignDisplayNames: string[] };
        void _f;
        expect(scenario(id).verify(bare)).toEqual(["no foreign display names were observed"]);
      });
    });
  }
  it("ignores the decision records' order only where the scenario fixes it: other-tenant first, nonexistent second", () => {
    expect(scenario("ATK-XTENANT-01").verify(obs({ auditEvents: decisions("resource_not_available", "resource_not_available") }))).toEqual([]);
  });
  it("only decisions count, not the PROPOSED records between them", () => {
    const proposed = event({ type: "AI_ACTION_PROPOSED", reason: null, outcome: null });
    expect(scenario("ATK-XTENANT-01").verify(obs({ auditEvents: [proposed, ...decisions("resource_not_available"), proposed, ...decisions("resource_not_available")] }))).toEqual([]);
  });
});

describe("ATK-XTENANT-03 cases (a tenant id in the envelope or the parameters)", () => {
  const cases = (scenario("ATK-XTENANT-03") as DenialScenario).cases(traits());
  it("puts the foreign tenant id in the envelope under four names, expecting a malformed envelope", () => {
    const envelope = cases.filter((item) => item.reason === "malformed_envelope");
    expect(envelope.map((item) => Object.keys(item.raw as object).filter((key) => !["action", "params"].includes(key))[0])).toEqual(["tenantId", "tenant", "tenant_id", "orgId"]);
    for (const item of envelope) expect(item).toMatchObject({ outcome: "INVALID_ACTION", raw: { action: "testMediumDraft" } });
    for (const item of envelope) expect(Object.values(item.raw as object)).toContain(TENANT_B);
  });
  it("puts it in the parameters under the same four names, expecting an unknown key at the root, audited under the action", () => {
    const params = cases.filter((item) => item.reason === "invalid_parameters");
    expect(params).toHaveLength(4);
    for (const item of params) expect(item).toMatchObject({ outcome: "INVALID_PARAMETERS", issues: [{ path: "", code: "unknown_key" }], auditedAction: "testMediumDraft" });
    expect(params.map((item) => Object.keys((item.raw as { params: object }).params).find((key) => !(key in validParamsFor("testMediumDraft"))))).toEqual(["tenantId", "tenant", "tenant_id", "orgId"]);
    for (const item of params) expect(Object.values((item.raw as { params: object }).params)).toContain(TENANT_B);
  });
  it("keeps the rest of the parameters valid, so only the tenant id can be the cause", () => {
    for (const item of cases.filter((entry) => entry.reason === "invalid_parameters")) {
      const { tenantId: _a, tenant: _b, tenant_id: _c, orgId: _d, ...rest } = (item.raw as { params: Record<string, unknown> }).params;
      void _a; void _b; void _c; void _d;
      expect(rest).toEqual(validParamsFor("testMediumDraft"));
    }
  });
  it("uses the denial oracle: it rejects empty evidence and an execution", () => {
    const empty = { feedback: [], executorCalls: 0, auditEvents: [], leakFindings: [] };
    expect(scenario("ATK-XTENANT-03").verify(empty)).toContain("submission count mismatch");
    expect(scenario("ATK-XTENANT-03").verify({ ...empty, executorCalls: 1 })).toContain("executor ran");
  });
});

describe("ATK-XTENANT-04 oracle (the host returns a resource of another tenant)", () => {
  const good = obs({ auditEvents: decisions("resource_not_available", "tenant_mismatch") });
  it("passes: the same bytes as a missing resource, recorded as a tenant mismatch", () => expect(scenario("ATK-XTENANT-04").verify(good)).toEqual([]));
  it.each([
    ["the mismatch was recorded as an ordinary missing resource", { auditEvents: decisions("resource_not_available", "resource_not_available") }, `audit reasons are ["resource_not_available","resource_not_available"], expected ["resource_not_available","tenant_mismatch"]`],
    ["the baseline was recorded as a mismatch", { auditEvents: decisions("tenant_mismatch", "tenant_mismatch") }, `audit reasons are ["tenant_mismatch","tenant_mismatch"], expected ["resource_not_available","tenant_mismatch"]`],
    ["the planner can tell the mismatch apart", { feedback: [generic, { outcome: "UNAUTHORIZED", category: "not_available" }] }, "the planner can tell the cases apart: feedback is not byte-identical"],
    ["the executor ran", { executorCalls: 1 }, "executor ran"],
    ["the foreign resource's display name surfaced", { feedback: [generic, { ...generic, displayName: FOREIGN[0] } as never] }, "another tenant's display name reached this tenant's output"],
  ] as const)("reports: %s", (_name, over, message) => expect(scenario("ATK-XTENANT-04").verify({ ...good, ...over } as AttackObservation)).toContain(message));
});

/** A scripted target that only RECORDS what a scenario does to the world: it decides nothing, so it is no gateway. */
function scriptedTarget() {
  const log: string[] = [];
  const target = {
    ...traits(), planner: { script: [] }, visibleOutput: undefined, executor: { calls: 0, grantsSeen: 0, receivedParams: [] }, audit: { events: [] }, foreignDisplayNames: FOREIGN,
    resourceProposal: (kind: string) => ({ kind }), foreignResource: () => "FOREIGN", setResourceAnswer: (answer: unknown) => { log.push(`answer:${JSON.stringify(answer)}`); },
    submit: async (call: { callId: string; raw: unknown }) => { log.push(`submit:${call.callId}:${(call.raw as { kind: string }).kind}`); return generic; },
  };
  return { target, log };
}

describe("how the scenarios drive the world (a scripted target that records, not a gateway)", () => {
  it("ATK-XTENANT-01 submits another tenant's resource, then a nonexistent one", async () => {
    const { target, log } = scriptedTarget();
    const observation = await scenario("ATK-XTENANT-01").run(target as never) as AttackObservation & { foreignDisplayNames: string[] };
    expect(log).toEqual(["submit:ATK-XTENANT-01-0:other-tenant", "submit:ATK-XTENANT-01-1:nonexistent"]);
    expect(observation.foreignDisplayNames).toEqual(FOREIGN);
  });
  it("ATK-XTENANT-02 submits a same-tenant unauthorized resource, then another tenant's", async () => {
    const { target, log } = scriptedTarget();
    await scenario("ATK-XTENANT-02").run(target as never);
    expect(log).toEqual(["submit:ATK-XTENANT-02-0:same-tenant-unauthorized", "submit:ATK-XTENANT-02-1:other-tenant"]);
  });
  it("ATK-XTENANT-04 makes the host answer null for the baseline and the foreign resource for the mismatch, each before its own proposal", async () => {
    const { target, log } = scriptedTarget();
    await scenario("ATK-XTENANT-04").run(target as never);
    expect(log).toEqual(["answer:null", "submit:ATK-XTENANT-04-0:nonexistent", 'answer:"FOREIGN"', "submit:ATK-XTENANT-04-1:other-tenant"]);
  });
});

describe("the scenarios against the end-to-end chain", () => {
  it.todo("ATK-XTENANT-01 runScenario: other-tenant and nonexistent resources through the real gateway, byte-identical feedback (needs world.withGateway T070 with a resource authorizer the scenario can drive, and ratestages)");
  it.todo("ATK-XTENANT-02 runScenario: a same-tenant resource the user may not use looks like another tenant's (needs T070 and ratestages)");
  it.todo("ATK-XTENANT-03 runScenario: a tenant id in the envelope or parameters is rejected (needs T070 and ratestages: intake and validate already refuse it, but the denial oracle also requires the audit linkage written by the runner)");
  it.todo("ATK-XTENANT-04 runScenario: a foreign resource returned by the host is a tenant_mismatch, indistinguishable to the planner (needs T070, ratestages, and a resource authorizer that can answer with a foreign resource)");
  it.todo("ATK-XTENANT-05..10 store isolation, same callId in two tenants, confirmations, rate counters, reviewer queries and display-name canaries: belong to the PostgreSQL, confirmation, limits and reader batches (T093/T094, T104/T105, T115-T119)");
});
