/** The demo's semantic registry: the stable ids a walkthrough may name. The password field is deliberately NOT here. */
import { createSemanticRegistry } from "@dap/walkthrough";
import type { SemanticElementDef, SemanticRegistry } from "@dap/walkthrough";

export const ROUTE_IDS = ["dashboard", "profile", "settings"] as const;

export const DEMO_ELEMENTS: readonly SemanticElementDef[] = [
  { id: "nav.settings", route: "dashboard", role: "link", label: "Settings link", description: "Opens the settings page", operations: ["highlight", "click"], privacy: "public" },
  { id: "nav.profile", route: "dashboard", role: "link", label: "Profile link", description: "Opens the profile page", operations: ["highlight", "click"], privacy: "public" },
  { id: "profile.nameInput", route: "profile", role: "textbox", label: "Name", description: "Your display name", operations: ["highlight", "input", "focus"], privacy: "public" },
  { id: "profile.emailInput", route: "profile", role: "textbox", label: "Email", description: "Your email address", operations: ["highlight", "input"], privacy: "private" },
  { id: "profile.saveButton", route: "profile", role: "button", label: "Save", description: "Saves your profile", operations: ["highlight", "click"], privacy: "public" },
  { id: "settings.advancedToggle", route: "settings", role: "button", label: "Advanced", description: "Shows or hides the advanced settings", operations: ["highlight", "click"], privacy: "public" },
  { id: "settings.securityPanel", route: "settings", role: "panel", label: "Security", description: "The security settings section", operations: ["highlight"], privacy: "public" },
  { id: "settings.twoFactorSetup", route: "settings", role: "button", label: "Two-factor setup", description: "Starts two-factor authentication setup", operations: ["highlight", "click"], privacy: "public" },
  { id: "dashboard.createProjectButton", route: "dashboard", role: "button", label: "Create project", description: "Starts a new project", operations: ["highlight", "click"], privacy: "public" },
];

export function createDemoRegistry(): SemanticRegistry {
  return createSemanticRegistry({ routes: ROUTE_IDS, elements: DEMO_ELEMENTS });
}
