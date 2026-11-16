/** The reference web app: a hash-routed vanilla TypeScript shell. `mountApp` is used by the browser entry (`browser.ts`) and by tests. */
import { createOverlay, createTargets, createSemanticBridge, createAvailabilityFeed } from "@dap/walkthrough/dom";
import type { Overlay, Targets } from "@dap/walkthrough/dom";
import { createWalkthroughCatalog, createWalkthroughRuntime } from "@dap/walkthrough";
import type { WalkthroughDef, WalkthroughRuntime, SemanticRegistry } from "@dap/walkthrough";
import { WALKTHROUGHS } from "./walkthroughs/index.js";
import { createPresenter } from "./presenter.js";
import { createStatusDialog, resultKind } from "./status-dialog.js";
import { createLauncher, guideApi } from "./launcher.js";
import type { GuideApi } from "./launcher.js";
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
  readonly guides: GuideApi;
  readonly runtime: WalkthroughRuntime;
  readonly profile: ReturnType<typeof createProfileController>;
  readonly registry: SemanticRegistry;
  readonly targets: Targets;
  readonly overlay: Overlay;
  readonly router: Router;
  readonly store: Store<AppState>;
  destroy(): void;
}


export function mountApp(root: HTMLElement, options: { readonly window?: Window; readonly profileService?: ProfileService; readonly trustedEventsOnly?: boolean; readonly walkthroughs?: readonly WalkthroughDef[] } = {}): MountedApp {
  const doc = root.ownerDocument;
  const win = options.window ?? doc.defaultView;
  if (win === null || win === undefined) throw new Error("mountApp needs a window");
  const registry = createDemoRegistry();
  const targets = createTargets(root, registry);
  const overlay = createOverlay(doc);
  const router = createRouter(win);
  const store = createStore<AppState>({ route: router.current(), profile: initialProfile(), advancedOpen: false });

  const profile = createProfileController(store, options.profileService ?? createProfileService());
  const postconditions = createPostconditions(store, router);
  const catalog = createWalkthroughCatalog(registry, POSTCONDITION_NAMES, options.walkthroughs ?? WALKTHROUGHS);
  let returnTo: HTMLElement | null = null;
  const dialog = createStatusDialog(doc, () => root.querySelector<HTMLElement>("h1") ?? root.querySelector<HTMLElement>("main"));
  const presenter = createPresenter({overlay,targets,registry,catalog,state:()=>runtime.getState(),cancel:()=>runtime.cancel(),ack:()=>runtime.dispatch({type:"ack"}),complete:text=>dialog.updateText(text)});
  const runtime = createWalkthroughRuntime({ registry, catalog, router: createRouterPort(router, registry), targets: createTargetPort(targets), postconditions: postconditions.checks,
    presenter, timers: { set: (callback, ms) => { const handle = win.setTimeout(callback, ms); return () => win.clearTimeout(handle); } },
  });
  const guides = guideApi(runtime);
  let launcher: ReturnType<typeof createLauncher> | undefined;
  const start = (id:string, source:HTMLElement) => {returnTo=source;dialog.close(false);const result=runtime.startWalkthrough(id);if(!result.ok)launcher?.refused();};
  const nav = h("nav", { class: "nav-group", "aria-label": copy.navigation });
  for (const route of ["dashboard", "profile", "settings"] as const) nav.append(h("a", { href: `#/${route}`, class: "nav-chip", ...(route === "dashboard" ? {} : { "data-ai-id": `nav.${route}` }) }, copy.nav[route]));
  const guidesLink = h("a", {href:"#/dashboard",class:"button"},copy.guide.link);
  const main = h("main", { class: "page-container", tabindex: "-1" });
  root.replaceChildren(h("header", { class: "app-header" }, h("span", { class: "brand" }, copy.brand), nav, guidesLink), main);
  let renderedRoute: AppState["route"] | undefined;
  let updatePage: (state: AppState) => void = () => {};
  const render = (state: AppState): void => {
    doc.title = copy.titles[state.route];
    for (const link of Array.from(nav.querySelectorAll("a"))) {
      if (link.getAttribute("href") === `#/${state.route}`) link.setAttribute("aria-current", "page"); else link.removeAttribute("aria-current");
    }
    if (state.route !== renderedRoute) {
      overlay.hide(); renderedRoute = state.route;
      if (state.route === "profile") {
        const page = profilePage({ edit: profile.edit, save: () => { void profile.save(); } });
        main.replaceChildren(page.element); updatePage = s => page.update(s.profile);
      } else if (state.route === "settings") {
        const page = settingsPage(() => store.set({ advancedOpen: !store.get().advancedOpen })); main.replaceChildren(page.element); updatePage = s => page.update(s.advancedOpen);
      } else { launcher=createLauncher(guides,start);launcher.update();main.replaceChildren(dashboardPage(launcher.element)); updatePage = () => {launcher?.update();}; }
    }
    root.querySelector("h1")?.setAttribute("tabindex","-1");
    updatePage(state);
  };
  render(store.get());
  const unsubscribeStore = store.subscribe(render);
  const availability=createAvailabilityFeed({registry,targets,dispatch:event=>runtime.dispatch(event)});
  const unsubscribeRouter = router.subscribe(route => { store.set({ route }); availability.refresh();runtime.dispatch({ type: "routeChanged", route }); });
  const stopPlacement=targets.observe(()=>overlay.reposition());
  let terminal="";let escBound=false;
  const escape=(event:KeyboardEvent)=>{if(event.key==="Escape"&&!dialog.isOpen()){event.preventDefault();runtime.cancel();}};
  const unsubscribeRuntime=runtime.subscribe(snapshot=>{
    presenter.update(snapshot);launcher?.update();
    const active=["RESOLVING","PRESENTING","WAITING","VERIFYING"].includes(snapshot.status);
    if(active&&!escBound){doc.addEventListener("keydown",escape);escBound=true;}else if(!active&&escBound){doc.removeEventListener("keydown",escape);escBound=false;}
    const kind=resultKind(snapshot);const key=kind===null?"":`${snapshot.walkthroughId}|${snapshot.status}|${snapshot.failure}`;
    if(kind&&key!==terminal){const def=snapshot.walkthroughId===null?undefined:catalog.get(snapshot.walkthroughId);const step=def?.steps.find(s=>s.id===snapshot.stepId);const id=snapshot.walkthroughId;
      dialog.show(kind,step?.kind==="complete"?step.text:"",{returnTo,retry:()=>{if(id!==null)runtime.startWalkthrough(id);}});
    }
    terminal=key;
  });
  const bridge = createSemanticBridge({ root, registry, targets, dispatch: event => runtime.dispatch(event), trustedEventsOnly: options.trustedEventsOnly ?? true });
  let destroyed = false;
  return Object.freeze({
    registry, targets, overlay, router, store, runtime, profile, guides,
    destroy() { if (destroyed) return; destroyed = true; bridge.destroy(); availability.destroy(); stopPlacement();unsubscribeRuntime();doc.removeEventListener("keydown",escape);dialog.destroy();unsubscribeRouter(); unsubscribeStore(); profile.destroy(); postconditions.destroy(); runtime.cancel(); overlay.hide(); root.replaceChildren(); },
  });
}
