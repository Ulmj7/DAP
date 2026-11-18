/**
 * C01: how the browser learns which walkthrough the Gateway APPROVED.
 *
 * The `startWalkthrough` capability's trusted executor calls a host `WalkthroughStarter` once it has passed the full Gateway pipeline. On this host the
 * starter cannot drive a browser, so it only RECORDS the id it was called with. `/api/guidance/start` submits the proposal through the existing bridge
 * (`submitWalkthroughStart`, i.e. `AiSession.submit` -> Gateway -> executor), then takes the recorded id: only an id the executor actually received AND a
 * Gateway result of `ok` yield an approved id, which the browser then passes to `GuideApi.startWalkthrough` itself. Anything else fails closed.
 */
import type { AiSession } from "../compose.js";
import type { WalkthroughStarter } from "../guidance/capability.js";
import { submitWalkthroughStart } from "../guidance/start-bridge.js";

/** The bridge's own result type (a Feature 003 GuidanceResult), so this module imports nothing from the AI package itself. */
type BridgeResult = Awaited<ReturnType<typeof submitWalkthroughStart>>;

/** `unavailable`: the start timed out or the start queue was full (the transport replies 503 unavailable); otherwise a refusal. */
export type StartOutcome = { readonly ok: true; readonly walkthroughId: string } | { readonly ok: false; readonly unavailable?: true };
/** The executor-side recorder. Bounded: past `maxPending` unclaimed records the starter refuses (the executor reports `start_refused`). */
export interface ApprovalRecorder {
  readonly starter: WalkthroughStarter;
  /** Claims one record of `walkthroughId`; returns the id the executor received, or `null`. */
  take(walkthroughId: string): string | null;
}

export function createApprovalRecorder(maxPending = 64): ApprovalRecorder {
  const pending: string[] = [];
  return Object.freeze({
    starter: Object.freeze({
      start(id: string) {
        if (pending.length >= maxPending) return { ok: false as const, reason: "busy" };
        pending.push(id);
        return { ok: true as const };
      },
    }),
    take(walkthroughId: string): string | null {
      const index = pending.indexOf(walkthroughId);
      if (index < 0) return null;
      const [approved] = pending.splice(index, 1);
      return approved ?? null;
    },
  });
}

/** Timers for the per-start timeout, injectable so tests decide when it elapses. */
export interface StartTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}
const hostStartTimers: StartTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => { if (handle !== null && typeof handle === "object") clearTimeout(handle as ReturnType<typeof setTimeout>); },
};
/** A start that has not finished in this time is abandoned: it fails closed and releases its slot. */
export const START_TIMEOUT_MS = 10_000;
/** Starts waiting or running at once; past this a start fails closed immediately. */
export const MAX_START_QUEUE = 8;
const UNAVAILABLE: StartOutcome = Object.freeze({ ok: false, unavailable: true });

export interface GatewayStartDeps {
  /** Opens the host's own (server-side) session; `null` when it is refused. */
  readonly openSession: () => Promise<AiSession | null>;
  readonly recorder: ApprovalRecorder;
  readonly submit?: (session: AiSession, walkthroughId: string) => Promise<BridgeResult>;
  readonly timers?: StartTimers;
  readonly timeoutMs?: number;
  readonly maxQueue?: number;
}

/**
 * Sends one proposed walkthrough id through the Gateway and returns the id the executor approved. Never throws.
 *
 * One submission at a time: the recorder matches by walkthrough id, so two overlapping starts of the same id could otherwise claim each other's record.
 * A submission that stalls past `timeoutMs` is abandoned (unavailable, its record cleared) and releases the slot; whatever it returns later is discarded,
 * and its own final `take` clears any record its executor makes late. At most `maxQueue` starts wait or run; further starts are unavailable at once.
 */
export function createGatewayStart({ openSession, recorder, submit = submitWalkthroughStart, timers = hostStartTimers, timeoutMs = START_TIMEOUT_MS, maxQueue = MAX_START_QUEUE }: GatewayStartDeps): (walkthroughId: string) => Promise<StartOutcome> {
  const startOnce = async (walkthroughId: string): Promise<StartOutcome> => {
    let result: BridgeResult;
    try {
      const session = await openSession();
      if (session === null) return { ok: false };
      result = await submit(session, walkthroughId);
    } catch {
      recorder.take(walkthroughId);
      return { ok: false };
    }
    const approved = recorder.take(walkthroughId); // claimed whatever the Gateway said, so a record never outlives its own submission
    return result.kind === "walkthrough" && approved !== null ? { ok: true, walkthroughId: approved } : { ok: false };
  };
  let tail: Promise<void> = Promise.resolve();
  let pending = 0;
  return (walkthroughId) => {
    if (pending >= maxQueue) return Promise.resolve(UNAVAILABLE);
    pending += 1;
    let releaseSlot: () => void = () => undefined;
    const previous = tail;
    tail = new Promise<void>((resolve) => { releaseSlot = resolve; });
    return previous.then(() => new Promise<StartOutcome>((resolve) => {
      let settled = false;
      const settle = (outcome: StartOutcome) => {
        if (settled) return;
        settled = true;
        pending -= 1;
        releaseSlot();
        resolve(outcome);
      };
      const handle = timers.setTimeout(() => { recorder.take(walkthroughId); settle(UNAVAILABLE); }, timeoutMs);
      startOnce(walkthroughId)
        .catch((): StartOutcome => ({ ok: false }))
        .then((outcome) => { timers.clearTimeout(handle); settle(outcome); });
    }));
  };
}
