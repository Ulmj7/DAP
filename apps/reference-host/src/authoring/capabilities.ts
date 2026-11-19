/**
 * The two authoring capabilities (Feature 004, T405): the ONLY way a definition is written. They are ordinary Feature 001 capabilities, modelled on
 * `guidance/capability.ts`: a request goes through the Gateway (strict schema, permission, risk, rate/replay, durable audit) and only then does a trusted executor run.
 *
 *   saveWalkthroughDraft   { walkthroughId, definition }          insert a draft, or update one ONLY while it is a draft
 *   setWalkthroughStatus   { walkthroughId, status: draft|published }   publish (re-validates the STORED definition) or unpublish
 *
 * Both are MEDIUM, `changesState`, permission EXACTLY `perm.walkthrough.maintain`, `allowedPages: "any"`, a `walkthrough` resource (rule R9) and a written justification
 * in place of a confirmation (HIGH is impossible until the confirmation service exists). Audit records `/walkthroughId` (and `/status` on the status capability, a
 * closed enum) as plain values and NOTHING else: never the definition, a title, step text or registry data.
 *
 * Trust: the executors take tenant and actor ONLY from `call.security` (the Gateway's trusted context), never from the parameters; the input schema is strict, so a
 * `tenantId`, `permissions` or `actorId` field is refused before an executor exists. They RE-VALIDATE before writing (defence in depth: the route validated already, the
 * Gateway only proves the SHAPE) with the one Feature 002 validator. Every result is a short fixed code; no thrown text, SQL or issue list leaves.
 */
import { defineAction, defineExecutor } from "@dap/contracts";
import type { ActionDefinition, ActionExecutor, ActionId, ExecutorId, PermissionId, ResourceRef } from "@dap/contracts";
import type { HostExtension } from "../compose.js";
import { isAuthoredId } from "./ids.js";
import { saveInputSchema, statusInputSchema } from "./schema.js";
import type { SaveInput, StatusInput } from "./schema.js";
import type { StatusOutcome, WalkthroughStore } from "./store.js";
import { TRUSTED_REGISTRY } from "./trusted-registry.js";
import type { TrustedRegistryData } from "./trusted-registry.js";
import { validateAuthoredDefinition } from "./validate.js";

export const MAINTAIN_PERMISSION = "perm.walkthrough.maintain";
export const SAVE_ACTION_ID = "saveWalkthroughDraft";
export const STATUS_ACTION_ID = "setWalkthroughStatus";
export const SAVE_EXECUTOR_ID = "ex.authoring-save-walkthrough-draft";
export const STATUS_EXECUTOR_ID = "ex.authoring-set-walkthrough-status";
export const AUTHORING_ACTION_IDS: readonly string[] = Object.freeze([SAVE_ACTION_ID, STATUS_ACTION_ID]);

/** Why MEDIUM may skip a user confirmation (registry rule R5). */
export const MEDIUM_JUSTIFICATION =
  "Only a maintainer session (perm.walkthrough.maintain) can call this. The definition is validated by the same rules the runtime applies before anything is stored, a draft is invisible to users, " +
  "publishing is reversible by unpublishing, and a guide only shows guidance: it never changes application data or grants authority. HIGH is not available until a confirmation service exists.";

const resource = (params: { readonly walkthroughId: string }): ResourceRef | null => ({ type: "walkthrough", id: params.walkthroughId });

export const saveWalkthroughDraft: ActionDefinition<SaveInput> = defineAction({
  id: SAVE_ACTION_ID as ActionId,
  version: 1,
  description: "Saves a walkthrough definition as a draft for the caller's tenant. Maintainer only; the definition is validated first and nothing is shown to users until it is published.",
  inputSchema: saveInputSchema,
  risk: "MEDIUM",
  requiredPermission: MAINTAIN_PERMISSION as PermissionId,
  allowedPages: "any",
  confirmation: { kind: "not-required", justification: MEDIUM_JUSTIFICATION },
  changesState: true,
  audit: { params: [{ path: "/walkthroughId", mode: "plain" }] },
  resource,
  executorId: SAVE_EXECUTOR_ID as ExecutorId,
});

export const setWalkthroughStatus: ActionDefinition<StatusInput> = defineAction({
  id: STATUS_ACTION_ID as ActionId,
  version: 1,
  description: "Publishes a stored draft (after re-validating it against the current registry) or unpublishes a published walkthrough. Maintainer only.",
  inputSchema: statusInputSchema,
  risk: "MEDIUM",
  requiredPermission: MAINTAIN_PERMISSION as PermissionId,
  allowedPages: "any",
  confirmation: { kind: "not-required", justification: MEDIUM_JUSTIFICATION },
  changesState: true,
  audit: { params: [{ path: "/walkthroughId", mode: "plain" }, { path: "/status", mode: "plain" }] },
  resource,
  executorId: STATUS_EXECUTOR_ID as ExecutorId,
});

/** The failure codes of the executors (short, fixed). */
export type AuthoringFailureCode = "invalid_definition" | "not_a_draft" | "not_found" | "limit_reached" | "id_refused" | "store_unavailable";

/** The host's own record of what the executors received (never reachable from an AI session). */
export interface AuthoringTrustedHandle {
  /** The validated parameters of every call that reached an executor body, per action, newest last, bounded. */
  receivedCalls(actionId: string): readonly unknown[];
  /** How many times an executor body ran, per action or in total. */
  executorCalls(actionId?: string): number;
}

export interface AuthoringDeps {
  readonly store: WalkthroughStore;
  /** The registry data the validator uses. Production code uses the trusted copy; a test injects a different one through the REAL validator. */
  readonly registryData?: TrustedRegistryData;
}

const MAX_RECORDED = 100;
const failure = (code: AuthoringFailureCode) => ({ status: "failure" as const, code });
const STATUS_FAILURES: Readonly<Record<Exclude<StatusOutcome, "changed" | "unchanged">, AuthoringFailureCode>> = Object.freeze({
  not_found: "not_found", invalid_definition: "invalid_definition", limit_reached: "limit_reached", id_refused: "id_refused",
});

export function createAuthoringExecutors(deps: AuthoringDeps): { readonly executors: readonly ActionExecutor[]; readonly trusted: AuthoringTrustedHandle } {
  const { store } = deps;
  const registryData = deps.registryData ?? TRUSTED_REGISTRY;
  const received = new Map<string, unknown[]>();
  let total = 0;
  const record = (actionId: string, params: unknown): void => {
    total += 1;
    const list = received.get(actionId) ?? [];
    list.push(structuredClone(params));
    if (list.length > MAX_RECORDED) list.shift();
    received.set(actionId, list);
  };

  const save = defineExecutor<SaveInput>({
    id: SAVE_EXECUTOR_ID,
    run: async (call) => {
      record(SAVE_ACTION_ID, call.params);
      // Tenant and actor come from the trusted context only.
      const scope = { tenantId: call.security.tenantId as string, actor: call.security.userId as string };
      const checked = validateAuthoredDefinition(call.params.walkthroughId, call.params.definition, registryData);
      if (!checked.ok) return failure(checked.code);
      try {
        const outcome = await store.saveDraft(scope, call.params.walkthroughId, checked.definition);
        switch (outcome) {
          case "created": case "updated": return { status: "success", affected: { type: "walkthrough", id: call.params.walkthroughId } };
          case "not_a_draft": return failure("not_a_draft");
          case "too_large": return failure("invalid_definition");
          default: return failure("id_refused");
        }
      } catch { return failure("store_unavailable"); }
    },
  });

  const status = defineExecutor<StatusInput>({
    id: STATUS_EXECUTOR_ID,
    run: async (call) => {
      record(STATUS_ACTION_ID, call.params);
      const scope = { tenantId: call.security.tenantId as string, actor: call.security.userId as string };
      const { walkthroughId } = call.params;
      if (!isAuthoredId(walkthroughId)) return failure("id_refused");
      try {
        // Publish: the store loads the STORED definition under a row lock and asks this check, so the guide is re-validated against the CURRENT registry data.
        const outcome = await store.setStatus(scope, walkthroughId, call.params.status, (stored) => validateAuthoredDefinition(walkthroughId, stored, registryData).ok);
        if (outcome === "changed" || outcome === "unchanged") return { status: "success", affected: { type: "walkthrough", id: walkthroughId } };
        return failure(STATUS_FAILURES[outcome]);
      } catch { return failure("store_unavailable"); }
    },
  });

  const trusted: AuthoringTrustedHandle = Object.freeze({
    receivedCalls: (actionId: string) => Object.freeze([...(received.get(actionId) ?? [])]),
    executorCalls: (actionId?: string) => (actionId === undefined ? total : (received.get(actionId)?.length ?? 0)),
  });
  return { executors: Object.freeze([save, status]), trusted };
}

/** The host extension that adds both capabilities and their executors. Each is still OFF unless `DAP_ENABLED_ACTIONS` lists it (default deny). */
export function createAuthoringExtension(deps: AuthoringDeps): { readonly extension: HostExtension; readonly trusted: AuthoringTrustedHandle } {
  const { executors, trusted } = createAuthoringExecutors(deps);
  return { extension: Object.freeze({ definitions: Object.freeze([saveWalkthroughDraft, setWalkthroughStatus]), executors }), trusted };
}
