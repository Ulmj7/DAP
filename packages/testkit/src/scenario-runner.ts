/**
 * @dap/testkit: scenario-runner.ts (T035)
 *
 * runScenario(scenario, target) executes one AttackScenario against a prepared target and
 * returns the AttackObservation. It additionally runs a LeakScanner over ALL planner-visible
 * output (the feedback items plus the target's visibleOutput) and merges those findings with
 * any the scenario reported itself.
 *
 * Fail-closed: if the scenario (or anything it drives) throws, the runner returns an
 * observation recording the failure ({outcome: "not_available"}) instead of crashing.
 */
import type {
  AttackObservation,
  AttackScenario,
  CapabilityTraits,
  HostilePlanner,
  PlannerFeedback,
  ProposalCall,
  RecordingExecutor,
} from "@dap/contracts";
import { InMemoryAuditSink } from "./audit-capture.js";
import { snapshotData } from "./snapshot.js";
import { LeakScanner } from "./leak-scanner.js";
import { OUTCOMES } from "@dap/contracts";
import { isDeepStrictEqual } from "node:util";

/**
 * Everything one scenario needs from the prepared world. Structurally a CapabilityTraits
 * (so it satisfies AttackScenario.run's parameter type) plus the recording pieces.
 */
export interface ScenarioTarget extends CapabilityTraits {
  /** The scripted hostile planner (stands in for a compromised model). */
  readonly planner: HostilePlanner;
  /** One planner turn: submit a scripted proposal and get the feedback the planner sees. */
  submit(call: ProposalCall): Promise<PlannerFeedback>;
  /** Recording executor that proves whether execution ever happened. */
  readonly executor: RecordingExecutor;
  /** In-memory audit sink capturing every event the pipeline wrote. */
  readonly audit: InMemoryAuditSink;
  /** Anything else the planner can see (raw echoes, reflected errors, ...). */
  readonly visibleOutput: unknown;
}

function failureFeedback(): PlannerFeedback {
  // Denial-shaped feedback: the planner learns nothing beyond "not available right now".
  return { outcome: "DENIED", category: "not_available" };
}

function isFeedback(value: unknown): value is PlannerFeedback {
  if (value === null || typeof value !== "object") return false;
  const { outcome, category } = value as Record<string, unknown>;
  return OUTCOMES.some((item) => item === outcome) &&
    ["ok", "not_available", "try_later", "invalid_input", "needs_user_confirmation"].some((item) => item === category);
}

/** Capture actual submissions and read recording ports independently of scenario claims. */
export async function runScenario(
  scenario: AttackScenario,
  target: ScenarioTarget,
  scanner = new LeakScanner(),
): Promise<AttackObservation> {
  const submitted: PlannerFeedback[] = [];
  const findings = new Set<string>();
  const scan = (value: unknown): void => {
    for (const finding of scanner.scan(value)) findings.add(`${finding.kind}:${finding.path}`);
  };
  let feedback: readonly PlannerFeedback[] = [];
  let executorCalls = Number.MAX_SAFE_INTEGER;
  let auditEvents: AttackObservation["auditEvents"] = [];
  let failed = false;
  let executor: RecordingExecutor | undefined;
  let audit: InMemoryAuditSink | undefined;
  try {
    const { actionId, risk, changesState, targetsResource, requiresConfirmation, planner, submit } = target;
    executor = target.executor;
    audit = target.audit;
    const visibleOutput = (): unknown => {
      // Each access is a new output observation; freeze/scan its data once before handing it out.
      try {
        const captured = snapshotData(target.visibleOutput);
        scan(captured);
        return captured;
      } catch {
        failed = true;
        findings.add("scan-error:$");
        throw new Error("Unreadable planner output");
      }
    };
    const observedTarget: ScenarioTarget = Object.freeze({
      actionId, risk, changesState, targetsResource, requiresConfirmation, planner, executor, audit,
      get visibleOutput() { return visibleOutput(); },
      async submit(call: ProposalCall): Promise<PlannerFeedback> {
        let response: unknown;
        try { response = await Reflect.apply(submit, target, [call]); }
        catch { failed = true; throw new Error("Scenario submitter failed"); }
        // Capture once; scan the same snapshot even if the scenario drops it or throws later.
        let captured: PlannerFeedback;
        try { captured = snapshotData(response) as PlannerFeedback; }
        catch { findings.add("scan-error:$"); failed = true; throw new Error("Unreadable planner output"); }
        scan(captured);
        if (!isFeedback(captured)) { findings.add("runner-error:$"); failed = true; throw new TypeError("Invalid feedback"); }
        submitted.push(captured);
        return captured;
      },
    });
    try {
      const report: unknown = await scenario.run(observedTarget);
      if (!report || typeof report !== "object") throw new TypeError("Invalid observation");
      let reportedFeedback: unknown;
      try { reportedFeedback = snapshotData(Reflect.get(report, "feedback")); }
      catch { findings.add("scan-error:$"); throw new TypeError("Unreadable feedback"); }
      scan(reportedFeedback);
      if (!Array.isArray(reportedFeedback) || !reportedFeedback.every(isFeedback)) { findings.add("runner-error:$"); throw new TypeError("Invalid feedback"); }
      feedback = reportedFeedback;
      // Audit/count claims are ignored entirely; unrelated getters must not suppress feedback.
      const reportedFindings: unknown = snapshotData(Reflect.get(report, "leakFindings"));
      if (!Array.isArray(reportedFindings)) { findings.add("runner-error:$"); throw new TypeError("Invalid findings"); }
      // Scenario findings are untrusted text: retain their kind, never their supplied path/value.
      for (const finding of reportedFindings) {
        const kind = typeof finding === "string" ? /^(canary|stack-trace|secret-shaped|reason-code|confirmation-id|scan-error):/.exec(finding)?.[1] : undefined;
        findings.add(`${kind ?? "scenario-reported"}:$`);
      }
    } catch { failed = true; }
    try { scan(visibleOutput()); }
    catch { failed = true; findings.add("scan-error:$"); }
  } catch { failed = true; findings.add("runner-error:$"); }

  try {
    const actualCalls = executor?.calls;
    if (typeof actualCalls !== "number" || !Number.isSafeInteger(actualCalls) || actualCalls < 0) throw new TypeError();
    executorCalls = actualCalls;
  } catch { failed = true; findings.add("runner-error:$"); }
  try {
    if (!audit) throw new TypeError();
    auditEvents = snapshotData(audit.events);
  } catch { failed = true; findings.add("runner-error:$"); }

  // Compare data snapshots, not object identity: a scenario commonly copies returned feedback.
  try {
    const combined = [...submitted];
    const unmatched = [...submitted];
    for (const item of feedback) {
      const index = unmatched.findIndex((actual) => isDeepStrictEqual(actual, item));
      if (index >= 0) unmatched.splice(index, 1);
      else combined.push(item);
    }
    if (failed) combined.unshift(failureFeedback());
    return snapshotData({ feedback: combined, executorCalls, auditEvents, leakFindings: [...findings] });
  } catch {
    return snapshotData({ feedback: [failureFeedback()], executorCalls, auditEvents, leakFindings: [...findings, "runner-error:$"] });
  }
}
