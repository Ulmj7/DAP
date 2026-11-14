/**
 * @dap/ai: tool-call.test.ts
 *
 * T069. `toProposalCall` passes the provider's raw argument text through
 * untouched (no parse, no trim, no normalization), and the public surface of
 * @dap/ai is exactly the allowlisted planner seam — no executor, registry,
 * context, confirmation, or state-store types.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as ai from "./index.js";
import { toProposalCall } from "./tool-call.js";
import ts from "typescript";

/** Every name index.ts re-exports, value or type (compile-time surface). */
function exportedNames(indexPath: string): string[] {
  const source = ts.createSourceFile(
    indexPath,
    readFileSync(indexPath, "utf8"),
    ts.ScriptTarget.ES2022,
    true,
  );
  const names: string[] = [];
  source.forEachChild((node) => {
    if (!ts.isExportDeclaration(node) || !node.exportClause) return;
    // index.ts only uses named exports; no `export *` allowed there.
    if (ts.isNamedExports(node.exportClause)) {
      for (const spec of node.exportClause.elements) names.push(spec.name.text);
    } else {
      names.push("<export-all>");
    }
  });
  return names;
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

  it("exposes exactly the allowlisted names (compile-time)", () => {
    const indexPath = fileURLToPath(new URL("./index.ts", import.meta.url));
    expect(exportedNames(indexPath).sort()).toEqual([...ALLOWLIST].sort());
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
