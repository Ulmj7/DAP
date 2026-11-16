import { h } from "../dom.js";

export function dashboardPage(): HTMLElement {
  return h("section", {},
    h("h1", { "data-ai-id": "dashboard.heading" }, "Dashboard"),
    h("p", {}, "Welcome back. Pick something to do."),
    h("button", { type: "button", "data-ai-id": "dashboard.createProjectButton" }, "Create project"),
  );
}
