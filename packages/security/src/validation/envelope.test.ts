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
  expect(result.outcome).toBe("INVALID_ACTION");
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
      '{"action":"sendEmail","params":1e400}', // not_finite
      '{"action":"sendEmail","params":{', // syntax
      '{"a":' .repeat(20) + "1", // too_deep
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
