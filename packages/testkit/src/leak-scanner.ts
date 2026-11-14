/**
 * @dap/testkit: leak-scanner.ts (T029)
 *
 * LeakScanner walks JSON-like values (strings, arrays, plain objects) and reports what a
 * planner-visible value must NEVER contain. Findings are `{kind, path}` ONLY — the leaked
 * value itself is never included in a finding.
 *
 * Kinds:
 *  - canary: any registered canary substring (canary-secret registry).
 *  - stack-trace: V8-style frames (`at Foo (file.js:1:2)`) or an `Error:` line followed by an
 *    `at ` frame.
 *  - secret-shaped: JWT-like base64url triples (three segments of 4+ base64url chars),
 *    `sk-` + 16+ alnum, `AKIA` + 16 uppercase alnum, or 32+ consecutive hex chars.
 *  - reason-code: any exact value from the contract REASON_CODES.
 *  - confirmation-id: UUID-shaped strings (confirmation ids are never handed to the planner).
 *
 * Traversal is capped at depth 20 and cycle-safe (visited objects are remembered).
 * A single string yields at most ONE finding per kind (multiple pattern hits of the same
 * kind collapse), keeping results deterministic and deduplicated.
 */
import { REASON_CODES } from "@dap/contracts";

export type LeakKind =
  | "canary"
  | "stack-trace"
  | "secret-shaped"
  | "reason-code"
  | "confirmation-id";

export interface LeakFinding {
  readonly kind: LeakKind;
  /** JSON path: "$" for the root, "$.0" for array items, "$.a.b" for object keys. */
  readonly path: string;
}

export interface LeakScannerOptions {
  /** Canaries registered at construction. Add more with registerCanary(). */
  readonly canaries?: readonly string[];
}

const MAX_DEPTH = 20;

const RE_STACK_FRAME = /at\s+[A-Za-z0-9_$.<>]+\s*\([^)\n]*\d+:\d+\)/;
const RE_ERROR_THEN_AT = /\bError\b[^\n]*\n\s*at\s/;
const RE_JWT_LIKE = /^(?:[A-Za-z0-9_-]{4,}\.){2}[A-Za-z0-9_-]{4,}$/;
const RE_SK_KEY = /sk-[A-Za-z0-9]{16,}/;
const RE_AKIA_KEY = /AKIA[A-Z0-9]{16}/;
const RE_HEX_RUN = /[0-9a-fA-F]{32,}/;
const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const REASON_CODE_SET: ReadonlySet<string> = new Set<string>(REASON_CODES);

export class LeakScanner {
  private readonly canaries: string[] = [];

  constructor(options: LeakScannerOptions = {}) {
    for (const canary of options.canaries ?? []) {
      this.registerCanary(canary);
    }
  }

  /** Register a canary secret; any occurrence of this substring in a scanned string is a finding. */
  registerCanary(canary: string): void {
    if (canary.length > 0 && !this.canaries.includes(canary)) {
      this.canaries.push(canary);
    }
  }

  /** Scan a JSON-like value and return all findings (empty list means clean). */
  scan(value: unknown): readonly LeakFinding[] {
    const findings: LeakFinding[] = [];
    this.walk(value, "$", 0, new WeakSet<object>(), findings);
    return findings;
  }

  private walk(
    value: unknown,
    path: string,
    depth: number,
    seen: WeakSet<object>,
    findings: LeakFinding[],
  ): void {
    if (depth > MAX_DEPTH) return;

    if (typeof value === "string") {
      this.recordStringFindings(value, path, findings);
      return;
    }
    if (typeof value !== "object" || value === null) {
      return; // numbers, booleans, null: nothing to walk
    }
    if (seen.has(value)) return; // cycle guard
    seen.add(value);

    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        this.walk(value[i], `${path}.${i}`, depth + 1, seen, findings);
      }
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      this.walk(child, `${path}.${key}`, depth + 1, seen, findings);
    }
  }

  private recordStringFindings(value: string, path: string, findings: LeakFinding[]): void {
    if (this.canaries.some((canary) => value.includes(canary))) {
      findings.push({ kind: "canary", path });
    }
    if (RE_STACK_FRAME.test(value) || RE_ERROR_THEN_AT.test(value)) {
      findings.push({ kind: "stack-trace", path });
    }
    if (
      RE_JWT_LIKE.test(value) ||
      RE_SK_KEY.test(value) ||
      RE_AKIA_KEY.test(value) ||
      RE_HEX_RUN.test(value)
    ) {
      findings.push({ kind: "secret-shaped", path });
    }
    if (REASON_CODE_SET.has(value)) {
      findings.push({ kind: "reason-code", path });
    }
    if (RE_UUID.test(value)) {
      findings.push({ kind: "confirmation-id", path });
    }
  }
}
