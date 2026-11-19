import { MAX_DESCRIPTION as MAX_TEXT, MAX_LABEL as MAX_TITLE } from "@dap/walkthrough";
import type { WalkthroughDef } from "@dap/walkthrough";
import { readReply } from "../help/client.js";
import type { FetchLike } from "../help/client.js";

export type DemoRole = "user" | "maintainer";
export type GuideStatus = "draft" | "published";
export interface GuideSummary { id: string; title: string; description: string }
export interface AuthoredSummary extends GuideSummary { status: GuideStatus; stepCount: number; updatedAt: string }
export interface GuideList { authored: readonly AuthoredSummary[]; builtIn: readonly GuideSummary[] }
export interface GuideRecord { id: string; status: GuideStatus; definition: WalkthroughDef }
export type AdminResult<T> = { kind: "ok"; value: T } | { kind: "denied" | "failed" | "oversize" | "published" } | { kind: "invalid"; issues: readonly string[] };

export interface AdminClient {
  published(): Promise<AdminResult<readonly WalkthroughDef[]>>;
  list(): Promise<AdminResult<GuideList>>;
  get(id: string): Promise<AdminResult<GuideRecord>>;
  create(definition: WalkthroughDef): Promise<AdminResult<GuideRecord>>;
  update(id: string, definition: WalkthroughDef): Promise<AdminResult<GuideRecord>>;
  setStatus(id: string, status: GuideStatus): Promise<AdminResult<GuideRecord>>;
}

type Bag = Record<string, unknown>;
const object = (value: unknown): value is Bag => value !== null && typeof value === "object" && !Array.isArray(value);
const only = (value: Bag, keys: readonly string[]) => Object.keys(value).every(key => keys.includes(key));
const text = (value: unknown, max: number): value is string => typeof value === "string" && value.length > 0 && value.length <= max;
const status = (value: unknown): value is GuideStatus => value === "draft" || value === "published";
const authoredId = (value: unknown): value is string => typeof value === "string" && /^wt-[a-f0-9]{12}$/.test(value);
const summary = (value: Bag) => text(value.id, 64) && text(value.title, MAX_TITLE) && text(value.description, MAX_TEXT);
const builtIn = (value: unknown): value is GuideSummary => object(value) && summary(value) && only(value, ["id", "title", "description"]);
const authored = (value: unknown): value is AuthoredSummary => object(value) && summary(value) && authoredId(value.id)
  && only(value, ["id", "title", "description", "status", "stepCount", "updatedAt"]) && status(value.status)
  && typeof value.stepCount === "number" && Number.isInteger(value.stepCount) && value.stepCount >= 1 && value.stepCount <= 24
  && text(value.updatedAt, 32) && Number.isFinite(Date.parse(value.updatedAt));
const list = (value: unknown): GuideList | null => object(value) && only(value, ["authored", "builtIn"]) && Array.isArray(value.authored) && value.authored.every(authored)
  && Array.isArray(value.builtIn) && value.builtIn.every(builtIn) ? { authored: value.authored, builtIn: value.builtIn } : null;

// Guard the wire shape. Semantic validity is decided by the walkthrough catalog.
function step(value: unknown): boolean {
  if (!object(value) || !text(value.id, 64)) return false;
  if (value.kind === "complete") return only(value, ["id", "kind", "text"]) && text(value.text, MAX_TEXT);
  if (!text(value.next, 64) || (value.recover !== undefined && !text(value.recover, 64))
    || (value.maxAttempts !== undefined && !Number.isInteger(value.maxAttempts))) return false;
  const common = ["id", "kind", "text", "next", "recover", "maxAttempts"];
  if (value.kind === "navigate") return only(value, [...common, "route"]) && text(value.route, 64) && (value.text === undefined || text(value.text, MAX_TEXT));
  return value.kind === "guide" && only(value, [...common, "target", "wait", "verify", "targetWaitMs"])
    && text(value.target, 128) && text(value.text, MAX_TEXT) && (value.wait === "click" || value.wait === "input" || value.wait === "ack")
    && (value.verify === undefined || text(value.verify, 64)) && (value.targetWaitMs === undefined || Number.isInteger(value.targetWaitMs));
}
const definition = (value: unknown): value is WalkthroughDef => object(value) && only(value, ["id", "title", "description", "start", "steps"])
  && summary(value) && authoredId(value.id) && text(value.start, 64) && Array.isArray(value.steps) && value.steps.length > 0 && value.steps.length <= 24 && value.steps.every(step);
const record = (value: unknown, id?: string, wanted?: GuideStatus): GuideRecord | null => object(value) && only(value, ["id", "status", "definition"])
  && status(value.status) && (wanted === undefined || value.status === wanted) && definition(value.definition)
  && value.id === value.definition.id && (id === undefined || id === value.id)
  ? { id: value.definition.id, status: value.status, definition: value.definition } : null;
const published = (value: unknown): readonly WalkthroughDef[] | null => object(value) && only(value, ["walkthroughs"])
  && Array.isArray(value.walkthroughs) && value.walkthroughs.length <= 50 ? value.walkthroughs.filter(definition) : null;

const ADMIN = "/api/admin/walkthroughs";
const FAILED = { kind: "failed" } as const;
export function createAdminClient(options: { fetch?: FetchLike | undefined; role: DemoRole; timeoutMs?: number }): AdminClient {
  async function request<T>(url: string, guard: (value: unknown) => T | null, method = "GET", payload?: Bag): Promise<AdminResult<T>> {
    const fetcher = options.fetch;
    if (!fetcher) return FAILED;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<typeof FAILED>(resolve => { timer = setTimeout(() => { controller.abort(); resolve(FAILED); }, options.timeoutMs ?? 2500); });
    const exchange = (async (): Promise<AdminResult<T>> => {
      const response = await fetcher(url, {
        method, credentials: "same-origin", redirect: "error", cache: "no-store", signal: controller.signal,
        headers: { accept: "application/json", "X-Demo-Role": options.role, ...(payload === undefined ? {} : { "content-type": "application/json" }) },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      });
      if (method === "GET" && (response.status === 401 || response.status === 403)) return { kind: "denied" };
      if (method !== "GET" && response.status === 413) return { kind: "oversize" };
      if (method === "PUT" && response.status === 409) return { kind: "published" };
      if (!response.ok && (method === "GET" || response.status !== 422)) return FAILED;
      // 50 definitions can each approach the host's 15,000-byte proposal budget. The list shares this reply bound.
      const raw = await readReply(response, controller.signal, 1_000_000);
      if (raw === null) return FAILED;
      const body: unknown = JSON.parse(raw);
      if (!response.ok) {
        if (!object(body) || !only(body, ["kind", "message", "issues"]) || body.kind !== "invalid" || !text(body.message, 200)
          || !Array.isArray(body.issues) || body.issues.length > 20 || !body.issues.every(issue => text(issue, 200))) return FAILED;
        return body.issues.includes("definition: too large to save") ? { kind: "oversize" } : { kind: "invalid", issues: body.issues };
      }
      const value = guard(body);
      return value === null ? FAILED : { kind: "ok", value };
    })().catch(() => FAILED);
    try { return await Promise.race([exchange, expired]); } finally { clearTimeout(timer); }
  }
  return {
    published: () => request("/api/walkthroughs/published", published),
    list: () => request(ADMIN, list),
    get: id => authoredId(id) ? request(`${ADMIN}/${id}`, value => record(value, id)) : Promise.resolve(FAILED),
    create: ({ title, description, start, steps }) => request(ADMIN, value => record(value, undefined, "draft"), "POST", { definition: { title, description, start, steps } }),
    update: (id, def) => authoredId(id) && id === def.id
      ? request(`${ADMIN}/${id}`, value => record(value, id, "draft"), "PUT", { definition: def }) : Promise.resolve(FAILED),
    setStatus: (id, wanted) => authoredId(id)
      ? request(`${ADMIN}/${id}/status`, value => record(value, id, wanted), "POST", { status: wanted }) : Promise.resolve(FAILED),
  };
}
