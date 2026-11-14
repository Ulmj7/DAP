/**
 * @dap/security: validation/strict-json.hostile.test.ts
 *
 * QA round on T061: the hostile-input boundary, checked against RFC 8259 and against every way an
 * already-parsed value can lie. Complements strict-json.test.ts.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { parseStrictJson, type StrictJsonCode } from "./strict-json.js";

type Outcome = "ok" | StrictJsonCode;
const outcome = (input: unknown, options?: Parameters<typeof parseStrictJson>[1]): Outcome => {
  const result = parseStrictJson(input, options);
  return result.ok ? "ok" : result.code;
};
const value = (input: unknown, options?: Parameters<typeof parseStrictJson>[1]): unknown => {
  const result = parseStrictJson(input, options);
  if (!result.ok) throw new Error(`expected success, got ${result.code}`);
  return result.value;
};
const utf8 = (text: string): number => new TextEncoder().encode(text).length;
const parsedAsJson = (text: string): unknown => JSON.parse(text, (_key, node: unknown) => (Object.is(node, -0) ? 0 : node));
const nestedArrays = (depth: number): string => "[".repeat(depth) + "]".repeat(depth);
const nestedObjects = (depth: number): string => `{"a":`.repeat(depth) + "1" + "}".repeat(depth);

describe("strings: escapes and surrogates (RFC 8259 section 7 and 8.2)", () => {
  it("decodes every legal escape", () => {
    expect(value('"\\"\\\\\\/\\b\\f\\n\\r\\t"')).toBe('"\\/\b\f\n\r\t');
    expect(value('"\\u0041\\u00e9\\u00E9\\u20AC"')).toBe("A\u00e9\u00e9\u20ac");
    expect(value('"\\ud83d\\ude00"')).toBe("\u{1f600}");
    expect(value('"\\uD83D\\uDE00"')).toBe("\u{1f600}");
    expect(value('"\u{1f600}"')).toBe("\u{1f600}");
    expect(value('"\\u0000"')).toBe("\u0000");
  });

  it.each(['"\\x41"', '"\\\'"', '"\\a"', '"\\u12"', '"\\u12G4"', '"\\u"', '"\\u 123"', '"\\U0041"', '"\\', '"abc', '"\\"', '"\\u123'])(
    "rejects the malformed escape or unterminated string %s", (text) => {
      expect(outcome(text)).toBe("syntax");
    });

  it("rejects every raw control character below U+0020 inside a string, and accepts DEL", () => {
    for (let code = 0; code < 0x20; code += 1) expect(outcome(`"a${String.fromCharCode(code)}b"`), `U+${code.toString(16)}`).toBe("syntax");
    expect(value('"a\u007fb"')).toBe("a\u007fb");
  });

  it.each([
    ["a high surrogate escape", '"\\ud800"'], ["a low surrogate escape", '"\\udc00"'], ["two high surrogates", '"\\ud800\\ud800"'],
    ["a reversed pair", '"\\udc00\\ud800"'], ["a high surrogate then text", '"\\ud800x"'], ["a high surrogate then another escape", '"\\ud800\\u0041"'],
    ["a high surrogate at the end", '"abc\\ud83d"'], ["a lone low surrogate after a pair", '"\\ud83d\\ude00\\ude00"'],
  ])("rejects a lone surrogate: %s", (_label, text) => {
    expect(outcome(text)).toBe("syntax");
    expect(outcome(`{${text}:1}`), "as a key").toBe("syntax");
    expect(outcome(`[${text}]`), "in an array").toBe("syntax");
  });

  it("rejects a lone surrogate written raw in the text, and accepts a raw pair", () => {
    expect(outcome('"\ud800"')).toBe("syntax");
    expect(outcome('"\udc00"')).toBe("syntax");
    expect(outcome('{"\ud800":1}')).toBe("syntax");
    expect(outcome('"\u{1f600}x"')).toBe("ok");
  });
});

describe("numbers (RFC 8259 section 6)", () => {
  it.each(["0", "-0", "1", "-1", "10", "1.5", "-1.25", "1e5", "1E5", "1e+5", "1e-5", "0.1e2", "0e0", "123456789012345680000", "1e308", "5e-324"])(
    "accepts %s", (text) => { expect(outcome(text)).toBe("ok"); expect(outcome(`[${text},{"n":${text}}]`)).toBe("ok"); });

  it.each(["01", "-01", "00", "+1", ".5", "-.5", "5.", "1.e3", "1e", "1e+", "1e-", "0x10", "0b1", "Infinity", "-Infinity", "NaN", "1_000", "- 1", "--1", "1.2.3", "1e5.5", "０", "١"])(
    "rejects the non-JSON number %s", (text) => { expect(outcome(text)).toBe("syntax"); });

  it.each(["1e999", "-1e999", "1e309", "1.8e308", "[1e999]", '{"a":-1e400}', "1" + "0".repeat(400)])("reports overflow %s as non-finite", (text) => {
    expect(outcome(text)).toBe("not_finite");
  });

  it.each(["-0", "-0.0", "-0e0", "-0e5", "-1e-999", "[-0]", '{"a":-0}'])("never returns negative zero from %s", (text) => {
    const walk = (node: unknown): void => {
      if (typeof node === "number") expect(Object.is(node, -0)).toBe(false);
      else if (node && typeof node === "object") Object.values(node).forEach(walk);
    };
    walk(value(text));
  });

  it("returns 0, not -0, for negative zero in already-parsed data too", () => {
    for (const input of [-0, [-0], { a: -0 }, { a: [{ b: -0 }] }]) {
      const walk = (node: unknown): void => {
        if (typeof node === "number") expect(Object.is(node, -0)).toBe(false);
        else if (node && typeof node === "object") Object.values(node).forEach(walk);
      };
      walk(value(input));
    }
  });
});

describe("structure and whitespace (RFC 8259 sections 2 to 4)", () => {
  it("allows exactly space, tab, LF and CR between tokens, at every position", () => {
    expect(value(' \t\r\n{ \t\r\n"a" \t\r\n: \t\r\n[ \t\r\n1 \t\r\n, \t\r\n2 \t\r\n] \t\r\n} \t\r\n')).toEqual({ a: [1, 2] });
  });

  it.each(["\f", "\v", "\u00a0", "\u2028", "\u2029", "\ufeff", "\u0000", "\u3000", "\u200b"])("rejects the non-JSON whitespace U+%s", (char) => {
    const code = char.charCodeAt(0).toString(16);
    for (const text of [`${char}{}`, `{}${char}`, `[1${char}]`, `{"a"${char}:1}`, `[1,${char}2]`]) expect(outcome(text), `U+${code} in ${JSON.stringify(text)}`).toBe("syntax");
  });

  it.each([
    "", " ", "\n", "[", "]", "{", "}", "[,]", "[1,]", "[,1]", "[1 2]", "[1,,2]", "{,}", '{"a":1,}', '{,"a":1}', '{"a" 1}', '{"a":}', '{"a"}', "{a:1}", "{'a':1}",
    '{"a":1 "b":2}', '{1:2}', "{}x", "{} {}", "[] []", "/* c */ {}", "{} // c", "{}\u0000", "truefalse", "[true false]", "tru", "True", "nul", "nulll", "undefined", "'a'",
    '{"a":1}}', "[[]", "[]]", '{"a":{"b":1}', '"a" "b"',
  ])("rejects the malformed document %j", (text) => {
    expect(outcome(text)).toBe("syntax");
  });

  it("accepts an empty array and object with interior whitespace", () => {
    expect(value("[ \n ]")).toEqual([]);
    expect(value("{ \n }")).toEqual({});
  });

  it("accepts every root scalar", () => {
    expect([value("null"), value("true"), value("false"), value("0"), value('""')]).toEqual([null, true, false, 0, ""]);
  });
});

describe("depth is counted exactly, for arrays, objects and mixes", () => {
  it.each([["arrays", nestedArrays], ["objects", nestedObjects]] as const)("%s: depth 8 is accepted and depth 9 is not", (_label, make) => {
    expect(outcome(make(8))).toBe("ok");
    expect(outcome(make(9))).toBe("too_deep");
    expect(outcome(make(1), { maxJsonDepth: 1 })).toBe("ok");
    expect(outcome(make(2), { maxJsonDepth: 1 })).toBe("too_deep");
  });

  it("counts a mix of arrays and objects as one chain", () => {
    expect(outcome('[{"a":[{"b":[{"c":[[1]]}]}]}]')).toBe("ok");
    expect(outcome('[{"a":[{"b":[{"c":[[[1]]]}]}]}]')).toBe("too_deep");
  });

  it("does not count scalars, and counts siblings by their own depth only", () => {
    expect(outcome(`[${nestedArrays(7)},${nestedArrays(7)},1,"x",null]`)).toBe("ok");
    expect(outcome(`[${nestedArrays(8)}]`)).toBe("too_deep");
  });

  it("rejects 100000-deep text without overflowing the stack, and never throws even with an absurd cap", () => {
    const text = "[".repeat(100_000);
    expect(outcome(text, { maxPayloadBytes: 10_000_000 })).toBe("too_deep");
    expect(() => parseStrictJson(nestedArrays(200_000), { maxPayloadBytes: 10_000_000, maxJsonDepth: 1_000_000 })).not.toThrow();
    expect(outcome(nestedArrays(200_000), { maxPayloadBytes: 10_000_000, maxJsonDepth: 1_000_000 })).not.toBe("ok");
  });

  it("applies the same depth rule to already-parsed values", () => {
    const deep = (depth: number): unknown => { let node: unknown = 1; for (let i = 0; i < depth; i += 1) node = [node]; return node; };
    const deepObject = (depth: number): unknown => { let node: unknown = 1; for (let i = 0; i < depth; i += 1) node = { a: node }; return node; };
    expect(outcome(deep(8))).toBe("ok");
    expect(outcome(deep(9))).toBe("too_deep");
    expect(outcome(deepObject(8))).toBe("ok");
    expect(outcome(deepObject(9))).toBe("too_deep");
    expect(outcome(deep(500_000), { maxPayloadBytes: 1e9 })).toBe("too_deep");
  });
});

describe("the byte cap is measured on the raw UTF-8 text", () => {
  const widths: ReadonlyArray<[string, string, number]> = [["1-byte", "a", 1], ["2-byte", "\u00e9", 2], ["3-byte", "\u20ac", 3], ["4-byte", "\u{1f600}", 4]];

  it.each(widths)("is exact at the boundary for %s characters", (_label, char, width) => {
    const cap = 40;
    const filler = Math.floor((cap - 4) / width);
    let text = `["${char.repeat(filler)}"]`;
    const pad = cap - utf8(text);
    text = `["${char.repeat(filler)}${"a".repeat(pad)}"]`;
    expect(utf8(text)).toBe(cap);
    expect(outcome(text, { maxPayloadBytes: cap })).toBe("ok");
    expect(outcome(text, { maxPayloadBytes: cap - 1 })).toBe("too_large");
    expect(outcome(text.replace('"]', 'a"]'), { maxPayloadBytes: cap })).toBe("too_large");
  });

  it("counts escapes by their raw length, not their decoded length", () => {
    const text = `["${"\\u00e9".repeat(3000)}"]`;
    expect(utf8(text)).toBe(18_004);
    expect(outcome(text)).toBe("too_large");
    expect(outcome(text, { maxPayloadBytes: 18_004 })).toBe("ok");
  });

  it("measures default 16384 on multi-byte text", () => {
    const fits = `"${"\u20ac".repeat(5460)}"`;
    expect(utf8(fits)).toBe(16_382);
    expect(outcome(fits)).toBe("ok");
    expect(outcome(`"${"\u20ac".repeat(5461)}"`)).toBe("too_large");
  });

  it("rejects an enormous string immediately, before scanning it", () => {
    const huge = "x".repeat(2 ** 26);
    const started = performance.now();
    expect(outcome(huge)).toBe("too_large");
    expect(performance.now() - started).toBeLessThan(250);
  });
});

describe("duplicate and forbidden keys are judged after escape decoding", () => {
  it.each([
    '{"a":1,"a":2}', '{"a":1,"\\u0061":2}', '{"\\u0061":1,"a":2}', '{"ab":1,"\\u0061\\u0062":2}', '{"":1,"":2}', '{"\\u0000":1,"\\u0000":2}',
    '{"x":{"a":1,"\\u0061":2}}', '[{"a":1,"a":2}]', '{"a":1,"b":2,"c":3,"a":4}', '{"\\/":1,"/":2}', '{"\\ud83d\\ude00":1,"\u{1f600}":2}',
  ])("rejects the duplicate key in %s", (text) => {
    expect(outcome(text)).toBe("duplicate_key");
  });

  it("accepts keys that merely look alike, and the same key in different objects", () => {
    expect(outcome('{"a":1,"A":2,"a ":3,"\u0430":4}')).toBe("ok");
    expect(outcome('{"a":{"a":1},"b":{"a":1},"c":[{"a":1},{"a":2}]}')).toBe("ok");
  });

  it.each([
    '{"__proto__":1}', '{"\\u005f\\u005fproto\\u005f\\u005f":1}', '{"__\\u0070roto__":1}', '{"constructor":1}', '{"constr\\u0075ctor":1}', '{"\\u0063onstructor":1}',
    '{"prototype":1}', '{"\\u0070rototype":1}', '{"a":{"__proto__":{"x":1}}}', '[{"a":[{"constructor":1}]}]', '{"a":1,"__proto__":2}',
  ])("rejects the forbidden key in %s", (text) => {
    expect(outcome(text)).toBe("forbidden_key");
  });

  it("accepts near-miss keys and never touches Object.prototype", () => {
    expect(outcome('{"__proto":1,"proto__":2,"_proto_":3,"Constructor":4,"constructors":5,"prototypes":6,"__PROTO__":7}')).toBe("ok");
    const parsed = value('{"toString":1,"hasOwnProperty":2,"valueOf":3,"__defineGetter__":4,"isPrototypeOf":5}') as Record<string, unknown>;
    expect(Object.keys(parsed)).toHaveLength(5);
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).toString).toBe(Object.prototype.toString);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("failures carry nothing from the input", () => {
  it.each([
    ['{"CANARY":1,"CANARY":2}', "duplicate_key"], ['{"__proto__":"CANARY"}', "forbidden_key"], ['["CANARY",1e999]', "not_finite"], ['{"CANARY":}', "syntax"],
    [`["CANARY"${",1".repeat(20_000)}]`, "too_large"], [`{"a":[[[[[[[[["CANARY"]]]]]]]]]}`, "too_deep"],
  ] as const)("%s", (text, code) => {
    const result = parseStrictJson(text);
    expect(result).toEqual({ ok: false, code });
    expect(Object.keys(result).sort()).toEqual(["code", "ok"]);
    expect(JSON.stringify(result)).not.toContain("CANARY");
  });
});

describe("already-parsed input: it is copied once, and only what is really data survives", () => {
  it("reads each accessor and proxy trap exactly once", () => {
    const reads: Record<string, number> = {};
    const count = (key: string): void => { reads[key] = (reads[key] ?? 0) + 1; };
    const source = { a: 1, b: [1, 2, 3], c: { d: "x" } } as Record<string, unknown>;
    const traps: string[] = [];
    const watched = new Proxy(source, {
      get(target, key, receiver) { count(`get:${String(key)}`); return Reflect.get(target, key, receiver); },
      ownKeys(target) { traps.push("ownKeys"); return Reflect.ownKeys(target); },
      getOwnPropertyDescriptor(target, key) { traps.push("descriptor"); return Reflect.getOwnPropertyDescriptor(target, key); },
      getPrototypeOf(target) { traps.push("getPrototypeOf"); return Reflect.getPrototypeOf(target); },
      has() { throw new Error("must not probe with in"); }, set() { throw new Error("must not write"); }, deleteProperty() { throw new Error("must not delete"); },
    });
    expect(value(watched)).toEqual({ a: 1, b: [1, 2, 3], c: { d: "x" } });
    expect(reads).toEqual({ "get:a": 1, "get:b": 1, "get:c": 1 });
    expect(traps.filter((trap) => trap === "ownKeys")).toHaveLength(1);
    expect(traps.filter((trap) => trap === "getPrototypeOf")).toHaveLength(1);
    expect(traps.filter((trap) => trap === "descriptor").length).toBeLessThanOrEqual(3);
  });

  it("returns the first answer of a flip-flopping accessor, on objects and on array elements", () => {
    let reads = 0;
    const object = { get a(): number { reads += 1; return reads; } };
    const array: unknown[] = [];
    let elementReads = 0;
    Object.defineProperty(array, "0", { enumerable: true, get() { elementReads += 1; return elementReads * 10; } });
    expect(value(object)).toEqual({ a: 1 });
    expect(value(array)).toEqual([10]);
    expect([reads, elementReads]).toEqual([1, 1]);
  });

  it("is unaffected by later mutation of the source", () => {
    const source = { a: { b: [1, 2] } };
    const result = value(source) as typeof source;
    source.a.b.push(3);
    source.a = { b: [] };
    expect(result).toEqual({ a: { b: [1, 2] } });
    expect(result).not.toBe(source);
    expect(result.a).not.toBe(source.a);
  });

  it.each([
    ["a symbol-keyed property", () => ({ a: 1, [Symbol("s")]: 2 })],
    ["a non-enumerable property", () => Object.defineProperty({ a: 1 }, "hidden", { value: 2, enumerable: false })],
    ["a non-enumerable accessor", () => Object.defineProperty({ a: 1 }, "hidden", { get: () => 2, enumerable: false })],
    ["an array with a named property", () => Object.assign([1], { extra: 2 })],
    ["an array with a symbol property", () => Object.assign([1], { [Symbol("s")]: 2 })],
    ["an array with a hidden property", () => Object.defineProperty([1], "hidden", { value: 2, enumerable: false })],
    ["an array hole", () => [1, , 3]],
    ["a nested sparse array", () => ({ a: [, ,] })],
  ])("rejects %s instead of silently dropping it", (_label, make) => {
    expect(outcome(make())).toBe("not_plain");
  });

  it("rejects a sparse array of absurd length quickly", () => {
    const started = performance.now();
    expect(outcome(new Array(2 ** 32 - 1))).not.toBe("ok");
    expect(outcome({ a: new Array(2 ** 31) })).not.toBe("ok");
    expect(performance.now() - started).toBeLessThan(500);
  });

  it("accepts null-prototype objects, including nested ones", () => {
    const bare = Object.assign(Object.create(null) as Record<string, unknown>, { a: Object.assign(Object.create(null), { b: 1 }) });
    expect(value(bare)).toEqual({ a: { b: 1 } });
  });

  it.each([
    ["a class instance", () => new (class Point { x = 1; })()], ["a Date", () => new Date(0)], ["a Map", () => new Map()], ["a Set", () => new Set()], ["a RegExp", () => /x/],
    ["an Error", () => new Error("CANARY")], ["a typed array", () => new Uint8Array(2)], ["an ArrayBuffer", () => new ArrayBuffer(2)], ["a boxed string", () => new String("x")],
    ["a boxed number", () => new Number(1)], ["a Promise", () => Promise.resolve(1)], ["a function", () => () => 1], ["an object with a foreign prototype", () => Object.create({ inherited: 1 })],
    ["undefined", () => undefined], ["a symbol", () => Symbol("s")], ["a bigint", () => 1n], ["nested undefined", () => ({ a: undefined })], ["nested bigint", () => [1n]],
    ["nested function", () => ({ a: { b: () => 1 } })], ["a Proxy over a Date", () => new Proxy(new Date(0), {})],
  ])("rejects %s", (_label, make) => {
    expect(outcome(make())).toBe("not_plain");
  });

  it.each([NaN, Infinity, -Infinity, [NaN], { a: { b: Infinity } }])("reports non-finite number %j", (input) => {
    expect(outcome(input)).toBe("not_finite");
  });

  it("contains a hostile proxy or throwing accessor without throwing or echoing", () => {
    const hostile: Array<() => unknown> = [
      () => ({ get a(): never { throw new Error("CANARY"); } }),
      () => new Proxy({}, { ownKeys() { throw new Error("CANARY"); } }),
      () => new Proxy({ a: 1 }, { getOwnPropertyDescriptor() { throw new Error("CANARY"); } }),
      () => new Proxy({ a: 1 }, { get() { throw new Error("CANARY"); } }),
      () => new Proxy({}, { getPrototypeOf() { throw new Error("CANARY"); } }),
      () => { const { proxy, revoke } = Proxy.revocable({ a: 1 }, {}); revoke(); return proxy; },
      () => new Proxy([1], { get() { throw new Error("CANARY"); } }),
    ];
    for (const make of hostile) {
      const result = parseStrictJson(make());
      expect(result).toEqual({ ok: false, code: "not_plain" });
      expect(JSON.stringify(result)).not.toContain("CANARY");
    }
  });

  it.each([
    ["a lone surrogate value", { a: "\ud800" }], ["a lone surrogate key", { "\udc00": 1 }], ["a lone surrogate in an array", ["x", "\ud83d"]], ["a reversed pair", ["\ude00\ud83d"]],
  ])("rejects %s", (_label, input) => {
    expect(outcome(input)).toBe("not_plain");
  });

  it("accepts a well-formed surrogate pair", () => {
    expect(value({ "\u{1f600}": "\u{1f600}" })).toEqual({ "\u{1f600}": "\u{1f600}" });
  });
});

describe("already-parsed input: shared references are data, cycles are not, and expansion is bounded", () => {
  it("accepts a shared sub-object and returns an independent tree", () => {
    const shared = { n: 1 };
    const list = [1];
    const source = { x: shared, y: shared, z: [list, list] };
    const result = value(source) as { x: object; y: object; z: object[] };
    expect(result).toEqual({ x: { n: 1 }, y: { n: 1 }, z: [[1], [1]] });
    expect(result.x).not.toBe(result.y);
    expect(result.x).not.toBe(shared);
    expect(result.z[0]).not.toBe(result.z[1]);
    expect(Object.isFrozen(result.x) && Object.isFrozen(result.y)).toBe(true);
  });

  it("rejects a self-reference, an indirect cycle and a cycle through an array", () => {
    const self: Record<string, unknown> = {}; self.me = self;
    const a: Record<string, unknown> = {}; const b: Record<string, unknown> = { a }; a.b = b;
    const loop: unknown[] = []; loop.push([loop]);
    const viaGetter: Record<string, unknown> = { get again(): unknown { return viaGetter; } };
    for (const input of [self, a, loop, viaGetter]) expect(outcome(input)).toBe("not_plain");
  });

  it("is not fooled by repetition at depth: a cycle at depth 3 still fails, a repeated leaf at depth 3 does not", () => {
    const leaf = { k: 1 };
    expect(outcome({ a: { b: { c: leaf, d: leaf } } })).toBe("ok");
    const top: Record<string, unknown> = { a: { b: {} } };
    ((top.a as Record<string, unknown>).b as Record<string, unknown>).c = top;
    expect(outcome(top)).toBe("not_plain");
  });

  it("refuses an expansion bomb quickly instead of building a billion-node tree", () => {
    let node: unknown = [1];
    for (let level = 0; level < 7; level += 1) node = Array.from({ length: 100 }, () => node);
    let objects: unknown = { v: 1 };
    for (let level = 0; level < 7; level += 1) { const next: Record<string, unknown> = {}; for (let i = 0; i < 100; i += 1) next[`k${i}`] = objects; objects = next; }
    const started = performance.now();
    expect(outcome(node)).toBe("too_large");
    expect(outcome(objects)).toBe("too_large");
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("applies the payload cap to already-parsed data, not just to text", () => {
    expect(outcome(Array.from({ length: 10_000 }, () => 1))).toBe("too_large");
    expect(outcome({ text: "x".repeat(20_000) })).toBe("too_large");
    expect(outcome(Array.from({ length: 10_000 }, () => 1), { maxPayloadBytes: 20_001 })).toBe("ok");
    expect(outcome(new Proxy([1], { get(target, key, receiver) { return key === "length" ? 1e9 : Reflect.get(target, key, receiver) ?? 1; } }))).not.toBe("ok");
  });

  it("measures already-parsed data as its compact JSON, so both branches agree at the boundary", () => {
    const wellFormedText = (text: string): boolean => !/[\ud800-\udfff]/.test(text.replace(/[\ud800-\udbff][\udc00-\udfff]/g, ""));
    const wellFormed = (node: unknown): boolean => {
      if (typeof node === "string") return wellFormedText(node);
      if (Array.isArray(node)) return node.every(wellFormed);
      if (node && typeof node === "object") return Object.entries(node).every(([key, child]) => wellFormedText(key) && wellFormed(child));
      return true;
    };
    const hasForbiddenKey = (node: unknown): boolean => {
      if (Array.isArray(node)) return node.some(hasForbiddenKey);
      if (node && typeof node === "object") return Object.entries(node).some(([key, child]) => ["__proto__", "constructor", "prototype"].includes(key) || hasForbiddenKey(child));
      return false;
    };
    fc.assert(fc.property(fc.jsonValue({ maxDepth: 4 }), (generated) => {
      // A bare string would be read as JSON text, so only containers can be offered as already-parsed data.
      fc.pre(typeof generated === "object" && generated !== null);
      fc.pre(wellFormed(generated) && !hasForbiddenKey(generated));
      const text = JSON.stringify(generated);
      const size = utf8(text);
      fc.pre(size > 1);
      const big = { maxJsonDepth: 1000 };
      expect(outcome(text, { ...big, maxPayloadBytes: size })).toBe("ok");
      expect(outcome(generated, { ...big, maxPayloadBytes: size })).toBe("ok");
      expect(outcome(text, { ...big, maxPayloadBytes: size - 1 })).toBe("too_large");
      expect(outcome(generated, { ...big, maxPayloadBytes: size - 1 })).toBe("too_large");
      expect(value(generated, { ...big, maxPayloadBytes: size })).toEqual(parsedAsJson(text));
    }), { numRuns: 200 });
  });
});

describe("options are validated rather than trusted", () => {
  it.each([NaN, 0, -1, 1.5, Infinity, -Infinity, 2 ** 53, "16384", null, {}, true])("rejects maxPayloadBytes %j", (bad) => {
    expect(() => parseStrictJson("{}", { maxPayloadBytes: bad as number })).toThrow(RangeError);
  });
  it.each([NaN, 0, -1, 1.5, Infinity, -Infinity, 2 ** 53, "8", null, {}, true])("rejects maxJsonDepth %j", (bad) => {
    expect(() => parseStrictJson("{}", { maxJsonDepth: bad as number })).toThrow(RangeError);
  });
  it("uses the documented defaults when options are absent or undefined", () => {
    expect(outcome("{}", {})).toBe("ok");
    const explicitlyUndefined = { maxJsonDepth: undefined, maxPayloadBytes: undefined } as unknown as Parameters<typeof parseStrictJson>[1];
    expect(outcome(nestedArrays(9), explicitlyUndefined)).toBe("too_deep");
    expect(outcome(`"${"x".repeat(16_383)}"`, explicitlyUndefined)).toBe("too_large");
  });
});

describe("totality", () => {
  it("never throws and never succeeds with a forbidden shape, for arbitrary values", () => {
    fc.assert(fc.property(fc.anything({ withBigInt: true, withDate: true, withMap: true, withSet: true, withObjectString: true, withNullPrototype: true, withTypedArray: true, withSparseArray: true, withBoxedValues: true }), (anything) => {
      const result = parseStrictJson(anything);
      if (result.ok) expect(Object.isFrozen(result.value) || result.value === null || typeof result.value !== "object").toBe(true);
    }), { numRuns: 300 });
  });

  it("never throws on arbitrary text, including text built from JSON fragments", () => {
    const fragment = fc.constantFrom('{', '}', '[', ']', ',', ':', '"', '\\', 'u', '0', '1', '-', 'e', '.', 'true', 'null', ' ', '\n', '"a"', '\\u00', '\ud800', '1e999', '"__proto__"');
    fc.assert(fc.property(fc.array(fragment, { maxLength: 40 }).map((parts) => parts.join("")), (text) => {
      const result = parseStrictJson(text);
      if (result.ok) expect(JSON.parse(JSON.stringify(result.value))).toEqual(parsedAsJson(text));
    }), { numRuns: 500 });
  });

  it("agrees with JSON.parse on everything it accepts, and accepts everything JSON.parse does unless a strict rule applies", () => {
    fc.assert(fc.property(fc.jsonValue({ maxDepth: 4 }), (generated) => {
      fc.pre(!JSON.stringify(generated).includes("__proto__") && !JSON.stringify(generated).includes('"constructor"') && !JSON.stringify(generated).includes('"prototype"'));
      fc.pre(JSON.stringify(generated).length < 3000);
      const text = JSON.stringify(generated);
      fc.pre(!/[\ud800-\udfff]/.test(text.replace(/[\ud800-\udbff][\udc00-\udfff]/g, "")));
      const result = parseStrictJson(text);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toEqual(parsedAsJson(text));
    }), { numRuns: 300 });
  });
});
