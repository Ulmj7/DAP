import { expect, it } from "vitest";
import ts from "typescript";
import { readdirSync, readFileSync } from "node:fs";
export function scanHost(file: string, text: string): string[] {
 const errors: string[] = [];
 const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
 const visit = (node: ts.Node) => {
  if (ts.isIdentifier(node) && node.text === "fetch" && file !== "guidance/anthropic-model.ts") errors.push("fetch");
  if (ts.isPropertyAccessExpression(node) && node.expression.getText(source) === "process" && node.name.text === "env" && file !== "guidance/demo.ts") errors.push("env");
  if (file.startsWith("packages/ai/") && ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && !["@dap/contracts", "zod"].includes(node.moduleSpecifier.text) && !node.moduleSpecifier.text.startsWith(".")) errors.push("import");
  ts.forEachChild(node, visit);
 }; visit(source); return errors;
}
it("host network and environment boundaries hold", () => {
 const root = new URL("../../apps/reference-host/src/", import.meta.url);
 for (const file of readdirSync(root, { recursive: true }) as string[]) {
  if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
  expect(scanHost(file, readFileSync(new URL(file, root), "utf8")), file).toEqual([]);
 }
});
it("planted violations are caught without mutating the repository", () => {
 expect(scanHost("x.ts", "fetch('/x'); process.env.X;")).toEqual(["fetch", "env"]);
 expect(scanHost("guidance/anthropic-model.ts", "fetch('/x');")).toEqual([]);
 expect(scanHost("guidance/demo.ts", "process.env.X;")).toEqual([]);
 expect(scanHost("x.ts", "// fetch process.env\nconst x = 'fetch';")).toEqual([]);
 expect(scanHost("packages/ai/src/x.ts", 'import "@dap/walkthrough"; import "node:fs";')).toHaveLength(2);
});
