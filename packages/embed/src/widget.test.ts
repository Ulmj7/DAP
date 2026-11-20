// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { mountWidget } from "./widget.js";

const cssUrl = new URL("https://assets.example.invalid/widget/v1.0.0/widget.css");
const cssIntegrity = "sha384-test";

function install() {
  mountWidget(document, cssUrl, cssIntegrity);
  const host = document.querySelector("ai-tuslah-widget")!;
  const shadow = host.shadowRoot!;
  return { host, shadow, stylesheet: shadow.querySelector("link")! };
}

function loadWidget() {
  const { shadow, stylesheet } = install();
  stylesheet.dispatchEvent(new Event("load"));
  return {
    shadow,
    launcher: shadow.querySelector<HTMLButtonElement>(".launcher")!,
    panel: shadow.querySelector<HTMLElement>(".panel")!,
    close: shadow.querySelector<HTMLButtonElement>(".close")!,
  };
}

afterEach(() => document.body.replaceChildren());

describe("SaaS widget", () => {
  it("loads one integrity-protected stylesheet and renders only after it is ready", () => {
    const { shadow, stylesheet } = install();
    install();
    expect(document.querySelectorAll("ai-tuslah-widget")).toHaveLength(1);
    expect(shadow.querySelector("button")).toBeNull();
    expect(stylesheet.href).toBe(cssUrl.href);
    expect(stylesheet.integrity).toBe(cssIntegrity);
    expect(stylesheet.crossOrigin).toBe("anonymous");
    stylesheet.dispatchEvent(new Event("load"));
    install();
    expect(shadow.querySelectorAll(".launcher")).toHaveLength(1);
    expect(document.querySelector(".launcher")).toBeNull();
  });

  it("opens, closes and restores focus without changing the host page", () => {
    const hostContent = document.createElement("main");
    hostContent.textContent = "Customer application";
    document.body.append(hostContent);
    const { shadow, launcher, panel, close } = loadWidget();
    expect(panel.hidden).toBe(true);
    launcher.click();
    expect(launcher.getAttribute("aria-expanded")).toBe("true");
    expect(panel.hidden).toBe(false);
    expect(shadow.activeElement).toBe(close);
    close.click();
    expect(launcher.getAttribute("aria-expanded")).toBe("false");
    expect(panel.hidden).toBe(true);
    expect(shadow.activeElement).toBe(launcher);
    expect(document.body.className).toBe("");
    expect(hostContent.textContent).toBe("Customer application");
  });

  it("handles Escape inside the widget and leaves host-page Escape events alone", () => {
    const { shadow, launcher, panel, close } = loadWidget();
    launcher.click();
    const outside = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    document.body.dispatchEvent(outside);
    expect(outside.defaultPrevented).toBe(false);
    expect(panel.hidden).toBe(false);
    const inside = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true, composed: true });
    close.dispatchEvent(inside);
    expect(inside.defaultPrevented).toBe(true);
    expect(panel.hidden).toBe(true);
    expect(shadow.activeElement).toBe(launcher);
  });

  it("cleans up a failed load and allows a later installation", () => {
    const { host, stylesheet } = install();
    stylesheet.dispatchEvent(new Event("error"));
    expect(host.isConnected).toBe(false);
    const { launcher } = loadWidget();
    expect(launcher.isConnected).toBe(true);
  });
});
