/**
 * @dap/ai: tool-call.test.ts
 *
 * T069. `toProposalCall` passes the provider's raw argument text through
 * untouched (no parse, no trim, no normalization), and the public surface of
 * @dap/ai is exactly the allowlisted planner seam — no executor, registry,
 * context, confirmation, or state-store types.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as ai from "./index.js";
import { toProposalCall } from "./tool-call.js";
import ts from "typescript";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const INDEX_PATH = join(PACKAGE_ROOT, "src", "index.ts");

/**
 * EVERY name the package exposes, value or type, however it is declared (`export type {}`, `export *`,
 * `export interface`, `export const`, `export default`, namespace re-exports...). Asked of the compiler's
 * checker, so no syntactic form can slip past a hand-written walk of export declarations.
 */
function exportedNames(): string[] {
  const configPath = join(PACKAGE_ROOT, "tsconfig.json");
  const config = ts.getParsedCommandLineOfConfigFile(configPath, {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (diagnostic) => { throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")); },
  });
  if (!config) throw new Error("cannot read the @dap/ai tsconfig");
  const program = ts.createProgram({ rootNames: [INDEX_PATH], options: config.options });
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(INDEX_PATH);
  const moduleSymbol = source && checker.getSymbolAtLocation(source);
  if (!moduleSymbol) throw new Error("index.ts is not a module");
  return checker.getExportsOfModule(moduleSymbol).map((symbol) => symbol.name);
}

/** Every module specifier (static, re-export, import-equals, dynamic, require) with the names it imports. */
function importsOf(file: string): Array<{ specifier: string; names: string[] | "*" }> {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.ES2022, true);
  const found: Array<{ specifier: string; names: string[] | "*" }> = [];
  const walk = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const bindings = node.importClause?.namedBindings;
      const names: string[] = [];
      let wildcard = false;
      if (node.importClause?.name) names.push("default");
      if (bindings && ts.isNamespaceImport(bindings)) wildcard = true;
      if (bindings && ts.isNamedImports(bindings)) for (const element of bindings.elements) names.push((element.propertyName ?? element.name).text);
      found.push({ specifier: node.moduleSpecifier.text, names: wildcard ? "*" : names });
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.exportClause;
      found.push({ specifier: node.moduleSpecifier.text, names: clause && ts.isNamedExports(clause) ? clause.elements.map((element) => (element.propertyName ?? element.name).text) : "*" });
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && ts.isStringLiteral(node.moduleReference.expression)) {
      found.push({ specifier: node.moduleReference.expression.text, names: "*" });
    } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
      const first = node.arguments[0];
      found.push({ specifier: first && (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first)) ? first.text : "<non-literal>", names: "*" });
    }
    ts.forEachChild(node, walk);
  };
  walk(source);
  return found;
}

describe("toProposalCall: raw text identity", () => {
  const samples: Array<[string, string]> = [
    ["plain", '{"action":"sendEmail","params":{"to":"a@b.c"}}'],
    [
      "surrounding whitespace",
      '  {"action":"sendEmail","params":{}}  \n',
    ],
    [
      "duplicate keys stay in the text",
      '{"action":"x","a":1,"a":2}',
    ],
    ["empty string", ""],
    ["whitespace only", " \t\n"],
    ["not JSON", "not json at all"],
    ["unicode", '{"s":"héllo 🀄"}'],
  ];

  for (const [label, text] of samples) {
    it(`passes the ${label} text through byte-for-byte`, () => {
      const call = toProposalCall("call-1", text);
      expect(call.callId).toBe("call-1");
      // Same string reference: untouched, not a copy.
      expect(call.raw).toBe(text);
    });
  }

  it("accepts an empty trusted callId as given", () => {
    const call = toProposalCall("", "x");
    expect(call.callId).toBe("");
    expect(call.raw).toBe("x");
  });
});

describe("@dap/ai export surface", () => {
  /** The complete public surface of @dap/ai (compile-time). */
  const ALLOWLIST = ["PlannerPort", "RawToolCall", "toProposalCall"] as const;
  const FORBIDDEN = [
    "ExecutorTable",
    "defineExecutor",
    "ActionRegistry",
    "defineAction",
    "AuthorizationContext",
    "SecurityStateStore",
    "ConfirmationService",
    "ConfirmationChannel",
    "PolicyGateway",
    "createPolicyGateway",
    "toPlannerFeedback",
    "MintToken",
  ] as const;

  it("exposes exactly the allowlisted names (compile-time, as the type checker sees them)", () => {
    expect(exportedNames().sort()).toEqual([...ALLOWLIST].sort());
  });

  it("exposes exactly the allowlisted runtime values", () => {
    // Type exports are erased at runtime; only toProposalCall is a value.
    expect(Object.keys(ai).sort()).toEqual(["toProposalCall"]);
  });

  it("does not export executor, registry, context, or confirmation names", () => {
    const runtime = Object.keys(ai);
    for (const name of FORBIDDEN) {
      expect(runtime, name).not.toContain(name);
    }
  });
});

describe("@dap/ai depends on @dap/contracts only, and takes nothing but the planner seam from it", () => {
  const sources = readdirSync(join(PACKAGE_ROOT, "src")).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts")).map((name) => join(PACKAGE_ROOT, "src", name));
  const ALLOWED_CONTRACT_NAMES = new Set(["PlannerFeedback", "ProposalCall"]);

  it("finds the production sources it is about to check", () => {
    expect(sources.map((file) => file.split("/").at(-1)).sort()).toEqual(["index.ts", "planner-port.ts", "tool-call.ts"]);
  });

  it("imports only relative modules and @dap/contracts, and only the two allowlisted contract types", () => {
    for (const file of sources) {
      for (const { specifier, names } of importsOf(file)) {
        if (specifier.startsWith("./")) continue;
        expect(specifier, `${file}`).toBe("@dap/contracts");
        expect(names, `${file} must not use a namespace or dynamic import of @dap/contracts`).not.toBe("*");
        for (const name of names) expect(ALLOWED_CONTRACT_NAMES.has(name), `${file} imports ${name} from @dap/contracts`).toBe(true);
      }
    }
  });

  it("declares @dap/contracts as its only dependency of any kind", () => {
    const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")) as Record<string, unknown>;
    expect(manifest.dependencies).toEqual({ "@dap/contracts": "*" });
    for (const field of ["devDependencies", "peerDependencies", "optionalDependencies", "bundledDependencies", "bundleDependencies"]) expect(manifest, field).not.toHaveProperty(field);
    const tsconfig = JSON.parse(readFileSync(join(PACKAGE_ROOT, "tsconfig.json"), "utf8")) as { references?: Array<{ path: string }> };
    expect(tsconfig.references).toEqual([{ path: "../contracts" }]);
  });
});

describe("toProposalCall: hostile text", () => {
  it.each([
    ["an unpaired surrogate", "{\"a\":\"\ud800\"}"], ["a NUL byte", "{\"a\":\"x\u0000y\"}"], ["a BOM", "\ufeff{}"], ["CRLF", "{}\r\n"], ["a lone backslash", "\\"],
    ["one megabyte", "x".repeat(1_000_000)], ["escape-looking text", '{"a":"\\u0041"}'], ["a prototype key", '{"__proto__":{"polluted":true}}'], ["a duplicate key", '{"a":1,"a":2}'],
  ])("passes %s through untouched, without parsing or judging it", (_label, text) => {
    const call = toProposalCall("id", text);
    expect(call.raw).toBe(text);
    expect(call.raw).toHaveLength(text.length);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("does not coerce, parse or copy a value that is not text; intake judges it", () => {
    const parsed = { action: "x", params: {} };
    expect(toProposalCall("id", parsed as never).raw).toBe(parsed);
    const exotic = { get raw() { return 1; } };
    expect(toProposalCall("id", exotic as never).raw).toBe(exotic);
    expect(toProposalCall("id", undefined as never).raw).toBeUndefined();
  });

  it("returns a frozen call that carries exactly callId and raw", () => {
    const call = toProposalCall("id", "{}");
    expect(Object.keys(call)).toEqual(["callId", "raw"]);
    expect(Object.isFrozen(call)).toBe(true);
    expect(() => { (call as { raw: unknown }).raw = "changed"; }).toThrow(TypeError);
    expect(toProposalCall("id", "{}")).not.toBe(call);
  });
});
