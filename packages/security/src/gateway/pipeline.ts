import { z } from "zod";
import { PIPELINE_STAGES } from "@dap/contracts";
import type { AuthorizationContext, JsonValue, PipelineStage, PlannerRunMeta, PolicyDecision, ProposalCall, RequestId } from "@dap/contracts";
import { isMintedContext } from "@dap/contracts/mint";
import { snapshotAnswer } from "./answer-snapshot.js";
import { allowedDecision, confirmationDecision, denyDecision } from "./decision.js";
import { assertTimeout, nativeTimer, underDeadline, type HookTimer } from "./deadline.js";
import type { HookOptions } from "./hook-wrapper.js";

export interface PipelineInput {
  readonly context: unknown;
  /** Untrusted until the pipeline validates it; a record that cannot be read arrives as null. */
  readonly run: unknown;
  readonly decisionId: string;
  readonly requestId: RequestId;
  /** Only intake reads the proposal; context denial must not even inspect its getters. */
  readonly readProposal: () => ProposalCall;
}
/**
 * What is left of the proposal's overall deadline, read from the runner's own monotonic timer. A stage that makes
 * several host calls in sequence (authorize) gives each one at most this much, and never more than `hookTimeoutMs`.
 */
export interface ProposalBudget { readonly remainingMs: () => number }
export interface PipelineRecord extends Omit<PipelineInput, "context" | "run"> {
  readonly budget: ProposalBudget;
  readonly context: AuthorizationContext | null;
  readonly run: PlannerRunMeta;
  /** Each stage owns one append-only slot. Values are detached, deeply frozen JSON data. */
  readonly facts: Readonly<Partial<Record<PipelineStage, JsonValue>>>;
}
export type StageResult = Readonly<{ kind: "continue"; data: Readonly<Record<string, JsonValue>> }> | Readonly<{ kind: "stop"; decision: PolicyDecision }>;
export type PolicyStage = (request: PipelineRecord) => StageResult | Promise<StageResult>;
export type StageMap = Partial<Record<PipelineStage, PolicyStage>>;
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
  const denied = (reason: FailureReason): StageResult => Object.freeze({ kind: "stop", decision: failure(request, stage, reason) });
  // A stage that throws or rejects is an internal error; a stage that is late, malformed or cannot be timed is a dependency failure.
  return underDeadline<StageResult>(() => fn(request), (raw) => captureResult(raw, request, stage), (cause) => denied(cause === "thrown" || cause === "rejected" ? "internal_error" : "dependency_failure"), timeout, timer);
}

export interface PipelineOptions extends HookOptions {
  /** Overall deadline for one proposal across every stage. Default 10 000 ms. */
  readonly proposalBudgetMs?: number;
}
/** Stages that make several host calls in sequence: their deadline is the remaining proposal budget, each call is capped by `hookTimeoutMs` inside the stage. */
const SEQUENTIAL_HOOK_STAGES: ReadonlySet<PipelineStage> = new Set(["authorize"]);

/** D6 positions are fixed; adding an implementation never changes another stage's code. */
export function createPipeline(stages: StageMap, { hookTimeoutMs = 2000, timer = nativeTimer, proposalBudgetMs = 10_000 }: PipelineOptions = {}) {
  assertTimeout(hookTimeoutMs, "pipeline");
  assertTimeout(proposalBudgetMs, "proposal budget");
  const ordered = PIPELINE_STAGES.map((name) => Object.freeze({ name, fn: stages[name] }));
  return Object.freeze({
    async run(source: PipelineInput): Promise<PolicyDecision> {
      let identifiers = { decisionId: "unavailable", requestId: "unavailable" as RequestId };
      let current: PipelineStage = "context";
      try {
        const { context, run, decisionId, requestId, readProposal } = source;
        if (typeof decisionId !== "string" || !decisionId || typeof requestId !== "string" || !requestId) return failure(identifiers, current, "dependency_failure");
        identifiers = { decisionId, requestId };
        // The runner owns the overall deadline: a stage cannot extend it, and a timer that cannot tell the time leaves none.
        const started = timer.now();
        const remaining = (): number => { const current = timer.now(); return Number.isFinite(started) && Number.isFinite(current) && current >= started ? proposalBudgetMs - (current - started) : 0; };
        const budget: ProposalBudget = Object.freeze({ remainingMs: remaining });
        const capturedRun = snapshotAnswer(run);
        if (!runSchema.safeParse(capturedRun).success || typeof readProposal !== "function") return failure(identifiers, current, "dependency_failure");
        let request: PipelineRecord = Object.freeze({ ...identifiers, context: isMintedContext(context) ? context : null, run: capturedRun as PlannerRunMeta, readProposal: proposalWithheld, facts: Object.freeze({}), budget });
        const proposal = onceProposal(readProposal);
        for (const { name, fn } of ordered) {
          current = name;
          // Absent guards must stop before any later hook or executor can run.
          if (typeof fn !== "function") return failure(request, name, "dependency_failure");
          const left = remaining();
          if (!(left > 0)) return failure(request, name, "dependency_failure");
          const view: PipelineRecord = name === "intake" ? Object.freeze({ ...request, readProposal: proposal }) : request;
          const result = await runStage(fn, view, name, SEQUENTIAL_HOOK_STAGES.has(name) ? left : Math.min(hookTimeoutMs, left), timer);
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
