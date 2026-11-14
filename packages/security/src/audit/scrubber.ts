/**
 * @dap/security: audit/scrubber.ts
 *
 * T085 / FR-041. The last defence before anything is written to the audit trail: secret-shaped text is redacted and
 * the value is bounded in size and depth. Applied to EVERY recorded value, whatever produced it (a projected parameter,
 * an attempted action name, a resource id), so a secret that slipped past an allowlist still never reaches the log.
 *
 * Patterns: JWT-like tokens (three base64url segments whose header is JSON: `eyJ…`, or decoding to an object with `alg` or `typ`), `sk-` style API keys,
 * `AKIA` access key ids, and runs of 32 or more hex characters. Text that only matches once invisible characters are removed
 * (a zero-width space inside a key) is redacted whole: a disguised secret is still a secret.
 *
 * Never throws: anything it cannot read as plain JSON data (getters that throw, proxies, cycles, bigints, functions,
 * symbols, non-finite numbers) becomes the marker `[unserializable]`.
 */
import type { JsonValue } from "@dap/contracts";

export const REDACTED = "[redacted]";
export const TRUNCATED = "[truncated]";
export const UNSERIALIZABLE = "[unserializable]";

/** Bounds on what one recorded value may be. Small on purpose: an audit row is a summary, not a copy of the request. */
export const SCRUB_LIMITS = Object.freeze({ maxDepth: 6, maxString: 1024, maxEntries: 64, maxNodes: 1024 });

// A JWT header is JSON, so it starts `{"` and its base64url form starts `eyJ`: found wherever it begins, however it is glued to other text.
const RE_JWT_EYJ = /eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g;
// Any other header (leading whitespace, another key order) is recognised by decoding the first segment.
const RE_JWT_LIKE = /(?<![A-Za-z0-9_-])([A-Za-z0-9_-]{4,})\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}(?![A-Za-z0-9_-])/g;
const RE_SK_KEY = /sk-[A-Za-z0-9_-]{16,}/g;
const RE_AKIA_KEY = /AKIA[A-Z0-9]{16}/g;
const RE_HEX_RUN = /[0-9a-fA-F]{32,}/g;
// Zero-width and soft-hyphen characters, byte-order mark, and bidi/word-joiner controls: invisible, so a secret can hide in them.
const RE_INVISIBLE = /[\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/gu;

function isJwtHeader(segment: string): boolean {
  try {
    // Anything that is not an object (a number, null, a string) makes Reflect.get throw: not a JWT header.
    const header = JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as object;
    return typeof Reflect.get(header, "alg") === "string" || Reflect.get(header, "typ") === "JWT";
  } catch { return false; }
}

function redactJwt(text: string): string {
  return text.replace(RE_JWT_EYJ, REDACTED).replace(RE_JWT_LIKE, (match: string, header: string) => (isJwtHeader(header) ? REDACTED : match));
}
function redactSecrets(text: string): string {
  return redactJwt(text).replace(RE_SK_KEY, REDACTED).replace(RE_AKIA_KEY, REDACTED).replace(RE_HEX_RUN, REDACTED);
}

/** Redacts secret-shaped text and bounds the length. Text that is secret-shaped only once invisible characters are removed is redacted whole. */
export function scrubText(text: string): string {
  try {
    const bounded = text.length > SCRUB_LIMITS.maxString ? text.slice(0, SCRUB_LIMITS.maxString) : text;
    const visible = bounded.normalize("NFKC").replace(RE_INVISIBLE, "");
    // Disguise (invisible or look-alike characters) around anything secret-shaped: the whole value goes, not just the part that still matches.
    if (visible !== bounded && redactSecrets(visible) !== visible) return REDACTED;
    const clean = redactSecrets(bounded);
    return text.length > SCRUB_LIMITS.maxString ? `${clean}${TRUNCATED}` : clean;
  } catch { return UNSERIALIZABLE; }
}

/** A recorded value: plain, frozen JSON, redacted and bounded. Never throws. */
export function scrubJson(value: unknown): JsonValue {
  const budget = { nodes: 0 };
  const active = new Set<object>();
  const walk = (node: unknown, depth: number): JsonValue => {
    if (++budget.nodes > SCRUB_LIMITS.maxNodes) return TRUNCATED;
    if (node === null || typeof node === "boolean") return node;
    if (typeof node === "string") return scrubText(node);
    if (typeof node === "number") return Number.isFinite(node) ? node : UNSERIALIZABLE;
    if (typeof node !== "object") return UNSERIALIZABLE;
    if (depth >= SCRUB_LIMITS.maxDepth) return TRUNCATED;
    if (active.has(node)) return UNSERIALIZABLE;
    active.add(node);
    try {
      if (Array.isArray(node)) {
        const length: unknown = Reflect.get(node, "length");
        if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0) return UNSERIALIZABLE;
        const items: JsonValue[] = [];
        for (let index = 0; index < Math.min(length, SCRUB_LIMITS.maxEntries); index++) items.push(walk(Reflect.get(node, String(index)), depth + 1));
        if (length > SCRUB_LIMITS.maxEntries) items.push(TRUNCATED);
        return Object.freeze(items);
      }
      const keys = Object.keys(node);
      const out: { [key: string]: JsonValue } = Object.create(null) as { [key: string]: JsonValue };
      let kept = 0;
      for (const key of keys) {
        if (kept >= SCRUB_LIMITS.maxEntries) { out[TRUNCATED] = TRUNCATED; break; }
        const safeKey = scrubText(key);
        if (Object.hasOwn(out, safeKey)) continue;
        out[safeKey] = walk(Reflect.get(node, key), depth + 1);
        kept++;
      }
      return Object.freeze(out);
    } catch { return UNSERIALIZABLE; } finally { active.delete(node); }
  };
  return walk(value, 0);
}
