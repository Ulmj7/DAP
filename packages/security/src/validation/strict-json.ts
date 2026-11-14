/**
 * @dap/security: validation/strict-json.ts
 *
 * T061 / FR-014. Strict intake of untrusted proposal data.
 *
 * Own strict RFC 8259 parser — NOT JSON.parse, which silently keeps only the
 * last duplicate key and accepts nothing special but cannot report duplicates.
 * Never throws and never echoes input content in its result.
 *
 * Rejects: payloads over maxPayloadBytes UTF-8 bytes, nesting over maxJsonDepth,
 * duplicate keys, `__proto__` / `constructor` / `prototype` keys, and
 * non-finite numbers. An already-parsed (non-string) input is deep-copied
 * exactly once into plain data before any check, so getters and proxies are
 * read exactly once and cannot change their answers mid-validation.
 */
import type { JsonValue } from "@dap/contracts";

/** Why strict intake rejected its input. Closed set; no input content. */
export type StrictJsonCode =
  | "too_large"
  | "too_deep"
  | "duplicate_key"
  | "forbidden_key"
  | "not_finite"
  | "not_plain"
  | "syntax";

/**
 * Success carries a deeply frozen plain JSON value; failure carries only the
 * code. There is no error string, so nothing from the input can leak out.
 */
export type StrictJsonResult =
  | { ok: true; readonly value: JsonValue }
  | { ok: false; readonly code: StrictJsonCode };

export interface StrictJsonOptions {
  /** UTF-8 byte cap for string input. Default 16384. */
  readonly maxPayloadBytes?: number;
  /** Maximum nesting depth (containers count). Default 8. */
  readonly maxJsonDepth?: number;
}

const FORBIDDEN_KEYS: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

const WHITESPACE: ReadonlySet<number> = new Set([0x20, 0x09, 0x0a, 0x0d]);

function isDigit(code: number): boolean {
  return code >= 0x30 && code <= 0x39;
}

function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (
      (code >= 0xd800 && code <= 0xdbff) &&
      i + 1 < text.length &&
      text.charCodeAt(i + 1) >= 0xdc00 &&
      text.charCodeAt(i + 1) <= 0xdfff
    ) {
      bytes += 4;
      i += 1;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

function freeze(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    for (const element of value) freeze(element);
    Object.freeze(value);
    return value;
  }
  if (typeof value === "object" && value !== null) {
    for (const element of Object.values(value)) freeze(element);
    Object.freeze(value);
    return value;
  }
  return value;
}

class Parser {
  private pos = 0;

  constructor(
    private readonly text: string,
    private readonly maxDepth: number,
  ) {}

  parseDocument(): StrictJsonResult {
    const result = this.parseValue(0);
    if (!result.ok) return result;
    this.skipWs();
    if (this.pos < this.text.length) return { ok: false, code: "syntax" };
    return { ok: true, value: result.value };
  }

  private skipWs(): void {
    const { text } = this;
    while (this.pos < text.length && WHITESPACE.has(text.charCodeAt(this.pos))) {
      this.pos += 1;
    }
  }

  private parseValue(depth: number): StrictJsonResult {
    this.skipWs();
    const text = this.text;
    if (this.pos >= text.length) return { ok: false, code: "syntax" };
    switch (text[this.pos]) {
      case "{":
        return this.parseObject(depth);
      case "[":
        return this.parseArray(depth);
      case '"':
        return this.parseString();
      case "t":
        return this.parseLiteral("true", true);
      case "f":
        return this.parseLiteral("false", false);
      case "n":
        return this.parseLiteral("null", null);
      default: {
        if (text[this.pos] === "-" || isDigit(text.charCodeAt(this.pos))) {
          return this.parseNumber();
        }
        return { ok: false, code: "syntax" };
      }
    }
  }

  private parseLiteral(literal: string, value: JsonValue): StrictJsonResult {
    if (this.text.startsWith(literal, this.pos)) {
      this.pos += literal.length;
      return { ok: true, value };
    }
    return { ok: false, code: "syntax" };
  }

  private parseObject(depth: number): StrictJsonResult {
    const depthIn = depth + 1;
    if (depthIn > this.maxDepth) return { ok: false, code: "too_deep" };
    this.pos += 1; // consume "{"
    const object: Record<string, JsonValue> = {};
    const seen = new Set<string>();
    this.skipWs();
    if (this.text[this.pos] === "}") {
      this.pos += 1;
      return { ok: true, value: object };
    }
    for (;;) {
      this.skipWs();
      if (this.text[this.pos] !== '"') return { ok: false, code: "syntax" };
      const keyResult = this.parseString();
      if (!keyResult.ok) return keyResult;
      const key = keyResult.value as string;
      if (FORBIDDEN_KEYS.has(key)) return { ok: false, code: "forbidden_key" };
      if (seen.has(key)) return { ok: false, code: "duplicate_key" };
      seen.add(key);
      this.skipWs();
      if (this.text[this.pos] !== ":") return { ok: false, code: "syntax" };
      this.pos += 1;
      const valueResult = this.parseValue(depthIn);
      if (!valueResult.ok) return valueResult;
      object[key] = valueResult.value;
      this.skipWs();
      const next = this.text[this.pos];
      if (next === ",") {
        this.pos += 1;
        continue;
      }
      if (next === "}") {
        this.pos += 1;
        return { ok: true, value: object };
      }
      return { ok: false, code: "syntax" };
    }
  }

  private parseArray(depth: number): StrictJsonResult {
    const depthIn = depth + 1;
    if (depthIn > this.maxDepth) return { ok: false, code: "too_deep" };
    this.pos += 1; // consume "["
    const array: JsonValue[] = [];
    this.skipWs();
    if (this.text[this.pos] === "]") {
      this.pos += 1;
      return { ok: true, value: array };
    }
    for (;;) {
      const valueResult = this.parseValue(depthIn);
      if (!valueResult.ok) return valueResult;
      array.push(valueResult.value);
      this.skipWs();
      const next = this.text[this.pos];
      if (next === ",") {
        this.pos += 1;
        continue;
      }
      if (next === "]") {
        this.pos += 1;
        return { ok: true, value: array };
      }
      return { ok: false, code: "syntax" };
    }
  }

  private parseString(): StrictJsonResult {
    const text = this.text;
    this.pos += 1; // consume opening quote
    let out = "";
    for (;;) {
      if (this.pos >= text.length) return { ok: false, code: "syntax" };
      const char = text.charAt(this.pos);
      const code = char.charCodeAt(0);
      if (char === '"') {
        this.pos += 1;
        return { ok: true, value: out };
      }
      if (char === "\\") {
        this.pos += 1;
        if (this.pos >= text.length) return { ok: false, code: "syntax" };
        const escape = text[this.pos];
        switch (escape) {
          case '"':
            out += '"';
            this.pos += 1;
            break;
          case "\\":
            out += "\\";
            this.pos += 1;
            break;
          case "/":
            out += "/";
            this.pos += 1;
            break;
          case "b":
            out += "\b";
            this.pos += 1;
            break;
          case "f":
            out += "\f";
            this.pos += 1;
            break;
          case "n":
            out += "\n";
            this.pos += 1;
            break;
          case "r":
            out += "\r";
            this.pos += 1;
            break;
          case "t":
            out += "\t";
            this.pos += 1;
            break;
          case "u": {
            const hex = text.slice(this.pos + 1, this.pos + 5);
            if (hex.length !== 4 || !/^[0-9a-fA-F]{4}$/.test(hex)) {
              return { ok: false, code: "syntax" };
            }
            out += String.fromCharCode(parseInt(hex, 16));
            this.pos += 5;
            break;
          }
          default:
            return { ok: false, code: "syntax" };
        }
      } else {
        if (code < 0x20) return { ok: false, code: "syntax" };
        out += char;
        this.pos += 1;
      }
    }
  }

  private parseNumber(): StrictJsonResult {
    const text = this.text;
    const start = this.pos;
    if (text[this.pos] === "-") this.pos += 1;
    if (this.pos >= text.length || !isDigit(text.charCodeAt(this.pos))) {
      return { ok: false, code: "syntax" };
    }
    if (text[this.pos] === "0") {
      const next = text[this.pos + 1];
      if (next !== undefined && isDigit(next.charCodeAt(0))) {
        return { ok: false, code: "syntax" };
      }
      this.pos += 1;
    } else {
      this.pos += 1;
      while (this.pos < text.length && isDigit(text.charCodeAt(this.pos))) {
        this.pos += 1;
      }
    }
    if (text[this.pos] === ".") {
      this.pos += 1;
      if (this.pos >= text.length || !isDigit(text.charCodeAt(this.pos))) {
        return { ok: false, code: "syntax" };
      }
      while (this.pos < text.length && isDigit(text.charCodeAt(this.pos))) {
        this.pos += 1;
      }
    }
    if (text[this.pos] === "e" || text[this.pos] === "E") {
      this.pos += 1;
      if (text[this.pos] === "+" || text[this.pos] === "-") this.pos += 1;
      if (this.pos >= text.length || !isDigit(text.charCodeAt(this.pos))) {
        return { ok: false, code: "syntax" };
      }
      while (this.pos < text.length && isDigit(text.charCodeAt(this.pos))) {
        this.pos += 1;
      }
    }
    const value = Number(text.slice(start, this.pos));
    if (!Number.isFinite(value)) return { ok: false, code: "not_finite" };
    return { ok: true, value };
  }
}

interface CopyState {
  readonly maxDepth: number;
  /** Cycle guard. Plain JSON data cannot contain a cycle. */
  readonly seen: Set<object>;
  /** A failed copy must not continue. */
  failed: boolean;
  code: StrictJsonCode;
}

function copyScalar(value: unknown, state: CopyState): void {
  const kind = typeof value;
  if (kind === "string" || kind === "boolean" || value === null) {
    return;
  }
  if (kind === "number") {
    if (!Number.isFinite(value)) {
      state.failed = true;
      state.code = "not_finite";
    }
    return;
  }
  state.failed = true;
  state.code = "not_plain";
}

function copyObject(
  value: object,
  out: Record<string, JsonValue>,
  depth: number,
  state: CopyState,
): Record<string, JsonValue> {
  const depthIn = depth + 1;
  if (depthIn > state.maxDepth) {
    state.failed = true;
    state.code = "too_deep";
    return out;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    state.failed = true;
    state.code = "not_plain";
    return out;
  }
  if (state.seen.has(value)) {
    state.failed = true;
    state.code = "not_plain";
    return out;
  }
  state.seen.add(value);
  for (const key of Object.keys(value)) {
    if (state.failed) break;
    if (FORBIDDEN_KEYS.has(key)) {
      state.failed = true;
      state.code = "forbidden_key";
      break;
    }
    const element = (value as Record<string, unknown>)[key];
    if (element !== null && typeof element === "object") {
      if (Array.isArray(element)) {
        out[key] = copyArray(element, depthIn, state);
      } else {
        out[key] = copyObject(element, {}, depthIn, state);
      }
    } else {
      out[key] = element as JsonValue;
      copyScalar(element, state);
    }
  }
  return out;
}

function copyArray(
  value: unknown[],
  depth: number,
  state: CopyState,
): JsonValue[] {
  const depthIn = depth + 1;
  if (depthIn > state.maxDepth) {
    state.failed = true;
    state.code = "too_deep";
    return [];
  }
  if (state.seen.has(value)) {
    state.failed = true;
    state.code = "not_plain";
    return [];
  }
  state.seen.add(value);
  const out: JsonValue[] = [];
  for (const element of value) {
    if (state.failed) break;
    if (element !== null && typeof element === "object") {
      if (Array.isArray(element)) {
        out.push(copyArray(element, depthIn, state));
      } else {
        out.push(copyObject(element, {}, depthIn, state));
      }
    } else {
      out.push(element as JsonValue);
      copyScalar(element, state);
    }
  }
  return out;
}

/**
 * Strict intake of one untrusted value (T061).
 *
 * String input is parsed by the strict RFC 8259 parser below, under
 * `maxPayloadBytes` (UTF-8 bytes, default 16384) and `maxJsonDepth`
 * (default 8) caps. Non-string input is treated as already-parsed data and
 * is deep-copied exactly once: every property is read once, class instances,
 * functions, symbols, bigints, undefined, and cycles are rejected, and the
 * copy is what gets checked and returned.
 *
 * Never throws. Success returns the value deeply frozen; failure returns
 * `{ ok: false, code }` with no input content.
 */
export function parseStrictJson(
  input: unknown,
  options: StrictJsonOptions = {},
): StrictJsonResult {
  const maxPayloadBytes = options.maxPayloadBytes ?? 16384;
  const maxDepth = options.maxJsonDepth ?? 8;
  try {
    if (typeof input === "string") {
      if (utf8ByteLength(input) > maxPayloadBytes) {
        return { ok: false, code: "too_large" };
      }
      const result = new Parser(input, maxDepth).parseDocument();
      if (result.ok) return { ok: true, value: freeze(result.value) };
      return result;
    }
    const state: CopyState = { maxDepth, seen: new Set(), failed: false, code: "not_plain" };
    let root: JsonValue;
    if (input !== null && typeof input === "object") {
      if (Array.isArray(input)) {
        root = copyArray(input, 0, state);
      } else {
        root = copyObject(input, {}, 0, state);
      }
    } else {
      root = input as JsonValue;
      copyScalar(input, state);
    }
    if (state.failed) return { ok: false, code: state.code };
    return { ok: true, value: freeze(root) };
  } catch {
    // Defensive only: both paths above are total. Fail closed, never echo.
    return { ok: false, code: "syntax" };
  }
}
