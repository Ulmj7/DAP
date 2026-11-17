/** The reference web app: a hash-routed vanilla TypeScript shell. `mountApp` is used by the browser entry (`browser.ts`) and by tests. */
import { createOverlay, createTargets } from "@dap/walkthrough/dom";
import type { Overlay, Targets } from "@dap/walkthrough/dom";
import type { SemanticRegistry } from "@dap/walkthrough";
import { h } from "./dom.js";
import { dashboardPage } from "./pages/dashboard.js";
import { profilePage } from "./pages/profile.js";
import { settingsPage } from "./pages/settings.js";
import { createRouter } from "./router.js";
import type { Route, Router } from "./router.js";
import { createDemoRegistry } from "./semantic-ui.js";
import { createStore } from "./store.js";
import type { Store } from "./store.js";

export interface AppState { readonly route: Route }
export interface MountedApp {
  readonly registry: SemanticRegistry;
  readonly targets: Targets;
  readonly overlay: Overlay;
  readonly router: Router;
  readonly store: Store<AppState>;
  /** Highlights the registered element `id` with `text`. Returns false, and shows nothing, when the id cannot be targeted. */
  showGuidance(id: string, text: string): boolean;
  destroy(): void;
}

export const DEMO_INSTRUCTION = "Type your name here.";

export function mountApp(root: HTMLElement, options: { readonly window?: Window } = {}): MountedApp {
  const doc = root.ownerDocument;
  const win = options.window ?? doc.defaultView;
  if (win === null || win === undefined) throw new Error("mountApp needs a window");
  const registry = createDemoRegistry();
  const targets = createTargets(root, registry);
  const overlay = createOverlay(doc);
  const router = createRouter(win);
  const store = createStore<AppState>({ route: router.current() });

  const showGuidance = (id: string, text: string): boolean => {
    const handle = targets.find(id);
    if (handle === null) { overlay.hide(); return false; }
    overlay.show(handle, text);
    return true;
  };

  const nav = h("header", {},
    h("a", { href: "#/dashboard" }, "Dashboard"),
    h("a", { href: "#/profile", "data-ai-id": "nav.profile" }, "Profile"),
    h("a", { href: "#/settings", "data-ai-id": "nav.settings" }, "Settings"),
  );
  const main = h("main");
  root.replaceChildren(nav, main);

  const render = (route: Route): void => {
    overlay.hide();
    const page = route === "profile"
      ? profilePage({ showMe: () => { showGuidance("profile.nameInput", DEMO_INSTRUCTION); }, showMissing: () => { showGuidance("profile.doesNotExist", "This must never appear."); } })
      : route === "settings" ? settingsPage() : dashboardPage();
    main.replaceChildren(page);
  };
  render(store.get().route);
  const unsubscribeStore = store.subscribe((state) => render(state.route));
  const unsubscribeRouter = router.subscribe((route) => store.set({ route }));

  return Object.freeze({
    registry, targets, overlay, router, store, showGuidance,
    destroy() { unsubscribeRouter(); unsubscribeStore(); overlay.hide(); root.replaceChildren(); },
  });
}
