import { describe, it } from "vitest";
import { dependencyFailureScenarios, confirmationChannelFailure } from "@dap/testkit";

describe("ATK-DEP real-gateway dependency matrix", () => {
  for (const scenario of dependencyFailureScenarios) {
    it.todo(`${scenario.id}: prepare a fresh one-shot fixture and configure ${scenario.port} with ${scenario.mode}, drive the REAL required port and assert faultCalls increments, assert generic DENIED/UNAUTHORIZED, executor 0 and no leaks; waiting for full gateway chain (hang via fake timer, not elapsed time)`);
  }
  for (const mode of confirmationChannelFailure.modes) {
    it.todo(`${confirmationChannelFailure.id}-${mode}: delivery fault leaves REQUIRES_CONFIRMATION and the durable request in listPending, executor 0; waiting for confirmation/audit chain`);
  }
});
