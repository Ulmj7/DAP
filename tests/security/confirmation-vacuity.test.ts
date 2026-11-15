import { describe, expect, it } from "vitest";
import type { ConfirmationStore, NewConfirmation, TenantScope } from "@dap/contracts";
import { InMemoryConfirmationStore } from "@dap/security";
import { FakeClock } from "@dap/testkit";
import { confirmationConformanceCases, type ConfirmationTestContext } from "../../packages/security/src/state/conformance/confirmation.conformance.js";

function reference(defect = -1): ConfirmationTestContext {
  const clock = new FakeClock(); const real = new InMemoryConfirmationStore(clock);
  let first: { scope: TenantScope; record: NewConfirmation } | undefined;
  const store: ConfirmationStore = {
    create: async (scope, row) => { if (defect === 7 && first?.record.id === row.id) return; await real.create(scope, row); first ??= { scope, record: row }; },
    get: async (scope, id) => {
      if (defect === 8 && typeof id === "string" && id.startsWith("{")) return null;
      const row = await real.get(defect === 2 && first ? first.scope : scope, id);
      if (defect === 9 && row?.status === "accepted") return { ...row, decidedAt: row.createdAt };
      return defect === 0 && row ? { ...row, params: { corrupted: true } } : row;
    },
    listPending: (scope, user) => real.listPending(scope, defect === 3 ? "alice" as never : user),
    tryAccept: async (scope, id, user) => defect === 1 || defect === 4 || defect === 5 ? true : real.tryAccept(scope, id, user),
    tryReject: real.tryReject.bind(real), invalidate: real.invalidate.bind(real),
    recordExecution: async (scope, id, status) => { if (defect === 6) return; return real.recordExecution(scope, id, status); },
  };
  return { store, now: () => clock.now(), advanceSeconds: async (seconds) => { clock.advance(seconds); } };
}
describe("T097 confirmation conformance has no vacuous property", () => {
  it.each(confirmationConformanceCases.map((entry, index) => [entry.name, entry, index] as const))("faithful and broken adapter: %s", async (_name, entry, index) => {
    await expect(entry.run(reference())).resolves.toBeUndefined();
    await expect(entry.run(reference(index))).rejects.toThrow();
  });
});
