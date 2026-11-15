/**
 * T059 (ATK-ARCH-01, ATK-ARCH-05, ATK-ARCH-06): the dependency graph and the workspace manifests. Complements contracts-boundary.test.ts (the
 * mint and deep-import edges in every import form) and module-loaders.test.ts / static-scan.test.ts (eval, Function, module loaders).
 *
 * 1. The real repository's graph has no violation, and the rule set has not lost a rule.
 * 2. Every workspace manifest declares exactly the @dap edges plan.md allows.
 * 3. In a disposable workspace, each forbidden edge is a violation of the rule that names it, each allowed edge is none, and a cycle is one.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const cruiseBin = path.join(ROOT, "node_modules/dependency-cruiser/bin/dependency-cruiser.mjs");

interface Graph { modules: { source: string; dependencies: { couldNotResolve: boolean; resolved: string }[] }[]; summary: { violations: { from: string; to: string; rule: { name: string } }[] } }
function cruise(cwd: string): Graph {
  const result = spawnSync(process.execPath, [cruiseBin, "--config", "dependency-cruiser.config.cjs", "--output-type", "json", "packages", "apps"], { cwd, encoding: "utf8", timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });
  expect(result.error).toBeUndefined();
  expect([0, 1], result.stderr).toContain(result.status);
  return JSON.parse(result.stdout) as Graph;
}

/** plan.md "Allowed dependency edges", as manifest dependencies. */
const ALLOWED_MANIFEST_EDGES: Readonly<Record<string, readonly string[]>> = {
  "packages/contracts": [],
  "packages/ai": ["@dap/contracts"],
  "packages/actions": ["@dap/contracts"],
  "packages/security": ["@dap/contracts"],
  "packages/testkit": ["@dap/contracts", "@dap/security", "@dap/ai"],
  "apps/reference-host": ["@dap/contracts", "@dap/ai", "@dap/actions", "@dap/security", "@dap/testkit"],
};
const RULES = ["ai-not-to-security-or-actions", "actions-not-to-ai-or-security", "security-not-to-ai-or-actions", "contracts-leaf", "testkit-allowed-edges", "production-not-to-testkit", "nothing-imports-apps", "no-deep-imports-into-contracts", "mint-entry-restricted", "no-runtime-module-loaders", "no-circular"];

describe("the real repository", () => {
  const graph = cruise(ROOT);
  it("has no forbidden edge", () => {
    expect(graph.summary.violations.map((v) => `${v.rule.name}: ${v.from} -> ${v.to}`)).toEqual([]);
    expect(graph.modules.length).toBeGreaterThan(100);
  });
  it("still has every rule of the boundary configuration", () => {
    const config = (JSON.parse(spawnSync(process.execPath, ["-e", "console.log(JSON.stringify(require('./dependency-cruiser.config.cjs').forbidden.map((rule) => rule.name)))"], { cwd: ROOT, encoding: "utf8" }).stdout) as string[]);
    expect(config.sort()).toEqual([...RULES].sort());
  });
  it("resolves every workspace import it follows (an unresolved edge could hide a violation)", () => {
    const unresolved = graph.modules.flatMap((module) => module.dependencies.filter((dep) => dep.couldNotResolve).map(() => module.source));
    expect(unresolved).toEqual([]);
  });
});

describe("workspace manifests", () => {
  const manifest = (dir: string) => JSON.parse(fs.readFileSync(path.join(ROOT, dir, "package.json"), "utf8")) as Record<string, Record<string, string> | undefined>;
  it.each(Object.entries(ALLOWED_MANIFEST_EDGES))("%s declares only the @dap packages it may use", (dir, allowed) => {
    const m = manifest(dir);
    const declared = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"].flatMap((field) => Object.keys(m[field] ?? {})).filter((name) => name.startsWith("@dap/"));
    expect(declared.filter((name) => !allowed.includes(name))).toEqual([]);
  });
  it("lists exactly the workspaces the table knows, so a new package cannot slip past it", () => {
    const dirs = ["packages", "apps"].flatMap((group) => fs.readdirSync(path.join(ROOT, group)).filter((name) => fs.existsSync(path.join(ROOT, group, name, "package.json"))).map((name) => `${group}/${name}`));
    expect(dirs.sort()).toEqual(Object.keys(ALLOWED_MANIFEST_EDGES).sort());
  });
  it("keeps the AI layer's reach to contracts only, and nothing production-side on testkit", () => {
    expect(Object.keys(manifest("packages/ai").dependencies ?? {})).toEqual(["@dap/contracts"]);
    for (const dir of ["packages/contracts", "packages/ai", "packages/actions", "packages/security"]) {
      for (const field of ["dependencies", "devDependencies", "peerDependencies"]) expect(Object.keys(manifest(dir)[field] ?? {}), `${dir} ${field}`).not.toContain("@dap/testkit");
    }
  });
});

describe("planted edges in a disposable workspace", () => {
  let workspace: string;
  const PACKAGES = ["contracts", "ai", "actions", "security", "testkit"] as const;
  const dirOf = (name: string) => (name === "reference-host" ? "apps/reference-host" : `packages/${name}`);
  /** [from, to, rule that must name it, or null when the edge is allowed] */
  const EDGES: [string, string, string | null][] = [
    ["ai", "security", "ai-not-to-security-or-actions"], ["ai", "actions", "ai-not-to-security-or-actions"],
    ["actions", "ai", "actions-not-to-ai-or-security"], ["actions", "security", "actions-not-to-ai-or-security"],
    ["security", "ai", "security-not-to-ai-or-actions"], ["security", "actions", "security-not-to-ai-or-actions"],
    ["contracts", "ai", "contracts-leaf"], ["contracts", "actions", "contracts-leaf"], ["contracts", "security", "contracts-leaf"], ["contracts", "testkit", "contracts-leaf"], ["contracts", "reference-host", "contracts-leaf"],
    ["testkit", "actions", "testkit-allowed-edges"], ["testkit", "reference-host", "testkit-allowed-edges"],
    ["ai", "testkit", "production-not-to-testkit"], ["actions", "testkit", "production-not-to-testkit"], ["security", "testkit", "production-not-to-testkit"], ["contracts", "testkit", "production-not-to-testkit"],
    ["ai", "reference-host", "nothing-imports-apps"], ["actions", "reference-host", "nothing-imports-apps"], ["security", "reference-host", "nothing-imports-apps"], ["testkit", "reference-host", "nothing-imports-apps"],
    ["ai", "contracts", null], ["actions", "contracts", null], ["security", "contracts", null], ["testkit", "contracts", null], ["testkit", "security", null], ["testkit", "ai", null],
  ];
  const planted = EDGES.map(([from, to, rule], index) => ({ file: `${dirOf(from)}/src/planted_${index}.ts`, from, to, rule }));
  let graph: Graph;

  beforeAll(() => {
    workspace = fs.mkdtempSync(path.join(tmpdir(), "dap-graph-"));
    expect(path.relative(ROOT, workspace).startsWith("..")).toBe(true);
    const put = (file: string, text: string) => { fs.mkdirSync(path.dirname(path.join(workspace, file)), { recursive: true }); fs.writeFileSync(path.join(workspace, file), text); };
    for (const file of ["package.json", "tsconfig.base.json", "dependency-cruiser.config.cjs"]) fs.copyFileSync(path.join(ROOT, file), path.join(workspace, file));
    for (const name of [...PACKAGES, "reference-host"]) {
      const dir = dirOf(name);
      fs.mkdirSync(path.join(workspace, dir), { recursive: true });
      fs.copyFileSync(path.join(ROOT, dir, "package.json"), path.join(workspace, dir, "package.json"));
      put(`${dir}/src/index.ts`, "export const marker = 1;\n");
    }
    fs.mkdirSync(path.join(workspace, "node_modules/@dap"), { recursive: true });
    for (const name of fs.readdirSync(path.join(ROOT, "node_modules"))) if (!name.startsWith(".") && name !== "@dap") fs.symlinkSync(path.join(ROOT, "node_modules", name), path.join(workspace, "node_modules", name), "junction");
    for (const name of PACKAGES) fs.symlinkSync(path.join(workspace, dirOf(name)), path.join(workspace, "node_modules/@dap", name), "junction");
    // The app has no package entry to import by name, so edges into it are written as the relative path a developer would type.
    const specifier = (file: string, to: string) => (to === "reference-host" ? path.posix.relative(path.posix.dirname(file), "apps/reference-host/src/index.ts").replace(/\.ts$/, ".js") : `@dap/${to}`);
    for (const { file, to } of planted) put(file, `import { marker } from ${JSON.stringify(specifier(file, to))};\nexport const planted = marker;\n`);
    // A two-file cycle inside the AI layer.
    put("packages/ai/src/cycle_a.ts", 'import { b } from "./cycle_b.js";\nexport const a = () => b;\n');
    put("packages/ai/src/cycle_b.ts", 'import { a } from "./cycle_a.js";\nexport const b = () => a;\n');
    graph = cruise(workspace);
  });
  afterAll(() => { if (workspace) fs.rmSync(workspace, { recursive: true, force: true }); });

  it("keeps every fixture outside the working repository", () => {
    expect(path.relative(ROOT, workspace).startsWith(`..${path.sep}`) || path.isAbsolute(path.relative(ROOT, workspace))).toBe(true);
  });

  it("resolves each planted edge (an unresolved one would be a vacuous pass)", () => {
    for (const { file, to } of planted) {
      const dependencies = graph.modules.find((module) => module.source === file)?.dependencies ?? [];
      expect(dependencies.length, file).toBeGreaterThan(0);
      expect(dependencies.some((dep) => dep.couldNotResolve), file).toBe(false);
      expect(dependencies[0]!.resolved, file).toContain(dirOf(to));
    }
  });

  it.each(planted.map((item) => [`${item.from} -> ${item.to}`, item] as const))("%s", (_label, item) => {
    const rules = graph.summary.violations.filter((violation) => violation.from === item.file).map((violation) => violation.rule.name);
    if (item.rule === null) expect(rules).toEqual([]);
    else expect(rules).toContain(item.rule);
  });

  it("a cycle between two modules is a violation", () => {
    expect(graph.summary.violations.some((violation) => violation.rule.name === "no-circular" && violation.from.startsWith("packages/ai/src/cycle_"))).toBe(true);
  });
});
