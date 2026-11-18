/**
 * The authoring routes (Feature 004, T406), registered on the EXISTING C01 Fastify instance (`createGuidanceTransport`) before `listen`:
 *
 *   GET  /api/walkthroughs/published        any valid session   the tenant's published definitions, each re-validated, at most 50 (never a draft)
 *   GET  /api/admin/walkthroughs            Maintainer          { authored: [...], builtIn: [...] }  (built-in guides are a SEPARATE read-only array, never persisted)
 *   GET  /api/admin/walkthroughs/:id        Maintainer          { id, status, definition }  (a built-in or unknown id is 404)
 *   POST /api/admin/walkthroughs            Maintainer          body EXACTLY { definition }: validate (422), generate the id, Gateway save, read back (201)
 *   PUT  /api/admin/walkthroughs/:id        Maintainer          body EXACTLY { definition }: drafts only (409 for a published guide)
 *   POST /api/admin/walkthroughs/:id/status Maintainer          body EXACTLY { status }: publish pre-validates against the current registry (422)
 *
 * It inherits everything the transport already enforces (loopback Host guard, Sec-Fetch-Site guard, JSON-only content type, 64 KiB limit, no-store/nosniff and the
 * fixed error handler) because it adds routes to that instance and nothing else: no second server. There is no analytics, event or audit route, and no DELETE.
 *
 * Authority. The PRINCIPAL is resolved by the host from its own session configuration (`resolvePrincipal`), never from the body or a header the browser could forge
 * for authority: `{ key, tenantId, actor, permissions, submit }`. Reads authorise on `permissions.has("perm.walkthrough.maintain")`. Writes pass the same check and
 * THEN go through the Gateway (`principal.submit`: permission, risk, rate/replay, durable audit, trusted executor), so a missing permission is refused twice. Tenant and
 * actor are never read from a request.
 *
 * Writes are fire-then-read: the Gateway answers only `{ outcome, category }`, so after `ALLOWED/ok` the route reads the stored record back. Every reply is a closed shape
 * with a fixed message: no stack, SQL, Zod text, permission id, Gateway stage, capability id or token ever leaves; `issues` (validator wording with positional labels) are
 * returned only on 422, capped at 20 of 200 characters with control characters removed.
 */
import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AiSession } from "../compose.js";
import { exactBody } from "../http/transport.js";
import { DEMO_WALKTHROUGH_SUMMARIES } from "../guidance/walkthrough-summaries.js";
import { MAINTAIN_PERMISSION, SAVE_ACTION_ID, STATUS_ACTION_ID } from "./capabilities.js";
import { generateWalkthroughId, isAuthoredId } from "./ids.js";
import { STATUSES } from "./schema.js";
import type { WalkthroughStatus } from "./schema.js";
import { MAX_PUBLISHED_PER_TENANT } from "./store.js";
import type { WalkthroughStore } from "./store.js";
import { TRUSTED_REGISTRY } from "./trusted-registry.js";
import type { TrustedRegistryData } from "./trusted-registry.js";
import { capIssues, validateAuthoredDefinition } from "./validate.js";

/** The host-resolved identity of one request. `submit` is the Gateway (a FRESH Gateway session per call, so each write is its own turn). */
export interface AuthoringPrincipal {
  readonly key: string;
  readonly tenantId: string;
  /** The safe actor id (what the audit trail will show). */
  readonly actor: string;
  readonly permissions: ReadonlySet<string>;
  submit: AiSession["submit"];
}
export type RequestHeaders = FastifyRequest["headers"];

export interface AuthoringRouteDeps {
  readonly store: WalkthroughStore;
  /** The host's session for this request, or `null` (no valid session). Never derived from the request body. */
  readonly resolvePrincipal: (headers: RequestHeaders) => Promise<AuthoringPrincipal | null>;
  /** The built-in guides listed (read-only) for the admin list. Defaults to the host's three summaries. */
  readonly builtIn?: readonly { readonly id: string; readonly title: string; readonly description: string }[];
  /** The registry data the validator uses (default: the trusted copy). */
  readonly registryData?: TrustedRegistryData;
  /** Id source (default: `wt-` + 12 hex from the OS random source). Injectable for tests. */
  readonly newId?: () => string;
}

export const AUTHORING_MESSAGES = Object.freeze({
  noSession: "Authoring is not available right now.",
  forbidden: "You do not have access to that.",
  notFound: "Not found.",
  malformed: "That request could not be read. Please try again.",
  invalid: "That walkthrough has problems. Please fix them and try again.",
  published: "A published walkthrough cannot be edited. Unpublish it first.",
  limit: "The limit of published walkthroughs has been reached. Unpublish one first.",
  refused: "That change was not allowed.",
  unavailable: "Authoring is temporarily unavailable. Please try again.",
});
/** Everything a reply can be: a closed set of shapes. */
type Fail = { kind: "unauthenticated" | "forbidden" | "not_found" | "malformed" | "conflict" | "unavailable"; message: string };

/** The Gateway's own payload limit is 16 KiB for the whole proposal (`maxPayloadBytes`); stay safely under it so the refusal is a clear 422, not an opaque denial. */
const MAX_PROPOSAL_BYTES = 15_000;
const failure = (kind: Fail["kind"], message: string): Fail => ({ kind, message });

export function registerAuthoringRoutes(app: FastifyInstance, deps: AuthoringRouteDeps): void {
  const { store, resolvePrincipal } = deps;
  const builtIn = Object.freeze((deps.builtIn ?? DEMO_WALKTHROUGH_SUMMARIES).map((summary) => Object.freeze({ id: summary.id, title: summary.title, description: summary.description })));
  const registryData = deps.registryData ?? TRUSTED_REGISTRY;
  const newId = deps.newId ?? (() => generateWalkthroughId());

  const send = (reply: FastifyReply, status: number, body: unknown) => reply.code(status).type("application/json; charset=utf-8").send(body);
  const principalOf = async (request: FastifyRequest): Promise<AuthoringPrincipal | null> => { try { return await resolvePrincipal(request.headers); } catch { return null; } };
  const isMaintainer = (principal: AuthoringPrincipal): boolean => principal.permissions.has(MAINTAIN_PERMISSION);
  /** Session, then (for admin routes) the maintainer permission. Returns the principal, or sends the refusal and returns `null`. */
  const gate = async (request: FastifyRequest, reply: FastifyReply, admin: boolean): Promise<AuthoringPrincipal | null> => {
    const principal = await principalOf(request);
    if (principal === null) { send(reply, 401, failure("unauthenticated", AUTHORING_MESSAGES.noSession)); return null; }
    if (admin && !isMaintainer(principal)) { send(reply, 403, failure("forbidden", AUTHORING_MESSAGES.forbidden)); return null; }
    return principal;
  };
  const unavailable = (reply: FastifyReply) => send(reply, 503, failure("unavailable", AUTHORING_MESSAGES.unavailable));
  const notFound = (reply: FastifyReply) => send(reply, 404, failure("not_found", AUTHORING_MESSAGES.notFound));
  const invalid = (reply: FastifyReply, issues: readonly string[]) => send(reply, 422, { kind: "invalid", message: AUTHORING_MESSAGES.invalid, issues: capIssues(issues) });
  const idParam = (request: FastifyRequest): string | null => {
    const id = (request.params as { id?: unknown } | undefined)?.id;
    return isAuthoredId(id) ? id : null; // a built-in id, the preview id and any junk are simply "not found"
  };
  const record = (row: { readonly id: string; readonly status: WalkthroughStatus; readonly definition: unknown }) => ({ id: row.id, status: row.status, definition: row.definition });

  /** `ok` (ALLOWED/ok), `failed` (ALLOWED/try_later: the executor refused or failed), `refused` (anything the Gateway did not allow), `broken` (no usable answer). */
  const submitWrite = async (principal: AuthoringPrincipal, action: string, params: unknown): Promise<"ok" | "failed" | "refused" | "broken"> => {
    let feedback: unknown;
    try { feedback = await principal.submit({ providerCallId: `authoring-${randomUUID()}`, arguments: JSON.stringify({ action, params }) }); } catch { return "broken"; }
    let outcome: unknown; let category: unknown;
    try { outcome = (feedback as { outcome?: unknown } | null)?.outcome; category = (feedback as { category?: unknown } | null)?.category; } catch { return "broken"; }
    if (outcome === "ALLOWED") return category === "ok" ? "ok" : category === "try_later" ? "failed" : "broken";
    return typeof outcome === "string" ? "refused" : "broken";
  };

  const isDefinition = (definition: unknown): definition is Record<string, unknown> =>
    definition !== null && typeof definition === "object" && !Array.isArray(definition);
  const tooLarge = (id: string, definition: unknown): boolean => Buffer.byteLength(JSON.stringify({ action: SAVE_ACTION_ID, params: { walkthroughId: id, definition } })) > MAX_PROPOSAL_BYTES;

  // --- reads --------------------------------------------------------------------------------------------------------------------------------------
  app.get("/api/walkthroughs/published", async (request, reply) => {
    const principal = await gate(request, reply, false);
    if (principal === null) return;
    try {
      const rows = await store.listPublished(principal.tenantId);
      // Every stored definition is re-validated against the CURRENT registry data; one that is no longer valid is left out (the others still load).
      const walkthroughs = rows.map((row) => validateAuthoredDefinition(row.id, row.definition, registryData)).flatMap((result) => (result.ok ? [result.definition] : [])).slice(0, MAX_PUBLISHED_PER_TENANT);
      return send(reply, 200, { walkthroughs });
    } catch { return unavailable(reply); }
  });

  app.get("/api/admin/walkthroughs", async (request, reply) => {
    const principal = await gate(request, reply, true);
    if (principal === null) return;
    try {
      const authored = (await store.list(principal.tenantId)).map((row) => ({ id: row.id, title: row.title, description: row.description, status: row.status, stepCount: row.stepCount, updatedAt: row.updatedAt }));
      return send(reply, 200, { authored, builtIn });
    } catch { return unavailable(reply); }
  });

  app.get("/api/admin/walkthroughs/:id", async (request, reply) => {
    const principal = await gate(request, reply, true);
    if (principal === null) return;
    const id = idParam(request);
    if (id === null) return notFound(reply);
    try {
      const row = await store.get(principal.tenantId, id);
      return row === null ? notFound(reply) : send(reply, 200, record(row));
    } catch { return unavailable(reply); }
  });

  // --- writes -------------------------------------------------------------------------------------------------------------------------------------
  app.post("/api/admin/walkthroughs", async (request, reply) => {
    const principal = await gate(request, reply, true);
    if (principal === null) return;
    const body = exactBody(request.body, ["definition"]);
    if (body === null) return send(reply, 400, failure("malformed", AUTHORING_MESSAGES.malformed));
    if (!isDefinition(body.definition)) return send(reply, 400, failure("malformed", AUTHORING_MESSAGES.malformed));
    if (Object.hasOwn(body.definition, "id")) return invalid(reply, ["definition.id: omit the id when creating a draft"]);
    const id = newId();
    const candidate = { ...body.definition, id };
    const checked = validateAuthoredDefinition(id, candidate, registryData);
    if (!checked.ok) return invalid(reply, checked.issues);
    if (tooLarge(id, candidate)) return invalid(reply, ["definition: too large to save"]);
    const result = await submitWrite(principal, SAVE_ACTION_ID, { walkthroughId: id, definition: candidate });
    if (result === "refused") return send(reply, 403, failure("forbidden", AUTHORING_MESSAGES.refused));
    if (result !== "ok") return unavailable(reply);
    try {
      const row = await store.get(principal.tenantId, id);
      return row === null ? unavailable(reply) : send(reply, 201, record(row));
    } catch { return unavailable(reply); }
  });

  app.put("/api/admin/walkthroughs/:id", async (request, reply) => {
    const principal = await gate(request, reply, true);
    if (principal === null) return;
    const id = idParam(request);
    if (id === null) return notFound(reply);
    const body = exactBody(request.body, ["definition"]);
    if (body === null) return send(reply, 400, failure("malformed", AUTHORING_MESSAGES.malformed));
    if (!isDefinition(body.definition)) return send(reply, 400, failure("malformed", AUTHORING_MESSAGES.malformed));
    if (Object.hasOwn(body.definition, "id") && body.definition.id !== id) return invalid(reply, ["definition.id: must match the requested draft"]);
    const candidate = { ...body.definition, id };
    let existing;
    try { existing = await store.get(principal.tenantId, id); } catch { return unavailable(reply); }
    if (existing === null) return notFound(reply);
    if (existing.status !== "draft") return send(reply, 409, failure("conflict", AUTHORING_MESSAGES.published));
    const checked = validateAuthoredDefinition(id, candidate, registryData);
    if (!checked.ok) return invalid(reply, checked.issues);
    if (tooLarge(id, candidate)) return invalid(reply, ["definition: too large to save"]);
    const result = await submitWrite(principal, SAVE_ACTION_ID, { walkthroughId: id, definition: candidate });
    if (result === "refused") return send(reply, 403, failure("forbidden", AUTHORING_MESSAGES.refused));
    try {
      if (result === "failed") { // the executor refused: most likely the guide was published in the meantime
        const now = await store.get(principal.tenantId, id);
        if (now !== null && now.status !== "draft") return send(reply, 409, failure("conflict", AUTHORING_MESSAGES.published));
      }
      if (result !== "ok") return unavailable(reply);
      const row = await store.get(principal.tenantId, id);
      return row === null ? unavailable(reply) : send(reply, 200, record(row));
    } catch { return unavailable(reply); }
  });

  app.post("/api/admin/walkthroughs/:id/status", async (request, reply) => {
    const principal = await gate(request, reply, true);
    if (principal === null) return;
    const id = idParam(request);
    if (id === null) return notFound(reply);
    const body = exactBody(request.body, ["status"]);
    const status = body?.status;
    if (body === null || typeof status !== "string" || !(STATUSES as readonly string[]).includes(status)) return send(reply, 400, failure("malformed", AUTHORING_MESSAGES.malformed));
    const wanted = status as WalkthroughStatus;
    let existing;
    try { existing = await store.get(principal.tenantId, id); } catch { return unavailable(reply); }
    if (existing === null) return notFound(reply);
    if (wanted === "published" && existing.status !== "published") {
      // Pre-validate the STORED definition against the CURRENT registry data: the clear 422 for a stale or invalid draft (the executor re-checks inside the transaction).
      const checked = validateAuthoredDefinition(id, existing.definition, registryData);
      if (!checked.ok) return invalid(reply, checked.issues);
      try {
        const published = await store.listPublished(principal.tenantId);
        if (published.length >= MAX_PUBLISHED_PER_TENANT) return send(reply, 409, failure("conflict", AUTHORING_MESSAGES.limit));
      } catch { return unavailable(reply); }
    }
    const result = await submitWrite(principal, STATUS_ACTION_ID, { walkthroughId: id, status: wanted });
    if (result === "refused") return send(reply, 403, failure("forbidden", AUTHORING_MESSAGES.refused));
    if (result !== "ok") return unavailable(reply);
    try {
      const row = await store.get(principal.tenantId, id);
      return row === null ? unavailable(reply) : send(reply, 200, record(row));
    } catch { return unavailable(reply); }
  });
}
