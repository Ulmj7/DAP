/**
 * The overlay: a highlight ring over a target plus a tooltip card. Every piece of text is set with `textContent` (never as markup).
 * `hide()` removes every node and listener it created. The controls only call back; there is no engine yet.
 */
import { ATTR_IGNORE } from "../privacy/privacy.js";
import type { TargetHandle } from "./targets.js";

export interface OverlayCallbacks {
  /** "Got it" was pressed (the overlay has already hidden itself). */
  readonly onAck?: () => void;
  /** "Cancel" was pressed (the overlay has already hidden itself). */
  readonly onCancel?: () => void;
}
export interface Overlay {
  show(target: TargetHandle, text: string, callbacks?: OverlayCallbacks): void;
  hide(): void;
  isShowing(): boolean;
}

const Z = "2147483000";

export function createOverlay(doc: Document): Overlay {
  let nodes: { readonly ring: HTMLElement; readonly card: HTMLElement } | null = null;
  let cleanup: (() => void) | null = null;

  const hide = (): void => {
    cleanup?.();
    cleanup = null;
    nodes?.ring.remove();
    nodes?.card.remove();
    nodes = null;
  };

  const show = (target: TargetHandle, text: string, callbacks: OverlayCallbacks = {}): void => {
    hide();
    const view = doc.defaultView;
    if (view === null || doc.body === null) return;
    target.reveal();

    const ring = doc.createElement("div");
    ring.setAttribute("data-ai-overlay", "ring");
    ring.setAttribute(ATTR_IGNORE, "");
    ring.setAttribute("aria-hidden", "true");
    Object.assign(ring.style, { position: "fixed", boxSizing: "border-box", border: "3px solid #f59e0b", borderRadius: "6px", boxShadow: "0 0 0 4px rgba(245,158,11,0.35)", pointerEvents: "none", zIndex: Z });

    const card = doc.createElement("div");
    card.setAttribute("data-ai-overlay", "tooltip");
    card.setAttribute(ATTR_IGNORE, "");
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-live", "polite");
    card.setAttribute("aria-label", "Guidance");
    Object.assign(card.style, { position: "fixed", maxWidth: "280px", padding: "12px", background: "#1f2937", color: "#fff", borderRadius: "8px", font: "14px/1.4 system-ui, sans-serif", boxShadow: "0 6px 20px rgba(0,0,0,0.3)", zIndex: Z });

    const message = doc.createElement("p");
    message.style.margin = "0 0 8px";
    message.textContent = text;
    const controls = doc.createElement("div");
    const makeButton = (label: string, kind: string, done: (() => void) | undefined): HTMLButtonElement => {
      const button = doc.createElement("button");
      button.type = "button";
      button.setAttribute("data-ai-overlay", kind);
      button.textContent = label;
      button.style.marginRight = "8px";
      button.addEventListener("click", () => { hide(); done?.(); });
      return button;
    };
    controls.append(makeButton("Got it", "ack", callbacks.onAck), makeButton("Cancel", "cancel", callbacks.onCancel));
    card.append(message, controls);
    doc.body.append(ring, card);
    nodes = { ring, card };

    const place = (): void => {
      const rect = target.rect();
      Object.assign(ring.style, { left: `${rect.left - 4}px`, top: `${rect.top - 4}px`, width: `${rect.width + 8}px`, height: `${rect.height + 8}px` });
      const left = Math.max(8, Math.min(rect.left, view.innerWidth - 296));
      Object.assign(card.style, { left: `${left}px`, top: `${rect.bottom + 12}px` });
    };
    place();
    view.addEventListener("scroll", place, true);
    view.addEventListener("resize", place);
    cleanup = () => { view.removeEventListener("scroll", place, true); view.removeEventListener("resize", place); };
  };

  return Object.freeze({ show, hide, isShowing: () => nodes !== null });
}
