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

it("context rejects a route outside the registry instead of echoing port data", () => {
  const h = makeHarness();
  const runtime = createWalkthroughRuntime({ ...h.options, router: { ...h.ports.router, current: () => "SECRET_BAD_PORT_VALUE" } });
  expect(runtime.context()).toEqual({ route: "", elements: [] });
});

it("native rejected promises are observed even when their own then getter throws", async () => {
  const h = makeHarness();
  const rejected = Promise.reject(new Error("private failure"));
  Object.defineProperty(rejected, "then", { get() { throw new Error("poisoned then"); } });
  h.answers.check = () => rejected;
  h.runtime.startWalkthrough("verifyOnly");
  h.runtime.dispatch({ type: "click", id: "profile.saveButton" });
  await Promise.resolve();
  await Promise.resolve();
  expect(h.runtime.getState()).toMatchObject({ status: "FAILED", failure: "verification_failed" });
});
