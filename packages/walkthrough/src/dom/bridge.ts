/** Delegated DOM-to-semantic boundary. Values and DOM objects never leave this adapter. */
import { parseSemanticEvent } from "../engine/events.js";
import type { SemanticEvent } from "../engine/events.js";
import type { SemanticRegistry } from "../semantic/types.js";
import type { Targets } from "./targets.js";
export function createSemanticBridge({ root, registry, targets, dispatch, trustedEventsOnly = true }: {
 root: HTMLElement; registry: SemanticRegistry; targets: Targets; dispatch: (event: SemanticEvent) => void; trustedEventsOnly?: boolean;
}): { destroy(): void } {
 let destroyed = false;
 const listener = (event: Event) => {
  try {
   if (destroyed || (trustedEventsOnly && event.isTrusted !== true)) return;
   const node = event.target as Node | null;
   const element = (node?.nodeType === 1 ? node as Element : node?.parentElement)?.closest("[data-ai-id]");
   if (!element || !root.contains(element)) return;
   const def = registry.get(element.getAttribute("data-ai-id"));
   // A private field may be highlighted by Targets; it must never generate an input/click event.
   if (!def || def.privacy !== "public" || element.closest("[data-ai-private],[data-ai-redact],[data-ai-ignore]") || targets.find(def.id)?.element !== element) return;
   let raw: unknown;
   if (event.type === "click") { if (!def.operations.includes("click")) return; raw = { type: "click", id: def.id }; }
   else {
    if (!def.operations.includes("input")) return;
    const tag = element.tagName;
    if (tag !== "TEXTAREA" && tag !== "SELECT" && !(tag === "INPUT" && ["text", "email", "search", "tel", "url"].includes((element as HTMLInputElement).type))) return;
    raw = { type: "input", id: def.id, nonEmpty: (element as HTMLInputElement).value.trim().length > 0 };
   }
   const parsed = parseSemanticEvent(raw, registry); if (parsed) dispatch(parsed);
  } catch { /* Neither a host subscriber nor hostile DOM may break ordinary UI interaction. */ }
 };
 const types = ["click", "input", "change"] as const;
 for (const type of types) root.addEventListener(type, listener, true);
 return { destroy() { if (destroyed) return; destroyed = true; for (const type of types) root.removeEventListener(type, listener, true); } };
}
