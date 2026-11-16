// The checks behind `npm run test:m1-gate`, kept separate so tests/architecture/m1-gate.test.ts can prove each one able to fail.
// Input: the JSON report of one vitest run (arch + security + conformance + integration). Output: a list of problems; empty means pass.

/** Suites that must exist, be non-empty, pass and have no skipped test. One or more per T071 category (see m1-gate.mjs). */
export const REQUIRED_SUITES = Object.freeze([
  "apps/reference-host/src/startup.test.ts", "packages/security/src/state/postgres/pool.test.ts",
  "tests/architecture/graph.test.ts", "tests/architecture/contracts-boundary.test.ts", "tests/architecture/module-loaders.test.ts", "tests/architecture/static-scan.test.ts", "tests/architecture/m1-gate.test.ts",
  "tests/security/test-world.gateway.test.ts", "tests/security/positive.test.ts", "tests/security/unknown-action.test.ts", "tests/security/malformed-parameters.test.ts",
  "tests/security/prompt-injection.test.ts", "tests/security/privilege-escalation.test.ts", "tests/security/cross-tenant.test.ts", "tests/security/execution-cap.test.ts",
  "tests/security/rate-replay.gateway.test.ts", "tests/security/secret-extraction.test.ts", "tests/security/audit.test.ts", "tests/security/dependency-failure.test.ts",
  "tests/security/review-fixes.test.ts", "tests/security/review-probes.test.ts",
  "tests/integration/audit-trail.test.ts", "tests/integration/audit-postgres.test.ts", "tests/integration/reference-host.test.ts",
  "packages/security/src/state/conformance/audit-migration.test.ts", "packages/security/src/state/conformance/state-postgres-audit.test.ts",
]);
/** One file at least must run in each vitest project the gate selects. */
export const PROJECT_PATHS = Object.freeze({
  arch: "tests/architecture/", security: "tests/security/", integration: "tests/integration/", conformance: "/state/conformance/",
});
/** The reference host's vertical path: each numbered group of tests/integration/reference-host.test.ts must have run and passed. */
export const REFERENCE_HOST_GROUPS = Object.freeze(["1. VALID EXECUTION", "2. MISSING, INVALID and EXPIRED", "3. an UNAUTHORIZED", "4. a persistent AUDIT", "5. a CONFIRMATION-REQUIRED", "6. the AI-facing handle"]);
const TIER = /\((?:OPTIONAL|FUTURE)\b/;

const count = (file, status) => file.assertionResults.filter((test) => test.status === status).length;
const find = (report, path) => report.testResults.find((file) => file.name.replaceAll("\\", "/").endsWith(`/${path}`));

export function checkReport(report, { suites = REQUIRED_SUITES, groups = REFERENCE_HOST_GROUPS } = {}) {
  const problems = [];
  if (report === null || typeof report !== "object" || !Array.isArray(report.testResults)) return ["the vitest report is missing or malformed"];
  if (report.success !== true || report.numFailedTests > 0 || report.numFailedTestSuites > 0) problems.push(`vitest reported failures (${report.numFailedTests} tests, ${report.numFailedTestSuites} suites)`);
  for (const path of suites) {
    const file = find(report, path);
    if (file === undefined) { problems.push(`missing suite: ${path}`); continue; }
    if (count(file, "passed") === 0) problems.push(`empty suite (no passing test): ${path}`);
    if (count(file, "failed") > 0) problems.push(`failing suite: ${path}`);
    if (count(file, "skipped") + count(file, "pending") + count(file, "disabled") > 0) problems.push(`skipped tests in: ${path}`);
  }
  for (const [project, part] of Object.entries(PROJECT_PATHS)) {
    if (!report.testResults.some((file) => file.name.replaceAll("\\", "/").includes(part) && count(file, "passed") > 0)) problems.push(`no test ran in the ${project} project`);
  }
  const host = find(report, "tests/integration/reference-host.test.ts");
  if (host !== undefined) {
    for (const group of groups) {
      if (!host.assertionResults.some((test) => test.status === "passed" && (test.ancestorTitles[0] ?? "").startsWith(group))) problems.push(`reference host group did not pass: ${group}`);
    }
  }
  // Every todo that is left must say it is OPTIONAL or FUTURE; a REQUIRED one means the gate is not honest about what it proves.
  for (const file of report.testResults) {
    for (const test of file.assertionResults) {
      if (test.status !== "todo") continue;
      const title = [...test.ancestorTitles, test.title].join(" > ");
      if (!TIER.test(test.title) || /\(REQUIRED\b/.test(test.title)) problems.push(`todo without an OPTIONAL or FUTURE tag (or tagged REQUIRED): ${file.name.split("/tests/").pop()}: ${title.slice(0, 90)}`);
    }
  }
  return problems;
}
