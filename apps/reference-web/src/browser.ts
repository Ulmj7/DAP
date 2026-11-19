import { createWalkthroughCatalog } from "@dap/walkthrough";
import type { WalkthroughDef } from "@dap/walkthrough";
import { createAdminClient } from "./admin/client.js";
import { PREVIEW_ID } from "./admin/draft.js";
import { readRole, setEditSession, takeRequestedEdit, writeRole } from "./admin/session.js";
import type { FetchLike } from "./help/client.js";
import { mountApp } from "./main.js";
import type { MountedApp } from "./main.js";
import { POSTCONDITION_NAMES } from "./postconditions.js";
import { createDemoRegistry } from "./semantic-ui.js";
import { WALKTHROUGHS } from "./walkthroughs/index.js";

export async function boot(root: HTMLElement, options: { fetch?: FetchLike; trustedEventsOnly?: boolean } = {}) {
  const window = root.ownerDocument.defaultView;
  if (!window) throw new Error("boot needs a window");
  const win = window;
  const fetcher = options.fetch ?? (typeof win.fetch === "function" ? win.fetch.bind(win) : undefined);
  const registry = createDemoRegistry();
  let role = readRole(win);
  let walkthroughs: readonly WalkthroughDef[] = WALKTHROUGHS;
  let app: MountedApp | undefined;
  let revision = 0;
  const mountOptions = options.trustedEventsOnly === undefined ? {} : { trustedEventsOnly: options.trustedEventsOnly };

  function preview(definition: WalkthroughDef) {
    const def = { ...definition, id: PREVIEW_ID };
    try { createWalkthroughCatalog(registry, POSTCONDITION_NAMES, [def]); } catch { return; }
    const returnHash = win.location.hash;
    app?.destroy();
    win.history.replaceState(null, "", "#/dashboard");
    app = mountApp(root, {
      ...mountOptions, walkthroughs: [...walkthroughs, def], hideFromLauncher: [PREVIEW_ID], autoStart: PREVIEW_ID,
      onPreviewEnd: () => {
        win.history.replaceState(null, "", returnHash || "#/walkthroughs");
        mountNormal();
        root.querySelector<HTMLElement>("h1")?.focus();
      },
    });
  }

  function mountNormal() {
    app?.destroy();
    app = mountApp(root, {
      ...mountOptions, walkthroughs,
      admin: {
        client: createAdminClient({ fetch: fetcher, role }), role, preview,
        changeRole(next) {
          if (next === role) return;
          role = next; writeRole(win, next); setEditSession(); takeRequestedEdit();
          app?.destroy(); app = undefined;
          void remount("#demo-role");
        },
        refresh() { void remount("h1"); },
      },
    });
  }

  async function remount(focus?: string) {
    const attempt = ++revision;
    const response = await createAdminClient({ fetch: fetcher, role }).published();
    if (attempt !== revision) return;
    const accepted: WalkthroughDef[] = [...WALKTHROUGHS];
    const seen = new Set(accepted.map(def => def.id));
    if (response.kind === "ok") for (const def of response.value) {
      if (seen.has(def.id)) continue;
      try {
        const validated = createWalkthroughCatalog(registry, POSTCONDITION_NAMES, [def]).get(def.id);
        if (validated) { accepted.push(validated); seen.add(def.id); }
      } catch { /* One invalid definition does not hide the others. */ }
    }
    walkthroughs = accepted;
    mountNormal();
    if (focus) root.querySelector<HTMLElement>(focus)?.focus();
  }

  await remount();
  return {
    current: () => app,
    destroy() { revision++; app?.destroy(); app = undefined; },
  };
}
