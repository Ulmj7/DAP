/**
 * tests/architecture/static-scan.ts
 *
 * T060 / FR-050 / ATK-ARCH-10. Static scan of production sources using the TypeScript compiler API
 * (no regex on source text). It is a tripwire for the code review of an honest contributor, not a
 * sandbox: it cannot stop an author who is determined to hide a capability, which is why the runtime
 * boundary (no executor without a grant, no network port) is the real defence. Per file it reports:
 *
 * - forbidden-import: any static import, export-from, import-equals, dynamic `import("...")`,
 *   `require("...")` or `process.getBuiltinModule("...")` of child_process, vm, http, https, http2,
 *   net, tls, dgram, dns, inspector, repl, module, undici, axios (bare or `node:`-prefixed, with or
 *   without a subpath), or pg and its pool/native packages anywhere outside
 *   packages/security/src/state/postgres. Static `import type` / `export type` are NOT findings: they
 *   emit nothing, which the repository guarantees with `verbatimModuleSyntax` (a test pins that),
 *   whereas an inline `import { type X }` still emits a side-effect import and IS a finding.
 * - dynamic-module: a module load whose specifier is not a literal, or a bare reference to `require`,
 *   because the scan cannot see what it loads (fail closed).
 * - global-fetch / global-network: a reference to the global `fetch`, `WebSocket`, `XMLHttpRequest` or
 *   `EventSource` that does not resolve to a local binding, including `globalThis.fetch`.
 * - global-object: any reference to `globalThis`, `global`, `window` or `self` that is not a local
 *   binding. No production code needs the global object, and every alias of it (`const g = globalThis`,
 *   `const { fetch } = globalThis`, `const fetch = globalThis.fetch`) passes through such a reference.
 * - unparseable: the compiler reports a syntax error, so the rest of the scan cannot be trusted.
 *
 * The scan refuses to run (throws at import time) if the installed TypeScript lacks a node kind or
 * guard it relies on, instead of silently matching nothing.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, posix } from "node:path";
import ts from "typescript";

export type StaticScanKind = "forbidden-import" | "dynamic-module" | "global-fetch" | "global-network" | "global-object" | "unparseable";

export interface StaticScanFinding {
  /** The path as given to the scan (relative to the repository root for a tree scan). */
  readonly file: string;
  /** 1-based line number. */
  readonly line: number;
  readonly kind: StaticScanKind;
  /** Module specifier as written, for forbidden-import findings. */
  readonly module?: string;
}

/** Every TypeScript API the scan calls. Kept next to the code; a test proves the list matches the usage. */
export const REQUIRED_COMPILER_API = {
  functions: [
    "createSourceFile", "transpileModule", "forEachChild",
    "isImportDeclaration", "isExportDeclaration", "isImportEqualsDeclaration", "isExternalModuleReference", "isCallExpression", "isStringLiteral",
    "isNoSubstitutionTemplateLiteral", "isIdentifier", "isPropertyAccessExpression", "isElementAccessExpression", "isParenthesizedExpression",
    "isAsExpression", "isNonNullExpression", "isTypeAssertionExpression", "isSatisfiesExpression", "isPropertyAssignment", "isMethodDeclaration",
    "isMethodSignature", "isPropertyDeclaration", "isPropertySignature", "isImportSpecifier", "isExportSpecifier", "isImportClause",
    "isVariableDeclaration", "isBindingElement", "isFunctionDeclaration", "isFunctionExpression", "isArrowFunction", "isParameter", "isCatchClause",
    "isClassDeclaration", "isClassExpression", "isEnumDeclaration", "isTypeAliasDeclaration", "isInterfaceDeclaration", "isModuleDeclaration",
    "isQualifiedName", "isConstructorDeclaration", "isBlock", "isSourceFile", "isVariableStatement", "isNamedImports", "isNamespaceImport",
  ],
  syntaxKinds: ["ImportKeyword", "ExternalModuleReference"],
} as const;

/** Throws, naming the missing entry, unless `api` provides everything the scan depends on. */
export function assertCompilerApi(api: typeof ts): void {
  const missing: string[] = [];
  for (const name of REQUIRED_COMPILER_API.functions) {
    if (typeof (api as unknown as Record<string, unknown> | undefined)?.[name] !== "function") missing.push(name);
  }
  const kinds = (api as unknown as { SyntaxKind?: Record<string, unknown> } | undefined)?.SyntaxKind;
  for (const name of REQUIRED_COMPILER_API.syntaxKinds) {
    if (typeof kinds?.[name] !== "number") missing.push(`SyntaxKind.${name}`);
  }
  if (missing.length > 0) throw new Error(`static-scan: the installed TypeScript lacks ${missing.join(", ")}; the scan cannot be trusted`);
}
assertCompilerApi(ts);

/** Bare module names (after dropping `node:` and any subpath) that grant a network, shell or script capability. */
const FORBIDDEN_MODULES: ReadonlySet<string> = new Set([
  "child_process", "vm", "http", "https", "http2", "net", "tls", "dgram", "dns", "inspector", "repl", "module", "undici", "axios",
]);
/** The PostgreSQL driver family: allowed ONLY under the postgres state implementation. */
const PG_MODULES: ReadonlySet<string> = new Set(["pg", "pg-pool", "pg-native"]);
const PG_ALLOWED_DIR = "packages/security/src/state/postgres/";

const GLOBAL_OBJECTS: ReadonlySet<string> = new Set(["globalThis", "global", "window", "self"]);
const NETWORK_GLOBALS: ReadonlyMap<string, "global-fetch" | "global-network"> = new Map([
  ["fetch", "global-fetch"], ["WebSocket", "global-network"], ["XMLHttpRequest", "global-network"], ["EventSource", "global-network"],
]);

/** `node:dns/promises` -> `dns`, `pg/lib/client` -> `pg`, `@scope/pkg/x` -> `@scope/pkg`. */
function packageOf(specifier: string): string {
  const bare = specifier.startsWith("node:") ? specifier.slice(5) : specifier;
  const parts = bare.split("/");
  return bare.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? bare);
}

/** The file's path relative to the repository root, or undefined when it cannot be anchored there. */
function relativeToRoot(file: string, repoRoot: string | undefined): string | undefined {
  const normalized = file.replace(/\\/g, "/");
  let relative: string;
  if (normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) {
    if (repoRoot === undefined) return undefined;
    const root = repoRoot.replace(/\\/g, "/").replace(/\/+$/, "");
    if (!normalized.startsWith(`${root}/`)) return undefined;
    relative = normalized.slice(root.length + 1);
  } else {
    relative = normalized;
  }
  const clean = posix.normalize(relative);
  return clean.startsWith("../") || clean === ".." ? undefined : clean;
}

function isPgAllowed(file: string, repoRoot: string | undefined): boolean {
  return relativeToRoot(file, repoRoot)?.startsWith(PG_ALLOWED_DIR) ?? false;
}

/** True when `node` is used as a name (property, declaration, specifier) rather than a value reference. */
function isNamePosition(node: ts.Identifier, parent: ts.Node | undefined): boolean {
  if (!parent) return true;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return true;
  if (ts.isQualifiedName(parent) && parent.right === node) return true;
  if (ts.isPropertyAssignment(parent) && parent.name === node) return true;
  if (ts.isMethodDeclaration(parent) && parent.name === node) return true;
  if (ts.isMethodSignature(parent) && parent.name === node) return true;
  if (ts.isPropertyDeclaration(parent) && parent.name === node) return true;
  if (ts.isPropertySignature(parent) && parent.name === node) return true;
  if (ts.isImportSpecifier(parent) && (parent.name === node || parent.propertyName === node)) return true;
  if (ts.isExportSpecifier(parent) && (parent.name === node || parent.propertyName === node)) return true;
  if (ts.isImportClause(parent) && parent.name && parent.name === node) return true;
  if (ts.isVariableDeclaration(parent) && parent.name === node) return true;
  if (ts.isBindingElement(parent) && (parent.name === node || parent.propertyName === node)) return true;
  if (ts.isFunctionDeclaration(parent) && parent.name === node) return true;
  if ((ts.isFunctionExpression(parent) || ts.isArrowFunction(parent)) && parent.name === node) return true;
  if (ts.isParameter(parent) && parent.name === node) return true;
  if (ts.isCatchClause(parent) && parent.variableDeclaration && parent.variableDeclaration.name === node) return true;
  if ((ts.isClassDeclaration(parent) || ts.isClassExpression(parent)) && parent.name && parent.name === node) return true;
  if (
    (ts.isEnumDeclaration(parent) || ts.isTypeAliasDeclaration(parent) || ts.isInterfaceDeclaration(parent) || ts.isModuleDeclaration(parent)) &&
    parent.name === node
  ) return true;
  return false;
}

/** Does a binding name directly bind `name`? (`const { other: name } = x` shadows; `const { name: other } = x` does not.) */
function bindsName(binding: ts.BindingName, name: string): boolean {
  if (ts.isIdentifier(binding)) return binding.text === name;
  for (const element of binding.elements) {
    if (ts.isBindingElement(element) && bindsName(element.name, name)) return true;
  }
  return false;
}

function declaresVariable(statement: ts.Statement, name: string): boolean {
  if (!ts.isVariableStatement(statement)) return false;
  return statement.declarationList.declarations.some((declaration) => bindsName(declaration.name, name));
}

/** Does `scope` declare a local binding called `name` directly in it? */
function declaresName(scope: ts.Node, name: string): boolean {
  if (ts.isFunctionDeclaration(scope) || ts.isFunctionExpression(scope) || ts.isArrowFunction(scope) || ts.isMethodDeclaration(scope) || ts.isConstructorDeclaration(scope)) {
    if ((ts.isFunctionDeclaration(scope) || ts.isFunctionExpression(scope)) && scope.name?.text === name) return true;
    return scope.parameters.some((parameter) => bindsName(parameter.name, name));
  }
  if (ts.isBlock(scope)) {
    return scope.statements.some((statement) =>
      declaresVariable(statement, name) ||
      ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name?.text === name));
  }
  if (ts.isCatchClause(scope)) {
    return scope.variableDeclaration !== undefined && bindsName(scope.variableDeclaration.name, name);
  }
  if (ts.isSourceFile(scope)) {
    for (const statement of scope.statements) {
      if (declaresVariable(statement, name)) return true;
      if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name?.text === name) return true;
      if (ts.isImportDeclaration(statement)) {
        // TS 6: default and namespace bindings both live on the import clause.
        const clause = statement.importClause;
        if (!clause) continue;
        if (clause.name?.text === name) return true;
        const named = clause.namedBindings;
        if (!named) continue;
        if (ts.isNamedImports(named) && named.elements.some((specifier) => specifier.name.text === name)) return true;
        if (ts.isNamespaceImport(named) && named.name.text === name) return true;
      }
    }
  }
  return false;
}

/** True when the reference to `name` resolves to a local binding in an enclosing scope, i.e. it is NOT the global. */
function resolvesLocally(node: ts.Node, name: string): boolean {
  for (let scope: ts.Node | undefined = node.parent; scope; scope = scope.parent) {
    if (declaresName(scope, name)) return true;
  }
  return false;
}

/** Look through parentheses, `as`, `!`, `<T>x` and `satisfies`, which change nothing at runtime. */
function unwrap(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isNonNullExpression(current) ||
    ts.isTypeAssertionExpression(current) || ts.isSatisfiesExpression(current)
  ) current = current.expression;
  return current;
}

/** Syntax errors only (TS1xxx): the scan walks an error-tolerant tree, which can hide an import behind a parse failure. */
function syntaxErrors(file: string, text: string): ts.Diagnostic[] {
  const output = ts.transpileModule(text, {
    fileName: file,
    reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.Preserve },
  });
  return (output.diagnostics ?? []).filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error && diagnostic.code >= 1000 && diagnostic.code < 2000);
}

/**
 * Scan one source file. `file` is the path reported in findings; for the pg allow-list it is anchored at
 * `repoRoot` when absolute (an absolute path with no root can never be allowed). Pure in-memory: nothing is read.
 */
export function scanSource(file: string, text: string, repoRoot?: string): StaticScanFinding[] {
  const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true);
  const findings: StaticScanFinding[] = [];
  const lineOf = (node: ts.Node): number => sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  const report = (node: ts.Node, kind: StaticScanKind, module?: string): void => {
    findings.push({ file, line: lineOf(node), kind, ...(module === undefined ? {} : { module }) });
  };

  const [syntaxError] = syntaxErrors(file, text);
  if (syntaxError) {
    const line = syntaxError.start === undefined ? 1 : sourceFile.getLineAndCharacterOfPosition(syntaxError.start).line + 1;
    findings.push({ file, line, kind: "unparseable" });
  }

  const checkModule = (specifier: ts.StringLiteral | ts.NoSubstitutionTemplateLiteral): void => {
    const name = packageOf(specifier.text);
    if (FORBIDDEN_MODULES.has(name) || (PG_MODULES.has(name) && !isPgAllowed(file, repoRoot))) report(specifier, "forbidden-import", specifier.text);
  };

  const isLoaderCall = (node: ts.CallExpression): boolean => {
    const callee = node.expression;
    if (callee.kind === ts.SyntaxKind.ImportKeyword) return true;
    if (ts.isIdentifier(callee) && callee.text === "require") return true;
    if (ts.isPropertyAccessExpression(callee)) return callee.name.text === "getBuiltinModule";
    return ts.isElementAccessExpression(callee) && ts.isStringLiteral(callee.argumentExpression) && callee.argumentExpression.text === "getBuiltinModule";
  };

  const checkNode = (node: ts.Node): void => {
    // Static forms. A type-only declaration emits nothing, so it grants nothing.
    if (ts.isImportDeclaration(node)) {
      if (!node.importClause?.isTypeOnly && ts.isStringLiteral(node.moduleSpecifier)) checkModule(node.moduleSpecifier);
    } else if (ts.isExportDeclaration(node)) {
      if (!node.isTypeOnly && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) checkModule(node.moduleSpecifier);
    } else if (ts.isImportEqualsDeclaration(node)) {
      const reference = node.moduleReference;
      // TS 6 names this node ExternalModuleReference (formerly ImportRequires).
      if (!node.isTypeOnly && reference.kind === ts.SyntaxKind.ExternalModuleReference && ts.isExternalModuleReference(reference) && ts.isStringLiteral(reference.expression)) {
        checkModule(reference.expression);
      }
    } else if (ts.isCallExpression(node) && isLoaderCall(node)) {
      // Loader calls: a literal specifier is checked; anything else cannot be seen, so it is a finding itself.
      const first = node.arguments[0];
      if (first && (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first))) checkModule(first);
      else report(node, "dynamic-module");
    }

    // `globalThis.fetch`, `window["fetch"]`, `(globalThis as X).WebSocket`: name what is being reached.
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const target = unwrap(node.expression);
      const member = ts.isPropertyAccessExpression(node) ? node.name.text : ts.isStringLiteral(node.argumentExpression) ? node.argumentExpression.text : undefined;
      const kind = member === undefined ? undefined : NETWORK_GLOBALS.get(member);
      if (kind && ts.isIdentifier(target) && GLOBAL_OBJECTS.has(target.text) && !resolvesLocally(target, target.text)) report(node, kind);
    }

    if (ts.isIdentifier(node)) {
      const parent = node.parent;
      const name = node.text;
      if (isNamePosition(node, parent) || resolvesLocally(node, name)) return;
      const network = NETWORK_GLOBALS.get(name);
      if (network) report(node, network);
      else if (GLOBAL_OBJECTS.has(name)) report(node, "global-object");
      // A bare `require` (not a call this scan already judged) can be aliased and called later: fail closed.
      else if (name === "require" && !(parent && ts.isCallExpression(parent) && parent.expression === node)) report(node, "dynamic-module");
    }
  };

  sourceFile.forEachChild(function walk(node: ts.Node): void {
    checkNode(node);
    ts.forEachChild(node, walk);
  });

  return findings;
}

const SOURCE_EXTENSION = /\.(?:ts|mts|cts|tsx|js|mjs|cjs|jsx)$/;
const DECLARATION_FILE = /\.d\.(?:ts|mts|cts)$/;
const TEST_FILE = /\.test\.(?:ts|mts|cts|tsx|js|mjs|cjs|jsx)$/;

function listSources(repoRoot: string, relativeDir: string, into: string[]): void {
  for (const entry of readdirSync(join(repoRoot, relativeDir), { withFileTypes: true })) {
    const relative = `${relativeDir}/${entry.name}`;
    // A link could point anywhere, including at code the scan never reads.
    if (entry.isSymbolicLink()) throw new Error(`static-scan: refusing symbolic link ${relative}`);
    if (entry.isDirectory()) listSources(repoRoot, relative, into);
    else if (entry.isFile() && SOURCE_EXTENSION.test(entry.name) && !DECLARATION_FILE.test(entry.name) && !TEST_FILE.test(entry.name)) into.push(relative);
  }
}

/**
 * Scan every production source file under `repoRoot/relativeRoot` (recursive; `*.test.*` and `*.d.ts` files are
 * excluded, every other JS/TS flavour is scanned). Fails loudly if the root is missing or holds no source files,
 * so a mistyped root can never pass vacuously. Paths in `files` and in findings are relative to `repoRoot`.
 */
export function scanTree(repoRoot: string, relativeRoot: string): { readonly files: string[]; readonly findings: StaticScanFinding[] } {
  const files: string[] = [];
  listSources(repoRoot, relativeRoot.replace(/\/+$/, ""), files);
  if (files.length === 0) throw new Error(`static-scan: no source files under ${relativeRoot}`);
  files.sort();
  const findings = files.flatMap((file) => scanSource(file, readFileSync(join(repoRoot, file), "utf8")));
  return { files, findings };
}
