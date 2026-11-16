/** The reference web app: a hash-routed vanilla TypeScript shell. `mountApp` is used by the browser entry (`browser.ts`) and by tests. */
import { createOverlay, createTargets, createSemanticBridge } from "@dap/walkthrough/dom";
import type { Overlay, Targets } from "@dap/walkthrough/dom";
import { createWalkthroughCatalog, createWalkthroughRuntime } from "@dap/walkthrough";
import type { WalkthroughRuntime, SemanticRegistry } from "@dap/walkthrough";
import { copy } from "./copy.js";
import { createProfileController, createProfileService, initialProfile } from "./profile-state.js";
import type { ProfileService } from "./profile-state.js";
import { createPostconditions, POSTCONDITION_NAMES } from "./postconditions.js";
import { createRouterPort, createTargetPort } from "./ports.js";
import type { AppState } from "./app-state.js";
export type { AppState } from "./app-state.js";
import { h } from "./dom.js";
import { dashboardPage } from "./pages/dashboard.js";
import { profilePage } from "./pages/profile.js";
import { settingsPage } from "./pages/settings.js";
import { createRouter } from "./router.js";
import type { Router } from "./router.js";
import { createDemoRegistry } from "./semantic-ui.js";
import { createStore } from "./store.js";
import type { Store } from "./store.js";

export interface MountedApp {
  readonly runtime: WalkthroughRuntime;
  readonly profile: ReturnType<typeof createProfileController>;
  readonly registry: SemanticRegistry;
  readonly targets: Targets;
  readonly overlay: Overlay;
  readonly router: Router;
  readonly store: Store<AppState>;
  /** Highlights the registered element `id` with `text`. Returns false, and shows nothing, when the id cannot be targeted. */
  showGuidance(id: string, text: string): boolean;
  destroy(): void;
}

export const DEMO_INSTRUCTION = copy.profile.instruction;

export function mountApp(root: HTMLElement, options: { readonly window?: Window; readonly profileService?: ProfileService; readonly trustedEventsOnly?: boolean } = {}): MountedApp {
  const doc = root.ownerDocument;
  const win = options.window ?? doc.defaultView;
  if (win === null || win === undefined) throw new Error("mountApp needs a window");
  const registry = createDemoRegistry();
  const targets = createTargets(root, registry);
  const overlay = createOverlay(doc);
  const router = createRouter(win);
  const store = createStore<AppState>({ route: router.current(), profile: initialProfile(), advancedOpen: false });

  const showGuidance = (id: string, text: string): boolean => {
    const handle = targets.find(id);
    if (handle === null) { overlay.hide(); return false; }
    overlay.show(handle, text);
    return true;
  };

  const profile = createProfileController(store, options.profileService ?? createProfileService());
  const postconditions = createPostconditions(store, router);
  const runtime = createWalkthroughRuntime({ registry, catalog: createWalkthroughCatalog(registry, POSTCONDITION_NAMES, []), router: createRouterPort(router, registry), targets: createTargetPort(targets), postconditions: postconditions.checks,
    // U1 scaffold: the real C02 presenter is attached in U2.
    presenter: { apply: () => {} }, timers: { set: (callback, ms) => { const handle = win.setTimeout(callback, ms); return () => win.clearTimeout(handle); } },
  });
  const nav = h("nav", { class: "nav-group", "aria-label": copy.navigation });
  for (const route of ["dashboard", "profile", "settings"] as const) nav.append(h("a", { href: `#/${route}`, class: "nav-chip", ...(route === "dashboard" ? {} : { "data-ai-id": `nav.${route}` }) }, copy.nav[route]));
  // Reserved header slot for U2's Guides entry; intentionally renders nothing.
  const main = h("main", { class: "page-container" });
  root.replaceChildren(h("header", { class: "app-header" }, h("span", { class: "brand" }, copy.brand), nav), main);
  let renderedRoute: AppState["route"] | undefined;
  let updatePage: (state: AppState) => void = () => {};
  const render = (state: AppState): void => {
    for (const link of Array.from(nav.querySelectorAll("a"))) {
      if (link.getAttribute("href") === `#/${state.route}`) link.setAttribute("aria-current", "page"); else link.removeAttribute("aria-current");
    }
    if (state.route !== renderedRoute) {
      overlay.hide(); renderedRoute = state.route;
      if (state.route === "profile") {
        const page = profilePage({ edit: profile.edit, save: () => { void profile.save(); }, showMe: () => { showGuidance("profile.nameInput", DEMO_INSTRUCTION); }, showMissing: () => { showGuidance("profile.doesNotExist", copy.profile.never); } });
        main.replaceChildren(page.element); updatePage = s => page.update(s.profile);
      } else if (state.route === "settings") {
        const page = settingsPage(() => store.set({ advancedOpen: !store.get().advancedOpen })); main.replaceChildren(page.element); updatePage = s => page.update(s.advancedOpen);
      } else { main.replaceChildren(dashboardPage()); updatePage = () => {}; }
    }
    updatePage(state);
  };
  render(store.get());
  const unsubscribeStore = store.subscribe(render);
  const unsubscribeRouter = router.subscribe(route => { store.set({ route }); runtime.dispatch({ type: "routeChanged", route }); });
  const bridge = createSemanticBridge({ root, registry, targets, dispatch: event => runtime.dispatch(event), trustedEventsOnly: options.trustedEventsOnly ?? true });
  let destroyed = false;
  return Object.freeze({
    registry, targets, overlay, router, store, showGuidance, runtime, profile,
    destroy() { if (destroyed) return; destroyed = true; bridge.destroy(); unsubscribeRouter(); unsubscribeStore(); profile.destroy(); postconditions.destroy(); runtime.cancel(); overlay.hide(); root.replaceChildren(); },
  });
}
