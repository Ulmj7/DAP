/**
 * @dap/testkit: fault-injection.ts (T032)
 *
 * `faulty(port, mode)` returns a PLAIN object (no Proxy) with the same method names as
 * `port`, where EVERY method misbehaves per mode. Used to prove fail-closed behavior when
 * a dependency throws, hangs, returns garbage, or lies about its type.
 *
 * Modes:
 *  - "throws":     every method synchronously throws `new Error("... " + FAULT_CANARY)`.
 *  - "hangs":      every method returns a promise that never resolves.
 *  - "undefined":  every method returns undefined.
 *  - "wrong-type": sync methods return the string "yes"; async-shaped methods return
 *                   Promise.resolve("yes").
 *
 * Async-shape rule (documented choice): a method is treated as async-shaped if its name is
 * in ASYNC_METHOD_NAMES — the method names of the contract ports — or if it ends in
 * "Async". This keeps the wrapper static: the original method is never invoked to probe
 * its return type.
 */

/** Canary string embedded in "throws" errors so tests can recognize injected failures. */
export const FAULT_CANARY = "TESTKIT_FAULT_CANARY";

export type FaultMode = "throws" | "hangs" | "undefined" | "wrong-type";

/** Method names of the contract ports that always return a promise. */
const ASYNC_METHOD_NAMES: ReadonlySet<string> = new Set([
  "authenticate",
  "has",
  "resolve",
  "currentPage",
  "deliver",
  "append",
  "ping",
  "claim",
  "hit",
  "isBlocked",
  "block",
  "create",
  "get",
  "listPending",
  "tryAccept",
  "tryReject",
  "invalidate",
  "recordExecution",
  "isDisabled",
]);

function isAsyncShape(name: string): boolean {
  return ASYNC_METHOD_NAMES.has(name) || name.endsWith("Async");
}

function neverResolving(): Promise<never> {
  return new Promise<never>(() => {});
}

/**
 * Wrap `port` so every method misbehaves per `mode`. Non-function properties are copied
 * through unchanged. Unknown modes throw RangeError.
 */
export function faulty(port: object, mode: FaultMode): object {
  if (mode !== "throws" && mode !== "hangs" && mode !== "undefined" && mode !== "wrong-type") {
    throw new RangeError(`faulty: unknown mode: ${String(mode)}`);
  }

  const wrapped: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(port)) {
    if (typeof value !== "function") {
      wrapped[name] = value;
      continue;
    }
    switch (mode) {
      case "throws":
        // Zero-parameter arrows: extra arguments from callers are ignored by JS.
        wrapped[name] = (): void => {
          throw new Error(`${FAULT_CANARY}: ${name}()`);
        };
        break;
      case "hangs":
        wrapped[name] = (): Promise<never> => neverResolving();
        break;
      case "undefined":
        wrapped[name] = (): undefined => undefined;
        break;
      case "wrong-type":
        wrapped[name] = isAsyncShape(name)
          ? (): Promise<string> => Promise.resolve("yes")
          : (): string => "yes";
        break;
    }
  }
  return wrapped;
}
