import { describe, expect, it } from "vitest";
import { buildRegistry } from "@dap/security";
import { malformedParamsSchema, malformedParameterScenarios, testSafeEcho } from "@dap/testkit";

const traits = { actionId: testSafeEcho.id, risk: "SAFE" as const, changesState: false, targetsResource: false, requiresConfirmation: false };
describe("T053 malformed parameters", () => {
  it("fixture schema registers and accepts bounded benign parameters", () => {
    const registry = buildRegistry([{ ...testSafeEcho, inputSchema: malformedParamsSchema }]);
    expect(registry.get(testSafeEcho.id)?.definition.inputSchema.safeParse({ message: "ok", count: 10, tags: ["a", "b"], options: { nested: { leaf: { value: "ok" } } } }).success).toBe(true);
  });
  for (const scenario of malformedParameterScenarios) {
    if (["01", "02", "03", "04", "05", "11"].some((suffix) => scenario.id.endsWith(suffix))) {
      it(`${scenario.id} schema rejects every malformed fixture`, () => {
        for (const item of scenario.cases(traits)) {
          const raw = item.raw as { params: unknown };
          expect(malformedParamsSchema.safeParse(raw.params).success).toBe(false);
        }
      });
    }
    // Intake/validate is in progress on intake-wire; end-to-end evidence still needs audit/execution.
    // Use fresh state and real limiter thresholds above cases().length (including denial throttle).
    // Pass the same traits to verify(observation, traits); scan all visible output with fixture canaries.
    it.todo(`${scenario.id} ${scenario.title}: runScenario against real gateway, expected outcome/reason, executorCalls === 0`);
  }
  it.todo("ATK-PARAMS-12 valid-first getter/Proxy changes after intake: allow path executes only the validated frozen first snapshot (requires real authorization/audit/execution and a positive control)");
  it("ATK-PARAMS-09 fixture exceeds byte cap before character count reaches cap", () => {
    const raw = malformedParameterScenarios.find((item) => item.id === "ATK-PARAMS-09")!.cases(traits)[0]!.raw as string;
    expect(raw.length).toBeLessThan(1024);
    expect(Buffer.byteLength(raw)).toBeGreaterThan(1024);
  });
});
