/**
 * @dap/security: validation/envelope.test.ts
 *
 * T062. Strict envelope `{action, params}`: action grammar, exactly two
 * keys, params is a plain object, failures are `INVALID_ACTION` with an
 * existing ReasonCode, and the failure result never echoes the offending
 * key or value.
 */
import { REASON_CODES } from "@dap/contracts";
import { describe, expect, it } from "vitest";
import { parseEnvelope } from "./envelope.js";
import { parseStrictJson } from "./strict-json.js";

function isInvalid(result: {
  ok: boolean;
  outcome?: string;
  reason?: string;
}): boolean {
  return !result.ok && result.outcome === "INVALID_ACTION";
}

function assertNoLeak(result: {
  ok: boolean;
  outcome?: string;
  reason?: string;
}): void {
  // The failure result is exactly (ok, outcome, reason) — no input content.
  expect(Object.keys(result).sort()).toEqual(["ok", "outcome", "reason"]);
  expect(["INVALID_ACTION", "INVALID_PARAMETERS"]).toContain(result.outcome);
  expect(REASON_CODES).toContain(result.reason);
}

describe("parseEnvelope: valid envelopes", () => {
  it("parses a minimal envelope", () => {
    const result = parseEnvelope('{"action":"sendEmail","params":{}}');
    expect(result).toEqual({ ok: true, action: "sendEmail", params: {} });
    expect(Object.isFrozen(result.ok ? result.params : null)).toBe(true);
  });

  it("parses an envelope with params and freezes them deeply", () => {
    const result = parseEnvelope(
      '{"action":"updateRecord","params":{"id":"r-1","meta":{"n":1}}}',
    );
    if (!result.ok) throw new Error("expected ok");
    expect(result.action).toBe("updateRecord");
    expect(result.params).toEqual({ id: "r-1", meta: { n: 1 } });
    expect(Object.isFrozen(result.params)).toBe(true);
    expect(Object.isFrozen((result.params.meta as object))).toBe(true);
  });

  it("accepts 3-char and 64-char action ids", () => {
    expect(parseEnvelope('{"action":"abc","params":{}}').ok).toBe(true);
    const long = "a" + "b".repeat(63); // 64 chars
    expect(parseEnvelope(`{"action":"${long}","params":{}}`).ok).toBe(true);
  });

  it("accepts an already-parsed envelope", () => {
    const result = parseEnvelope({ action: "sendEmail", params: { to: "a@b.c" } });
    if (!result.ok) throw new Error("expected ok");
    expect(result.action).toBe("sendEmail");
    expect(result.params).toEqual({ to: "a@b.c" });
  });
});

describe("parseEnvelope: missing keys", () => {
  it("rejects an envelope without action", () => {
    const result = parseEnvelope('{"params":{}}');
    expect(isInvalid(result)).toBe(true);
    assertNoLeak(result);
  });

  it("rejects an envelope without params", () => {
    const result = parseEnvelope('{"action":"sendEmail"}');
    expect(isInvalid(result)).toBe(true);
    assertNoLeak(result);
  });

  it("rejects an empty envelope", () => {
    const result = parseEnvelope('{}');
    expect(isInvalid(result)).toBe(true);
    assertNoLeak(result);
  });
});

describe("parseEnvelope: extra keys", () => {
  for (const extra of ["callId", "requestId", "userConfirmed", "confirmed", "id"]) {
    it(`rejects an envelope with an extra "${extra}" key`, () => {
      const result = parseEnvelope(
        `{"action":"sendEmail","params":{},"${extra}":"x-1"}`,
      );
      expect(isInvalid(result)).toBe(true);
      assertNoLeak(result);
    });
  }
});

describe("parseEnvelope: action grammar", () => {
  for (const action of [
    "A", // too short
    "ab", // 2 chars, too short
    "Abc", // starts uppercase
    "1abc", // starts with a digit
    "abc-", // trailing dash
    "a-b", // dash in the middle
    "a_b", // underscore
    "a b", // space
    "a".repeat(65), // 65 chars, too long
    "", // empty
    42, // not a string
    null, // not a string
  ]) {
    it(`rejects action ${JSON.stringify(action) ?? "null"}`, () => {
      const result = parseEnvelope(
        JSON.stringify({ action, params: {} }),
      );
      expect(isInvalid(result)).toBe(true);
      assertNoLeak(result);
    });
  }
});

describe("parseEnvelope: params shape", () => {
  for (const params of [[1], null, 42, "s", true]) {
    it(`rejects params of shape ${JSON.stringify(params) ?? "null"}`, () => {
      const result = parseEnvelope(
        JSON.stringify({ action: "sendEmail", params }),
      );
      expect(isInvalid(result)).toBe(true);
      assertNoLeak(result);
    });
  }
});

describe("parseEnvelope: malformed payloads", () => {
  it("rejects a root array or scalar", () => {
    for (const text of ["[1,2]", "42", '"sendEmail"', "true"]) {
      const result = parseEnvelope(text);
      expect(isInvalid(result)).toBe(true);
      assertNoLeak(result);
    }
  });

  it("rejects duplicate keys", () => {
    const result = parseEnvelope(
      '{"action":"sendEmail","action":"other","params":{}}',
    );
    expect(isInvalid(result)).toBe(true);
    assertNoLeak(result);
  });

  it("rejects a forbidden key in params", () => {
    const result = parseEnvelope(
      '{"action":"sendEmail","params":{"__proto__":1}}',
    );
    expect(isInvalid(result)).toBe(true);
    assertNoLeak(result);
  });

  it("maps an oversized payload to payload_too_large", () => {
    const text =
      '{"action":"sendEmail","params":{"pad":"' +
      "a".repeat(16400) +
      '"}}';
    const result = parseEnvelope(text);
    expect(result).toEqual({
      ok: false,
      outcome: "INVALID_ACTION",
      reason: "payload_too_large",
    });
  });

  it("maps every other strict-json failure to malformed_envelope", () => {
    for (const text of [
      '{"action":"sendEmail","params":{', // syntax
      '{"a":'.repeat(20) + "1" + "}".repeat(20), // too_deep, and a well-formed document otherwise
    ]) {
      const result = parseEnvelope(text);
      expect(result).toEqual({
        ok: false,
        outcome: "INVALID_ACTION",
        reason: "malformed_envelope",
      });
    }
  });
});

describe("parseEnvelope: no input echo", () => {
  it("never puts offending values in the result", () => {
    const secret = "secret-value-42";
    const result = parseEnvelope(
      `{"action":"sendEmail","params":{"pad":"${secret}"}}`,
    );
    if (!result.ok) throw new Error("expected ok");
    // The success result only carries action and params.
    expect(Object.keys(result).sort()).toEqual(["action", "ok", "params"]);
    expect(result.action).toBe("sendEmail");
    expect((result.params as Record<string, unknown>).pad).toBe(secret);
  });
});

describe("parseEnvelope: QA hardening", () => {
  const ok = '{"action":"sendEmail","params":{}}';

  it("uses the configured caps, not hard-coded ones", () => {
    expect(parseEnvelope(ok, { maxPayloadBytes: ok.length })).toMatchObject({ ok: true });
    expect(parseEnvelope(ok, { maxPayloadBytes: ok.length - 1 })).toEqual({ ok: false, outcome: "INVALID_ACTION", reason: "payload_too_large" });
    expect(parseEnvelope('{"action":"sendEmail","params":{"a":{"b":1}}}', { maxJsonDepth: 3 })).toMatchObject({ ok: true });
    expect(parseEnvelope('{"action":"sendEmail","params":{"a":{"b":{"c":1}}}}', { maxJsonDepth: 3 })).toEqual({ ok: false, outcome: "INVALID_ACTION", reason: "malformed_envelope" });
    expect(() => parseEnvelope(ok, { maxPayloadBytes: 0 })).toThrow(RangeError);
  });

  it("reports a non-finite number as invalid parameters, not an invalid action (ATK-PARAMS-10)", () => {
    for (const input of [
      '{"action":"sendEmail","params":{"n":1e999}}', '{"action":"sendEmail","params":{"n":[-1e999]}}', '{"action":"sendEmail","params":{"id":9007199254740993}}',
      { action: "sendEmail", params: { n: NaN } }, { action: "sendEmail", params: { n: Infinity } }, { action: "sendEmail", params: { n: { deep: -Infinity } } },
    ]) {
      const result = parseEnvelope(input);
      expect(result).toEqual({ ok: false, outcome: "INVALID_PARAMETERS", reason: "invalid_parameters" });
      assertNoLeak(result);
    }
  });

  it("classifies by structure first: a numeric fault never decides the outcome of a structurally invalid envelope", () => {
    for (const input of [
      '{"action":"sendEmail","params":{},"callId":1e999}', '{"params":{"n":1e999},"params":{}}', '{"action":"sendEmail","params":{"n":1e999,"__proto__":1}}',
      '[1e999]', '{"action":1e999,"params":{}}', '{"action":"sendEmail","params":1e999}', '{"action":"sendEmail","params":{"n":1e999},"userConfirmed":true}',
      '{"action":"ab","params":{"n":1e999}}', '{"action":"sendEmail"}', '{"n":1e999}', "1e999", '{"action":"sendEmail","params":{"n":9007199254740993},"extra":1}',
      '{"action":"sendEmail","params":{"n":1e999,"n":2}}', { action: "sendEmail", params: { n: NaN }, callId: "x" }, { action: "sendEmail", params: { n: NaN, bad: 1n } },
    ]) {
      expect(parseEnvelope(input), typeof input === "string" ? input : "an already-parsed envelope").toEqual({ ok: false, outcome: "INVALID_ACTION", reason: "malformed_envelope" });
    }
  });

  it("is the same whichever order the keys and faults come in", () => {
    const orders = [
      '{"action":"sendEmail","params":{"n":1e999},"callId":"x"}', '{"callId":"x","params":{"n":1e999},"action":"sendEmail"}', '{"params":{"n":1e999},"callId":"x","action":"sendEmail"}',
    ];
    for (const text of orders) expect(parseEnvelope(text), text).toEqual({ ok: false, outcome: "INVALID_ACTION", reason: "malformed_envelope" });
    for (const text of ['{"action":"sendEmail","params":{"n":1e999}}', '{"params":{"n":1e999},"action":"sendEmail"}']) {
      expect(parseEnvelope(text), text).toEqual({ ok: false, outcome: "INVALID_PARAMETERS", reason: "invalid_parameters" });
    }
  });

  it("keeps duplicate, forbidden, oversized and malformed input as an invalid action (ATK-PARAMS-06 to 09, 13)", () => {
    for (const input of [
      '{"action":"sendEmail","action":"other","params":{}}', '{"action":"sendEmail","params":{},"params":{}}', '{"action":"sendEmail","params":{"__proto__":{}}}',
      '{"action":"sendEmail","params":{"constructor":1}}', '{"action":"sendEmail","params":{"prototype":1}}', '{"action":"sendEmail","params":{},"callId":"x"}',
      '{"action":"sendEmail","params":{},"requestId":"x"}', '{"action":"sendEmail","params":{},"userConfirmed":true}', { action: "sendEmail", params: {}, userConfirmed: true },
    ]) {
      const result = parseEnvelope(input);
      expect(result.ok).toBe(false);
      expect(result).toMatchObject({ outcome: "INVALID_ACTION", reason: "malformed_envelope" });
      assertNoLeak(result);
    }
  });

  it("judges the decoded action, not the escaped text", () => {
    expect(parseEnvelope('{"action":"\\u0073endEmail","params":{}}')).toMatchObject({ ok: true, action: "sendEmail" });
    // JSON escapes (a backslash in the text), so the document is valid and the GRAMMAR is what rejects the decoded value.
    for (const escaped of ["sendEmail\\n", "sendEmail\\r\\n", "sendEmail\\u0000", "\\u0073endEmail\\r", "send\\u200bEmail", "s\\u0435ndEmail", "\\nsendEmail", "send\\u00e9Email", "\\uff53endEmail"]) {
      const text = `{"action":"${escaped}","params":{}}`;
      expect(parseStrictJson(text).ok, `${escaped} must be valid JSON for this case to test the grammar`).toBe(true);
      expect(parseEnvelope(text), escaped).toEqual({ ok: false, outcome: "INVALID_ACTION", reason: "malformed_envelope" });
    }
    // Plain-text values that fail the grammar on length or class.
    for (const action of ["ab", "a".repeat(65), "SendEmail", "1send", "send_email", "send-email", "send email", ""]) {
      expect(parseEnvelope(`{"action":"${action}","params":{}}`), action).toEqual({ ok: false, outcome: "INVALID_ACTION", reason: "malformed_envelope" });
    }
    // A lone surrogate is rejected by the parser before the grammar sees it.
    expect(parseEnvelope('{"action":"\\ud800sendEmail","params":{}}')).toEqual({ ok: false, outcome: "INVALID_ACTION", reason: "malformed_envelope" });
  });

  it("does not take an action or params from the prototype chain", () => {
    const proto = Object.prototype as unknown as Record<string, unknown>;
    proto.action = "sendEmail";
    proto.params = {};
    try {
      for (const input of ['{"a":1,"b":2}', '{"x":"sendEmail","params":{}}', '{"action":"sendEmail","y":{}}', { a: 1, b: 2 }]) {
        expect(parseEnvelope(input), JSON.stringify(input)).toMatchObject({ ok: false, reason: "malformed_envelope" });
      }
    } finally {
      delete proto.action;
      delete proto.params;
    }
  });

  it("is independent of key order and of surrounding whitespace", () => {
    expect(parseEnvelope('\n {"params":{"a":1},"action":"sendEmail"} \t')).toMatchObject({ ok: true, action: "sendEmail", params: { a: 1 } });
  });

  it("reads an already-parsed envelope exactly once", () => {
    let reads = 0;
    const source = { get action() { reads += 1; return reads === 1 ? "sendEmail" : "somethingElse"; }, params: {} };
    expect(parseEnvelope(source)).toMatchObject({ ok: true, action: "sendEmail" });
    expect(reads).toBe(1);
  });

  it("returns frozen results, so a caller cannot rewrite a decision input", () => {
    const success = parseEnvelope('{"action":"sendEmail","params":{"a":[1]}}');
    const failure = parseEnvelope("not json");
    expect(Object.isFrozen(success) && Object.isFrozen(failure)).toBe(true);
    if (!success.ok) throw new Error("expected success");
    expect(Object.isFrozen(success.params) && Object.isFrozen((success.params as { a: unknown[] }).a)).toBe(true);
    expect(failure).not.toBe(parseEnvelope("also not json"));
  });

  it("rejects every non-object shape for the whole envelope and for params", () => {
    for (const input of ["[]", "null", "1", '"sendEmail"', "true", [], null, 1, undefined, () => 1, { action: "sendEmail" }, { params: {} }, {}]) {
      expect(parseEnvelope(input), String(input)).toMatchObject({ ok: false, outcome: "INVALID_ACTION", reason: "malformed_envelope" });
    }
    for (const params of ["[]", "null", "1", '"x"', "true"]) {
      expect(parseEnvelope(`{"action":"sendEmail","params":${params}}`), params).toMatchObject({ ok: false, reason: "malformed_envelope" });
    }
  });
});
