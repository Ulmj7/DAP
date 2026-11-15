/**
 * @dap/testkit: cli/coverage.ts (T127), bound to `npm run coverage:security`.
 *
 * Builds the coverage report for every test capability and every discovered scenario and exits non-zero when any cell is MISSING (SC-011), naming
 * the actionId and the scenario id of each one. Exit codes: 0 nothing missing, 1 at least one MISSING cell, 2 the input is unusable (unreadable or
 * malformed waivers or evidence, unknown arguments), which is never reported as success.
 *
 *   node packages/testkit/dist/cli/coverage.js [--executed <file>] [--json]
 */
import { readFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import type { AttackScenario, CapabilityTraits } from "@dap/contracts";
import * as testkit from "../index.js";
import { ALL_TEST_CAPABILITIES } from "../test-capabilities/index.js";
import { buildCoverageReport, CoverageInputError, discoverScenarios, ExecutionLedger, formatMissing, parseWaivers, traitsOf } from "../coverage.js";

/** Everything the CLI touches outside itself, so that a test can drive it without files or a process. */
export interface CoverageCliIo {
  readText(path: string): string;
  stdout(line: string): void;
  stderr(line: string): void;
  readonly scenarios: readonly AttackScenario[];
  readonly capabilities: readonly CapabilityTraits[];
  readonly waiversPath: string;
  /** Where the evidence of what ran and passed is read from when `--executed` is not given. Absent file: nothing has run. */
  readonly defaultEvidencePath: string;
  readonly generatedAt: string;
}

const isNoEntry = (error: unknown): boolean => typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT";

export function runCoverageCli(argv: readonly string[], io: CoverageCliIo): number {
  let evidencePath = io.defaultEvidencePath;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") json = true;
    else if (arg === "--executed") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) { io.stderr("coverage: --executed needs a file"); return 2; }
      evidencePath = value;
      index += 1;
    } else { io.stderr(`coverage: unknown argument ${String(arg)}`); return 2; }
  }
  try {
    const waivers = parseWaivers(io.readText(io.waiversPath));
    let evidence = new ExecutionLedger();
    try { evidence = ExecutionLedger.parse(io.readText(evidencePath)); }
    catch (error) { if (!isNoEntry(error)) throw error; }
    const report = buildCoverageReport({ capabilities: io.capabilities, scenarios: io.scenarios, executedScenarioIds: evidence.toMap(), waivers, generatedAt: io.generatedAt });
    const counts = { covered: 0, waived: 0, "not-applicable": 0, MISSING: 0 };
    for (const [actionId, row] of Object.entries(report.matrix)) {
      for (const [scenarioId, cell] of Object.entries(row)) {
        counts[cell.state] += 1;
        if (cell.state === "waived" && !json) io.stdout(`WAIVED ${actionId} ${scenarioId} (reviewed by ${cell.waiver.reviewedBy})`);
      }
    }
    if (json) io.stdout(JSON.stringify(report, null, 2));
    else io.stdout(`coverage: covered ${counts.covered}, waived ${counts.waived}, not-applicable ${counts["not-applicable"]}, missing ${counts.MISSING} (${io.capabilities.length} capabilities x ${io.scenarios.length} scenarios)`);
    if (report.missing.length > 0) {
      for (const line of formatMissing(report.missing).split("\n")) io.stderr(line);
      io.stderr(`coverage: ${report.missing.length} applicable scenario(s) neither covered nor waived (SC-011)`);
      return 1;
    }
    return 0;
  } catch (error) {
    if (error instanceof CoverageInputError || isNoEntry(error)) { io.stderr(`coverage: ${(error as Error).message}`); return 2; }
    throw error;
  }
}

/** The real files and the real code. `waivers.json` sits at the package root; the evidence file is written by the catalogue run. */
function realIo(): CoverageCliIo {
  return {
    readText: (path) => readFileSync(path, "utf8"),
    stdout: (line) => { console.log(line); },
    stderr: (line) => { console.error(line); },
    scenarios: discoverScenarios(testkit as Record<string, unknown>),
    capabilities: ALL_TEST_CAPABILITIES.map(traitsOf),
    waiversPath: new URL("../../waivers.json", import.meta.url).pathname,
    defaultEvidencePath: new URL("../../.coverage/executed.json", import.meta.url).pathname,
    generatedAt: new Date().toISOString(),
  };
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(realpathSync(entry)).href) process.exitCode = runCoverageCli(process.argv.slice(2), realIo());
