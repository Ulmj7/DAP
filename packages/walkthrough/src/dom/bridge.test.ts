import { afterEach, expect, it, vi } from "vitest";
import { createSemanticRegistry } from "../semantic/registry.js";
import { createTargets } from "./targets.js";
import { createSemanticBridge } from "./bridge.js";
import type { SemanticEvent } from "../engine/events.js";
const registry = createSemanticRegistry({ routes: ["profile"], elements: [
 { id: "profile.input", route: "profile", role: "textbox", label: "Name", description: "Name field", operations: ["input"], privacy: "public" },
 ...["first", "other"].map(id => ({ id: `profile.${id}`, route: "profile", role: "button" as const, label: "Button", description: "Action", operations: ["click" as const], privacy: "public" as const })),
 { id: "profile.email", route: "profile", role: "textbox", label: "Email", description: "Private", operations: ["input"], privacy: "private" },
] });
const cleanups: (() => void)[] = [];
afterEach(() => { for (const fn of cleanups.splice(0)) fn(); document.body.replaceChildren(); });
function setup(trustedEventsOnly = false, dispatch?: (event: SemanticEvent) => void) {
 const root = document.createElement("div"); document.body.append(root); const events: SemanticEvent[] = [];
 const installed = vi.spyOn(root, "addEventListener");
 const bridge = createSemanticBridge({ root, registry, targets: createTargets(root, registry), dispatch: dispatch ?? (e => events.push(e)), trustedEventsOnly }); cleanups.push(bridge.destroy);
 const element = (tag: string, id: string, attrs: Record<string, string> = {}) => { const el = document.createElement(tag); el.setAttribute("data-ai-id", id); for (const [k,v] of Object.entries(attrs)) el.setAttribute(k,v); root.append(el); return el; };
 return { root, events, bridge, element, installed };
}
it("emits the actual clicked registered element, even a nested node", () => {
 const s = setup(); const first = s.element("button", "profile.first"); const child = document.createElement("span"); first.append(child); child.click();
 s.element("button", "profile.other").click();
 expect(s.events).toEqual([{ type: "click", id: "profile.first" }, { type: "click", id: "profile.other" }]);
});
it.each(["unknown", "__proto__", "constructor", "[x]"])("never treats attribute %s as a selector or lookup property", id => { const s = setup(); s.element("button", id).click(); expect(s.events).toEqual([]); });
it.each(["data-ai-ignore", "data-ai-private", "data-ai-redact", "hidden"])("never emits from a protected or unavailable target (%s)", attr => { const s = setup(); s.element("button", "profile.first", { [attr]: "" }).click(); expect(s.events).toEqual([]); });
it("never emits private, password, redacted, ignored, duplicate or non-text values", () => {
 const s = setup();
 for (const [id, attrs] of [["profile.email", {}], ["profile.input", { type: "password" }], ["profile.input", { "data-ai-redact": "" }], ["profile.input", { type: "checkbox" }], ["profile.input", { type: "radio" }], ["profile.input", { type: "number" }]] as const) {
  const el = s.element("input", id, attrs as Record<string,string>) as HTMLInputElement; el.value = "SECRETVALUE"; el.dispatchEvent(new Event("input", { bubbles: true })); el.remove();
 }
 const ignored = document.createElement("div"); ignored.setAttribute("data-ai-ignore", ""); s.root.append(ignored); ignored.append(s.element("button", "profile.first")); ignored.querySelector("button")!.click(); ignored.remove();
 s.element("button", "profile.first"); s.element("button", "profile.first").click(); expect(s.events).toEqual([]);
});
it.each(["input", "textarea", "select"])("%s emits only a nonEmpty boolean, never the value", tag => {
 const s = setup(); const el = s.element(tag, "profile.input") as HTMLInputElement;
 if (tag === "select") { const option = document.createElement("option"); option.value = "SECRET"; el.append(option); }
 for (const value of ["SECRET", " ", ""]) { el.value = value; el.dispatchEvent(new Event("input", { bubbles: true })); }
 expect(s.events.map(e => e.type === "input" && e.nonEmpty)).toEqual([true, false, false]); expect(JSON.stringify(s.events)).not.toContain("SECRET");
});
it("default ignores synthetic events; opt-in accepts them; destroy is idempotent", () => {
 const s = setup(true); const el = s.element("button", "profile.first"); el.click(); expect(s.events).toEqual([]);
 s.bridge.destroy(); s.bridge.destroy(); el.click(); expect(s.events).toEqual([]);
 const other = setup(); const button = other.element("button", "profile.first"); button.click(); other.bridge.destroy(); button.click(); expect(other.events).toHaveLength(1);
});
it("delegates exactly three listeners and swallows dispatch errors", () => {
 const s = setup(false, () => { throw new Error("subscriber failure"); });
 expect(s.installed.mock.calls.map(([type,,capture]) => [type,capture])).toEqual([["click",true],["input",true],["change",true]]);
 s.installed.mockClear();
 for (let i=0;i<5;i++) { s.root.replaceChildren(); expect(() => s.element("button", "profile.first").click()).not.toThrow(); }
 expect(s.installed).not.toHaveBeenCalled();
});
