/**
 * tests/architecture/static-scan.test.ts
 *
 * T060. The AI, actions (executor), and security layers must not touch the
 * network or shell directly: no child_process, vm, node:http, node:https,
 * undici, axios, pg (outside the postgres state implementation), or global
 * fetch. The scan uses the TypeScript compiler API, not regex.
 *
 * - Production scan: every non-test .ts file under the three package src
 *   trees must be clean.
 * - Positive control: in-memory fixtures must each be flagged, and clean
 *   fixtures (including pg inside state/postgres and a locally declared
 *   `fetch`) must not be.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { assertCompilerApi, REQUIRED_COMPILER_API, scanSource, scanTree } from "./static-scan.js";
import type { StaticScanFinding, StaticScanKind } from "./static-scan.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Every root, with one file that must be reachable, so an empty or mistyped root can never pass vacuously. */
const SCAN_ROOTS: ReadonlyArray<readonly [string, string]> = [
  ["packages/ai/src", "packages/ai/src/tool-call.ts"],
  ["packages/actions/src", "packages/actions/src/index.ts"],
  ["packages/security/src", "packages/security/src/gateway/pipeline.ts"],
];

describe("production scan: no forbidden modules or global fetch", () => {
  for (const [root, sentinel] of SCAN_ROOTS) {
    it(`is clean in ${root}`, () => {
      const { files, findings } = scanTree(REPO_ROOT, root);
      expect(files.length).toBeGreaterThan(0);
      expect(files).toContain(sentinel);
      expect(findings).toEqual([]);
    });
  }
});

describe("positive control: forbidden constructs are flagged", () => {
  const fixtures: Array<{
    label: string;
    file: string;
    code: string;
    kind: StaticScanKind;
    module?: string;
  }> = [
    {
      label: "static import of child_process",
      file: "packages/ai/src/probe.ts",
      code: 'import { execSync } from "child_process";\nexport const run = (): string => execSync("ls").toString();\n',
      kind: "forbidden-import",
      module: "child_process",
    },
    {
      label: "static import of node:child_process",
      file: "packages/ai/src/probe.ts",
      code: 'import { execSync } from "node:child_process";\nexport const run = (): string => execSync("ls").toString();\n',
      kind: "forbidden-import",
      module: "node:child_process",
    },
    {
      label: "static import of vm",
      file: "packages/actions/src/probe.ts",
      code: 'import * as vm from "vm";\nexport const run = vm.runInNewContext;\n',
      kind: "forbidden-import",
      module: "vm",
    },
    {
      label: "static import of node:vm",
      file: "packages/actions/src/probe.ts",
      code: 'import { runInNewContext } from "node:vm";\nexport const run = runInNewContext;\n',
      kind: "forbidden-import",
      module: "node:vm",
    },
    {
      label: "static import of node:http",
      file: "packages/security/src/probe.ts",
      code: 'import { createServer } from "node:http";\nexport const makeServer = createServer;\n',
      kind: "forbidden-import",
      module: "node:http",
    },
    {
      label: "static import of https",
      file: "packages/security/src/probe.ts",
      code: 'import * as https from "https";\nexport const get = https.get;\n',
      kind: "forbidden-import",
      module: "https",
    },
    {
      label: "static import of node:https",
      file: "packages/security/src/probe.ts",
      code: 'import { get } from "node:https";\nexport const fetchLike = get;\n',
      kind: "forbidden-import",
      module: "node:https",
    },
    {
      label: "static import of undici",
      file: "packages/ai/src/probe.ts",
      code: 'import { request } from "undici";\nexport const doRequest = request;\n',
      kind: "forbidden-import",
      module: "undici",
    },
    {
      label: "static import of axios",
      file: "packages/ai/src/probe.ts",
      code: 'import axios from "axios";\nexport const get = axios.get;\n',
      kind: "forbidden-import",
      module: "axios",
    },
    {
      label: "static import of pg outside state/postgres",
      file: "packages/security/src/probe.ts",
      code: 'import pg from "pg";\nexport const client = pg.Client;\n',
      kind: "forbidden-import",
      module: "pg",
    },
    {
      label: "dynamic import of child_process",
      file: "packages/ai/src/probe.ts",
      code: 'export async function load(): Promise<unknown> {\n  const mod = await import("child_process");\n  return mod;\n}\n',
      kind: "forbidden-import",
      module: "child_process",
    },
    {
      label: "require of vm",
      file: "packages/actions/src/probe.ts",
      code: 'export const vm = require("vm");\n',
      kind: "forbidden-import",
      module: "vm",
    },
    {
      label: "export-from undici",
      file: "packages/security/src/probe.ts",
      code: 'export { request } from "undici";\n',
      kind: "forbidden-import",
      module: "undici",
    },
    {
      label: "import-equals require of pg",
      file: "packages/security/src/probe.ts",
      code: 'import pg = require("pg");\nexport const client = pg.Client;\n',
      kind: "forbidden-import",
      module: "pg",
    },
    {
      label: "global fetch call",
      file: "packages/ai/src/probe.ts",
      code: 'export async function call(url: string): Promise<unknown> {\n  const res = await fetch(url);\n  return res.json();\n}\n',
      kind: "global-fetch",
    },
    {
      label: "global fetch used without await",
      file: "packages/ai/src/probe.ts",
      code: 'export const pending = fetch("https://example.test");\n',
      kind: "global-fetch",
    },
  ];

  for (const fixture of fixtures) {
    it(`flags ${fixture.label}`, () => {
      const findings = scanSource(fixture.file, fixture.code);
      expect(findings).toHaveLength(1);
      const finding = findings[0] as StaticScanFinding;
      expect(finding.kind).toBe(fixture.kind);
      if (fixture.module) expect(finding.module).toBe(fixture.module);
      expect(finding.file).toBe(fixture.file);
      expect(finding.line).toBeGreaterThanOrEqual(1);
    });
  }
});

describe("negative control: allowed constructs are not flagged", () => {
  const fixtures: Array<{ label: string; file: string; code: string }> = [
    {
      label: "pg inside state/postgres",
      file: "packages/security/src/state/postgres/probe.ts",
      code: 'import pg from "pg";\nexport const client = pg.Client;\n',
    },
    {
      label: "a locally declared fetch function",
      file: "packages/ai/src/probe.ts",
      code: 'export function fetch(url: string): string {\n  return url;\n}\nexport const use = fetch;\n',
    },
    {
      label: "fetch as a property access",
      file: "packages/ai/src/probe.ts",
      code: 'const client = { fetch: (url: string) => url };\nexport const run = client.fetch;\n',
    },
    {
      label: "fetch as a parameter",
      file: "packages/ai/src/probe.ts",
      code: 'export function run(fetch: (url: string) => string): string {\n  return fetch("https://example.test");\n}\n',
    },
    {
      label: "fetch destructured with a rename",
      file: "packages/ai/src/probe.ts",
      code: 'export function run(obj: { fetch: (url: string) => string }): string {\n  const { fetch: doFetch } = obj;\n  return doFetch("https://example.test");\n}\n',
    },
    {
      label: "ordinary contract and crypto imports",
      file: "packages/ai/src/probe.ts",
      code: 'import { randomUUID } from "node:crypto";\nimport type { ProposalCall } from "@dap/contracts";\nexport const id = (): string => randomUUID();\nexport const wrap = (raw: unknown, callId: string): ProposalCall => ({ callId, raw });\n',
    },
    {
      label: "fetch inside a string literal",
      file: "packages/ai/src/probe.ts",
      code: 'export const note = "no fetch here";\n',
    },
  ];

  for (const fixture of fixtures) {
    it(`allows ${fixture.label}`, () => {
      expect(scanSource(fixture.file, fixture.code)).toEqual([]);
    });
  }
});

const kinds = (code: string, file = "packages/ai/src/probe.ts"): StaticScanKind[] => [...new Set(scanSource(file, code).map((finding) => finding.kind))].sort();

describe("bypass attempts: module specifiers", () => {
  it.each([
    ["an aliased named import", 'import { request as secretly } from "node:http";\nexport const go = secretly;\n', "node:http"],
    ["a namespace import of net", 'import * as sock from "node:net";\nexport const go = sock;\n', "node:net"],
    ["a default import of tls", 'import tls from "tls";\nexport const go = tls;\n', "tls"],
    ["http2", 'import { connect } from "node:http2";\nexport const go = connect;\n', "node:http2"],
    ["a dns subpath", 'import { lookup } from "node:dns/promises";\nexport const go = lookup;\n', "node:dns/promises"],
    ["dgram", 'import dgram from "dgram";\nexport const go = dgram;\n', "dgram"],
    ["inspector", 'import inspector from "node:inspector";\nexport const go = inspector;\n', "node:inspector"],
    ["the module loader", 'import { createRequire } from "node:module";\nexport const go = createRequire;\n', "node:module"],
    ["a side-effect import", 'import "node:child_process";\n', "node:child_process"],
    ["an inline type modifier, which verbatimModuleSyntax still emits", 'import { type Pool } from "pg";\nexport type P = Pool;\n', "pg"],
    ["a pg subpath", 'import Client from "pg/lib/client";\nexport const go = Client;\n', "pg/lib/client"],
    ["an undici subpath", 'import { Agent } from "undici/types";\nexport const go = Agent;\n', "undici/types"],
    ["an axios subpath", 'import axios from "axios/dist/node/axios.cjs";\nexport const go = axios;\n', "axios/dist/node/axios.cjs"],
    ["pg-pool", 'import Pool from "pg-pool";\nexport const go = Pool;\n', "pg-pool"],
    ["export * from a forbidden module", 'export * from "node:vm";\n', "node:vm"],
    ["export * as from a forbidden module", 'export * as vm from "node:vm";\n', "node:vm"],
    ["a named re-export", 'export { request } from "node:https";\n', "node:https"],
    ["a require in a template literal", "export const vm = require(`child_process`);\n", "child_process"],
    ["a dynamic import in a template literal", "export const load = () => import(`node:vm`);\n", "node:vm"],
    ["a dynamic import with an options argument", 'export const load = () => import("node:vm", { with: {} });\n', "node:vm"],
    ["import-equals with export", 'export import vm = require("vm");\n', "vm"],
    ["getBuiltinModule with a literal", 'export const vm = process.getBuiltinModule("node:vm");\n', "node:vm"],
    ["an element-access getBuiltinModule with a literal", 'export const vm = process["getBuiltinModule"]("vm");\n', "vm"],
    ["require nested in an expression", 'export const run = (() => require("vm"))().runInNewContext;\n', "vm"],
  ])("flags %s", (_label, code, module) => {
    const findings = scanSource("packages/ai/src/probe.ts", code);
    expect(findings.map((finding) => [finding.kind, finding.module])).toEqual([["forbidden-import", module]]);
  });

  it.each([
    ["a concatenated require", 'export const vm = require("child_" + "process");\n'],
    ["a variable dynamic import", 'export const load = (name: string) => import(name);\n'],
    ["a template with a substitution", "export const load = (n: string) => import(`node:${n}`);\n"],
    ["a bare reference to require", 'const load = require;\nexport const vm = load("vm");\n'],
    ["a require with no argument", "export const x = require();\n"],
    ["getBuiltinModule with a variable", 'export const vm = (n: string) => process.getBuiltinModule(n);\n'],
    ["an element-access getBuiltinModule with a variable", 'export const vm = (n: string) => process["getBuiltinModule"](n);\n'],
  ])("cannot see through %s, so it fails closed", (_label, code) => {
    expect(kinds(code)).toContain("dynamic-module");
  });

  it("does not flag a type-only import or export, which emits nothing", () => {
    for (const code of [
      'import type { Pool } from "pg";\nexport type P = Pool;\n', 'import type pg from "pg";\nexport type P = pg.Pool;\n', 'import type * as vm from "node:vm";\nexport type V = typeof vm;\n',
      'export type { Server } from "node:http";\n', 'export type * from "node:http";\n', 'import type vm = require("vm");\nexport type V = typeof vm;\n',
    ]) expect(scanSource("packages/security/src/probe.ts", code), code).toEqual([]);
  });

  it("rests that on verbatimModuleSyntax, so the assumption cannot lapse silently", () => {
    const base = ts.readConfigFile(join(REPO_ROOT, "tsconfig.base.json"), ts.sys.readFile);
    expect((base.config as { compilerOptions: { verbatimModuleSyntax?: boolean } }).compilerOptions.verbatimModuleSyntax).toBe(true);
  });
});

describe("bypass attempts: pg is allowed only under state/postgres, anchored at the repository root", () => {
  const pg = 'import pg from "pg";\nexport const client = pg.Client;\n';
  it.each([
    "packages/security/src/state/postgres/tenant-policy.ts", "packages/security/src/state/postgres/nested/deeper/x.ts", "packages/security/src/state/postgres/x.mjs",
  ])("allows %s", (file) => { expect(scanSource(file, pg)).toEqual([]); });

  it.each([
    "packages/ai/src/packages/security/src/state/postgres/x.ts", "packages/security/src/state/postgres-evil/x.ts", "packages/security/src/state/postgresql/x.ts",
    "packages/security/src/state/conformance/postgres/x.ts", "packages/security/src/other/state/postgres/x.ts", "evil/packages/security/src/state/postgres/x.ts",
    "packages/security/src/state/postgres.ts", "packages/actions/src/state/postgres/x.ts",
  ])("flags %s", (file) => { expect(scanSource(file, pg).map((finding) => finding.kind)).toEqual(["forbidden-import"]); });

  it("anchors an absolute path at the given repository root, and refuses an absolute path without one", () => {
    const allowed = `${REPO_ROOT}/packages/security/src/state/postgres/x.ts`;
    expect(scanSource(allowed, pg, REPO_ROOT)).toEqual([]);
    expect(scanSource(allowed, pg).map((finding) => finding.kind)).toEqual(["forbidden-import"]);
    expect(scanSource(`${REPO_ROOT}/packages/ai/src/packages/security/src/state/postgres/x.ts`, pg, REPO_ROOT)).toHaveLength(1);
    expect(scanSource("/elsewhere/packages/security/src/state/postgres/x.ts", pg, REPO_ROOT)).toHaveLength(1);
  });

  it("uses forward and back slashes alike", () => {
    expect(scanSource("packages\\security\\src\\state\\postgres\\x.ts", pg)).toEqual([]);
    expect(scanSource("packages\\ai\\src\\state\\postgres\\x.ts", pg)).toHaveLength(1);
  });
});

describe("bypass attempts: reaching the network through the global object", () => {
  it.each([
    ["globalThis.fetch", "export const go = (u: string) => globalThis.fetch(u);\n"],
    ["window.fetch", "export const go = (u: string) => window.fetch(u);\n"],
    ["self.fetch", "export const go = (u: string) => self.fetch(u);\n"],
    ["global.fetch", "export const go = (u: string) => global.fetch(u);\n"],
    ["a computed string key", 'export const go = (u: string) => globalThis["fetch"](u);\n'],
    ["a cast globalThis", "export const go = (u: string) => (globalThis as unknown as { fetch: (u: string) => unknown }).fetch(u);\n"],
    ["a non-null globalThis", "export const go = (u: string) => globalThis!.fetch(u);\n"],
    ["optional chaining", "export const go = (u: string) => globalThis?.fetch?.(u);\n"],
    ["destructuring from globalThis", "const { fetch } = globalThis;\nexport const go = (u: string) => fetch(u);\n"],
    ["a renamed destructuring from globalThis", "const { fetch: f } = globalThis;\nexport const go = (u: string) => f(u);\n"],
    ["a local alias of the global fetch", "const fetch = globalThis.fetch;\nexport const go = (u: string) => fetch(u);\n"],
    ["a local alias that hides the call", "const f = globalThis.fetch;\nexport const go = (u: string) => f(u);\n"],
    ["an alias of the global object itself", "const g = globalThis;\nexport const go = (u: string) => g.fetch(u);\n"],
    ["Reflect.get on the global object", 'export const go = Reflect.get(globalThis, "fetch");\n'],
    ["an indirect string key", 'const key = "fet" + "ch";\nexport const go = (globalThis as Record<string, unknown>)[key];\n'],
    ["fetch in a template literal", "export const go = (u: string) => `${fetch(u)}`;\n"],
    ["fetch held in an array", "export const go = (u: string) => [fetch][0]?.(u);\n"],
    ["fetch as a shorthand property", "export const bag = { fetch };\n"],
    ["fetch with optional call", "export const go = (u: string) => fetch?.(u);\n"],
    ["fetch passed as an argument", "export const go = (use: (f: unknown) => void) => use(fetch);\n"],
    ["a typeof probe followed by a call", 'export const go = (u: string) => (typeof fetch === "function" ? fetch(u) : null);\n'],
  ])("flags %s", (_label, code) => {
    expect(scanSource("packages/ai/src/probe.ts", code).length, code).toBeGreaterThan(0);
  });

  it.each([
    ["new WebSocket", 'export const go = () => new WebSocket("wss://example.test");\n'], ["new XMLHttpRequest", "export const go = () => new XMLHttpRequest();\n"],
    ["new EventSource", 'export const go = () => new EventSource("https://example.test");\n'], ["globalThis.WebSocket", 'export const go = () => new globalThis.WebSocket("wss://x");\n'],
  ])("flags %s", (_label, code) => {
    expect(kinds(code)).toEqual(expect.arrayContaining([expect.stringMatching(/global-network|global-object/)]));
  });

  it.each([
    ["an as cast", "export const go = (globalThis as unknown as { fetch: unknown }).fetch;\n"], ["a non-null assertion", "export const go = globalThis!.fetch;\n"],
    ["a type assertion", "export const go = (<{ fetch: unknown }>(<unknown>globalThis)).fetch;\n"], ["satisfies", "export const go = (globalThis satisfies object).fetch;\n"],
    ["nested parentheses", "export const go = ((globalThis)).fetch;\n"], ["a string key", 'export const go = globalThis["fetch"];\n'],
    ["an optional string key", 'export const go = globalThis?.["fetch"];\n'], ["window", "export const go = window.fetch;\n"], ["self", "export const go = self.fetch;\n"], ["global", "export const go = global.fetch;\n"],
  ])("names the fetch kind through %s", (_label, code) => {
    expect(kinds(code)).toContain("global-fetch");
  });

  it.each([["a string key", 'export const go = () => new globalThis["WebSocket"]("wss://x");\n'], ["a cast", 'export const go = () => new (globalThis as { WebSocket: new (u: string) => unknown }).WebSocket("wss://x");\n']])("names the network kind through %s", (_label, code) => {
    expect(kinds(code)).toContain("global-network");
  });

  it("names the specific kind when the member is fetch", () => {
    expect(kinds("export const go = (u: string) => globalThis.fetch(u);\n")).toEqual(["global-fetch", "global-object"]);
    expect(kinds("const g = globalThis;\nexport const go = g;\n")).toEqual(["global-object"]);
  });

  it.each([
    ["a local binding named self", "export function run(): number {\n  const self = { n: 1 };\n  return self.n;\n}\n"],
    ["a parameter named window", "export const area = (window: { w: number; h: number }) => window.w * window.h;\n"],
    ["a local named global", "export function run(): number {\n  const global = { n: 1 };\n  return global.n;\n}\n"],
    ["a property that is named like a global", "export const read = (o: { window: number; self: number; global: number; globalThis: number }) => o.window + o.self + o.global + o.globalThis;\n"],
    ["the words in a string and a comment", '// globalThis.fetch is not used here\nexport const note = "globalThis window self global";\n'],
    ["an object key", "export const options = { window: 1, self: 2, globalThis: 3 };\n"],
    ["a method named fetch", "export class Repo {\n  fetch(id: string): string { return id; }\n}\nexport const read = (r: Repo) => r.fetch('x');\n"],
    ["a function parameter shadowing fetch", "export const run = (fetch: (u: string) => string) => fetch('x');\n"],
    ["an imported local fetch", 'import { fetch } from "./local-repo.js";\nexport const run = () => fetch("x");\n'],
    ["a destructured rename from a local object", "export const run = (o: { fetch: (u: string) => string }) => { const { fetch: get } = o; return get('x'); };\n"],
    ["an interface member", "export interface Repo { fetch(id: string): string }\n"],
  ])("does not flag %s", (_label, code) => {
    expect(scanSource("packages/ai/src/probe.ts", code), code).toEqual([]);
  });
});

afterEach(() => { vi.doUnmock("typescript"); });

describe("bypass attempts: loader indirection, dynamic code, remote specifiers, shadowing by declarations that emit nothing", () => {
  it.each([
    ["destructuring getBuiltinModule", 'const { getBuiltinModule } = process;\nexport const vm = getBuiltinModule("vm");\n'],
    ["aliasing getBuiltinModule", 'const load = process.getBuiltinModule;\nexport const vm = load("vm");\n'],
    ["getBuiltinModule.call", 'export const vm = process.getBuiltinModule.call(process, "vm");\n'],
    ["getBuiltinModule.bind", 'export const load = process.getBuiltinModule.bind(process);\n'],
    ["a renamed destructuring", 'const { getBuiltinModule: g } = process;\nexport const vm = g("child_process");\n'],
    ["a string-keyed destructuring", 'const { "getBuiltinModule": g } = process;\nexport const vm = g("vm");\n'],
    ["process.mainModule.require", 'export const cp = process.mainModule!.require("child_process");\n'],
    ["module.require", 'export const cp = module.require("child_process");\n'],
    ["process.binding", 'export const spawn = process.binding("spawn_sync");\n'],
    ["a computed process.binding", 'export const spawn = process["binding"]("spawn_sync");\n'],
    ["process.dlopen", "export const load = process.dlopen;\n"],
    ["destructuring binding from process", "const { binding } = process;\nexport const b = binding;\n"],
    ["an alias of process", 'const p = process;\nexport const spawn = p.binding("spawn_sync");\n'],
    ["a computed key on process", 'export const x = (k: string) => (process as unknown as Record<string, unknown>)[k];\n'],
  ])("flags %s", (_label, code) => {
    expect(scanSource("packages/ai/src/probe.ts", code).length, code).toBeGreaterThan(0);
  });

  it.each([
    ["a parenthesized callee", 'export const vm = (process.getBuiltinModule)("vm");\n', "vm"],
    ["a template-literal key", 'export const vm = process[`getBuiltinModule`]("vm");\n', "vm"],
    ["a non-null callee", 'export const vm = process.getBuiltinModule!("node:vm");\n', "node:vm"],
  ])("still names the module through %s", (_label, code, module) => {
    expect(scanSource("packages/ai/src/probe.ts", code).map((finding) => [finding.kind, finding.module])).toEqual([["forbidden-import", module]]);
  });

  it.each([
    ["eval", 'export const run = (s: string) => eval(s);\n'], ["an indirect eval", 'export const run = (s: string) => (0, eval)(s);\n'],
    ["new Function", 'export const make = (s: string) => new Function(s);\n'], ["Function called", 'export const make = (s: string) => Function(s);\n'],
    ["an aliased eval", "const e = eval;\nexport const run = e;\n"], ["Function reached through the global object", 'export const make = (s: string) => globalThis.Function(s);\n'],
    ["a constructor call", 'export const make = (s: string) => (() => 1).constructor(s)();\n'], ["a constructor construct", 'export const make = (s: string) => new (class {}).constructor(s);\n'],
    ["a computed constructor call", 'export const make = (s: string) => (() => 1)["constructor"](s);\n'],
  ])("flags dynamic code through %s", (_label, code) => {
    expect(kinds(code), code).toEqual(expect.arrayContaining([expect.stringMatching(/dynamic-code|global-object/)]));
  });

  it.each([
    ["a method that is merely named eval", "export const run = (o: { eval(s: string): string }) => o.eval('x');\n"],
    ["words that contain eval or Function", 'export const evaluate = (s: string) => s; export const functionName = "Function eval";\n'],
    ["a local Function binding", "export const make = (Function: (s: string) => string) => Function('x');\n"],
    ["Function as a type", "export type Callback = Function;\nexport const f = (c: Callback) => c;\n"],
    ["reading constructor.name", "export const name = (o: object) => o.constructor.name;\n"],
    ["a safe process member", 'export const v = () => process.version;\n'],
    ["a safe computed process member", 'export const v = () => process["env"];\n'],
    ["a local named module", "export const read = () => { const module = { n: 1 }; return module.n; };\n"],
  ])("does not flag %s", (_label, code) => {
    expect(scanSource("packages/ai/src/probe.ts", code), code).toEqual([]);
  });

  it.each(["worker_threads", "node:worker_threads", "cluster", "execa", "node-fetch", "ws", "got", "ky", "superagent", "cross-spawn", "shelljs", "vm2", "isolated-vm", "node-pty", "needle"])(
    "flags %s", (module) => {
      expect(scanSource("packages/ai/src/probe.ts", `import x from "${module}";\nexport const go = x;\n`).map((finding) => [finding.kind, finding.module])).toEqual([["forbidden-import", module]]);
    });

  it.each([
    'import "data:text/javascript,import(\'node:vm\')";\n', 'import x from "https://cdn.example.test/x.js";\nexport const go = x;\n', 'import x from "http://localhost/x.js";\nexport const go = x;\n',
    'import x from "file:///etc/x.js";\nexport const go = x;\n', 'export const load = () => import("data:text/javascript,export default 1");\n', 'import x from "blob:https://x/y";\nexport const go = x;\n',
    'import x from "../../../node_modules/undici/index.js";\nexport const go = x;\n', 'import x from "./node_modules/axios/index.js";\nexport const go = x;\n',
    'import x from "../../node_modules/pg/lib/index.js";\nexport const go = x;\n',
  ])("flags the remote or out-of-tree specifier in %s", (code) => {
    expect(kinds(code), code).toEqual(["forbidden-import"]);
  });

  it("allows ordinary relative, node: and package specifiers", () => {
    for (const specifier of ["./local.js", "../registry/build-registry.js", "node:crypto", "node:perf_hooks", "node:path", "zod", "@dap/contracts", "@dap/contracts/mint", "fast-check"]) {
      expect(scanSource("packages/security/src/probe.ts", `import x from "${specifier}";\nexport const go = x;\n`), specifier).toEqual([]);
    }
  });

  it.each([
    ["an ambient const", "declare const fetch: (u: string) => Promise<unknown>;\nexport const go = (u: string) => fetch(u);\n"],
    ["an ambient function", "declare function fetch(u: string): Promise<unknown>;\nexport const go = (u: string) => fetch(u);\n"],
    ["a type-only import", 'import type { fetch } from "./x.js";\nexport const go = (u: string) => fetch(u);\n'],
    ["an inline type-only import", 'import { type fetch } from "./x.js";\nexport const go = (u: string) => fetch(u);\n'],
    ["a type-only namespace import", 'import type * as fetch from "./x.js";\nexport const go = (u: string) => fetch(u);\n'],
    ["a type-only default import", 'import type fetch from "./x.js";\nexport const go = (u: string) => fetch(u);\n'],
    ["an ambient self", "declare const self: { fetch(u: string): Promise<unknown> };\nexport const go = (u: string) => self.fetch(u);\n"],
  ])("is not fooled into treating %s as a local binding", (_label, code) => {
    expect(scanSource("packages/ai/src/probe.ts", code).length, code).toBeGreaterThan(0);
  });
});

describe("failing loudly", () => {
  it("reports a file the compiler cannot parse instead of silently scanning half of it", () => {
    const findings = scanSource("packages/ai/src/broken.ts", 'import { exec } from "node:child_process";\nexport const = ;\nexport function (\n');
    expect(findings.map((finding) => finding.kind)).toContain("unparseable");
    expect(scanSource("packages/ai/src/ok.ts", "export const fine = 1;\n")).toEqual([]);
  });

  it("reports 1-based lines for findings on later lines", () => {
    const findings = scanSource("packages/ai/src/probe.ts", '\n\nexport const a = 1;\nimport { request } from "node:http";\n\nexport const b = fetch;\n');
    expect(findings.map((finding) => [finding.kind, finding.line])).toEqual([["forbidden-import", 4], ["global-fetch", 6]]);
  });

  it("refuses to run on a TypeScript API that lacks a node kind or guard the scan depends on", () => {
    expect(() => assertCompilerApi(ts)).not.toThrow();
    for (const name of REQUIRED_COMPILER_API.functions) {
      expect(() => assertCompilerApi({ ...ts, [name]: undefined } as unknown as typeof ts), name).toThrow(name);
    }
    for (const name of REQUIRED_COMPILER_API.syntaxKinds) {
      const kinds = { ...ts.SyntaxKind } as Record<string, unknown>;
      delete kinds[name];
      expect(() => assertCompilerApi({ ...ts, SyntaxKind: kinds } as unknown as typeof ts), name).toThrow(name);
    }
    expect(() => assertCompilerApi({} as typeof ts)).toThrow();
  });

  it("refuses at import time to load against a TypeScript that lacks a required guard", async () => {
    vi.resetModules();
    vi.doMock("typescript", () => ({ default: { ...ts, isImportEqualsDeclaration: undefined } }));
    try {
      await expect(import("./static-scan.js")).rejects.toThrow(/isImportEqualsDeclaration/);
    } finally {
      vi.doUnmock("typescript");
      vi.resetModules();
    }
  });

  it("lists every compiler API the scan actually uses, so the guard cannot drift from the code", () => {
    const text = readFileSync(join(REPO_ROOT, "tests/architecture/static-scan.ts"), "utf8");
    const used = new Set([...text.matchAll(/\bts\.(is[A-Z]\w*|create\w+|transpileModule|forEachChild)\b/g)].map((match) => match[1]));
    const guarded = new Set<string>(REQUIRED_COMPILER_API.functions);
    for (const name of used) expect(guarded.has(name as string), `ts.${name} is used but not asserted present`).toBe(true);
    const kindsUsed = new Set([...text.matchAll(/\bts\.SyntaxKind\.(\w+)\b/g)].map((match) => match[1]));
    const guardedKinds = new Set<string>(REQUIRED_COMPILER_API.syntaxKinds);
    for (const name of kindsUsed) expect(guardedKinds.has(name as string), `SyntaxKind.${name} is used but not asserted present`).toBe(true);
  });
});

describe("walking the tree", () => {
  const withTree = (build: (root: string) => void, check: (root: string) => void): void => {
    const root = mkdtempSync(join(tmpdir(), "static-scan-"));
    try { build(root); check(root); } finally { rmSync(root, { recursive: true, force: true }); }
  };
  const put = (root: string, relative: string, text: string): void => {
    mkdirSync(dirname(join(root, relative)), { recursive: true });
    writeFileSync(join(root, relative), text);
  };
  const vm = 'import { runInNewContext } from "node:vm";\nexport const run = runInNewContext;\n';

  it.each(["x.ts", "x.mts", "x.cts", "x.tsx", "x.js", "x.mjs", "x.cjs", "x.jsx", "x.test-support.ts", "deep/er/x.ts"])("scans %s as production code", (name) => {
    withTree((root) => put(root, `packages/ai/src/${name}`, name.endsWith("x") ? "export const x = <div/>;\n" : vm), (root) => {
      const { files, findings } = scanTree(root, "packages/ai/src");
      expect(files).toEqual([`packages/ai/src/${name}`]);
      if (name !== "x.tsx" && name !== "x.jsx") expect(findings.map((finding) => finding.kind)).toEqual(["forbidden-import"]);
    });
  });

  it("skips tests and declaration files only", () => {
    withTree((root) => {
      for (const name of ["a.test.ts", "a.test.mts", "a.test.js", "a.d.ts", "a.d.mts", "a.json", "a.md", "a.txt"]) put(root, `packages/ai/src/${name}`, vm);
      put(root, "packages/ai/src/prod.ts", "export const fine = 1;\n");
    }, (root) => {
      const { files, findings } = scanTree(root, "packages/ai/src");
      expect(files).toEqual(["packages/ai/src/prod.ts"]);
      expect(findings).toEqual([]);
    });
  });

  it("reports relative file paths and applies the pg allow-list against the repository root", () => {
    withTree((root) => {
      put(root, "packages/security/src/state/postgres/ok.ts", 'import pg from "pg";\nexport const c = pg;\n');
      put(root, "packages/security/src/state/other.ts", 'import pg from "pg";\nexport const c = pg;\n');
    }, (root) => {
      const { findings } = scanTree(root, "packages/security/src");
      expect(findings.map((finding) => finding.file)).toEqual(["packages/security/src/state/other.ts"]);
    });
  });

  it("fails loudly on a missing or empty scan root, and on symbolic links", () => {
    withTree(() => undefined, (root) => {
      expect(() => scanTree(root, "packages/ai/src")).toThrow();
      mkdirSync(join(root, "packages/ai/src"), { recursive: true });
      expect(() => scanTree(root, "packages/ai/src")).toThrow(/no source files/);
    });
    withTree((root) => {
      put(root, "packages/ai/src/real.ts", "export const fine = 1;\n");
      put(root, "elsewhere/vm.ts", vm);
      symlinkSync(join(root, "elsewhere/vm.ts"), join(root, "packages/ai/src/link.ts"));
    }, (root) => {
      expect(() => scanTree(root, "packages/ai/src")).toThrow(/symbolic link/);
    });
  });
});
