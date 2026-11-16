import { expect, it } from "vitest";

it("the reference web app's tests run under jsdom", () => expect(document.body).toBeDefined());
