import { h } from "../dom.js";

export function settingsPage(): HTMLElement {
  return h("section", {},
    h("h1", {}, "Settings"),
    h("div", { class: "panel", "data-ai-id": "settings.securityPanel" }, h("h2", {}, "Security"), h("p", {}, "Review how your account is protected.")),
    h("button", { type: "button", "aria-expanded": "false", "data-ai-id": "settings.advancedToggle" }, "Advanced"),
    // Static for now: the advanced area stays collapsed, and the two-factor control is inert.
    h("div", { hidden: true },
      h("button", { type: "button", "data-ai-id": "settings.twoFactorSetup" }, "Set up two-factor authentication"),
    ),
  );
}
