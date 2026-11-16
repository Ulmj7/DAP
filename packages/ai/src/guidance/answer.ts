/**
 * The grounded answer path (T310): retrieve -> structured request -> ONE guarded model call -> strict decision -> grounding rule.
 *
 * Retrieved chunks are data. The public result is built only from the trusted chunks that were supplied: an `answer` must cite at least one of their ids,
 * a model-invented id makes it `ungrounded`, and the returned sources are `{ id: docId, title }` taken from the chunks, never from model-provided titles.
 * In this slice a `start_walkthrough` decision is not handled (Slice 3 replaces that branch). With no usable chunks no model call is made; the full service
 * may still call the model for walkthrough routing.
 */
import { MAX_ANSWER_CHARS, MAX_SOURCES } from "./limits.js";
import { callGuidanceModel } from "./call-model.js";
import type { ModelCallGuard } from "./call-model.js";
import { parseGuidanceModelRequest } from "./request.js";
import type { RequestParse } from "./request.js";
import { unsupportedResult } from "./result.js";
import type { GuidanceDecision, GuidanceModel, GuidanceResult, GuidanceTimers } from "./types.js";
import type { Retriever } from "./knowledge/retriever.js";

/** What the answer path keeps of a retrieved chunk. */
export interface AnswerChunk { readonly id: string; readonly docId: string; readonly title: string; readonly text: string }

/** A request validated by the Slice 1 schema: sources are the retrieved chunks, no walkthrough summaries, the answer bound as the output bound. */
export function buildAnswerRequest(args: { readonly query: unknown; readonly semanticContext: unknown; readonly chunks: readonly AnswerChunk[] }): RequestParse {
  const chunks = Array.isArray(args.chunks) ? args.chunks : [];
  return parseGuidanceModelRequest({
    input: {
      query: args.query,
      semanticContext: args.semanticContext,
      walkthroughSummaries: [],
      sources: chunks.map((chunk) => ({ id: chunk.id, title: chunk.title, text: chunk.text })),
    },
    maxOutputChars: MAX_ANSWER_CHARS,
  });
}

/** Turns a validated decision into a trusted result, given the chunks that were actually supplied to the model. Pure. */
export function groundDecision(decision: GuidanceDecision, supplied: readonly Pick<AnswerChunk, "id" | "docId" | "title">[]): GuidanceResult {
  switch (decision.kind) {
    case "answer": {
      const byId = new Map(supplied.map((chunk) => [chunk.id, chunk]));
      if (decision.sources.length === 0 || decision.sources.some((id) => !byId.has(id))) return unsupportedResult("ungrounded");
      const sources: { id: string; title: string }[] = [];
      for (const id of decision.sources) {
        const chunk = byId.get(id)!;
        if (!sources.some((source) => source.id === chunk.docId)) sources.push({ id: chunk.docId, title: chunk.title });
      }
      return Object.freeze({ kind: "answer", answer: decision.answer, sources: Object.freeze(sources.map((source) => Object.freeze(source))) });
    }
    case "clarify": return Object.freeze({ kind: "clarify", message: decision.message });
    default: return unsupportedResult("unsupported_request"); // `unsupported` (fixed message, never model text) and, until Slice 3, `start_walkthrough`
  }
}

function retrieve(retriever: Retriever, query: unknown): AnswerChunk[] {
  try {
    const found: unknown = retriever.search(query);
    if (!Array.isArray(found)) return [];
    return found.slice(0, MAX_SOURCES).map((chunk: AnswerChunk) => ({ id: chunk.id, docId: chunk.docId, title: chunk.title, text: chunk.text }));
  } catch { return []; } // a failing retriever means no evidence
}

export async function answerQuestion(args: {
  readonly model: GuidanceModel; readonly timers: GuidanceTimers; readonly retriever: Retriever; readonly query: unknown; readonly semanticContext: unknown; readonly guard?: ModelCallGuard;
}): Promise<GuidanceResult> {
  try {
    const chunks = retrieve(args.retriever, args.query);
    if (chunks.length === 0) return unsupportedResult("ungrounded"); // no evidence: no model call
    const request = buildAnswerRequest({ query: args.query, semanticContext: args.semanticContext, chunks });
    if (!request.ok) return unsupportedResult(request.reason);
    const outcome = await callGuidanceModel({ model: args.model, request: request.request, timers: args.timers, ...(args.guard === undefined ? {} : { guard: args.guard }) });
    return outcome.ok ? groundDecision(outcome.decision, chunks) : unsupportedResult(outcome.reason);
  } catch { return unsupportedResult("unavailable"); }
}
