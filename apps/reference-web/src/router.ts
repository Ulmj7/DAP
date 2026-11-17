/** A hash router over a fixed set of routes (`#/dashboard`, `#/profile`, `#/settings`). Anything else is the dashboard. */
export const ROUTES = ["dashboard", "profile", "settings"] as const;
export type Route = (typeof ROUTES)[number];

export interface Router {
  current(): Route;
  navigate(route: Route): void;
  subscribe(callback: (route: Route) => void): () => void;
}

export function createRouter(win: Window): Router {
  const current = (): Route => {
    const name = win.location.hash.replace(/^#\/?/, "");
    return (ROUTES as readonly string[]).includes(name) ? (name as Route) : "dashboard";
  };
  return {
    current,
    navigate(route) { win.location.hash = `#/${route}`; },
    subscribe(callback) {
      const listener = (): void => callback(current());
      win.addEventListener("hashchange", listener);
      return () => win.removeEventListener("hashchange", listener);
    },
  };
}
