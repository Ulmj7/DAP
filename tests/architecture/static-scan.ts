/**
 * tests/architecture/static-scan.ts
 *
 * T060 helper. Static scan of production sources using the TypeScript
 * compiler API (no regex on source text). Detects, per file:
 *
 * - Imports of forbidden modules: child_process, vm, node:http, node:https,
 *   undici, axios, and pg (pg is allowed ONLY under
 *   packages/security/src/state/postgres).
 * - Global `fetch` references (any reference to the global fetch; a locally
 *   declared `fetch` or a property access like `x.fetch` is not a finding).
 *
 * Import forms covered: static import, export-from, import-equals,
 * dynamic import("..."), and require("...").
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

export type StaticScanKind = "forbidden-import" | "global-fetch";

export interface StaticScanFinding {
  /** Absolute file path. */
  readonly file: string;
  /** 1-based line number. */
  readonly line: number;
  readonly kind: StaticScanKind;
  /** Module specifier, for forbidden-import findings. */
  readonly module?: string;
}

/**
 * Forbidden module specifiers (both bare and `node:`-prefixed forms resolve
 * to the same built-ins in Node).
 */
const FORBIDDEN_MODULES: ReadonlySet<string> = new Set([
  "child_process",
  "node:child_process",
  "vm",
  "node:vm",
  "http",
  "node:http",
  "https",
  "node:https",
  "undici",
  "axios",
]);

/** pg is forbidden everywhere except the postgres state implementation. */
const PG_MODULES: ReadonlySet<string> = new Set(["pg", "node:pg"]);
const PG_ALLOWED_DIR = "packages/security/src/state/postgres/";

function isPgAllowed(file: string): boolean {
  const normalized = file.replace(/\\/g, "/");
  return normalized.includes(PG_ALLOWED_DIR);
}

/** True when `node` is used as a name (property, declaration, specifier) rather than a value reference. */
function isNamePosition(node: ts.Identifier, parent: ts.Node | undefined): boolean {
  if (!parent) return true;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return true;
  if (ts.isPropertyAssignment(parent) && parent.name === node) return true;
  if (ts.isMethodDeclaration(parent) && parent.name === node) return true;
  if (ts.isMethodSignature(parent) && parent.name === node) return true;
  if (ts.isPropertyDeclaration(parent) && parent.name === node) return true;
  if (ts.isPropertySignature(parent) && parent.name === node) return true;
  if (ts.isImportSpecifier(parent) && (parent.name === node || parent.propertyName === node))
    return true;
  if (ts.isExportSpecifier(parent) && (parent.name === node || parent.propertyName === node))
    return true;
  if (ts.isImportClause(parent) && parent.name && parent.name === node) return true;
  if (ts.isVariableDeclaration(parent) && parent.name === node) return true;
  if (ts.isBindingElement(parent) && (parent.name === node || parent.propertyName === node))
    return true;
  if (ts.isFunctionDeclaration(parent) && parent.name === node) return true;
  if ((ts.isFunctionExpression(parent) || ts.isArrowFunction(parent)) && parent.name === node)
    return true;
  if (ts.isParameter(parent) && parent.name === node) return true;
  if (ts.isCatchClause(parent) && parent.variableDeclaration && parent.variableDeclaration.name === node)
    return true;
  if (ts.isClassDeclaration(parent) || ts.isClassExpression(parent)) {
    if (parent.name && parent.name === node) return true;
  }
  if (
    ts.isEnumDeclaration(parent) ||
    ts.isTypeAliasDeclaration(parent) ||
    ts.isInterfaceDeclaration(parent) ||
    ts.isModuleDeclaration(parent)
  ) {
    if (parent.name && parent.name === node) return true;
  }
  return false;
}

/** Does a binding pattern directly bind the name `fetch`? */
function bindsFetch(name: ts.BindingName): boolean {
  if (ts.isIdentifier(name)) return name.text === "fetch";
  for (const element of name.elements) {
    // The local binding is element.name; `const { other: fetch } = x` shadows
    // the global, while `const { fetch: other } = x` does not.
    if (ts.isBindingElement(element) && ts.isIdentifier(element.name)) {
      if (element.name.text === "fetch") return true;
    }
  }
  return false;
}

/** Does `scope` declare a local binding named `fetch` directly in it? */
function declaresFetch(scope: ts.Node): boolean {
  if (ts.isFunctionDeclaration(scope) || ts.isFunctionExpression(scope) || ts.isArrowFunction(scope)) {
    if (scope.name && scope.name.text === "fetch") return true;
    for (const param of scope.parameters) {
      if (ts.isIdentifier(param.name) && param.name.text === "fetch") return true;
      if (ts.isObjectBindingPattern(param.name) && bindsFetch(param.name)) return true;
    }
    return false;
  }
  if (ts.isBlock(scope)) {
    for (const statement of scope.statements) {
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (bindsFetch(declaration.name)) return true;
        }
      }
    }
    return false;
  }
  if (ts.isCatchClause(scope)) {
    const variable = scope.variableDeclaration;
    return variable !== undefined && bindsFetch(variable.name);
  }
  if (ts.isSourceFile(scope)) {
    for (const statement of scope.statements) {
      if (ts.isFunctionDeclaration(statement) && statement.name && statement.name.text === "fetch") {
        return true;
      }
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (bindsFetch(declaration.name)) return true;
        }
      }
      if (ts.isImportDeclaration(statement)) {
        // TS 6: `import * as fetch from ...` and `import fetch from ...`
        // both live on the import clause; there is no namespaceImport field.
        const clause = statement.importClause;
        if (!clause) continue;
        if (clause.name && clause.name.text === "fetch") return true;
        const named = clause.namedBindings;
        if (!named) continue;
        if (ts.isNamedImports(named)) {
          for (const specifier of named.elements) {
            if (specifier.name.text === "fetch") return true;
          }
          continue;
        }
        if (ts.isNamespaceImport(named) && named.name.text === "fetch") return true;
      }
    }
    return false;
  }
  return false;
}

/**
 * True when the reference named `fetch` resolves to a local binding in an
 * enclosing scope (walking up the parent chain), i.e. it is NOT the global.
 */
function resolvesLocally(node: ts.Node): boolean {
  let scope: ts.Node | undefined = node.parent;
  while (scope) {
    if (declaresFetch(scope)) return true;
    if (ts.isSourceFile(scope)) return false;
    scope = scope.parent;
  }
  return false;
}

function isImportLikeCall(node: ts.Node): node is ts.CallExpression {
  if (!ts.isCallExpression(node)) return false;
  const callee = node.expression;
  // dynamic import("...")
  if (callee.kind === ts.SyntaxKind.ImportKeyword) return true;
  // require("...")
  if (ts.isIdentifier(callee) && callee.text === "require") return true;
  return false;
}

function moduleSpecifierOf(node: ts.Node): ts.StringLiteral | undefined {
  if (ts.isImportDeclaration(node)) {
    return ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier : undefined;
  }
  if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined) {
    return ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier : undefined;
  }
  if (ts.isImportEqualsDeclaration(node)) {
    const ref = node.moduleReference;
    // TS 6 names this node ExternalModuleReference (formerly ImportRequires).
    if (ref.kind === ts.SyntaxKind.ExternalModuleReference && ts.isStringLiteral(ref.expression))
      return ref.expression;
    return undefined;
  }
  if (isImportLikeCall(node)) {
    const first = node.arguments[0];
    if (first && ts.isStringLiteral(first)) return first;
  }
  return undefined;
}

/**
 * Scan one source file. `file` is the path reported in findings (and used
 * for the pg allow-list). Pure in-memory: no files are read here.
 */
export function scanSource(file: string, text: string): StaticScanFinding[] {
  const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true);
  const findings: StaticScanFinding[] = [];

  // Line numbers are 1-based in findings.
  const positionOf = (node: ts.Node): number =>
    sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;

  sourceFile.forEachChild(function walk(node: ts.Node): void {
    const specifier = moduleSpecifierOf(node);
    if (specifier) {
      const module = specifier.text;
      if (
        (FORBIDDEN_MODULES.has(module) || PG_MODULES.has(module)) &&
        !(PG_MODULES.has(module) && isPgAllowed(file))
      ) {
        findings.push({
          file,
          line: positionOf(specifier),
          kind: "forbidden-import",
          module,
        });
      }
    }

    if (ts.isIdentifier(node) && node.text === "fetch") {
      const parent = node.parent;
      if (!isNamePosition(node, parent) && !resolvesLocally(node)) {
        findings.push({ file, line: positionOf(node), kind: "global-fetch" });
      }
    }

    ts.forEachChild(node, walk);
  });

  return findings;
}

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      out.push(...listTsFiles(full));
    } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Scan every production .ts file under `root` (recursive). `*.test.ts`
 * files are excluded from the production scan.
 */
export function scanProductionTree(root: string): StaticScanFinding[] {
  const findings: StaticScanFinding[] = [];
  for (const file of listTsFiles(root)) {
    findings.push(...scanSource(file, readFileSync(file, "utf8")));
  }
  return findings;
}
