import { describe, it, beforeAll, afterAll } from "vitest";
import { expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { ESLint } from "eslint";
import { cruise } from "dependency-cruiser";
import type { IConfiguration } from "dependency-cruiser";

// ---------------------------------------------------------------------------
// Permanent regression test for the @dap/contracts mint boundary (ATK-ARCH-05/06).
//
// It writes short-lived fixtures into the repo under the right package path, lints each one
// with the repo's ESLint config (Node API, so the per-file overrides apply) and cruises the
// whole package set with dependency-cruiser (Node API), then asserts:
//
//   - mint-subpath imports and deep src/dist imports from the AI/actions/app layers are
//     REJECTED by BOTH linters, for STATIC and DYNAMIC (literal) import forms;
//   - the allowed controls (package root, mint from security/testkit, in-package relative
//     inside contracts) PASS both linters.
//
// Everything is written to disk only so depcruise can see it, and is ALWAYS removed in
// afterAll (and in a per-case guard) so the tree is left clean. T059 extends this matrix.
//
// NOTE: this test runs in the `arch` vitest project and expects `npm run typecheck` to have
// emitted packages/contracts/dist (the DoD runs lint -> typecheck -> vitest, so it exists).
// ---------------------------------------------------------------------------

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");

type Form = "static" | "dynamic";
type Verdict = "forbidden" | "allowed";

interface Origin {
  name: string;
  dir: string; // directory (relative to ROOT) the fixture lives in
  deepBase: string; // relative prefix from dir to packages/contracts
  mintAllowed: boolean; // may this origin import @dap/contracts/mint?
}

const ORIGINS: Origin[] = [
  { name: "ai", dir: "packages/ai/src", deepBase: "../../contracts", mintAllowed: false },
  { name: "actions", dir: "packages/actions/src", deepBase: "../../contracts", mintAllowed: false },
  { name: "app", dir: "apps/reference-host/src", deepBase: "../../../packages/contracts", mintAllowed: false },
  { name: "security", dir: "packages/security/src", deepBase: "../../contracts", mintAllowed: true },
  { name: "testkit", dir: "packages/testkit/src", deepBase: "../../contracts", mintAllowed: true },
];

interface Case {
  id: string;
  file: string; // relative to ROOT
  code: string;
  verdict: Verdict;
  origin: string;
  target: string; // "mint" | "root" | "deep-src" | "deep-dist" | "internal"
  form: Form | "internal";
}

const MINT = "@dap/contracts/mint";
const ROOT_SPEC = "@dap/contracts";

function staticImport(spec: string): string {
  const name = spec.includes("/") ? lastSegment(spec) : "x";
  return `import { ${name} } from ${JSON.stringify(spec)};\nexport const probe = ${name};\n`;
}
function dynamicImport(spec: string): string {
  return `export async function probe() { return await import(${JSON.stringify(spec)}); }\n`;
}
function lastSegment(spec: string): string {
  const base = spec.split("/").pop() ?? "x";
  return base.replace(/\.js$/, "").replace(/[^A-Za-z0-9_]/g, "_");
}

function buildCases(): Case[] {
  const cases: Case[] = [];
  const push = (c: Case) => cases.push(c);

  for (const origin of ORIGINS) {
    const file = (target: string) => path.join(origin.dir, `zz_arch_${origin.name}_${target}.ts`);

    // mint subpath
    const mintVerdict: Verdict = origin.mintAllowed ? "allowed" : "forbidden";
    push({ id: `${origin.name}-mint-static`, file: file("mint_s"), code: staticImport(MINT), verdict: mintVerdict, origin: origin.name, target: "mint", form: "static" });
    push({ id: `${origin.name}-mint-dyn`, file: file("mint_d"), code: dynamicImport(MINT), verdict: mintVerdict, origin: origin.name, target: "mint", form: "dynamic" });

    // package root (always allowed)
    push({ id: `${origin.name}-root-static`, file: file("root_s"), code: staticImport(ROOT_SPEC), verdict: "allowed", origin: origin.name, target: "root", form: "static" });

    // deep src (always forbidden outside contracts)
    const deepSrc = `${origin.deepBase}/src/execution-runtime.js`;
    push({ id: `${origin.name}-deepsrc-static`, file: file("dsrc_s"), code: staticImport(deepSrc), verdict: "forbidden", origin: origin.name, target: "deep-src", form: "static" });
    push({ id: `${origin.name}-deepsrc-dyn`, file: file("dsrc_d"), code: dynamicImport(deepSrc), verdict: "forbidden", origin: origin.name, target: "deep-src", form: "dynamic" });

    // deep dist (always forbidden outside contracts)
    const deepDist = `${origin.deepBase}/dist/mint/grant-registry.js`;
    push({ id: `${origin.name}-deepdist-static`, file: file("ddist_s"), code: `import * as g from ${JSON.stringify(deepDist)};\nexport const probe = g;\n`, verdict: "forbidden", origin: origin.name, target: "deep-dist", form: "static" });
    push({ id: `${origin.name}-deepdist-dyn`, file: file("ddist_d"), code: dynamicImport(deepDist), verdict: "forbidden", origin: origin.name, target: "deep-dist", form: "dynamic" });
  }

  // In-package: contracts may reach its own mint tree by relative path (this is the legal path
  // the restricted subpath exposes).
  push({
    id: "contracts-internal-mint",
    file: "packages/contracts/src/mint/zz_arch_internal.ts",
    code: `import { registerGrant } from "./grant-registry.js";\nexport const probe = registerGrant;\n`,
    verdict: "allowed",
    origin: "contracts",
    target: "internal",
    form: "internal",
  });

  return cases;
}

const CASES = buildCases();
const FIXTURE_FILES = CASES.map((c) => c.file);

let eslint: ESLint;

beforeAll(() => {
  // dist must exist for the deep-dist cases to resolve (DoD builds first).
  expect(fs.existsSync(path.join(ROOT, "packages/contracts/dist/index.js"))).toBe(true);
  eslint = new ESLint({ cwd: ROOT, overrideConfigFile: "eslint.config.js" });
});

afterAll(() => {
  for (const rel of FIXTURE_FILES) {
    const abs = path.join(ROOT, rel);
    fs.rmSync(abs, { force: true });
  }
});

function abs(rel: string): string {
  return path.join(ROOT, rel);
}

// Lint one fixture in memory; a "violation" is any no-restricted-imports/no-restricted-syntax hit.
async function lintCase(file: string, code: string): Promise<string[]> {
  const results = await eslint.lintText(code, { filePath: abs(file) });
  const r = results[0];
  if (!r) return [];
  return r.messages
    .filter((m) => m.ruleId === "no-restricted-imports" || m.ruleId === "no-restricted-syntax")
    .map((m) => m.ruleId ?? "unknown");
}

// Run depcruise once over the whole package set and return the set of violation edges, keyed
// by the importing (from) file, plus a flat set of "from -> to" edges.
async function depcruiseViolations(): Promise<{ byFrom: Map<string, string[]>; edges: Set<string> }> {
  const cfgPath = path.join(ROOT, "dependency-cruiser.config.cjs");
  const dcConfig = require(cfgPath) as IConfiguration;
  const res = (await cruise(["packages", "apps"], {
    validate: true,
    outputType: "err",
    rulesFile: cfgPath,
    ruleSet: { forbidden: dcConfig.forbidden ?? [] },
    ...dcConfig.options,
  })) as { output: string; exitCode: number };

  const byFrom = new Map<string, string[]>();
  const edges = new Set<string>();
  // Lines look like: "  error <rule>: <from> → <to>"
  const lineRe = /^\s*error\s+([A-Za-z0-9_-]+):\s*(.+?)\s*→\s*(.+?)\s*$/;
  for (const line of res.output.split("\n")) {
    const m = line.match(lineRe);
    if (!m) continue;
    const [, rule, from, to] = m;
    if (!rule || !from || !to) continue;
    const froms = byFrom.get(from) ?? [];
    froms.push(rule);
    byFrom.set(from, froms);
    edges.add(`${from} -> ${to}`);
  }
  return { byFrom, edges };
}

describe("contracts mint boundary (architecture regression)", () => {
  it("forbids mint/deep imports from untrusted layers and allows the controls", async () => {
    // Write fixtures to disk (depcruise reads them) and lint each in memory.
    const written: string[] = [];
    let violations: { byFrom: Map<string, string[]>; edges: Set<string> } | undefined;
    try {
      for (const c of CASES) {
        const absPath = abs(c.file);
        fs.mkdirSync(path.dirname(absPath), { recursive: true });
        fs.writeFileSync(absPath, c.code, "utf8");
        written.push(c.file);
      }
      violations = await depcruiseViolations();
    } finally {
      for (const rel of written) fs.rmSync(abs(rel), { force: true });
    }

    const failures: string[] = [];
    for (const c of CASES) {
      const lintRules = await lintCase(c.file, c.code);
      const lintBlocked = lintRules.length > 0;
      const fromKey = c.file; // depcruise reports the importing file path (relative to ROOT)
      const depBlocked = violations?.byFrom.has(fromKey) ?? false;
      const lintOk = c.verdict === "forbidden" ? lintBlocked : !lintBlocked;
      const depOk = c.verdict === "forbidden" ? depBlocked : !depBlocked;
      if (!lintOk || !depOk) {
        failures.push(
          `${c.id}: expected ${c.verdict}; lint ${lintBlocked ? "blocked" : "allowed"} (${lintRules.join(",") || "-"}), depcruise ${depBlocked ? "blocked" : "allowed"}`,
        );
      }
    }

    expect(failures, `Boundary matrix failures:\n  ${failures.join("\n  ")}`).toEqual([]);
  });
});
