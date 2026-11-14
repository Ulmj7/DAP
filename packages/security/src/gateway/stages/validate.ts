import type { ActionRegistry, AnyActionDefinition, FeedbackIssue } from "@dap/contracts";
import { validateParams } from "../../validation/params.js";
import type { StrictJsonOptions } from "../../validation/strict-json.js";
import { denyDecision } from "../decision.js";
import type { PolicyStage } from "../pipeline.js";

const record = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : undefined;

/**
 * Stage 5, validate (T067, FR-018, FR-020): checks the parameters intake published against the strict schema of
 * the action resolve published, for the minted tenant and user, and publishes
 * `facts.validate = { params, paramsDigest, resource }`: the only parameters any later stage may authorize,
 * digest, confirm, audit or execute.
 *
 * The definition is looked up again and must be the very action, version and definition hash that resolve
 * authorized; anything else is a dependency failure, never a validation against a different definition. A
 * rejected parameter set is `INVALID_PARAMETERS` carrying only structural issues (a path and a generic code). A
 * defective definition makes `validateParams` throw, which the runner turns into an internal error.
 */
export function createValidateStage(registry: ActionRegistry, options: StrictJsonOptions = {}): PolicyStage {
  const get = registry.get.bind(registry);
  const caps: StrictJsonOptions = Object.freeze({ ...options });
  return (request) => {
    const stop = (outcome: "DENIED" | "INVALID_PARAMETERS", reason: "dependency_failure" | "invalid_parameters", extra: { attemptedAction?: string; issues?: readonly FeedbackIssue[] } = {}) =>
      ({ kind: "stop" as const, decision: denyDecision({ decisionId: request.decisionId, requestId: request.requestId, stage: "validate", outcome, reason, ...extra } as Parameters<typeof denyDecision>[0]) });
    const intake = record(request.facts.intake);
    const resolved = record(request.facts.resolve);
    const context = request.context;
    if (!intake || !resolved || !context || intake.action !== resolved.id || record(intake.params) === undefined) return stop("DENIED", "dependency_failure");
    const entry = get(resolved.id as string);
    if (!entry || typeof entry !== "object") return stop("DENIED", "dependency_failure");
    // One read per field, before any await: the proof below and the validation see the same definition.
    const definition: unknown = Reflect.get(entry, "definition");
    const definitionHash: unknown = Reflect.get(entry, "definitionHash");
    if (!definition || typeof definition !== "object" || Reflect.get(definition, "id") !== resolved.id || Reflect.get(definition, "version") !== resolved.version || definitionHash !== resolved.definitionHash) return stop("DENIED", "dependency_failure");
    const checked = validateParams(definition as AnyActionDefinition, intake.params, { tenantId: context.tenantId, userId: context.userId }, caps);
    if (!checked.ok) return stop("INVALID_PARAMETERS", "invalid_parameters", { attemptedAction: resolved.id as string, issues: checked.issues });
    return { kind: "continue", data: { params: checked.normalized, paramsDigest: checked.paramsDigest, resource: checked.resource } };
  };
}
