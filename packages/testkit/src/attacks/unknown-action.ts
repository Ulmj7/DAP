import type { Outcome, ReasonCode } from "@dap/contracts";
import { denialScenario } from "./denial-scenario.js";

export const RESERVED_ATTACK_NAMES = ["executeShell", "runShell", "executeJavaScript", "queryDatabase", "fetchAnyUrl", "clickAnySelector", "getPassword", "disableAudit", "changeOwnPermissions"] as const;
export const PROTOTYPE_ACTION_NAMES = ["__proto__", "constructor", "toString", "hasOwnProperty"] as const;
export const lookalikeNames = (id: string): readonly string[] => [id.toUpperCase(), `${id} `, `${id}\u200b`, id.replace("e", "е"), `${id}é`, `${id}e\u0301`, `ｔ${id.slice(1)}`];
const entry = (action: string, outcome: Outcome, reason: ReasonCode) => ({ raw: { action, params: { message: "benign" } }, outcome, reason });

/** 05 needs an empty global allowlist; 06 needs the action enabled globally and disabled in tenant A. */
export const unknownActionScenarios = [
  denialScenario("ATK-UNKNOWN-01", "unknown-action", "never registered", () => [entry("deleteEverything", "INVALID_ACTION", "unknown_action")]),
  denialScenario("ATK-UNKNOWN-02", "unknown-action", "reserved dangerous names", () => RESERVED_ATTACK_NAMES.map((name) => entry(name, "FORBIDDEN_POLICY", "reserved_forbidden_action"))),
  denialScenario("ATK-UNKNOWN-03", "unknown-action", "exact matching rejects look-alikes", ({ actionId }) => lookalikeNames(actionId).map((name) => entry(name, "INVALID_ACTION", /^[a-z][A-Za-z0-9]{2,63}$/.test(name) ? "unknown_action" : "malformed_envelope"))),
  denialScenario("ATK-UNKNOWN-04", "unknown-action", "prototype names", () => PROTOTYPE_ACTION_NAMES.map((name) => entry(name, "INVALID_ACTION", name === "__proto__" ? "malformed_envelope" : "unknown_action"))),
  denialScenario("ATK-UNKNOWN-05", "unknown-action", "registered but globally disabled", ({ actionId }) => [entry(actionId, "DENIED", "action_not_enabled")]),
  denialScenario("ATK-UNKNOWN-06", "unknown-action", "disabled for calling tenant", ({ actionId }) => [entry(actionId, "DENIED", "tenant_action_disabled")]),
];
