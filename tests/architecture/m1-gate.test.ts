/**
 * T071: the M1 gate's own checks (scripts/m1-gate-check.mjs) are able to fail. A gate that cannot reject a missing, empty, skipped or failing suite, a reference-host
 * group that did not run, or an untagged todo would pass vacuously. Pure data in, problems out; no database.
 */
import { describe, expect, it } from "vitest";
import { PROJECT_PATHS, REFERENCE_HOST_GROUPS, REQUIRED_SUITES, checkReport } from "../../scripts/m1-gate-check.mjs";

type Status = "passed" | "failed" | "skipped" | "todo";
const test = (status: Status, title = "t", group = "g") => ({ ancestorTitles: [group], title, status });
const file = (path: string, tests: ReturnType<typeof test>[]) => ({ name: `/repo/${path}`, assertionResults: tests });
const hostTests = REFERENCE_HOST_GROUPS.map((group) => test("passed", "x", group));
/** One passing file for every required suite, one for every project, the host with all its groups. */
const healthy = () => ({
  success: true, numFailedTests: 0, numFailedTestSuites: 0,
  testResults: [
    ...REQUIRED_SUITES.map((path) => file(path, path.endsWith("reference-host.test.ts") ? hostTests : [test("passed")])),
  ],
});
const without = (report: ReturnType<typeof healthy>, path: string) => ({ ...report, testResults: report.testResults.filter((entry) => !entry.name.endsWith(path)) });
const replace = (report: ReturnType<typeof healthy>, path: string, tests: ReturnType<typeof test>[]) => ({ ...report, testResults: report.testResults.map((entry) => (entry.name.endsWith(path) ? file(path, tests) : entry)) });
const HOST = "tests/integration/reference-host.test.ts";

describe("the M1 gate's checks", () => {
  it("passes a healthy report, and every project and the reference host are part of it", () => {
    expect(checkReport(healthy())).toEqual([]);
    expect(Object.keys(PROJECT_PATHS).sort()).toEqual(["arch", "conformance", "integration", "security"]);
    expect(REQUIRED_SUITES).toContain(HOST);
    expect(REFERENCE_HOST_GROUPS).toHaveLength(6);
  });
  it.each(REQUIRED_SUITES)("a missing suite is a failure: %s", (path) => {
    expect(checkReport(without(healthy(), path))).toContain(`missing suite: ${path}`);
  });
  it("an empty suite (todo only, or skipped only) is a failure", () => {
    expect(checkReport(replace(healthy(), "tests/security/positive.test.ts", [test("todo", "x (OPTIONAL)")]))).toContain("empty suite (no passing test): tests/security/positive.test.ts");
    expect(checkReport(replace(healthy(), "tests/security/positive.test.ts", [test("skipped")]))).toContain("empty suite (no passing test): tests/security/positive.test.ts");
    expect(checkReport(replace(healthy(), "tests/security/positive.test.ts", []))).toContain("empty suite (no passing test): tests/security/positive.test.ts");
  });
  it("a skipped test inside an otherwise passing suite, and a failing one, are failures", () => {
    expect(checkReport(replace(healthy(), "tests/security/positive.test.ts", [test("passed"), test("skipped")]))).toContain("skipped tests in: tests/security/positive.test.ts");
    expect(checkReport(replace(healthy(), "tests/security/positive.test.ts", [test("passed"), test("failed")]))).toContain("failing suite: tests/security/positive.test.ts");
  });
  it("a run vitest itself calls unsuccessful is a failure, even if every selected file looks healthy", () => {
    expect(checkReport({ ...healthy(), success: false, numFailedTests: 2 }).join("\n")).toMatch(/vitest reported failures/);
  });
  it.each(REFERENCE_HOST_GROUPS)("a reference-host group that did not pass is a failure: %s", (group) => {
    const tests = REFERENCE_HOST_GROUPS.filter((name) => name !== group).map((name) => test("passed", "x", name));
    expect(checkReport(replace(healthy(), HOST, tests))).toContain(`reference host group did not pass: ${group}`);
    const skipped = REFERENCE_HOST_GROUPS.map((name) => test(name === group ? "skipped" : "passed", "x", name));
    expect(checkReport(replace(healthy(), HOST, skipped))).toContain(`reference host group did not pass: ${group}`);
  });
  it("a project in which no test ran is a failure", () => {
    const report = healthy();
    const noArch = { ...report, testResults: report.testResults.filter((entry) => !entry.name.includes("tests/architecture/")) };
    expect(checkReport(noArch, { suites: [] })).toContain("no test ran in the arch project");
  });
  it("a todo must say OPTIONAL or FUTURE: an untagged one and a REQUIRED one are failures, a tagged one is not", () => {
    const withTodo = (title: string) => replace(healthy(), "tests/security/positive.test.ts", [test("passed"), test("todo", title)]);
    expect(checkReport(withTodo("ATK-X (OPTIONAL, T108) later"))).toEqual([]);
    expect(checkReport(withTodo("ATK-X (FUTURE, T123) later"))).toEqual([]);
    expect(checkReport(withTodo("ATK-X later")).join("\n")).toMatch(/todo without an OPTIONAL or FUTURE tag/);
    expect(checkReport(withTodo("ATK-X (REQUIRED) later")).join("\n")).toMatch(/todo without an OPTIONAL or FUTURE tag/);
    expect(checkReport(withTodo("ATK-X (OPTIONAL) and (REQUIRED)")).join("\n")).toMatch(/todo without an OPTIONAL or FUTURE tag/);
  });
  it("a missing or malformed report is a failure", () => {
    expect(checkReport(undefined)).toEqual(["the vitest report is missing or malformed"]);
    expect(checkReport({})).toEqual(["the vitest report is missing or malformed"]);
  });
});


it("the gate requires the existing dev-auth startup and PostgreSQL pool guards, not only integration files", () => {
  expect(REQUIRED_SUITES).toContain("apps/reference-host/src/startup.test.ts");
  expect(REQUIRED_SUITES).toContain("packages/security/src/state/postgres/pool.test.ts");
});
