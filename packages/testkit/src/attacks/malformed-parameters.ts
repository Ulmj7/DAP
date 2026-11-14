import { z } from "zod";
import type { Outcome, ReasonCode } from "@dap/contracts";
import { denialScenario } from "./denial-scenario.js";

/** Register this bounded strict schema on testSafeEcho for the PARAMS scenario fixture. */
export const malformedParamsSchema = z.strictObject({
  message: z.string().max(200),
  options: z.strictObject({ nested: z.strictObject({ leaf: z.strictObject({ value: z.string().max(20) }) }) }).optional(),
  count: z.number().min(0).max(10).optional(),
  tags: z.array(z.string().max(20)).max(2).optional(),
});
const envelope = (params: unknown) => ({ action: "testSafeEcho", params });
const invalid = (raw: unknown, outcome: Outcome = "INVALID_PARAMETERS", reason: ReasonCode = "invalid_parameters") => ({ raw, outcome, reason });
const schemaCase = (id: string, title: string, params: () => readonly unknown[]) => denialScenario(`ATK-PARAMS-${id}`, "malformed-parameters", title, () => params().map((value) => invalid(envelope(value))));

/** 08/09 require gateway caps maxJsonDepth=8 and maxPayloadBytes=1024. Reset rate/replay state per case. */
export const malformedParameterScenarios = [
  schemaCase("01", "missing required message", () => [{}]),
  schemaCase("02", "mistyped scalar/object", () => [{ message: 7 }, { message: "ok", count: "1" }, { message: "ok", options: [] }]),
  schemaCase("03", "extra top-level parameter", () => [{ message: "ok", unexpected: "value" }]),
  schemaCase("04", "extra key at depth three", () => [{ message: "ok", options: { nested: { leaf: { value: "ok", extra: true } } } }]),
  schemaCase("05", "bounded strings arrays and numbers", () => [{ message: "x".repeat(201) }, { message: "ok", tags: ["a", "b", "c"] }, { message: "ok", count: 11 }]),
  denialScenario("ATK-PARAMS-06", "malformed-parameters", "duplicate raw JSON keys", () => [invalid('{"action":"testSafeEcho","params":{"message":"a","message":"b"}}', "INVALID_ACTION", "malformed_envelope"), invalid('{"action":"testSafeEcho","action":"deleteEverything","params":{"message":"ok"}}', "INVALID_ACTION", "malformed_envelope")]),
  denialScenario("ATK-PARAMS-07", "malformed-parameters", "prototype keys in raw JSON", () => ["__proto__", "constructor", "prototype"].flatMap((key) => [invalid(`{"action":"testSafeEcho","params":{"message":"ok","${key}":{}}}`, "INVALID_ACTION", "malformed_envelope"), invalid(`{"action":"testSafeEcho","params":{"message":"ok","options":{"${key}":{}}}}`, "INVALID_ACTION", "malformed_envelope")])),
  denialScenario("ATK-PARAMS-08", "malformed-parameters", "depth cap of eight exceeded", () => [invalid(envelope({ message: "ok", nested: Array.from({ length: 12 }).reduce<unknown>((value) => ({ child: value }), null) }), "INVALID_ACTION", "malformed_envelope")]),
  denialScenario("ATK-PARAMS-09", "malformed-parameters", "1024-byte cap exceeded with multibyte UTF-8", () => [invalid(JSON.stringify(envelope({ message: "界".repeat(400) })), "INVALID_ACTION", "payload_too_large")]),
  schemaCase("10", "non-finite object numbers", () => [NaN, Infinity, -Infinity].map((count) => ({ message: "ok", count }))),
  schemaCase("11", "identity-like keys at top level and nested", () => ["tenantId", "userId", "role", "confirmed", "isAdmin"].flatMap((key) => [{ message: "ok", [key]: "claimed" }, { message: "ok", options: { nested: { leaf: { value: "ok", [key]: "claimed" } } } }])),
  schemaCase("12", "getter and Proxy initially invalid then valid must remain denied", () => {
    let getterReads = 0;
    let proxyReads = 0;
    return [{ get message() { return ++getterReads === 1 ? 7 : "ok"; } }, new Proxy({ message: 7 }, { get(target, key, receiver) { return key === "message" ? (++proxyReads === 1 ? 7 : "ok") : Reflect.get(target, key, receiver); } })];
  }),
  denialScenario("ATK-PARAMS-13", "malformed-parameters", "extra envelope keys", () => ["callId", "requestId", "userConfirmed"].map((key) => invalid({ ...envelope({ message: "ok" }), [key]: "fabricated" }, "INVALID_ACTION", "malformed_envelope"))),
];
