import { h } from "../dom.js";

export interface ProfileActions {
  /** The slice-1 demo: highlight a registered element with a tooltip. */
  readonly showMe: () => void;
  /** Asks for an id that is not registered; nothing may be highlighted. */
  readonly showMissing: () => void;
}

export function profilePage(actions: ProfileActions): HTMLElement {
  const showMe = h("button", { type: "button", id: "show-me" }, "Show me");
  showMe.addEventListener("click", actions.showMe);
  const showMissing = h("button", { type: "button", id: "show-missing" }, "Ask for a missing element");
  showMissing.addEventListener("click", actions.showMissing);
  return h("section", {},
    h("h1", {}, "Profile"),
    h("label", { for: "name" }, "Name"),
    h("input", { id: "name", type: "text", "data-ai-id": "profile.nameInput" }),
    h("label", { for: "email" }, "Email"),
    h("input", { id: "email", type: "email", "data-ai-private": true, "data-ai-id": "profile.emailInput" }),
    h("label", { for: "phone" }, "Phone"),
    h("input", { id: "phone", type: "text", "data-ai-redact": true }),
    h("label", { for: "password" }, "Password"),
    // Deliberately carries a data-ai-id although it is not registered and is a password field: it must stay untargetable.
    h("input", { id: "password", type: "password", "data-ai-id": "profile.passwordInput" }),
    h("div", {}, h("button", { type: "button", "data-ai-id": "profile.saveButton" }, "Save")),
    h("div", { class: "panel", "data-ai-ignore": true }, h("strong", {}, "Billing notes"), h("p", {}, "Private to this device. The guidance layer never sees this panel."), h("input", { type: "text", "aria-label": "Billing note" })),
    h("div", { class: "demo" }, h("p", {}, "Slice 1 demo:"), showMe, showMissing),
  );
}
