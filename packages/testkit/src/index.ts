/**
 * @dap/testkit — package barrel.
 *
 * Test infrastructure for attacking the Policy Gateway (FR-045..FR-049). Production code
 * never imports this package (enforced by dependency-cruiser).
 */
export * from "./clock.js";
export * from "./ids.js";
export * from "./recording-executor.js";
export * from "./leak-scanner.js";
export * from "./host-fakes.js";
export * from "./fault-injection.js";
export * from "./audit-capture.js";
export * from "./test-capabilities/index.js";
export * from "./world.js";
export * from "./scenario-runner.js";
export * from "./attacks/unknown-action.js";
export * from "./attacks/malformed-parameters.js";
export * from "./attacks/injection-corpus.js";
export * from "./attacks/prompt-injection.js";
export * from "./hostile-planner.js";
export * from "./oracle.js";
export * from "./attacks/cross-tenant-store.js";
export * from "./attacks/dependency-failure.js";
