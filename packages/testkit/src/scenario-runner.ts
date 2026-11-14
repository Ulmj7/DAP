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
import { LeakScanner } from "./leak-scanner.js";

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

function findingsOf(value: unknown): readonly string[] {
  const scanner = new LeakScanner();
  return scanner.scan(value).map((f) => `${f.kind}:${f.path}`);
}

export async function runScenario(
  scenario: AttackScenario,
  target: ScenarioTarget,
): Promise<AttackObservation> {
  let observation: AttackObservation;
  try {
    observation = await scenario.run(target);
  } catch {
    // Fail-closed: record the failure; never let one scenario crash the runner.
    return {
      feedback: [failureFeedback()],
      executorCalls: target.executor.calls,
      auditEvents: [...target.audit.events],
      leakFindings: [],
    };
  }

  // Re-scan ALL planner-visible output independently of the scenario's own claims.
  const merged: string[] = [...observation.leakFindings];
  for (const finding of [
    ...findingsOf(observation.feedback),
    ...findingsOf(target.visibleOutput),
  ]) {
    if (!merged.includes(finding)) {
      merged.push(finding);
    }
  }

  return {
    ...observation,
    leakFindings: merged,
  };
}
