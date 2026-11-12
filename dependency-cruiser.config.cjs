/**
 * Package-boundary rules (T009). Allowed edges, from plan.md "Allowed dependency edges":
 *
 *   contracts            -> external libraries only
 *   ai, actions, security -> contracts
 *   testkit              -> contracts, security, ai
 *   apps/reference-host  -> all packages (composition root)
 *
 * Everything else is forbidden. Workspace packages resolve to their real paths
 * (packages/*) through the "@dap/source" export condition, so the rules are path-based.
 */
const forbid = (name, fromPath, toPath, comment) => ({
  name,
  comment,
  severity: "error",
  from: { path: fromPath },
  to: { path: toPath },
});

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    forbid("ai-not-to-security-or-actions", "^packages/ai/", "^packages/(security|actions)/",
      "The AI layer must not reach the Gateway internals or any executor (ATK-ARCH-01)."),
    forbid("actions-not-to-ai-or-security", "^packages/actions/", "^packages/(ai|security)/",
      "Executors depend on contracts only."),
    forbid("security-not-to-ai-or-actions", "^packages/security/", "^packages/(ai|actions)/",
      "The Gateway depends on contracts only."),
    forbid("contracts-leaf", "^packages/contracts/", "^(packages/(ai|actions|security|testkit)|apps)/",
      "contracts may depend on external libraries only."),
    forbid("testkit-allowed-edges", "^packages/testkit/", "^(packages/actions|apps)/",
      "testkit may depend on contracts, security, and ai only."),
    forbid("production-not-to-testkit", "^packages/(contracts|ai|actions|security)/", "^packages/testkit/",
      "No production package may import test infrastructure."),
    forbid("nothing-imports-apps", "^packages/", "^apps/",
      "Apps are composition roots; nothing imports them."),
    {
      name: "no-circular",
      severity: "error",
      comment: "Circular dependencies make the trust layering unverifiable.",
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.base.json" },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["@dap/source", "import", "node", "default"],
      mainFields: ["module", "main", "types"],
    },
    exclude: { path: "(^|/)(dist|coverage|node_modules)/" },
  },
};
