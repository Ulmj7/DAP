/**
 * @dap/security: context/factory.ts
 *
 * T076 / FR-021, FR-022. `createSecurityContextFactory({ authentication, clock })` turns the host's answer about who
 * the caller is into the only thing the Gateway will accept as an identity: a context minted through
 * `@dap/contracts/mint`. Identity comes from nowhere else; the context holds NO permissions (they are checked live).
 *
 * Fail-closed: `establish` resolves to null, never throws, for an unauthenticated caller, a principal that is not
 * exactly `{ userId, tenantId, sessionId, authenticatedAt, validUntil }` of the right kinds (tenantId a lowercase
 * UUID per research D8, the instants timezone-qualified ISO 8601), a session that has expired or has not begun,
 * a host port that throws, hangs, rejects or answers the wrong shape, and a clock that cannot tell the time.
 */
import { z } from "zod";
import type { AuthenticationPort, Clock, SecurityContextFactory } from "@dap/contracts";
import { mintAuthorizationContext } from "@dap/contracts/mint";
import { wrapHook, type HookOptions } from "../gateway/hook-wrapper.js";

/** Printable text of a sane length: these strings end up in audit records and log lines. */
const identifier = z.string().min(1).max(256).regex(/^[^\p{Cc}\p{Zl}\p{Zp}]+$/u);
const principalSchema = z.strictObject({
  userId: identifier,
  // Canonical lowercase, so one tenant has one spelling (tenant equality is a string comparison); the nil UUID is a "no tenant" sentinel, not a tenant.
  tenantId: z.uuid().refine((value) => value === value.toLowerCase() && value !== "00000000-0000-0000-0000-000000000000"),
  sessionId: identifier,
  authenticatedAt: z.iso.datetime({ offset: true }),
  validUntil: z.iso.datetime({ offset: true }),
});

export function createSecurityContextFactory<TEvidence = unknown>(
  { authentication, clock }: { readonly authentication: AuthenticationPort<TEvidence>; readonly clock: Clock },
  options: HookOptions = {},
): SecurityContextFactory<TEvidence> {
  // The ports are read once, here: a host that swaps its methods later cannot change what establish() calls.
  const authenticate: unknown = authentication?.authenticate;
  const readClock: unknown = clock?.now;
  if (typeof authenticate !== "function" || typeof readClock !== "function") throw new TypeError("Missing security context dependency");
  const who = wrapHook((evidence: TEvidence) => Reflect.apply(authenticate, authentication, [evidence]), "authentication", options);
  const now = wrapHook(() => Reflect.apply(readClock, clock, []), "instant", options);
  return Object.freeze({
    establish: Object.freeze(async (evidence: TEvidence) => {
      try {
        const answer = await who(evidence);
        if (!answer.ok) return null;
        const principal = principalSchema.safeParse(answer.value);
        if (!principal.success) return null;
        const reading = await now();
        if (!reading.ok) return null;
        const present = Date.parse(reading.value);
        const began = Date.parse(principal.data.authenticatedAt);
        const until = Date.parse(principal.data.validUntil);
        if (!Number.isFinite(present) || !Number.isFinite(began) || !Number.isFinite(until)) return null;
        // Not begun yet, already over, or ending before it began: none of these is a usable session.
        if (began > present || until <= present || until <= began) return null;
        return mintAuthorizationContext(principal.data);
      } catch { return null; }
    }),
  });
}
