/**
 * C01 dev server (`npm run dev:host`): the reference host composed with the guidance capability, behind the narrow browser transport, on 127.0.0.1 only.
 *
 * DEV-ONLY DEMO LIMITATION: the browser supplies no identity. The host opens its OWN demo session server-side from `DAP_DEMO_SESSION_TOKEN` (dev-auth
 * evidence, read from the environment, never from a request), so every browser that can reach 127.0.0.1 shares that one session. A real deployment needs
 * real authentication in front of this transport.
 *
 * Environment: everything `composeReferenceHost` needs (DAP_DATABASE_URL, DAP_ENABLED_ACTIONS including `startWalkthrough`, NODE_ENV, DAP_ALLOW_DEV_AUTH,
 * DEV_SESSIONS), DAP_DEMO_SESSION_TOKEN, optional DAP_HTTP_PORT (default 8787), DAP_GUIDANCE_MODEL (`fake` by default; `anthropic` needs
 * ANTHROPIC_API_KEY, which stays in this process). No value is ever printed.
 */
import { randomBytes } from "node:crypto";
import { composeReferenceHost } from "../compose.js";
import { createGuidanceHost } from "../guidance/compose-guidance.js";
import { GuidanceConfigError } from "../guidance/anthropic-model.js";
import { demoCatalogView } from "../guidance/walkthrough-summaries.js";
import { createApprovalRecorder, createGatewayStart } from "./approved-start.js";
import { createProposalStore } from "./proposal-store.js";
import { startupFailureMessage } from "./startup-message.js";
import type { StartupPhase } from "./startup-message.js";
import { HTTP_HOST, createGuidanceTransport, parseHttpPort } from "./transport.js";
import type { GuidanceSession } from "./transport.js";

const env = process.env;
let close: (() => Promise<void>) | undefined;
let phase: StartupPhase = "config";
try {
  const port = parseHttpPort(env.DAP_HTTP_PORT);
  if (port === null) throw new GuidanceConfigError("DAP_HTTP_PORT must be a port number from 1 to 65535");
  const token = env.DAP_DEMO_SESSION_TOKEN;
  if (!token) throw new GuidanceConfigError("DAP_DEMO_SESSION_TOKEN is required");
  const recorder = createApprovalRecorder();
  const guidance = createGuidanceHost({ env, starter: recorder.starter });
  phase = "compose";
  const { host } = await composeReferenceHost(env, { extensions: [guidance.extension] });
  close = () => host.close();
  phase = "session";
  if ((await host.openSession(token)) === null) throw new GuidanceConfigError("DAP_DEMO_SESSION_TOKEN session was refused");
  const demoSession: GuidanceSession = Object.freeze({ key: "dev-demo-session", start: createGatewayStart({ openSession: () => host.openSession(token), recorder }) });
  const app = createGuidanceTransport({
    ask: guidance.askGuidance,
    catalog: demoCatalogView,
    resolveSession: async () => demoSession,
    proposals: createProposalStore({ now: Date.now, newId: () => randomBytes(32).toString("base64url") }),
  });
  close = async () => { await app.close(); await host.close(); };
  phase = "listen";
  await app.listen({ host: HTTP_HOST, port });
  console.log(`DAP guidance host listening on http://${HTTP_HOST}:${port} (dev only)`);
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void close?.().finally(() => process.exit(0)); });
} catch (error) {
  console.error(startupFailureMessage(error, phase));
  await close?.().catch(() => {});
  process.exitCode = 1;
}
