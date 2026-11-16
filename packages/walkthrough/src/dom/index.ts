/** @dap/walkthrough/dom: the browser adapter, the only place that may touch `document` or `window`. */
export { createTargets } from "./targets.js";
export type { TargetHandle, Targets } from "./targets.js";
export { createOverlay } from "./overlay.js";
export type { Overlay, OverlayCallbacks } from "./overlay.js";
