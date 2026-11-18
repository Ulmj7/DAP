/** C01 approved-id handoff and proposal store, no PostgreSQL: the Gateway submission is a stub that plays the executor's part. */
import { describe, expect, it, vi } from "vitest";
import type { GuidanceResult } from "@dap/ai";
import type { AiSession } from "../compose.js";
import { createApprovalRecorder, createGatewayStart } from "./approved-start.js";
import { PROPOSAL_TTL_MS, createProposalStore } from "./proposal-store.js";

const session: AiSession = { submit: async () => { throw new Error("unused: submit is stubbed"); } };
const approved = (walkthroughId: string): GuidanceResult => ({ kind: "walkthrough", walkthroughId });
const refused: GuidanceResult = { kind: "unsupported", message: "Not permitted.", reason: "not_permitted" };

describe("createGatewayStart", () => {
  it("approve: the id the executor's starter received is returned, and the record is claimed", async () => {
    const recorder = createApprovalRecorder();
    const submit = vi.fn(async (_s: AiSession, id: string) => { recorder.starter.start(id); return approved(id); });
    const start = createGatewayStart({ openSession: async () => session, recorder, submit });
    expect(await start("profileUpdate")).toEqual({ ok: true, walkthroughId: "profileUpdate" });
    expect(submit).toHaveBeenCalledWith(session, "profileUpdate");
    expect(recorder.take("profileUpdate")).toBeNull();
  });

  it("policy refuse: the executor never ran, so nothing is recorded and the start fails", async () => {
    const recorder = createApprovalRecorder();
    const start = createGatewayStart({ openSession: async () => session, recorder, submit: async () => refused });
    expect(await start("profileUpdate")).toEqual({ ok: false });
  });

  it("a Gateway ok without a recorded id fails closed", async () => {
    const recorder = createApprovalRecorder();
    const start = createGatewayStart({ openSession: async () => session, recorder, submit: async (_s, id) => approved(id) });
    expect(await start("profileUpdate")).toEqual({ ok: false });
  });

  it("a record left by a refused submission is claimed and never approves a later start", async () => {
    const recorder = createApprovalRecorder();
    let allow = false;
    const start = createGatewayStart({ openSession: async () => session, recorder, submit: async (_s, id) => { recorder.starter.start(id); return allow ? approved(id) : refused; } });
    expect(await start("profileUpdate")).toEqual({ ok: false });
    expect(recorder.take("profileUpdate")).toBeNull();
    allow = true;
    expect(await start("profileUpdate")).toEqual({ ok: true, walkthroughId: "profileUpdate" });
  });

  it("no session, or a throwing submission, fails closed without throwing", async () => {
    const recorder = createApprovalRecorder();
    expect(await createGatewayStart({ openSession: async () => null, recorder, submit: async (_s, id) => approved(id) })("profileUpdate")).toEqual({ ok: false });
    expect(await createGatewayStart({ openSession: async () => { throw new Error("db down"); }, recorder })("profileUpdate")).toEqual({ ok: false });
    const throwing = createGatewayStart({ openSession: async () => session, recorder, submit: async (_s, id) => { recorder.starter.start(id); throw new Error("boom"); } });
    expect(await throwing("profileUpdate")).toEqual({ ok: false });
    expect(recorder.take("profileUpdate")).toBeNull();
  });

  it("overlapping starts of the same id are serialized, so a refused one cannot claim an approved one's record", async () => {
    const recorder = createApprovalRecorder();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let call = 0;
    const submit = async (_s: AiSession, id: string) => {
      call += 1;
      if (call === 1) { recorder.starter.start(id); await gate; return approved(id); }
      return refused;
    };
    const start = createGatewayStart({ openSession: async () => session, recorder, submit });
    const first = start("profileUpdate");
    const second = start("profileUpdate");
    release();
    expect(await first).toEqual({ ok: true, walkthroughId: "profileUpdate" });
    expect(await second).toEqual({ ok: false });
  });

  it("the recorder is bounded: past its limit the starter refuses", () => {
    const recorder = createApprovalRecorder(2);
    expect(recorder.starter.start("a")).toEqual({ ok: true });
    expect(recorder.starter.start("b")).toEqual({ ok: true });
    expect(recorder.starter.start("c")).toMatchObject({ ok: false });
    expect(recorder.take("a")).toBe("a");
    expect(recorder.starter.start("c")).toEqual({ ok: true });
  });
});

describe("createProposalStore", () => {
  const make = (maxEntries?: number) => {
    const clock = { now: 0 };
    let n = 0;
    const store = createProposalStore({ now: () => clock.now, newId: () => `id-${String(++n).padStart(14, "0")}`, ...(maxEntries ? { maxEntries } : {}) });
    return { clock, store };
  };

  it("redeems once, for the minting session only, within the TTL", () => {
    const { clock, store } = make();
    const a = store.mint("s1", "profileUpdate");
    expect(store.redeem("s1", a)).toBe("profileUpdate");
    expect(store.redeem("s1", a)).toBeNull();
    const b = store.mint("s1", "profileUpdate");
    expect(store.redeem("s2", b)).toBeNull();
    expect(store.redeem("s1", b)).toBeNull();
    const c = store.mint("s1", "profileUpdate");
    clock.now += PROPOSAL_TTL_MS;
    expect(store.redeem("s1", c)).toBeNull();
    expect(store.size()).toBe(0);
  });

  it("is bounded: the oldest proposal is evicted first", () => {
    const { store } = make(2);
    const first = store.mint("s", "a");
    const second = store.mint("s", "b");
    const third = store.mint("s", "c");
    expect(store.size()).toBe(2);
    expect(store.redeem("s", first)).toBeNull();
    expect(store.redeem("s", second)).toBe("b");
    expect(store.redeem("s", third)).toBe("c");
  });

  it("fails closed on a repeating id generator", () => {
    const store = createProposalStore({ now: () => 0, newId: () => "same-id-0000000000" });
    store.mint("s", "a");
    expect(() => store.mint("s", "b")).toThrow();
  });
});
