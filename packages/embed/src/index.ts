import { mountWidget } from "./widget.js";

declare const __WIDGET_CSS_INTEGRITY__: string;

const script = document.currentScript;
if (script instanceof HTMLScriptElement && script.src) {
  mountWidget(document, new URL("widget.css", script.src), __WIDGET_CSS_INTEGRITY__);
}
