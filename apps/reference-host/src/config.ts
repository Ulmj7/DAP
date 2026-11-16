import { z } from "zod";
import type { ActionId } from "@dap/contracts";

const identifier = z.string().min(1).max(256).regex(/^[^\p{C}\p{Z}](?:[^\p{C}\p{Z}]| )*(?<! )$/u);
const sessionSchema = z.strictObject({
  token: z.string().min(32).max(256).regex(/^[A-Za-z0-9_-]+$/),
  userId: identifier, sessionId: identifier,
  tenantId: z.uuid().refine((value) => value === value.toLowerCase() && value !== "00000000-0000-0000-0000-000000000000"),
  authenticatedAt: z.iso.datetime({ offset: true }), validUntil: z.iso.datetime({ offset: true }),
  permissions: z.array(z.enum(["guidance:read"])).max(1),
}).refine((value) => Date.parse(value.validUntil) > Date.parse(value.authenticatedAt));
export type DevSession = z.infer<typeof sessionSchema>;
export interface HostConfig {
  readonly port: number;
  readonly databaseUrl: string;
  readonly sessions: readonly DevSession[];
  readonly globalAllowlist: ReadonlySet<ActionId>;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): HostConfig {
  if (env.NODE_ENV === "production" || env.DAP_ALLOW_DEV_AUTH !== "1") {
    throw new Error("Reference host requires non-production mode and DAP_ALLOW_DEV_AUTH=1");
  }
  try {
    const databaseUrl = z.url().parse(env.DAP_DATABASE_URL);
    const url = new URL(databaseUrl);
    if (!["postgres:", "postgresql:"].includes(url.protocol) || decodeURIComponent(url.username) !== "dap_app") throw new Error();
    const sessions = z.array(sessionSchema).min(1).max(100).parse(JSON.parse(env.DEV_SESSIONS ?? "null"));
    const tokens = new Set<string>();
    const principals = new Set<string>();
    for (const session of sessions) {
      const key = JSON.stringify([session.tenantId, session.userId, session.sessionId]);
      if (tokens.has(session.token) || principals.has(key)) throw new Error();
      tokens.add(session.token); principals.add(key);
      Object.freeze(session.permissions); Object.freeze(session);
    }
    const allowed = z.array(z.literal("getGuidance")).max(1).parse(JSON.parse(env.DAP_GLOBAL_ALLOWLIST ?? "[]"));
    return Object.freeze({
      port: z.coerce.number().int().min(1).max(65535).parse(env.PORT ?? "3000"),
      databaseUrl, sessions: Object.freeze(sessions), globalAllowlist: new Set(allowed as ActionId[]),
    });
  } catch {
    // Validation issues can contain credentials; never echo them.
    throw new Error("Invalid host configuration: check PORT, DAP_DATABASE_URL, DEV_SESSIONS and DAP_GLOBAL_ALLOWLIST");
  }
}
