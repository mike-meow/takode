import { describe, it, expect } from "vitest";
import { shortenHome, cwdRelativeToRoot } from "./path-display.js";

describe("shortenHome", () => {
  it("replaces /home/<user> prefix with ~", () => {
    expect(shortenHome("/home/jiayiwei/companion/web")).toBe("~/companion/web");
  });

  it("replaces /Users/<user> prefix with ~ (macOS)", () => {
    expect(shortenHome("/Users/alice/projects/app")).toBe("~/projects/app");
  });

  it("returns path unchanged when no home prefix detected", () => {
    expect(shortenHome("/var/lib/data")).toBe("/var/lib/data");
    expect(shortenHome("/tmp/test")).toBe("/tmp/test");
  });

  it("handles bare home directory", () => {
    expect(shortenHome("/home/user")).toBe("~");
  });
});

describe("cwdRelativeToRoot", () => {
  it("returns relative subpath when cwd is inside repoRoot", () => {
    expect(cwdRelativeToRoot("/home/user/repo/web", "/home/user/repo")).toBe("web");
    expect(cwdRelativeToRoot("/home/user/repo/src/lib", "/home/user/repo")).toBe("src/lib");
  });

  it("returns null when cwd equals repoRoot", () => {
    expect(cwdRelativeToRoot("/home/user/repo", "/home/user/repo")).toBeNull();
  });

  it("returns null when cwd is not inside repoRoot", () => {
    expect(cwdRelativeToRoot("/home/user/other", "/home/user/repo")).toBeNull();
  });
});
