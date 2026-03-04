// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { navigateTo, navigateToSession } from "./navigation.js";

describe("navigation helpers", () => {
  beforeEach(() => {
    window.location.hash = "";
  });

  it("navigates to a hash path", () => {
    navigateTo("/questmaster");
    expect(window.location.hash).toBe("#/questmaster");
  });

  it("navigates to a hash path with query", () => {
    navigateTo("/questmaster?quest=q-67");
    expect(window.location.hash).toBe("#/questmaster?quest=q-67");
  });

  it("clears hash when navigating home", () => {
    navigateTo("/questmaster");
    navigateTo("");
    expect(window.location.hash === "" || window.location.hash === "#").toBe(true);
  });

  it("navigates to session routes via helper", () => {
    navigateToSession("abc-123");
    expect(window.location.hash).toBe("#/session/abc-123");
  });
});
