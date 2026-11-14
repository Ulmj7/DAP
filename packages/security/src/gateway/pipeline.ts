import { performance } from "node:perf_hooks";
import { z } from "zod";
import { PIPELINE_STAGES } from "@dap/contracts";
import type { AuthorizationContext, JsonValue, PipelineStage, PlannerRunMeta, PolicyDecision, ProposalCall, RequestId } from "@dap/contracts";
import { isMintedContext } from "@dap/contracts/mint";
import { snapshotAnswer } from "./answer-snapshot.js";
import { allowedDecision, confirmationDecision, denyDecision } from "./decision.js";
import type { HookOptions, HookTimer } from "./hook-wrapper.js";

export interface PipelineInput {
  readonly context: unknown;
  /** Untrusted until the pipeline validates it; a record that cannot be read arrives as null. */
  readonly run: unknown;
  readonly decisionId: string;
  readonly requestId: RequestId;
  /** Only intake reads the proposal; context denial must not even inspect its getters. */
  readonly readProposal: () => ProposalCall;
}
export interface PipelineRecord extends Omit<PipelineInput, "context" | "run"> {
  readonly context: AuthorizationContext | null;
  readonly run: PlannerRunMeta;
  /** Each stage owns one append-only slot. Values are detached, deeply frozen JSON data. */
  readonly facts: Readonly<Partial<Record<PipelineStage, JsonValue>>>;
}
export type StageResult = Readonly<{ kind: "continue"; data: Readonly<Record<string, JsonValue>> }> | Readonly<{ kind: "stop"; decision: PolicyDecision }>;
export type PolicyStage = (request: PipelineRecord) => StageResult | Promise<StageResult>;
export type StageMap = Partial<Record<PipelineStage, PolicyStage>>;
const nativeTimer: HookTimer = { now: () => performance.now(), setTimeout: (callback, ms) => setTimeout(callback, ms), clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>) };
const runSchema = z.strictObject({ aiSessionId: z.string().min(1), turnId: z.string().min(1), model: z.string().min(1), depth: z.number().int().nonnegative(), turnStartedAt: z.iso.datetime({ offset: true }) });
const continuing = z.strictObject({ kind: z.literal("continue"), data: z.record(z.string(), z.json()) });
type FailureReason = "internal_error" | "dependency_failure";
/**
 * Each untrusted proposal field is read exactly once. The shell is frozen; `raw` stays the caller's
 * value for intake to copy once (never frozen in place), so intake is the only stage handed this reader:
 * every other stage works from intake's detached facts and can never see a second, different `raw`.
 */
function onceProposal(read: () => ProposalCall): () => ProposalCall {
  let captured: { readonly proposal: ProposalCall } | null | undefined;
  return Object.freeze((): ProposalCall => {
    if (captured === undefined) {
      try {
        const call = read();
        if (call === null || typeof call !== "object") throw new TypeError("Proposal is not an object");
        captured = { proposal: Object.freeze({ callId: call.callId, raw: call.raw }) };
      } catch { captured = null; }
    }
    if (captured === null) throw new TypeError("Proposal unavailable");
    return captured.proposal;
  });
}
const proposalWithheld = Object.freeze((): ProposalCall => { throw new TypeError("Only intake may read the proposal"); });
const failure = (request: Pick<PipelineInput, "decisionId" | "requestId">, stage: PipelineStage, reason: FailureReason) => denyDecision({ decisionId: request.decisionId, requestId: request.requestId, stage, reason });

function captureResult(raw: unknown, request: PipelineRecord, stage: PipelineStage): StageResult {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new TypeError("Invalid stage result");
  // Reject extra fields before copying: promise assimilation may already have read `then`.
  const keys = Reflect.ownKeys(raw);
  if (keys.length !== 2 || !keys.includes("kind") || (!keys.includes("data") && !keys.includes("decision"))) throw new TypeError("Invalid stage result fields");
  const captured = snapshotAnswer(raw);
  if (!captured || typeof captured !== "object" || Array.isArray(captured)) throw new TypeError("Invalid stage result");
  const value = captured as Record<string, unknown>;
  if (value.kind === "continue") {
    if (!continuing.safeParse(value).success) throw new TypeError("Invalid stage continuation");
    return captured as StageResult;
  }
  if (value.kind !== "stop" || Object.keys(value).length !== 2 || !Object.hasOwn(value, "decision")) throw new TypeError("Invalid stage stop");
  const decision = value.decision as PolicyDecision;
  if (!decision || decision.decisionId !== request.decisionId || decision.requestId !== request.requestId) throw new TypeError("Invalid decision binding");
  // Builders validate all fields again from the captured data, never from caller getters.
  const { outcome, ...fields } = decision;
  let checked: PolicyDecision;
  if (outcome === "ALLOWED") {
    if (stage !== "execute") throw new TypeError("Premature allow");
    checked = allowedDecision(fields as Parameters<typeof allowedDecision>[0]);
  } else if (outcome === "REQUIRES_CONFIRMATION") {
    if (stage !== "risk" && stage !== "confirmation") throw new TypeError("Premature confirmation");
    checked = confirmationDecision(fields as Parameters<typeof confirmationDecision>[0]);
  } else {
    checked = denyDecision({ ...fields, outcome } as Parameters<typeof denyDecision>[0]);
    if (checked.stage !== stage || checked.reason === "allowed") throw new TypeError("Invalid denial");
  }
  return Object.freeze({ kind: "stop", decision: checked });
}

function runStage(fn: PolicyStage, request: PipelineRecord, stage: PipelineStage, timeout: number, timer: HookTimer): Promise<StageResult> {
  return new Promise((resolve) => {
    let settled = false;
    let armed = false;
    let handle: unknown;
    const denied = (reason: FailureReason): StageResult => Object.freeze({ kind: "stop", decision: failure(request, stage, reason) });
    const finish = (result: StageResult): void => {
      if (settled) return;
      settled = true;
      try { if (armed) timer.clearTimeout(handle); } catch { result = denied("dependency_failure"); }
      resolve(result);
    };
    try {
      const start = timer.now();
      if (!Number.isFinite(start)) { finish(denied("dependency_failure")); return; }
      const withinDeadline = (): boolean => { const current = timer.now(); return Number.isFinite(current) && current >= start && current - start < timeout; };
      handle = timer.setTimeout(() => finish(denied("dependency_failure")), timeout);
      armed = true;
      if (settled) { timer.clearTimeout(handle); return; }
      let result: unknown;
      try { result = fn(request); } catch { finish(denied("internal_error")); return; }
      void Promise.resolve(result).then((raw: unknown) => {
        if (settled) return;
        try {
          if (!withinDeadline()) { finish(denied("dependency_failure")); return; }
          const captured = captureResult(raw, request, stage);
          finish(withinDeadline() ? captured : denied("dependency_failure"));
        } catch { finish(denied("dependency_failure")); }
      }, () => finish(denied("internal_error")));
    } catch { finish(denied("dependency_failure")); }
  });
}

/** D6 positions are fixed; adding an implementation never changes another stage's code. */
export function createPipeline(stages: StageMap, { hookTimeoutMs = 2000, timer = nativeTimer }: HookOptions = {}) {
  if (!Number.isSafeInteger(hookTimeoutMs) || hookTimeoutMs < 1 || hookTimeoutMs > 0x7fff_ffff) throw new RangeError("Invalid pipeline timeout");
  const ordered = PIPELINE_STAGES.map((name) => Object.freeze({ name, fn: stages[name] }));
  return Object.freeze({
    async run(source: PipelineInput): Promise<PolicyDecision> {
      let identifiers = { decisionId: "unavailable", requestId: "unavailable" as RequestId };
      let current: PipelineStage = "context";
      try {
        const { context, run, decisionId, requestId, readProposal } = source;
        if (typeof decisionId !== "string" || !decisionId || typeof requestId !== "string" || !requestId) return failure(identifiers, current, "dependency_failure");
        identifiers = { decisionId, requestId };
        const capturedRun = snapshotAnswer(run);
        if (!runSchema.safeParse(capturedRun).success || typeof readProposal !== "function") return failure(identifiers, current, "dependency_failure");
        let request: PipelineRecord = Object.freeze({ ...identifiers, context: isMintedContext(context) ? context : null, run: capturedRun as PlannerRunMeta, readProposal: proposalWithheld, facts: Object.freeze({}) });
        const proposal = onceProposal(readProposal);
        for (const { name, fn } of ordered) {
          current = name;
          // Absent guards must stop before any later hook or executor can run.
          if (typeof fn !== "function") return failure(request, name, "dependency_failure");
          const view: PipelineRecord = name === "intake" ? Object.freeze({ ...request, readProposal: proposal }) : request;
          const result = await runStage(fn, view, name, hookTimeoutMs, timer);
          if (result.kind === "stop") return result.decision;
          // Whatever the context stage is, nothing after it may run without a minted context.
          if (name === "context" && request.context === null) return failure(request, name, "dependency_failure");
          request = Object.freeze({ ...request, facts: Object.freeze({ ...request.facts, [name]: result.data }) });
        }
        return failure(request, "execute", "dependency_failure");
      } catch { return failure(identifiers, current, "internal_error"); }
    },
  });
}
