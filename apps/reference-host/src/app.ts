import Fastify, { LogController } from "fastify";
import type { FastifyError } from "fastify";
import { z } from "zod";
import { GUIDANCE_TOPICS } from "@dap/actions";
import type { HostConfig } from "./config.js";
import { composeHost } from "./compose.js";

const requestSchema = z.strictObject({ topicId: z.enum(GUIDANCE_TOPICS) });

export function createApp(config: HostConfig) {
  const host = composeHost(config);
  const app = Fastify({
    bodyLimit: 1024, requestTimeout: 15_000,
    logger: { level: "info", redact: ["req.headers.authorization", "req.headers.cookie"] },
    // Log bounded metadata only, not URL/query text, bodies, tokens or driver errors.
    logController: new LogController({ disableRequestLogging: true }),
  });
  app.addHook("onResponse", async (request, reply) => {
    request.log.info({ statusCode: reply.statusCode, requestId: request.id }, "request completed");
  });
  app.addHook("onClose", async () => { await host.close(); });
  app.setErrorHandler<FastifyError>((error, request, reply) => {
    const status = error.statusCode !== undefined && error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : 500;
    request.log.warn({ statusCode: status }, "request failed");
    void reply.code(status).send({ error: status < 500 ? "invalid_request" : "internal_error" });
  });
  app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: "not_found" }));
  app.get("/healthz", async () => ({ status: "ok" }));
  app.get("/readyz", async (_request, reply) => {
    const ready = await host.ready();
    return reply.code(ready ? 200 : 503).send({ status: ready ? "ready" : "unavailable" });
  });
  app.post("/guidance", {
    onRequest: async (request, reply) => {
      if (!await host.authenticate(request.headers.authorization)) {
        return reply.code(401).send({ error: "unauthenticated" });
      }
    },
  }, async (request, reply) => {
    const parsed = requestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
    const result = await host.guidance(request.headers.authorization, parsed.data.topicId);
    return reply.code(result.status).send(result.body);
  });
  return app;
}
