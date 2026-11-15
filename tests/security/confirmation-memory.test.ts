import { describe, expect, it } from "vitest";
import { InMemoryConfirmationStore } from "@dap/security";
import { FakeClock } from "@dap/testkit";
import { confirmationFixture, confirmationScope, runConfirmationConformance } from "../../packages/security/src/state/conformance/confirmation.conformance.js";
runConfirmationConformance(async () => {
  const clock = new FakeClock(); return { store: new InMemoryConfirmationStore(clock), now: () => clock.now(), advanceSeconds: async (seconds) => { clock.advance(seconds); } };
});
describe("confirmation memory bounds", () => {
  it("full capacity fails closed without evicting any consumed handle", async () => {
    const clock = new FakeClock(); const store = new InMemoryConfirmationStore(clock, { maxEntries: 1 }); const scope = confirmationScope(); const first = confirmationFixture(scope);
    await store.create(scope, first); await store.tryAccept(scope, first.id, first.userId); clock.advance(901);
    await expect(store.create(scope, confirmationFixture(scope))).rejects.toThrow("capacity");
    expect((await store.get(scope, first.id))!.status).toBe("accepted");
  });
  it("rejects malformed or caller-authored state and captures getter/Proxy data once", async () => {
    const store = new InMemoryConfirmationStore(new FakeClock()); const scope = confirmationScope();
    for (const patch of [{id:"bad"},{ttlSeconds:901},{ttlSeconds:0},{definitionVersion:0},{definitionHash:"secret"},{paramsDigest:"invalid"},{params:{nested:{value:"bad\u0000text"}}},{params:{nested:{["bad\u0000key"]:"value"}}},{risk:"FORBIDDEN"},{actionId:"bad id"},{userId:" alice"},{status:"accepted"},{resource:{type:"doc"}},{resource:{type:"document",id:"doc",extra:true}},{consequence:{title:"bad\ntext",effects:[],irreversible:false}},{consequence:{title:"Title",effects:[],irreversible:false,extra:true}}]) {
      await expect(store.create(scope,{...confirmationFixture(scope),...patch} as never)).rejects.toThrow();
    }
    const input = confirmationFixture(scope); const reads = new Map<PropertyKey,number>();
    const proxy = new Proxy(input,{get(target,key,receiver){const count=(reads.get(key)??0)+1;reads.set(key,count);if(count>1)throw new Error("repeat");return Reflect.get(target,key,receiver);}});
    await store.create(scope,proxy);
    for (const key of Object.keys(input)) expect(reads.get(key)).toBe(1);
    expect((await store.get(scope,input.id))!.params).toEqual(input.params);
  });

});
