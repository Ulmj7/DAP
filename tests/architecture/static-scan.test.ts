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
import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { scanProductionTree, scanSource } from "./static-scan.js";
import type { StaticScanFinding } from "./static-scan.js";

const REPO_ROOT = join(__dirname, "..", "..");

const SCAN_ROOTS = [
  "packages/ai/src",
  "packages/actions/src",
  "packages/security/src",
];

describe("production scan: no forbidden modules or global fetch", () => {
  for (const root of SCAN_ROOTS) {
    it(`is clean in ${root}`, () => {
      const findings = scanProductionTree(join(REPO_ROOT, root));
      expect(findings).toEqual([]);
    });
  }
});

describe("positive control: forbidden constructs are flagged", () => {
  const fixtures: Array<{
    label: string;
    file: string;
    code: string;
    kind: "forbidden-import" | "global-fetch";
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
