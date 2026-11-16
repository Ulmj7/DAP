import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const app = createApp(config);
  let closing = false;
  const close = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    try { await app.close(); } catch { process.exitCode = 1; }
  };
  process.once("SIGINT", () => { void close(); });
  process.once("SIGTERM", () => { void close(); });
  try { await app.listen({ host: "0.0.0.0", port: config.port }); }
  catch {
    await close();
    throw new Error("Reference host could not listen; check PORT availability");
  }
}

main().catch(() => {
  // Never echo arbitrary startup exceptions (a library could include a connection URL).
  process.stderr.write("Reference host startup failed; check development auth, environment configuration and PORT\n");
  process.exitCode = 1;
});
