import { expect, it } from "vitest";
import * as dom from "./index.js";

it("the DOM adapter entry loads under jsdom", () => {
  expect(dom).toBeDefined();
  expect(typeof document.createElement).toBe("function");
});
