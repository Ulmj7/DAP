import { z } from "zod";
import type { GatewayConfig, LimitConfig } from "@dap/contracts";

// Administrative ceilings bound work and retention without admitting an unlimited sentinel.
const integer = (maximum: number) => z.number().int().min(1).max(maximum);
const count = integer(1_000_000);
const seconds = integer(31_536_000);
const rule = z.strictObject({ limit: count, windowSeconds: seconds });
const limitsSchema = z.strictObject({
  proposalsPerTurn: count, executionsPerTurn: count, maxChainDepth: integer(64), turnBudgetMs: integer(300_000),
  perUserPerMinute: rule, perTenantPerMinute: rule, perUserPerCapabilityPerMinute: rule,
  highRiskPerUserPerHour: rule,
  denialThrottle: z.strictObject({ denials: count, windowSeconds: seconds, blockSeconds: seconds }),
});
const gatewaySchema = z.strictObject({
  limits: limitsSchema, maxPayloadBytes: integer(1_048_576), maxJsonDepth: integer(64),
  replayRetentionSeconds: seconds, confirmationDefaultTtlSeconds: integer(900), hookTimeoutMs: integer(60_000),
});
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Complete configuration required: missing fields never fall back or disable a limit. */
export function validateLimitConfig(input: unknown): LimitConfig {
  try { return freeze(limitsSchema.parse(input)); }
  catch { throw new TypeError("Invalid security limit configuration"); }
}
export function validateGatewayConfig(input: unknown): GatewayConfig {
  try { return freeze(gatewaySchema.parse(input)); }
  catch { throw new TypeError("Invalid security gateway configuration"); }
}

export const DEFAULT_GATEWAY_CONFIG: GatewayConfig = validateGatewayConfig({
  limits: {
    proposalsPerTurn: 25, executionsPerTurn: 8, maxChainDepth: 4, turnBudgetMs: 30_000,
    perUserPerMinute: { limit: 60, windowSeconds: 60 },
    perTenantPerMinute: { limit: 600, windowSeconds: 60 },
    perUserPerCapabilityPerMinute: { limit: 20, windowSeconds: 60 },
    highRiskPerUserPerHour: { limit: 10, windowSeconds: 3600 },
    denialThrottle: { denials: 5, windowSeconds: 60, blockSeconds: 300 },
  },
  replayRetentionSeconds: 86_400, confirmationDefaultTtlSeconds: 300,
  maxPayloadBytes: 16_384, maxJsonDepth: 8, hookTimeoutMs: 2000,
});
export const DEFAULT_LIMIT_CONFIG: LimitConfig = DEFAULT_GATEWAY_CONFIG.limits;
