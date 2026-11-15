import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { AttackScenario, CapabilityTraits, CoverageReport, Waiver } from "@dap/contracts";
import * as testkit from "./index.js";
import { ALL_TEST_CAPABILITIES, testCriticalDelete, testHighPublish, testLowNavigate, testMediumDraft, testSafeEcho } from "./test-capabilities/index.js";
import {
  ANY_CAPABILITY, buildCoverageReport, CoverageInputError, discoverScenarios, ExecutionLedger, formatMissing, parseApplicabilityTable, parseWaivers, traitsOf,
} from "./coverage.js";
import { runCoverageCli } from "./cli/coverage.js";
import type { CoverageCliIo } from "./cli/coverage.js";

const here = dirname(fileURLToPath(import.meta.url));
const read = (relative: string): string => readFileSync(join(here, relative), "utf8");

const traits = (actionId: string, extra: Partial<CapabilityTraits> = {}): CapabilityTraits =>
  ({ actionId, risk: "SAFE", changesState: false, targetsResource: false, requiresConfirmation: false, ...extra });
const scenario = (id: string, appliesTo: (t: CapabilityTraits) => boolean = () => true): AttackScenario => ({
  id, category: "unknown-action", title: id, appliesTo,
  run: () => Promise.reject(new Error("coverage never runs a scenario")), verify: () => ["never"],
});
const waiver = (actionId: string, scenarioId: string, extra: Partial<Waiver> = {}): Waiver =>
  ({ actionId, scenarioId, justification: "documented reason", reviewedBy: "reviewer", ...extra });
const executed = (entries: Record<string, readonly string[]>): ReadonlyMap<string, ReadonlySet<string>> =>
  new Map(Object.entries(entries).map(([action, ids]) => [action, new Set(ids)]));

const A = traits("actionA");
const B = traits("actionB", { risk: "HIGH", requiresConfirmation: true });
const S1 = scenario("ATK-T-01");
const S2 = scenario("ATK-T-02", (t) => t.requiresConfirmation);

describe("T120 buildCoverageReport cells", () => {
  it("marks an applicable scenario that was executed as covered", () => {
    const report = buildCoverageReport({ capabilities: [A], scenarios: [S1], executedScenarioIds: executed({ actionA: ["ATK-T-01"] }), waivers: [] });
    expect(report.matrix["actionA"]?.["ATK-T-01"]).toEqual({ state: "covered" });
    expect(report.missing).toEqual([]);
  });
  it("marks a scenario whose traits do not apply as not-applicable, even when it was executed", () => {
    const report = buildCoverageReport({ capabilities: [A, B], scenarios: [S2], executedScenarioIds: executed({ actionA: ["ATK-T-02"] }), waivers: [] });
    expect(report.matrix["actionA"]?.["ATK-T-02"]).toEqual({ state: "not-applicable" });
    expect(report.matrix["actionB"]?.["ATK-T-02"]).toEqual({ state: "MISSING" });
    expect(report.missing).toEqual([{ actionId: "actionB", scenarioId: "ATK-T-02" }]);
  });
  it("marks an applicable scenario that was neither executed nor waived as MISSING and lists it", () => {
    const report = buildCoverageReport({ capabilities: [A], scenarios: [S1], executedScenarioIds: new Map(), waivers: [] });
    expect(report.matrix["actionA"]?.["ATK-T-01"]).toEqual({ state: "MISSING" });
    expect(report.missing).toEqual([{ actionId: "actionA", scenarioId: "ATK-T-01" }]);
  });
  it("a scenario executed for another capability does not cover this one", () => {
    const report = buildCoverageReport({ capabilities: [A, B], scenarios: [S1], executedScenarioIds: executed({ actionB: ["ATK-T-01"] }), waivers: [] });
    expect(report.matrix["actionA"]?.["ATK-T-01"]).toEqual({ state: "MISSING" });
    expect(report.matrix["actionB"]?.["ATK-T-01"]).toEqual({ state: "covered" });
  });
  it("marks a cell waived and carries the waiver, which is the only way a gap does not fail", () => {
    const w = waiver("actionA", "ATK-T-01");
    const report = buildCoverageReport({ capabilities: [A], scenarios: [S1], executedScenarioIds: new Map(), waivers: [w] });
    expect(report.matrix["actionA"]?.["ATK-T-01"]).toEqual({ state: "waived", waiver: w });
    expect(report.missing).toEqual([]);
  });
  it("a waiver names one action: it does not excuse another capability", () => {
    const report = buildCoverageReport({ capabilities: [A, B], scenarios: [S1], executedScenarioIds: new Map(), waivers: [waiver("actionA", "ATK-T-01")] });
    expect(report.matrix["actionB"]?.["ATK-T-01"]).toEqual({ state: "MISSING" });
  });
  it("a waiver names one scenario: it does not excuse another scenario of the same capability", () => {
    const report = buildCoverageReport({ capabilities: [B], scenarios: [S1, S2], executedScenarioIds: new Map(), waivers: [waiver("actionB", "ATK-T-01")] });
    expect(report.matrix["actionB"]?.["ATK-T-02"]).toEqual({ state: "MISSING" });
  });
  it("a standing waiver for every capability waives the scenario for all of them", () => {
    const w = waiver(ANY_CAPABILITY, "ATK-T-01");
    const report = buildCoverageReport({ capabilities: [A, B], scenarios: [S1], executedScenarioIds: new Map(), waivers: [w] });
    expect(report.matrix["actionA"]?.["ATK-T-01"]).toEqual({ state: "waived", waiver: w });
    expect(report.matrix["actionB"]?.["ATK-T-01"]).toEqual({ state: "waived", waiver: w });
  });
  it("an executed scenario is covered, not waived, when a waiver also exists", () => {
    const report = buildCoverageReport({ capabilities: [A], scenarios: [S1], executedScenarioIds: executed({ actionA: ["ATK-T-01"] }), waivers: [waiver("actionA", "ATK-T-01")] });
    expect(report.matrix["actionA"]?.["ATK-T-01"]).toEqual({ state: "covered" });
  });
  it("a specific waiver wins over a standing one for the same cell", () => {
    const specific = waiver("actionA", "ATK-T-01", { justification: "specific" });
    const report = buildCoverageReport({ capabilities: [A], scenarios: [S1], executedScenarioIds: new Map(), waivers: [waiver(ANY_CAPABILITY, "ATK-T-01"), specific] });
    expect(report.matrix["actionA"]?.["ATK-T-01"]).toEqual({ state: "waived", waiver: specific });
  });
  it("has exactly one cell for every capability and scenario and nothing else", () => {
    const report = buildCoverageReport({ capabilities: [A, B], scenarios: [S1, S2], executedScenarioIds: new Map(), waivers: [] });
    expect(Object.keys(report.matrix)).toEqual(["actionA", "actionB"]);
    for (const row of Object.values(report.matrix)) expect(Object.keys(row)).toEqual(["ATK-T-01", "ATK-T-02"]);
  });
  it("lists missing cells in capability order, then scenario order", () => {
    const report = buildCoverageReport({ capabilities: [A, B], scenarios: [S1, S2], executedScenarioIds: new Map(), waivers: [] });
    expect(report.missing).toEqual([
      { actionId: "actionA", scenarioId: "ATK-T-01" }, { actionId: "actionB", scenarioId: "ATK-T-01" }, { actionId: "actionB", scenarioId: "ATK-T-02" },
    ]);
  });
  it("is deterministic and carries the supplied timestamp without reading a clock", () => {
    const args = { capabilities: [A, B], scenarios: [S1, S2], executedScenarioIds: executed({ actionA: ["ATK-T-01"] }), waivers: [waiver("actionB", "ATK-T-02")], generatedAt: "2026-01-02T03:04:05.000Z" };
    const first = buildCoverageReport(args);
    expect(first.generatedAt).toBe("2026-01-02T03:04:05.000Z");
    expect(JSON.stringify(buildCoverageReport(args))).toBe(JSON.stringify(first));
    expect(buildCoverageReport({ ...args, generatedAt: undefined as never }).generatedAt).toBe("1970-01-01T00:00:00.000Z");
  });
  it("handles an action id that is a prototype key", () => {
    const report = buildCoverageReport({ capabilities: [traits("__proto__")], scenarios: [S1], executedScenarioIds: new Map(), waivers: [] });
    expect(Object.keys(report.matrix)).toEqual(["__proto__"]);
    expect(report.matrix["__proto__"]?.["ATK-T-01"]).toEqual({ state: "MISSING" });
    expect(Object.getPrototypeOf(report.matrix)).toBeNull();
  });
  it("returns a frozen report", () => {
    const report = buildCoverageReport({ capabilities: [A], scenarios: [S1], executedScenarioIds: new Map(), waivers: [] });
    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.matrix)).toBe(true);
    expect(Object.isFrozen(report.matrix["actionA"])).toBe(true);
    expect(Object.isFrozen(report.missing)).toBe(true);
  });
});

describe("T120 buildCoverageReport fails closed on bad input", () => {
  const base = { capabilities: [A, B], scenarios: [S1, S2], executedScenarioIds: new Map<string, ReadonlySet<string>>() };
  const rejects = (args: Parameters<typeof buildCoverageReport>[0], pattern: RegExp) => {
    expect(() => buildCoverageReport(args)).toThrow(CoverageInputError);
    expect(() => buildCoverageReport(args)).toThrow(pattern);
  };
  it.each(["", "   ", "\t\n"])("rejects a waiver with the blank justification %j", (justification) => {
    rejects({ ...base, waivers: [waiver("actionA", "ATK-T-01", { justification })] }, /justification/);
  });
  it.each(["", "   "])("rejects a waiver with the blank reviewer %j", (reviewedBy) => {
    rejects({ ...base, waivers: [waiver("actionA", "ATK-T-01", { reviewedBy })] }, /reviewer/);
  });
  it("rejects a waiver whose fields are not strings", () => {
    rejects({ ...base, waivers: [{ actionId: "actionA", scenarioId: "ATK-T-01", justification: 1, reviewedBy: "r" } as never] }, /justification/);
  });
  it("rejects a waiver for a scenario that does not exist (stale waiver)", () => {
    rejects({ ...base, waivers: [waiver("actionA", "ATK-T-99")] }, /unknown scenario/);
  });
  it("rejects a waiver for a capability that does not exist (stale waiver)", () => {
    rejects({ ...base, waivers: [waiver("ghost", "ATK-T-01")] }, /unknown capability/);
  });
  it("rejects a waiver for a scenario that does not apply to that capability", () => {
    rejects({ ...base, waivers: [waiver("actionA", "ATK-T-02")] }, /does not apply/);
  });
  it("rejects two waivers for the same cell", () => {
    rejects({ ...base, waivers: [waiver("actionA", "ATK-T-01"), waiver("actionA", "ATK-T-01", { justification: "again" })] }, /duplicate waiver/);
  });
  it("rejects evidence for a scenario that is not in the scenario list", () => {
    rejects({ ...base, executedScenarioIds: executed({ actionA: ["ATK-T-77"] }), waivers: [] }, /unknown scenario/);
  });
  it("rejects evidence for a capability that is not in the capability list", () => {
    rejects({ ...base, executedScenarioIds: executed({ ghost: ["ATK-T-01"] }), waivers: [] }, /unknown capability/);
  });
  it("rejects duplicate scenario ids and duplicate capabilities", () => {
    rejects({ ...base, scenarios: [S1, S1], waivers: [] }, /duplicate scenario/);
    rejects({ ...base, capabilities: [A, A], waivers: [] }, /duplicate capability/);
  });
  it("rejects an empty scenario list or capability list, which would pass vacuously", () => {
    rejects({ ...base, scenarios: [], waivers: [] }, /no scenarios/);
    rejects({ ...base, capabilities: [], waivers: [] }, /no capabilities/);
  });
  it("rejects an appliesTo that throws or answers something other than a boolean", () => {
    rejects({ ...base, scenarios: [scenario("ATK-T-03", () => { throw new Error("boom"); })], waivers: [] }, /appliesTo/);
    rejects({ ...base, scenarios: [scenario("ATK-T-03", (() => "yes") as never)], waivers: [] }, /appliesTo/);
    rejects({ ...base, scenarios: [scenario("ATK-T-03", (() => undefined) as never)], waivers: [] }, /appliesTo/);
  });
  it("rejects a capability or a waiver with a blank id, and says which", () => {
    rejects({ ...base, capabilities: [A, traits("  ")], waivers: [] }, /no action id/);
    rejects({ ...base, waivers: [waiver("", "ATK-T-01")] }, /needs an action id and a scenario id/);
    rejects({ ...base, waivers: [waiver("actionA", "")] }, /needs an action id and a scenario id/);
    rejects({ ...base, waivers: [waiver(" ", "ATK-T-01")] }, /needs an action id and a scenario id/);
  });
  it("rejects a malformed scenario id", () => {
    rejects({ ...base, scenarios: [scenario("")], waivers: [] }, /scenario id/);
  });
});

describe("T120 ExecutionLedger (the evidence of what ran and passed)", () => {
  it("records pairs and exposes them as the map the report builder reads", () => {
    const ledger = new ExecutionLedger();
    ledger.record("actionA", "ATK-T-01");
    ledger.record("actionA", "ATK-T-01");
    ledger.record("actionB", "ATK-T-02");
    expect([...ledger.toMap().get("actionA") ?? []]).toEqual(["ATK-T-01"]);
    expect([...ledger.toMap().get("actionB") ?? []]).toEqual(["ATK-T-02"]);
  });
  it("round-trips through its JSON form", () => {
    const ledger = new ExecutionLedger();
    ledger.record("actionB", "ATK-T-02");
    ledger.record("actionA", "ATK-T-01");
    const again = ExecutionLedger.parse(ledger.serialize());
    expect(again.serialize()).toBe(ledger.serialize());
    expect(again.toMap().get("actionA")?.has("ATK-T-01")).toBe(true);
  });
  it("serializes in a stable order whatever the order of recording", () => {
    const one = new ExecutionLedger(); one.record("b", "ATK-X-2"); one.record("a", "ATK-X-1"); one.record("a", "ATK-X-0");
    const two = new ExecutionLedger(); two.record("a", "ATK-X-0"); two.record("a", "ATK-X-1"); two.record("b", "ATK-X-2");
    expect(one.serialize()).toBe(two.serialize());
  });
  it.each([
    ["not JSON", "{"], ["not an object", "[]"], ["no executed key", "{}"], ["executed is an array", '{"executed":[]}'],
    ["ids are not an array", '{"executed":{"a":"ATK-1"}}'], ["an id is not a string", '{"executed":{"a":[1]}}'], ["an id is empty", '{"executed":{"a":[""]}}'],
    ["an extra key", '{"executed":{},"note":"x"}'],
  ])("rejects a ledger that is %s", (_name, text) => {
    expect(() => ExecutionLedger.parse(text)).toThrow(CoverageInputError);
  });
  it("rejects blank ids when recording", () => {
    expect(() => new ExecutionLedger().record("", "ATK-T-01")).toThrow(CoverageInputError);
    expect(() => new ExecutionLedger().record("actionA", "")).toThrow(CoverageInputError);
  });
});

describe("T120 parseWaivers", () => {
  const entry = { actionId: "*", scenarioId: "ATK-HIDDEN", justification: "reserved", reviewedBy: "someone" };
  it("accepts the waiver file shape", () => {
    expect(parseWaivers(JSON.stringify({ waivers: [entry] }))).toEqual([entry]);
    expect(parseWaivers(JSON.stringify({ waivers: [] }))).toEqual([]);
  });
  it.each([
    ["not JSON", "{"], ["not an object", "[]"], ["no waivers key", "{}"], ["waivers is not an array", '{"waivers":{}}'],
    ["an entry is not an object", '{"waivers":[1]}'], ["an extra top-level key", '{"waivers":[],"x":1}'],
  ])("rejects a file that is %s", (_name, text) => {
    expect(() => parseWaivers(text)).toThrow(CoverageInputError);
  });
  it.each(["actionId", "scenarioId", "justification", "reviewedBy"])("rejects an entry without %s", (key) => {
    const rest = Object.fromEntries(Object.entries(entry).filter(([name]) => name !== key));
    expect(() => parseWaivers(JSON.stringify({ waivers: [rest] }))).toThrow(CoverageInputError);
  });
  it("rejects an entry that is null, a number or an array", () => {
    for (const bad of ["null", "1", "[]", '"text"']) expect(() => parseWaivers(`{"waivers":[${bad}]}`), bad).toThrow(CoverageInputError);
  });
  it("rejects an entry with an extra key and one with a non-string field", () => {
    expect(() => parseWaivers(JSON.stringify({ waivers: [{ ...entry, extra: 1 }] }))).toThrow(CoverageInputError);
    expect(() => parseWaivers(JSON.stringify({ waivers: [{ ...entry, reviewedBy: 5 }] }))).toThrow(CoverageInputError);
  });
});

describe("T120 formatMissing", () => {
  it("names the actionId and the scenario id of every missing cell, one per line", () => {
    const text = formatMissing([{ actionId: "actionA", scenarioId: "ATK-T-01" }, { actionId: "actionB", scenarioId: "ATK-T-02" }]);
    expect(text.split("\n")).toEqual(["MISSING actionA ATK-T-01", "MISSING actionB ATK-T-02"]);
  });
  it("is empty when nothing is missing", () => {
    expect(formatMissing([])).toBe("");
  });
});

describe("T127 the coverage CLI", () => {
  const WAIVERS = JSON.stringify({ waivers: [] });
  const io = (files: Record<string, string>, scenarios: readonly AttackScenario[] = [S1, S2], capabilities: readonly CapabilityTraits[] = [A, B]): CoverageCliIo & { out: string[]; err: string[] } => {
    const out: string[] = []; const err: string[] = [];
    return {
      out, err,
      readText: (path) => { const text = files[path]; if (text === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); return text; },
      stdout: (line) => out.push(line), stderr: (line) => err.push(line),
      scenarios, capabilities, waiversPath: "waivers.json", defaultEvidencePath: "executed.json", generatedAt: "2026-01-02T03:04:05.000Z",
    };
  };
  const ledger = (pairs: readonly (readonly [string, string])[]) => { const l = new ExecutionLedger(); for (const [a, s] of pairs) l.record(a, s); return l.serialize(); };

  it("exits 1 and names the actionId and the scenario id of every MISSING cell", () => {
    const env = io({ "waivers.json": WAIVERS, "executed.json": ledger([["actionA", "ATK-T-01"]]) });
    expect(runCoverageCli([], env)).toBe(1);
    expect(env.err.join("\n")).toContain("MISSING actionB ATK-T-01");
    expect(env.err.join("\n")).toContain("MISSING actionB ATK-T-02");
    expect(env.err.join("\n")).not.toContain("MISSING actionA");
  });
  it("exits 0 when every applicable cell is covered or waived", () => {
    const text = JSON.stringify({ waivers: [waiver("actionB", "ATK-T-02")] });
    const env = io({ "waivers.json": text, "executed.json": ledger([["actionA", "ATK-T-01"], ["actionB", "ATK-T-01"]]) });
    expect(runCoverageCli([], env)).toBe(0);
    expect(env.err).toEqual([]);
    expect(env.out).toContain("WAIVED actionB ATK-T-02 (reviewed by reviewer)");
    expect(env.out.join("\n")).toMatch(/covered 2.*waived 1.*not-applicable 1.*missing 0/);
  });
  it("treats a missing evidence file as nothing having run: every applicable cell is MISSING", () => {
    const env = io({ "waivers.json": WAIVERS });
    expect(runCoverageCli([], env)).toBe(1);
    expect(env.err.filter((line) => line.startsWith("MISSING"))).toHaveLength(3);
    expect(env.err.at(-1)).toContain("3 applicable scenario(s) neither covered nor waived");
  });
  it("reads the evidence from --executed when given", () => {
    const env = io({ "waivers.json": WAIVERS, "other.json": ledger([["actionA", "ATK-T-01"], ["actionB", "ATK-T-01"], ["actionB", "ATK-T-02"]]) });
    expect(runCoverageCli(["--executed", "other.json"], env)).toBe(0);
  });
  it("exits 2, not 0 or 1, when the waivers file is unreadable or malformed", () => {
    expect(runCoverageCli([], io({ "executed.json": ledger([]) }))).toBe(2);
    expect(runCoverageCli([], io({ "waivers.json": "{", "executed.json": ledger([]) }))).toBe(2);
    expect(runCoverageCli([], io({ "waivers.json": JSON.stringify({ waivers: [waiver("actionA", "ATK-T-01", { reviewedBy: " " })] }) }))).toBe(2);
  });
  it("exits 2 when the evidence file exists but is malformed, or names something unknown", () => {
    expect(runCoverageCli([], io({ "waivers.json": WAIVERS, "executed.json": "{" }))).toBe(2);
    expect(runCoverageCli([], io({ "waivers.json": WAIVERS, "executed.json": ledger([["actionA", "ATK-T-77"]]) }))).toBe(2);
  });
  it("exits 2 on unknown arguments and on --executed without a value", () => {
    expect(runCoverageCli(["--nope"], io({ "waivers.json": WAIVERS }))).toBe(2);
    expect(runCoverageCli(["--executed"], io({ "waivers.json": WAIVERS }))).toBe(2);
    expect(runCoverageCli(["--executed", "--json"], io({ "waivers.json": WAIVERS }))).toBe(2);
  });
  it("prints the report as JSON with --json, so CI can archive it", () => {
    const env = io({ "waivers.json": JSON.stringify({ waivers: [waiver("actionB", "ATK-T-02")] }), "executed.json": ledger([["actionA", "ATK-T-01"]]) });
    expect(runCoverageCli(["--json"], env)).toBe(1);
    const report = JSON.parse(env.out.join("\n")) as CoverageReport;
    expect(report.generatedAt).toBe("2026-01-02T03:04:05.000Z");
    expect(report.matrix["actionA"]?.["ATK-T-01"]).toEqual({ state: "covered" });
    expect(report.missing).toHaveLength(1);
    expect(report.matrix["actionB"]?.["ATK-T-02"]?.state).toBe("waived");
  });
});

describe("T127 the scenarios and capabilities are derived from the code, not listed", () => {
  const discovered = discoverScenarios(testkit as Record<string, unknown>);
  const ids = discovered.map((item) => item.id);

  it("discovers scenarios from the exports of the attack modules", () => {
    expect(ids).toEqual(expect.arrayContaining(["ATK-UNKNOWN-01", "ATK-UNKNOWN-06", "ATK-PARAMS-01", "ATK-PARAMS-13", "ATK-INJECT-01", "ATK-INJECT-06", "ATK-HIDDEN"]));
    expect(ids.some((id) => id.startsWith("ATK-DEP-"))).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });
  it("finds a scenario array wherever it is exported and ignores everything else", () => {
    const exports = { notScenarios: [1, 2], text: "x", one: [scenario("ATK-A-01")], two: Object.freeze([scenario("ATK-A-02"), scenario("ATK-A-03")]), fn: () => 1, empty: [], mixed: [scenario("ATK-A-04"), 5] };
    expect(discoverScenarios(exports).map((item) => item.id)).toEqual(["ATK-A-01", "ATK-A-02", "ATK-A-03"]);
  });
  it("ignores arrays of objects that look like scenarios but whose id is not an ATK id", () => {
    expect(discoverScenarios({ one: [scenario("not-an-attack")], two: [scenario("ATK-A-01")] }).map((item) => item.id)).toEqual(["ATK-A-01"]);
  });
  it("accepts the same scenario object exported under two names", () => {
    const shared = scenario("ATK-A-01");
    expect(discoverScenarios({ one: [shared], two: [shared] })).toEqual([shared]);
  });
  it("rejects the same scenario id exported twice", () => {
    expect(() => discoverScenarios({ one: [scenario("ATK-A-01")], two: [scenario("ATK-A-01")] })).toThrow(CoverageInputError);
  });
  it("includes every scenario id that appears as a string literal in an attack module", () => {
    // A scenario added to attacks/ but not reaching the report would silently escape SC-011: this fails instead.
    const dir = join(here, "attacks");
    const literal = /["'`](ATK-[A-Z]+-[A-Za-z0-9-]*[A-Za-z0-9])["'`]/g;
    const found = new Set<string>();
    for (const file of readdirSync(dir).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))) {
      for (const match of readFileSync(join(dir, file), "utf8").matchAll(literal)) found.add(match[1]!);
    }
    // Not an AttackScenario: the confirmation-channel exception documented in the catalogue's ATK-DEP section.
    found.delete("ATK-DEP-confirmation-channel");
    expect(found.size).toBeGreaterThan(10);
    expect([...found].filter((id) => !ids.includes(id))).toEqual([]);
  });
  it("includes every scenario family whose ids are built from a template", () => {
    const dir = join(here, "attacks");
    const families = new Set<string>();
    for (const file of readdirSync(dir).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))) {
      for (const match of readFileSync(join(dir, file), "utf8").matchAll(/["'`]ATK-([A-Z]+)-(?:\$\{|[A-Za-z0-9-]*[A-Za-z0-9]["'`])/g)) families.add(match[1]!);
    }
    expect(families.size).toBeGreaterThanOrEqual(4);
    for (const family of families) expect(ids.some((id) => id.startsWith(`ATK-${family}-`) || id === `ATK-${family}`), family).toBe(true);
  });
  it("reads targetsResource from the resource extractor and requiresConfirmation from the policy, nothing else", () => {
    const definition = { id: "x", risk: "MEDIUM" as const, changesState: true, confirmation: { kind: "not-required" as const, justification: "reversible" } };
    expect(traitsOf(definition as never)).toMatchObject({ changesState: true, targetsResource: false, requiresConfirmation: false });
    expect(traitsOf({ ...definition, changesState: false, resource: () => null } as never)).toMatchObject({ changesState: false, targetsResource: true });
    expect(traitsOf({ ...definition, confirmation: { kind: "required" } } as never)).toMatchObject({ requiresConfirmation: true });
  });
  it("derives each test capability's traits from its definition", () => {
    expect(traitsOf(testSafeEcho)).toEqual({ actionId: "testSafeEcho", risk: "SAFE", changesState: false, targetsResource: false, requiresConfirmation: false });
    expect(traitsOf(testLowNavigate)).toMatchObject({ risk: "LOW", changesState: false, targetsResource: false, requiresConfirmation: false });
    expect(traitsOf(testMediumDraft)).toMatchObject({ risk: "MEDIUM", changesState: true, targetsResource: true });
    expect(traitsOf(testHighPublish)).toEqual({ actionId: "testHighPublish", risk: "HIGH", changesState: true, targetsResource: true, requiresConfirmation: true });
    expect(traitsOf(testCriticalDelete)).toMatchObject({ risk: "CRITICAL", changesState: true, targetsResource: true, requiresConfirmation: true });
  });
  it("derives traits for every test capability, so a new one is in the report without a list edit", () => {
    expect(ALL_TEST_CAPABILITIES.map((definition) => traitsOf(definition).actionId)).toEqual(ALL_TEST_CAPABILITIES.map((definition) => definition.id));
  });
});

describe("T127 the standing ATK-HIDDEN waiver", () => {
  const waivers = parseWaivers(read("../waivers.json"));
  const scenarios = discoverScenarios(testkit as Record<string, unknown>);
  const capabilities = ALL_TEST_CAPABILITIES.map(traitsOf);
  it("is one reviewed standing waiver for the reserved scenario and no other", () => {
    expect(waivers).toHaveLength(1);
    expect(waivers[0]).toMatchObject({ actionId: ANY_CAPABILITY, scenarioId: "ATK-HIDDEN" });
    expect(waivers[0]?.justification.trim().length).toBeGreaterThan(20);
    expect(waivers[0]?.reviewedBy.trim().length).toBeGreaterThan(0);
  });
  it("makes the reserved scenario waived for every test capability and leaves every other cell to the evidence", () => {
    const report = buildCoverageReport({ capabilities, scenarios, executedScenarioIds: new Map(), waivers });
    for (const capability of capabilities) {
      expect(report.matrix[capability.actionId]?.["ATK-HIDDEN"]?.state).toBe("waived");
      expect(report.matrix[capability.actionId]?.["ATK-UNKNOWN-01"]?.state).toBe("MISSING");
    }
    expect(report.missing.some((cell) => cell.scenarioId === "ATK-HIDDEN")).toBe(false);
  });
  it("is the only thing keeping ATK-HIDDEN from failing the gate", () => {
    const report = buildCoverageReport({ capabilities, scenarios, executedScenarioIds: new Map(), waivers: [] });
    expect(report.missing.filter((cell) => cell.scenarioId === "ATK-HIDDEN")).toHaveLength(capabilities.length);
  });
  it("the reserved scenario cannot pass if someone ever runs it", async () => {
    const hidden = scenarios.find((item) => item.id === "ATK-HIDDEN")!;
    await expect(hidden.run(capabilities[0]!)).rejects.toThrow(/reserved/);
    expect(hidden.verify({ feedback: [], executorCalls: 0, auditEvents: [], leakFindings: [] }).length).toBeGreaterThan(0);
  });
});

describe("T127 scenario applicability agrees with the catalogue's Applicability traits table", () => {
  const rows = parseApplicabilityTable(read("../../../specs/001-ai-security-foundation/contracts/security-test-catalogue.md"));
  const scenarios = discoverScenarios(testkit as Record<string, unknown>);
  const capabilities = ALL_TEST_CAPABILITIES.map(traitsOf);
  // The catalogue's ATK-DEP section limits a port to the capabilities that need it; the table's "every capability" is the coarse form.
  const NARROWED_BY_CATALOGUE_TEXT = /^ATK-DEP-(resources|confirmations-store)-/;

  it("parses the table into the trait rows it contains", () => {
    expect(rows.map((row) => row.trait)).toEqual(["every capability", "targetsResource", "requiresConfirmation", "changesState", "risk HIGH or CRITICAL"]);
    expect(rows[0]!.matches("ATK-UNKNOWN-03")).toBe(true);
    expect(rows[0]!.matches("ATK-PRIV-06")).toBe(true);
    expect(rows[0]!.matches("ATK-PRIV-05")).toBe(false);
    expect(rows[0]!.matches("ATK-REPLAY-02")).toBe(true);
    expect(rows[0]!.matches("ATK-REPLAY-04")).toBe(false);
    expect(rows[0]!.matches("ATK-REPLAY-07")).toBe(true);
    expect(rows[0]!.matches("ATK-RATE-03")).toBe(true);
    expect(rows[0]!.matches("ATK-RATE-04")).toBe(false);
    expect(rows[1]!.matches("ATK-XTENANT-10")).toBe(true);
    expect(rows[2]!.matches("ATK-CONFIRM-09")).toBe(true);
    expect(rows[3]!.matches("ATK-CONFIRM-16")).toBe(true);
    expect(rows[3]!.matches("ATK-CONFIRM-15")).toBe(false);
    expect(rows[4]!.matches("ATK-RATE-04")).toBe(true);
  });
  it("matches numbers as plain decimal digits only and families as whole words", () => {
    expect(rows[0]!.matches("ATK-PRIV-0x06")).toBe(false);
    expect(rows[0]!.matches("ATK-PRIV-6")).toBe(true);
    expect(rows[0]!.matches("ATK-PRIV-06a")).toBe(false);
    expect(rows[0]!.matches("ATK-PRIVATE-06")).toBe(false);
    expect(rows[0]!.matches("ATK-UNKNOWN")).toBe(true);
    expect(rows[0]!.matches("PRIV-06")).toBe(false);
    expect(rows[3]!.matches("ATK-CONFIRM-14")).toBe(true);
  });
  it("applies each row by its own trait", () => {
    const some = (extra: Partial<CapabilityTraits>) => traits("x", extra);
    expect(rows[0]!.applies(some({}))).toBe(true);
    expect(rows[1]!.applies(some({ targetsResource: true }))).toBe(true);
    expect(rows[1]!.applies(some({ requiresConfirmation: true, changesState: true }))).toBe(false);
    expect(rows[2]!.applies(some({ requiresConfirmation: true }))).toBe(true);
    expect(rows[2]!.applies(some({ targetsResource: true, changesState: true }))).toBe(false);
    expect(rows[3]!.applies(some({ changesState: true }))).toBe(true);
    expect(rows[3]!.applies(some({ targetsResource: true }))).toBe(false);
    expect(rows[4]!.applies(some({ risk: "HIGH" }))).toBe(true);
    expect(rows[4]!.applies(some({ risk: "CRITICAL" }))).toBe(true);
    expect(rows[4]!.applies(some({ risk: "MEDIUM" }))).toBe(false);
    expect(rows[4]!.applies(some({ risk: "SAFE" }))).toBe(false);
  });
  describe("on a table it does not recognise", () => {
    const table = (body: string) => `## Applicability traits\n\n| Trait | Families |\n|---|---|\n${body}\n`;
    it("rejects a catalogue with no such section", () => {
      expect(() => parseApplicabilityTable("# nothing here\n")).toThrow(/no Applicability traits section/);
    });
    it("rejects a table without rows and an unknown trait or id form", () => {
      expect(() => parseApplicabilityTable(table(""))).toThrow(/no rows/);
      expect(() => parseApplicabilityTable(table("| `mystery` | UNKNOWN |"))).toThrow(/unknown trait/);
      expect(() => parseApplicabilityTable(table("| every capability | UNKNOWN-xx |"))).toThrow(/cannot read/);
      expect(() => parseApplicabilityTable(table("| every capability | lower-01 |"))).toThrow(/scenario family/);
    });
    it("stops at the end of the table and at the next heading", () => {
      const parsed = parseApplicabilityTable(`${table("| every capability | UNKNOWN |")}\n| \`changesState\` | AUDIT-01 |\n`);
      expect(parsed.map((row) => row.trait)).toEqual(["every capability"]);
      const next = parseApplicabilityTable(`${table("| every capability | UNKNOWN |")}## Next\n\n| \`changesState\` | AUDIT-01 |\n`);
      expect(next.map((row) => row.trait)).toEqual(["every capability"]);
    });
  });
  it("every discovered scenario that the table names applies exactly where the table says, except where the catalogue narrows it", () => {
    const disagreements: string[] = [];
    let compared = 0;
    for (const item of scenarios) {
      const named = rows.filter((row) => row.matches(item.id));
      if (named.length === 0) continue;
      for (const capability of capabilities) {
        const expected = named.some((row) => row.applies(capability));
        const actual = item.appliesTo(capability);
        compared += 1;
        if (actual === expected) continue;
        if (NARROWED_BY_CATALOGUE_TEXT.test(item.id) && expected && !actual) continue;
        disagreements.push(`${item.id} on ${capability.actionId}: table ${expected}, code ${actual}`);
      }
    }
    expect(compared).toBeGreaterThan(50);
    expect(disagreements).toEqual([]);
  });
  it("a scenario the table names under no trait row is reported, so the table cannot silently lag the code", () => {
    const unnamed = scenarios.filter((item) => item.id !== "ATK-HIDDEN" && !rows.some((row) => row.matches(item.id))).map((item) => item.id);
    expect(unnamed).toEqual([]);
  });
});
