import { performance } from "node:perf_hooks";
import { z } from "zod";
import type { AuthenticatedPrincipal, PageId, ResolvedResource } from "@dap/contracts";
import { snapshotAnswer } from "./answer-snapshot.js";

export type HookResult<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; reason: "denied" | "dependency_failure" }>;
export interface HookTimer {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}
export interface HookOptions { readonly hookTimeoutMs?: number; readonly timer?: HookTimer }
interface HookAnswers {
  boolean: true;
  authentication: AuthenticatedPrincipal;
  resource: ResolvedResource;
  page: PageId;
  void: undefined;
  /** A policy store narrows access: true denies; only the literal false passes this hook. */
  tenantPolicy: false;
}
export type HookKind = keyof HookAnswers;

const text = z.string().min(1);
const schemas = {
  boolean: z.literal(true),
  authentication: z.strictObject({ userId: text, tenantId: z.uuid(), sessionId: text, authenticatedAt: z.iso.datetime({ offset: true }), validUntil: z.iso.datetime({ offset: true }) }),
  resource: z.strictObject({ ref: z.strictObject({ type: text, id: text }), tenantId: z.uuid(), displayName: text }),
  page: text,
  void: z.undefined(),
  tenantPolicy: z.literal(false),
};
const nativeTimer: HookTimer = {
  now: () => performance.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};
const failure = Object.freeze({ ok: false, reason: "dependency_failure" } as const);
const denied = Object.freeze({ ok: false, reason: "denied" } as const);

/** Protocol boundary for a bound host method; tenant equality and principal expiry are caller checks. */
export function wrapHook<K extends HookKind, A extends readonly unknown[]>(
  invoke: (...args: A) => unknown,
  kind: K,
  { hookTimeoutMs = 2000, timer = nativeTimer }: HookOptions = {},
): (...args: A) => Promise<HookResult<HookAnswers[K]>> {
  if (!Number.isSafeInteger(hookTimeoutMs) || hookTimeoutMs < 1 || hookTimeoutMs > 0x7fff_ffff) throw new RangeError("Invalid hook timeout");
  return (...args: A) => new Promise((resolve) => {
    let settled = false;
    let armed = false;
    let handle: unknown;
    const finish = (result: HookResult<HookAnswers[K]>): void => {
      if (settled) return;
      settled = true;
      try { if (armed) timer.clearTimeout(handle); } catch { result = failure; }
      resolve(result);
    };
    try {
      const start = timer.now();
      if (!Number.isFinite(start)) { finish(failure); return; }
      const withinDeadline = (): boolean => {
        const current = timer.now();
        return Number.isFinite(current) && current >= start && current - start < hookTimeoutMs;
      };
      handle = timer.setTimeout(() => finish(failure), hookTimeoutMs);
      armed = true;
      if (settled) { timer.clearTimeout(handle); return; }
      const raw = invoke(...args);
      // Promise<void> resolves to undefined; a bare undefined means the host omitted its operation.
      if (kind === "void" && raw === undefined) { finish(failure); return; }
      void Promise.resolve(raw).then((answer: unknown) => {
        if (settled) return;
        try {
          if (!withinDeadline()) { finish(failure); return; }
          const captured = snapshotAnswer(answer);
          if (!withinDeadline()) { finish(failure); return; }
          const negative = (kind === "boolean" && captured === false) || (kind === "tenantPolicy" && captured === true) ||
            (["authentication", "resource", "page"].includes(kind) && captured === null);
          if (negative) { finish(denied); return; }
          if (!Object.hasOwn(schemas, kind) || !schemas[kind].safeParse(captured).success) { finish(failure); return; }
          if (!withinDeadline()) { finish(failure); return; }
          finish(Object.freeze({ ok: true, value: captured as HookAnswers[K] }));
        } catch { finish(failure); }
      }, () => finish(failure));
    } catch { finish(failure); }
  });
}
