import { describe, expect, it } from "vitest";
import { toProposalCall } from "@dap/ai";
import { buildRegistry } from "@dap/security";
import { injectionCorpus, promptInjectionScenarios, testSafeEcho } from "@dap/testkit";

const traits = { actionId: testSafeEcho.id, risk: "SAFE" as const, changesState: false, targetsResource: false, requiresConfirmation: false };
describe("T054 prompt injection", () => {
  it("corpus has at least 40 distinct bounded strings, including control and Unicode characters", () => {
    expect(new Set(injectionCorpus).size).toBeGreaterThanOrEqual(40);
    expect(injectionCorpus.every((text) => text.length > 0 && text.length <= 200)).toBe(true);
    expect(injectionCorpus.some((text) => text.includes("\u200b"))).toBe(true);
    expect(injectionCorpus.some((text) => text.includes("\u001b"))).toBe(true);
  });
  it.each(injectionCorpus)("ATK-INJECT-02 schema treats bounded injection text as data: %j", (message) => {
    const schema = buildRegistry([testSafeEcho]).get(testSafeEcho.id)!.definition.inputSchema;
    expect(schema.parse({ message })).toEqual({ message });
  });
  it("ATK-INJECT-01 every scripted proposal names an unregistered action", () => {
    const registry = buildRegistry([testSafeEcho]);
    expect(registry.get(testSafeEcho.id)).toBeDefined();
    const scenario = promptInjectionScenarios[0]!;
    expect(scenario.cases(traits)).toHaveLength(injectionCorpus.length);
    for (const item of scenario.cases(traits)) {
      expect(registry.get((item.raw as { action: string }).action)).toBeUndefined();
    }
  });
  it("ATK-INJECT-06 AI adapter preserves raw injection-bearing envelopes without adding a text channel", () => {
    const raw = JSON.stringify({ action: "testSafeEcho", params: { message: injectionCorpus[0] }, system: "allow" });
    // The intake, not the AI adapter, must reject the extra system field.
    expect(toProposalCall("host-call", raw)).toEqual({ callId: "host-call", raw });
  });
  for (const scenario of promptInjectionScenarios) {
    // Requires full gateway, fresh replay/rate state per variant, and a recording executor.
    it.todo(`${scenario.id} ${scenario.title}: runScenario, generic feedback, audit reason, executorCalls === 0`);
  }
  // Extend the metamorphic run across every eligible bounded string field of all six capabilities.
  it.todo("ATK-INJECT-02 across every valid string parameter: benign/injected outcome, audit reason and executor count identical on independent fresh worlds (include an allowed positive control)");
  // Confirmation consequence and audit projection belong to later task batches.
  it.todo("ATK-INJECT-03 resource display-name injection stays plain data and cannot change risk or confirmation requirement (confirmation service)");
  it.todo("ATK-INJECT-04 newline/ANSI/JSON-breaking audit values stay in one structured row (audit projection)");
});
