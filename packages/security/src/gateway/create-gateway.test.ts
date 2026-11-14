import { describe, expect, it } from "vitest";
import type { GatewayDependencies } from "@dap/contracts";
import { createPolicyGateway } from "./create-gateway.js";
import { context, dependencies, run } from "./fixtures.test-support.js";

/** A well-formed envelope: intake, resolve and validate pass, and the first absent stage then denies fail-closed. */
const VALID = '{"action":"viewProject","params":{}}';

describe("gateway composition and planner boundary", () => {
  it("returns the two frozen doors and a fail-closed confirmation placeholder", async () => {
    const { deps, calls } = dependencies();
    const gateway = createPolicyGateway(deps);
    expect(Object.keys(gateway)).toEqual(["proposals", "confirmations"]);
    expect(Object.isFrozen(gateway)).toBe(true);
    expect(Object.isFrozen(gateway.proposals)).toBe(true);
    expect(Object.isFrozen(gateway.confirmations)).toBe(true);
    const result = await gateway.confirmations.decide(context(), { confirmationId: "unknown", decision: "accept" });
    expect(result).toEqual({ status: "not_valid", category: "not_found" });
    expect(Object.isFrozen(result)).toBe(true);
    const pending = await gateway.confirmations.listPending(context());
    expect(pending).toEqual([]);
    expect(Object.isFrozen(pending)).toBe(true);
    expect(calls()).toBe(0);
  });

  it("submit exposes feedback only, with no id, internal reason or raw value", async () => {
    const { deps, calls } = dependencies();
    const submitter = createPolicyGateway(deps).proposals.forSession(context(), run);
    const result = await submitter.submit({ callId: "CANARY_CALL", raw: { action: "viewProject", params: { canary: "CANARY_VALUE" } } });
    expect(result).toEqual({ outcome: "DENIED", category: "try_later" });
    expect(Object.keys(submitter)).toEqual(["submit"]);
    expect(Object.isFrozen(submitter)).toBe(true);
    expect(Object.isFrozen(result)).toBe(true);
    expect(calls()).toBe(0);
  });

  it("checks context before accessing a proposal", async () => {
    const { deps, calls } = dependencies();
    let reads = 0;
    const call = { get raw(): never { reads++; throw new Error("CANARY"); }, get callId(): never { reads++; throw new Error("CANARY"); } };
    const result = await createPolicyGateway(deps).proposals.forSession({ ...context() }, run).submit(call);
    expect(result).toEqual({ outcome: "UNAUTHORIZED", category: "not_available" });
    expect(reads).toBe(0);
    expect(calls()).toBe(0);
  });

  it("captures dependency properties once and preserves host method receivers", async () => {
    const { deps, calls } = dependencies();
    const seen = new WeakMap<object, Map<PropertyKey, number>>();
    const copies = new WeakMap<object, object>();
    let clockCalls = 0;
    const receivers: unknown[] = [];
    const port = { time: "2026-01-01T00:00:00Z", now() { clockCalls++; receivers.push(this); return this.time as never; } };
    Object.assign(deps, { clock: port });
    function watch(value: object): object {
      const old = copies.get(value);
      if (old) return old;
      const proxy = new Proxy(value, { get(target, key) {
        const counts = seen.get(target) ?? new Map<PropertyKey, number>();
        seen.set(target, counts);
        const count = (counts.get(key) ?? 0) + 1; counts.set(key, count);
        if (count > 1) throw new Error(`repeated field ${String(key)}`);
        const child: unknown = Reflect.get(target, key, target);
        return child && typeof child === "object" && !Object.isFrozen(child) && !(child instanceof Set) ? watch(child) : child;
      } });
      copies.set(value, proxy);
      return proxy;
    }
    const gateway = createPolicyGateway(watch(deps) as GatewayDependencies);
    expect(await gateway.proposals.forSession(context(), run).submit({ callId: "call", raw: VALID })).toEqual({ outcome: "DENIED", category: "try_later" });
    // One reading for the context stage, one to date the PROPOSED record and one for the decision record.
    expect(clockCalls).toBe(3);
    expect(receivers).toHaveLength(3);
    for (const receiver of receivers) expect(receiver).toBe(copies.get(port));
    expect(calls()).toBe(0);
  });

  it("snapshots run metadata once and isolates submitters", async () => {
    const { deps, calls } = dependencies();
    let reads = 0;
    const metadata = { ...run, get model() { reads++; return "model"; } };
    const submitter = createPolicyGateway(deps).proposals.forSession(context(), metadata);
    await submitter.submit({ callId: "one", raw: VALID });
    await submitter.submit({ callId: "two", raw: VALID });
    expect(reads).toBe(1);
    expect(calls()).toBe(0);
  });

  it("snapshots host method selection and configuration at construction", async () => {
    const { deps, calls } = dependencies();
    let clocks = 0;
    Object.assign(deps, { clock: { now: () => { clocks++; return "2026-01-01T00:00:00Z"; } } });
    const gateway = createPolicyGateway(deps);
    Object.assign(deps.clock, { now: () => { throw new Error("replacement"); } });
    Object.assign(deps.config, { hookTimeoutMs: -1 });
    expect(await gateway.proposals.forSession(context(), run).submit({ callId: "call", raw: VALID })).toEqual({ outcome: "DENIED", category: "try_later" });
    expect(clocks).toBe(3); // context stage, PROPOSED record, decision record
    expect(calls()).toBe(0);
  });
});
