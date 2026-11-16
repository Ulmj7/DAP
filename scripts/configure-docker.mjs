import { readFileSync, writeFileSync } from "node:fs";
import { parseEnv } from "node:util";

try {
  const local = parseEnv(readFileSync(new URL("../.env.local", import.meta.url), "utf8"));
  const sessions = JSON.parse(local.DEV_SESSIONS ?? "[]");
  if (!Array.isArray(sessions) || sessions.length === 0 || !sessions.some((session) => Date.parse(session.validUntil) > Date.now())) {
    throw new Error();
  }
  const app = new URL(process.env.DAP_DOCKER_DATABASE_URL ?? local.DAP_DATABASE_URL ?? "");
  const postgresPort = process.env.DAP_POSTGRES_PORT ?? local.DAP_POSTGRES_PORT ?? (app.port || "54329");
  app.hostname = "postgres";
  app.port = "5432";
  if (!["postgres:", "postgresql:"].includes(app.protocol) || decodeURIComponent(app.username) !== "dap_app") throw new Error();
  if (process.env.DAP_APP_PASSWORD !== undefined) app.password = process.env.DAP_APP_PASSWORD;
  const owner = new URL(process.env.DAP_DOCKER_MIGRATE_DATABASE_URL ?? app.toString());
  owner.hostname = "postgres";
  owner.port = "5432";
  owner.username = "dap_owner";
  if (process.env.DAP_DOCKER_MIGRATE_DATABASE_URL === undefined) {
    owner.password = process.env.DAP_OWNER_PASSWORD ?? "dap_owner_local_only";
  }
  const values = {
    DAP_HOST_PORT: process.env.DAP_HOST_PORT ?? "3000",
    DAP_POSTGRES_PORT: postgresPort,
    DAP_DOCKER_DATABASE_URL: app.toString(),
    DAP_DOCKER_MIGRATE_DATABASE_URL: owner.toString(),
    DAP_APP_PASSWORD: decodeURIComponent(app.password),
    DAP_OWNER_PASSWORD: decodeURIComponent(owner.password),
    DAP_GLOBAL_ALLOWLIST: local.DAP_GLOBAL_ALLOWLIST ?? "[]",
    DEV_SESSIONS: JSON.stringify(sessions),
  };
  // Compose single-quoted values are literal ($ does not interpolate); escape apostrophes.
  const text = Object.entries(values).map(([key, value]) => `${key}='${value.replaceAll("'", "\\'")}'`).join("\n");
  writeFileSync(new URL("../.env.docker.local", import.meta.url), `${text}\n`, { mode: 0o600, flag: "wx" });
  console.log("Created protected .env.docker.local; existing .env.local was preserved. Credentials hidden.");
} catch (error) {
  if (error?.code === "EEXIST") {
    console.error(".env.docker.local already exists; preserved it. Review it locally before updating.");
  } else {
    console.error("Docker configuration failed. Check .env.local, session expiry and optional Docker DB settings. See docs/lab08.md.");
  }
  process.exitCode = 1;
}
