/**
 * @dap/testkit: attacks/hidden-data.ts: ATK-HIDDEN, the reserved cell.
 *
 * Hidden-data exposure belongs to the client-side privacy feature (catalogue, "ATK-HIDDEN: reserved"). The scenario exists so that the coverage
 * report lists the cell for every capability; this feature waives it through the standing waiver in `packages/testkit/waivers.json`. It must never
 * be able to count as coverage: running it fails, and its oracle never returns an empty list.
 */
import type { AttackScenario } from "@dap/contracts";

export const hiddenDataScenarios: readonly AttackScenario[] = Object.freeze([
  Object.freeze({
    id: "ATK-HIDDEN",
    category: "hidden-data" as const,
    title: "reserved for the client-side privacy feature (waived in this feature)",
    appliesTo: () => true,
    run: () => Promise.reject(new Error("ATK-HIDDEN is reserved: it has no implementation in this feature and must be waived, not run")),
    verify: () => Object.freeze(["ATK-HIDDEN is reserved and cannot pass"]),
  }),
]);
