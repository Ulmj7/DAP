import { expect, it } from "vitest";
import { makeHarness, walkthroughC } from "./test-support.js";
import { createWalkthroughRuntime } from "./runtime.js";

it("subscriber cancellation prevents pending presentation", () => {
  const h = makeHarness();
  h.runtime.subscribe(snapshot => {
    if (snapshot.status === "PRESENTING") h.runtime.cancel();
  });
  h.runtime.startWalkthrough("verifyOnly");
  expect(h.runtime.getState().status).toBe("CANCELLED");
  expect(h.effects.filter(effect => effect.type === "present")).toEqual([]);
  expect(h.pending()).toHaveLength(0);
});

it("duplicate synchronous timer callbacks cannot expire the recovery step", () => {
  const h = makeHarness({ definitions: [walkthroughC] });
  let calls = 0;
  const runtime = createWalkthroughRuntime({
    ...h.options,
    targets: { resolve: () => "unavailable" },
    timers: { set: callback => {
      if (calls++ === 0) { callback(); callback(); }
      return () => undefined;
    } },
  });
  runtime.startWalkthrough("findTwoFactor");
  expect(runtime.getState()).toMatchObject({ status: "RESOLVING", stepId: "c2" });
});
