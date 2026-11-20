const ROOT_TAG = "ai-tuslah-widget";
const ROOT_ATTRIBUTE = "data-ai-tuslah-widget";
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

function helpIcon(doc: Document): SVGSVGElement {
  const icon = doc.createElementNS(SVG_NAMESPACE, "svg");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("aria-hidden", "true");
  icon.setAttribute("focusable", "false");

  const path = doc.createElementNS(SVG_NAMESPACE, "path");
  path.setAttribute("d", "M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4.5 4v-4h0A2.5 2.5 0 0 1 4 13.5Z M9.75 7.75a2.25 2.25 0 1 1 3.1 2.08c-.5.21-.85.68-.85 1.22v.2 M12 13.6v.01");
  icon.append(path);
  return icon;
}

export function mountWidget(doc: Document, cssUrl: URL, cssIntegrity: string): void {
  if (doc.body === null || doc.querySelector(`${ROOT_TAG}[${ROOT_ATTRIBUTE}]`) !== null) return;

  const root = doc.createElement(ROOT_TAG);
  root.setAttribute(ROOT_ATTRIBUTE, "");
  const shadow = root.attachShadow({ mode: "open" });
  const stylesheet = doc.createElement("link");
  stylesheet.rel = "stylesheet";
  stylesheet.href = cssUrl.href;
  stylesheet.integrity = cssIntegrity;
  stylesheet.crossOrigin = "anonymous";

  const launcher = doc.createElement("button");
  launcher.type = "button";
  launcher.className = "launcher";
  launcher.setAttribute("aria-expanded", "false");
  launcher.setAttribute("aria-controls", "ai-tuslah-panel");
  launcher.append(helpIcon(doc), "AI Help");

  const panel = doc.createElement("section");
  panel.id = "ai-tuslah-panel";
  panel.className = "panel";
  panel.hidden = true;
  panel.setAttribute("aria-labelledby", "ai-tuslah-title");

  const title = doc.createElement("h2");
  title.id = "ai-tuslah-title";
  title.textContent = "ai-tuslah";
  const close = doc.createElement("button");
  close.type = "button";
  close.className = "close";
  close.textContent = "Close";
  panel.append(title, close);

  const setOpen = (open: boolean): void => {
    panel.hidden = !open;
    launcher.setAttribute("aria-expanded", String(open));
    (open ? close : launcher).focus({ preventScroll: true });
  };
  launcher.addEventListener("click", () => setOpen(panel.hasAttribute("hidden")));
  close.addEventListener("click", () => setOpen(false));
  shadow.addEventListener("keydown", (event) => {
    if (!(event instanceof KeyboardEvent) || event.key !== "Escape" || event.defaultPrevented || panel.hidden) return;
    event.preventDefault();
    event.stopPropagation();
    setOpen(false);
  });

  stylesheet.addEventListener("load", () => shadow.append(panel, launcher), { once: true });
  stylesheet.addEventListener("error", () => root.remove(), { once: true });
  shadow.append(stylesheet);
  doc.body.append(root);
}
